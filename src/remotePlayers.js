import * as THREE from 'three'
import { createCarModel } from './carModel.js'
import { applyLoadout } from './parts.js'
import { SEND_RATE, TICK_RATE } from '../shared/protocol.js'

// Rakip arabalar: sunucudan gelen durumları biraz GERİDEN oynatırız (interpolasyon).
// Neden? Durumlar saniyede 15 kez (66 ms'de bir) gelir, ekran 60 kare çizer. En son geleni çizersek
// araba 66 ms durur, sonra zıplar. Geride kalınca o anın hem ÖNCESİNDEKİ hem SONRASINDAKİ
// durum elimizde olur: ikisinin arasını yumuşakça doldururuz (konum: lerp, dönüş: slerp)
//
// Ne kadar geride? En yeni durum, rakip gönderdikten sonra sunucunun tick'ini de bekler:
// 66 ms (gönderme aralığı) + 66 ms (tick aralığı) = elimizdeki en yeni bilgi 132 ms'ye kadar eski olabilir.
// 100 ms denedik: karelerin ~%30'unda "sonraki" durum henüz gelmemişti, araba donuyordu. + 20 ms ağ payı
const INTERP_DELAY = 1000 / SEND_RATE + 1000 / TICK_RATE + 20 // ≈ 153 ms
const SNAP_DISTANCE = 40 // iki durum arası bundan uzaksa (yeniden doğma) kaydırma, ışınla
const LABEL_HEIGHT = 4.6 // isim etiketi arabanın kaç birim üstünde
const MAX_BUFFER = 30 // en fazla kaç durum saklansın (~2 sn)

// İsim etiketi: canvas'a yazılmış bir Sprite (her zaman kameraya döner)
function createLabel(name, color) {
  const canvas = document.createElement('canvas')
  canvas.width = 256
  canvas.height = 64
  const ctx = canvas.getContext('2d')
  const css = `#${color.toString(16).padStart(6, '0')}`
  ctx.fillStyle = 'rgba(8, 10, 22, 0.75)'
  ctx.beginPath()
  ctx.roundRect(4, 8, 248, 48, 24)
  ctx.fill()
  ctx.strokeStyle = css
  ctx.lineWidth = 4
  ctx.stroke()
  ctx.fillStyle = '#ffffff'
  ctx.font = '700 28px system-ui, sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(name, 128, 33, 230) // canvas'a çizilen yazı HTML değildir: isimdeki < > zararsız
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  // toneMapped: false → pozlama (0.5) etiketi karartmasın; fog: false → uzaktan da okunsun
  const material = new THREE.SpriteMaterial({ map: texture, toneMapped: false, fog: false, depthTest: false })
  const sprite = new THREE.Sprite(material)
  sprite.scale.set(8, 2, 1)
  sprite.renderOrder = 10 // diğer her şeyin üstüne çizilsin
  return sprite
}

export function createRemotePlayers(scene, net) {
  const players = new Map() // id → { info, model, label, buffer: [{ rt, position, quaternion, progress }] }

  function add(info) {
    const model = createCarModel(info.color)
    // Rakibin garaj parçaları (sadece görsel). Varsayılan boyadaysa oyuncu rengi: yarışta ayırt edilsin
    applyLoadout(model, info.loadout, { playerColor: info.color })
    model.traverse((obj) => {
      if (obj.isMesh) obj.castShadow = true
    })
    model.visible = false // ilk durum gelene kadar gizli
    const label = createLabel(info.name, info.color)
    label.visible = false
    scene.add(model, label)
    players.set(info.id, { info, model, label, buffer: [] })
  }

  function remove(id) {
    const p = players.get(id)
    if (!p) return
    scene.remove(p.model, p.label)
    p.label.material.map.dispose()
    p.label.material.dispose()
    players.delete(id)
  }

  // Oda listesi değişince (sunucu 'room'): yeni gelenlere araba ekle, gidenleri çıkar
  function syncRoom(roomPlayers, selfId) {
    const ids = new Set()
    for (const info of roomPlayers) {
      if (info.id === selfId || info.left) continue
      ids.add(info.id)
      if (!players.has(info.id)) add(info)
      players.get(info.id).info = info
    }
    for (const id of [...players.keys()]) if (!ids.has(id)) remove(id)
  }

  // Sunucunun tick paketi: her oyuncunun son durumu. rt = sunucunun o durumu aldığı an (ortak saat)
  function onSnapshot(snapshot) {
    for (const s of snapshot.players) {
      const p = players.get(s.id)
      if (!p) continue
      p.info.status = s.status
      const last = p.buffer[p.buffer.length - 1]
      if (last && s.rt <= last.rt) continue // aynı durum tekrar geldi (oyuncu bu tick'te yeni bir şey yollamadı)
      p.buffer.push({
        rt: s.rt,
        position: new THREE.Vector3(s.x, s.y, s.z),
        quaternion: new THREE.Quaternion(...s.rotation),
        progress: s.progress,
        speed: s.speed, // motor sesi perdesi (audio.js)
      })
      if (p.buffer.length > MAX_BUFFER) p.buffer.shift()
    }
  }

  // Her kare: "şimdi − 100 ms" anını iki durum arasında ara değerle
  function update() {
    const renderTime = net.serverNow() - INTERP_DELAY
    for (const p of players.values()) {
      const buffer = p.buffer
      // renderTime'ı geride bırakan eski durumları at (en az biri kalsın)
      while (buffer.length >= 2 && buffer[1].rt <= renderTime) buffer.shift()
      const visible = buffer.length > 0 && p.info.status !== 'dnf' // DNF: düştü, pistten kaldır
      p.model.visible = p.label.visible = visible
      if (!visible) continue

      const a = buffer[0]
      const b = buffer[1]
      if (b && a.rt <= renderTime && a.position.distanceTo(b.position) < SNAP_DISTANCE) {
        const alpha = (renderTime - a.rt) / (b.rt - a.rt) // 0 → a, 1 → b
        p.model.position.lerpVectors(a.position, b.position, alpha)
        p.model.quaternion.slerpQuaternions(a.quaternion, b.quaternion, alpha)
      } else {
        // Elimizde ileri bir durum yok (paket gecikti) ya da ışınlandı: son bilineni göster
        p.model.position.copy(a.position)
        p.model.quaternion.copy(a.quaternion)
      }
      p.label.position.copy(p.model.position).y += LABEL_HEIGHT
    }
  }

  // Canlı sıralama için: her rakibin en güncel ilerlemesi (çizdiğimiz değil, son gelen)
  function progressOf(id) {
    const buffer = players.get(id)?.buffer
    return buffer?.length ? buffer[buffer.length - 1].progress : 0
  }

  // Sesi çıkacak rakipler: çizilen arabanın konumu ve son bilinen hızı (audio.js: uzaklığa göre kısılan motor)
  function voices() {
    const list = []
    for (const [id, p] of players) {
      if (p.model.visible && p.buffer.length) list.push({ id, position: p.model.position, speed: p.buffer[p.buffer.length - 1].speed ?? 0 })
    }
    return list
  }

  return { syncRoom, onSnapshot, update, progressOf, voices }
}
