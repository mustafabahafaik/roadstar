// Monad Racer çok oyunculu sunucu: Node.js + Socket.IO.
// Görevleri: odalar ve hazır durumu, ortak seed + başlangıç saati, durumları odaya yayma (15 Hz),
// basit hile kontrolü, kopan oyuncuyu DNF sayma. Fizik burada değil: her oyuncu kendi arabasını sürer.
//
// Çalıştır: npm run server   (kök klasörde)  →  http://localhost:3001
import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { Server } from 'socket.io'
import {
  RACE_LENGTH,
  MAX_PLAYERS,
  MIN_PLAYERS,
  COUNTDOWN_MS,
  TICK_RATE,
  MAX_TRACK_SPEED,
  PLAYER_COLORS,
  rankPlayers,
} from '../shared/protocol.js'

const PORT = Number(process.env.PORT) || 3001
// Hangi sitelerden bağlanılabilir (CORS). İnternete yüklerken oyunun adresini yaz: CLIENT_ORIGIN=https://...
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN?.split(',') ?? '*'
const RACE_TIMEOUT_MS = 5 * 60 * 1000 // 5 dakikada bitiremeyen DNF sayılır

// Hile kontrolü toleransları: ağ gecikmesi paketleri bazen yığar, dürüst oyuncu reddedilmesin
const SPEED_TOLERANCE = 1.2 // azami hızın %20 fazlasına kadar
const STEP_SLACK = 30 // her güncellemede ek pay (birim)
const FINISH_MIN_PROGRESS = 0.97 // "bitirdim" diyen oyuncunun son kabul edilen ilerlemesi en az bu olmalı

const httpServer = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
  res.end('Monad Racer sunucusu çalışıyor\n') // tarayıcıdan açınca "çalışıyor mu?" kontrolü
})
const io = new Server(httpServer, { cors: { origin: CLIENT_ORIGIN } })

// --- Odalar ---
// room: { id, status: 'lobby' | 'racing', seed, startAt, players: Map<socketId, player> }
// player: { id, name, color, ready, status, state, last, finishMs, left }
const rooms = new Map()

const cleanName = (text, fallback, max) => String(text ?? '').trim().slice(0, max) || fallback
const cleanRoom = (text) =>
  String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '')
    .slice(0, 20) || 'monad'

function getRoom(id) {
  if (!rooms.has(id)) rooms.set(id, { id, status: 'lobby', seed: null, startAt: 0, players: new Map() })
  return rooms.get(id)
}

// Odadaki herkese gönderilen özet (lobi listesi, sıralama). Sadece paylaşılabilir alanlar
function publicRoom(room) {
  return {
    id: room.id,
    status: room.status,
    players: [...room.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      color: p.color,
      ready: p.ready,
      status: p.status,
      progress: p.last.progress,
      finishMs: p.finishMs,
      left: p.left,
    })),
  }
}
const broadcastRoom = (room) => io.to(room.id).emit('room', publicRoom(room))

function freeColor(room) {
  const used = new Set([...room.players.values()].map((p) => p.color))
  return PLAYER_COLORS.find((c) => !used.has(c)) ?? PLAYER_COLORS[0]
}

// --- Yarışı başlat: herkes hazır (en az 2 kişi) ya da oda doldu ---
function maybeStart(room) {
  if (room.status !== 'lobby') return
  const players = [...room.players.values()]
  const allReady = players.length >= MIN_PLAYERS && players.every((p) => p.ready)
  if (!allReady && players.length < MAX_PLAYERS) return

  room.status = 'racing'
  room.seed = '0x' + randomBytes(32).toString('hex') // herkes bu seed'den AYNI parkuru üretir
  // "Şimdi başla" demiyoruz: mesaj herkese farklı gecikmeyle varır. Gelecekte bir AN veriyoruz;
  // her oyuncu bu anı kendi saatine çevirip (saat farkı: ping/pong) aynı anda başlar
  room.startAt = Date.now() + COUNTDOWN_MS
  for (const p of players) {
    p.status = 'racing'
    p.ready = false
    p.state = null
    p.last = { progress: 0, time: room.startAt }
    p.finishMs = null
  }
  console.log(`[${room.id}] yarış başlıyor: ${players.map((p) => p.name).join(', ')} · seed ${room.seed.slice(0, 10)}…`)
  io.to(room.id).emit('start', { seed: room.seed, startAt: room.startAt })
  broadcastRoom(room)
}

// --- Yarış bitti mi? Herkes bitirdi ya da DNF → sonuçları gönder, odayı lobiye döndür ---
function maybeEnd(room) {
  if (room.status !== 'racing') return
  const players = [...room.players.values()]
  if (Date.now() - room.startAt > RACE_TIMEOUT_MS) {
    for (const p of players) if (p.status === 'racing') p.status = 'dnf'
  }
  if (players.some((p) => p.status === 'racing')) return

  const standings = rankPlayers(publicRoom(room).players)
  console.log(`[${room.id}] yarış bitti: ${standings.map((p, i) => `${i + 1}. ${p.name} (${p.status})`).join(', ')}`)
  io.to(room.id).emit('results', { standings })

  room.status = 'lobby'
  for (const p of players) {
    if (p.left) room.players.delete(p.id) // kopanlar sonuçta göründü, artık listeden çıkar
    p.status = 'lobby'
    p.state = null
  }
  if (room.players.size === 0) rooms.delete(room.id)
  else broadcastRoom(room)
}

// --- Hile kontrolü: iki güncelleme arasında fiziksel olarak mümkün olandan fazla ilerleme ---
// Sunucunun KENDİ saatiyle ölçüyoruz (oyuncunun gönderdiği zamana güvenmiyoruz)
function checkMove(room, player, progress, now) {
  const dt = Math.max(0, now - player.last.time) / 1000
  const moved = (progress - player.last.progress) * RACE_LENGTH // geri gitmek (yeniden doğma) serbest
  const allowedStep = MAX_TRACK_SPEED * SPEED_TOLERANCE * dt + STEP_SLACK
  if (moved > allowedStep) {
    return `${moved.toFixed(1)} birim / ${(dt * 1000).toFixed(0)} ms (izin ${allowedStep.toFixed(1)})`
  }
  // Toplam kontrol: küçük küçük adımlarla da olsa, başlangıçtan beri azami hızla gidilebilecekten fazlası olmaz
  const elapsed = Math.max(0, now - room.startAt) / 1000
  const allowedTotal = MAX_TRACK_SPEED * SPEED_TOLERANCE * elapsed + STEP_SLACK
  if (progress * RACE_LENGTH > allowedTotal) {
    return `toplam ${(progress * RACE_LENGTH).toFixed(0)} birim / ${elapsed.toFixed(1)} sn (izin ${allowedTotal.toFixed(0)})`
  }
  return null
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v)

io.on('connection', (socket) => {
  let room = null
  let player = null

  // Saat eşitleme: istemci kendi saatini gönderir, biz kendi saatimizle cevap veririz (ack = cevap fonksiyonu)
  socket.on('clock', (ack) => typeof ack === 'function' && ack(Date.now()))

  socket.on('join', ({ name, room: roomId } = {}, ack = () => {}) => {
    if (room) return ack({ ok: false, error: 'Zaten bir odadasın' })
    const target = getRoom(cleanRoom(roomId))
    if (target.status !== 'lobby') return ack({ ok: false, error: 'Bu odada yarış sürüyor, biraz bekle' })
    if (target.players.size >= MAX_PLAYERS) return ack({ ok: false, error: `Oda dolu (${MAX_PLAYERS} kişi)` })

    room = target
    player = {
      id: socket.id,
      name: cleanName(name, 'Pilot', 16),
      color: freeColor(room),
      ready: false,
      status: 'lobby',
      state: null,
      last: { progress: 0, time: 0 },
      finishMs: null,
      left: false,
      rejected: 0, // reddedilen güncelleme sayısı
      lastCheatLog: 0,
    }
    room.players.set(socket.id, player)
    socket.join(room.id) // Socket.IO odası: io.to(room.id) bu odadaki herkese gönderir
    console.log(`[${room.id}] ${player.name} katıldı (${room.players.size}/${MAX_PLAYERS})`)
    ack({ ok: true, you: { id: player.id, color: player.color }, room: publicRoom(room) })
    broadcastRoom(room)
    maybeStart(room) // oda 5 kişiyle dolduysa beklemeden başla
  })

  socket.on('ready', (ready) => {
    if (!room || room.status !== 'lobby') return
    player.ready = Boolean(ready)
    broadcastRoom(room)
    maybeStart(room)
  })

  // Oyuncunun durumu (saniyede 15 kez). Kontrol edip saklarız; odaya tick döngüsü yayar
  socket.on('state', (s) => {
    if (!room || room.status !== 'racing' || player.status !== 'racing' || !s) return
    const now = Date.now()
    const values = [s.x, s.y, s.z, s.speed, s.progress, ...(Array.isArray(s.rotation) ? s.rotation : [])]
    if (values.length !== 9 || !values.every(isNum)) return // bozuk veri: sessizce at
    if (now < room.startAt) return // geri sayımda gelen durum: yarış başlamadı
    const progress = Math.min(Math.max(s.progress, 0), 1)

    const cheat = checkMove(room, player, progress, now)
    if (cheat) {
      player.rejected++
      // Log'u saniyede bire sınırla: hileci saniyede 15 satırla sunucu kaydını boğmasın
      if (now - player.lastCheatLog > 1000) {
        player.lastCheatLog = now
        console.warn(`[${room.id}] HİLE? ${player.name}: ${cheat} → reddedildi (toplam ${player.rejected})`)
      }
      return // durumu kabul etme: diğerleri onu eski yerinde görür
    }
    player.last = { progress, time: now }
    // rt (receive time): sunucunun aldığı an. Alıcılar interpolasyonu bu ortak zaman çizgisinde yapar
    player.state = { x: s.x, y: s.y, z: s.z, rotation: s.rotation.slice(0, 4), speed: s.speed, progress, rt: now }
  })

  socket.on('finish', () => {
    if (!room || room.status !== 'racing' || player.status !== 'racing') return
    const elapsed = Date.now() - room.startAt
    const fastest = (RACE_LENGTH / (MAX_TRACK_SPEED * SPEED_TOLERANCE)) * 1000
    if (player.last.progress < FINISH_MIN_PROGRESS || elapsed < fastest) {
      console.warn(`[${room.id}] HİLE? ${player.name}: %${Math.round(player.last.progress * 100)} ilerlemeyle ${elapsed} ms'de bitirdi → reddedildi`)
      return
    }
    player.status = 'finished'
    player.finishMs = elapsed // süreyi SUNUCU ölçer: herkes için aynı saat
    player.last.progress = 1
    console.log(`[${room.id}] ${player.name} bitirdi: ${(elapsed / 1000).toFixed(3)} sn`)
    broadcastRoom(room)
    maybeEnd(room)
  })

  socket.on('dnf', () => {
    if (!room || player.status !== 'racing') return
    player.status = 'dnf'
    console.log(`[${room.id}] ${player.name} DNF`)
    broadcastRoom(room)
    maybeEnd(room)
  })

  // Bağlantı koptu: lobide listeden çık; yarıştaysa DNF say (sonuçta görünsün diye listede kalır)
  socket.on('disconnect', () => {
    if (!room) return
    if (room.status === 'racing') {
      if (player.status === 'racing') player.status = 'dnf'
      player.left = true
      console.log(`[${room.id}] ${player.name} koptu → DNF`)
      broadcastRoom(room)
      maybeEnd(room)
    } else {
      room.players.delete(socket.id)
      console.log(`[${room.id}] ${player.name} ayrıldı`)
      if (room.players.size === 0) rooms.delete(room.id)
      else {
        broadcastRoom(room)
        maybeStart(room) // kalanların hepsi hazırsa başlasın
      }
    }
  })
})

// --- Tick döngüsü: saniyede 15 kez, yarışan her odaya tüm oyuncuların son durumunu gönder ---
// volatile: alıcı o an meşgulse bu paketi at (eski konumu sonradan göndermenin anlamı yok, yenisi geliyor)
setInterval(() => {
  const now = Date.now()
  for (const room of rooms.values()) {
    if (room.status !== 'racing') continue
    const players = []
    for (const p of room.players.values()) {
      if (p.state && !p.left) players.push({ id: p.id, status: p.status, ...p.state })
    }
    io.to(room.id).volatile.emit('snapshot', { t: now, players })
    maybeEnd(room) // zaman aşımı kontrolü
  }
}, 1000 / TICK_RATE)

httpServer.listen(PORT, () => console.log(`Monad Racer sunucusu: http://localhost:${PORT}`))
