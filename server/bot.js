// Test botu: odaya katılır, "hazır" der, pist boyunca sabit hızla sürer, bitirince yeniden hazır olur.
// Tek tarayıcı sekmesiyle çok oyunculu denemek için (iki 3D sekme ekran kartını çok yorar).
//
// Kullanım (kök klasörde, sunucu açıkken):  node server/bot.js [oda] [isim] [hız]
//   örnek: node server/bot.js monad Bot 50
import { io } from 'socket.io-client'
import * as THREE from 'three'
import { trackCurve } from '../src/track.js'
import { RACE_LENGTH, SEND_RATE } from '../shared/protocol.js'

const [room = 'monad', name = 'Bot', speedArg = '50'] = process.argv.slice(2)
const SPEED = Number(speedArg) // birim / saniye (oyuncunun azami hızı 70, boost'la 140)
const SERVER_URL = process.env.SERVER_URL ?? 'http://localhost:3001'

const socket = io(SERVER_URL)
let offset = 0 // sunucu saati − bizim saatimiz
const serverNow = () => Date.now() + offset

// Oyundakiyle aynı ping/pong saat eşitlemesi (src/net.js)
async function syncClock() {
  let best = null
  for (let i = 0; i < 5; i++) {
    const t0 = Date.now()
    const ts = await socket.emitWithAck('clock')
    const t1 = Date.now()
    if (!best || t1 - t0 < best.rtt) best = { rtt: t1 - t0, offset: ts - (t0 + t1) / 2 }
  }
  offset = best.offset
  console.log(`saat farkı ${best.offset.toFixed(1)} ms · ping ${best.rtt} ms`)
}

socket.on('connect', async () => {
  await syncClock()
  const res = await socket.emitWithAck('join', { name, room })
  if (!res.ok) {
    console.log('katılamadı:', res.error)
    process.exit(1)
  }
  console.log(`${name} → oda "${res.room.id}" (${res.room.players.length} kişi), hazır`)
  socket.emit('ready', true)
})

// Botun arabası: pistin ortasında hafif zikzak, burnu gidiş yönüne
const UP = new THREE.Vector3(0, 1, 0)
const body = new THREE.Object3D()
const side = new THREE.Vector3()
let driving = null

socket.on('start', ({ startAt }) => {
  console.log(`yarış ${((startAt - serverNow()) / 1000).toFixed(1)} sn sonra başlıyor`)
  clearInterval(driving)
  driving = setInterval(() => {
    const now = serverNow()
    if (now < startAt) return // geri sayım
    const t = (now - startAt) / 1000
    const progress = Math.min(1, (SPEED * t) / RACE_LENGTH)
    const u = progress % 1 // ilerleme 1 → bitiş kapısı (u = 0)
    const tangent = trackCurve.getTangentAt(u)
    side.crossVectors(tangent, UP).normalize()
    body.position.copy(trackCurve.getPointAt(u)).addScaledVector(side, Math.sin(t * 0.8) * 4)
    body.lookAt(body.position.clone().add(tangent))
    const q = body.quaternion
    const state = {
      x: body.position.x,
      y: body.position.y,
      z: body.position.z,
      rotation: [q.x, q.y, q.z, q.w],
      speed: SPEED,
      progress,
      status: 'racing',
      t: now - startAt,
    }
    socket.emit('state', state)
    if (progress >= 1) {
      clearInterval(driving)
      socket.emit('finish')
      console.log(`bitirdim: ${t.toFixed(1)} sn`)
    }
  }, 1000 / SEND_RATE)
})

socket.on('results', ({ standings }) => {
  console.log('sonuç:', standings.map((p, i) => `${i + 1}. ${p.name} (${p.status})`).join(' · '))
  setTimeout(() => socket.emit('ready', true), 2000) // bir sonraki yarış için yeniden hazır
})

socket.on('disconnect', () => {
  console.log('sunucu bağlantısı koptu')
  process.exit(0)
})
