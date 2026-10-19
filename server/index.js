// Monad Racer çok oyunculu sunucu: Node.js + Socket.IO.
// Görevleri: odalar ve hazır durumu, ortak seed + başlangıç saati, durumları odaya yayma (15 Hz),
// basit hile kontrolü, kopan oyuncuyu DNF sayma. Fizik burada değil: her oyuncu kendi arabasını sürer.
// Ücretli oda (RacePool): ödemeyi zincirden doğrular, yarış sonunda sıralamayı imzalar.
//
// Çalıştır: npm run server   (kök klasörde)  →  http://localhost:3001
import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { Server } from 'socket.io'
import { getAddress } from 'ethers'
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
import { createPool, verifyOwnership } from './pool.js'

// server/.env → process.env (RESULT_SIGNER_KEY, POOL_ADDRESS...). Dosya yoksa ücretli oda kapalı çalışır
try {
  process.loadEnvFile(fileURLToPath(new URL('.env', import.meta.url)))
} catch {
  // .env yok: sorun değil
}

const PORT = Number(process.env.PORT) || 3001
// Hangi sitelerden bağlanılabilir (CORS). İnternete yüklerken oyunun adresini yaz: CLIENT_ORIGIN=https://...
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN?.split(',') ?? '*'
const RACE_TIMEOUT_MS = 5 * 60 * 1000 // 5 dakikada bitiremeyen DNF sayılır
const CREATE_LOCK_MS = 60 * 1000 // zincir odasını kuran oyuncuya ayrılan süre
const FULL_ROOM_GRACE_MS = 15 * 1000 // ücretli oda zincirde dolunca, hazır olmayan varsa en geç bu sürede başla
const POOL_JOIN_WINDOW_S = 10 * 60 // RacePool.JOIN_WINDOW ile aynı: bu sürede dolmayan zincir odasına giriş kapanır

// Hile kontrolü toleransları: ağ gecikmesi paketleri bazen yığar, dürüst oyuncu reddedilmesin
const SPEED_TOLERANCE = 1.2 // azami hızın %20 fazlasına kadar
const STEP_SLACK = 30 // her güncellemede ek pay (birim)
const FINISH_MIN_PROGRESS = 0.97 // "bitirdim" diyen oyuncunun son kabul edilen ilerlemesi en az bu olmalı

// --- Ücretli oda (RacePool). Anahtar ya da adres yoksa null: sadece ücretsiz yarış ---
const pool = createPool({
  rpcUrl: process.env.RPC_URL || 'https://testnet-rpc.monad.xyz',
  address: process.env.POOL_ADDRESS,
  signerKey: process.env.RESULT_SIGNER_KEY,
})
if (pool) {
  console.log(`RacePool ${pool.address} · imzacı ${pool.signerAddress}`)
  pool
    .checkSigner()
    .then((ok) => !ok && console.warn('⚠️  Kontrattaki resultSigner bu anahtarın adresi DEĞİL: imzalar reddedilecek'))
    .catch((err) => console.warn('⚠️  RacePool okunamadı:', err.shortMessage ?? err.message))
} else {
  console.log('RacePool ayarlı değil (server/.env): sadece ücretsiz yarış')
}

const httpServer = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
  res.end('Monad Racer sunucusu çalışıyor\n') // tarayıcıdan açınca "çalışıyor mu?" kontrolü
})
const io = new Server(httpServer, { cors: { origin: CLIENT_ORIGIN } })

// --- Odalar ---
// room: { id, status: 'lobby' | 'starting' | 'racing' | 'ending', seed, startAt, players: Map<socketId, player>,
//         chain: null | { roomId, entryFee, maxPlayers }  (bağlı RacePool odası),
//         creating: null | { playerId, at, maxPlayers },  (zincir odasını kuran oyuncunun kilidi)
//         autoStartAt: 0 }  (ücretli oda dolunca en geç başlama anı)
// player: { id, name, color, address, paid, ready, status, state, last, finishMs, left, rejected, lastCheatLog }
const rooms = new Map()

const cleanName = (text, fallback, max) => String(text ?? '').trim().slice(0, max) || fallback
const cleanRoom = (text) =>
  String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '')
    .slice(0, 20) || 'monad'

function getRoom(id) {
  if (!rooms.has(id)) {
    rooms.set(id, { id, status: 'lobby', seed: null, startAt: 0, players: new Map(), chain: null, creating: null, autoStartAt: 0 })
  }
  return rooms.get(id)
}

// Zincir odası 10 dakikada dolmadıysa kontrat yeni girişi reddeder: odayı ücretsize döndür.
// Ödemiş olanlar paralarını kontrattan refund(roomId) ile geri alır
function releaseExpiredChain(room) {
  if (!room.chain || Date.now() / 1000 < room.chain.createdAt + POOL_JOIN_WINDOW_S) return
  console.log(`[${room.id}] zincir odası #${room.chain.roomId} 10 dakikada dolmadı → bırakıldı (iade açık)`)
  room.chain = null
  room.creating = null
  room.autoStartAt = 0
  for (const p of room.players.values()) {
    p.paid = false
    p.ready = false
  }
  broadcastRoom(room)
}

// Odadaki herkese gönderilen özet (lobi listesi, sıralama). Sadece paylaşılabilir alanlar
function publicRoom(room) {
  return {
    id: room.id,
    status: room.status,
    chain: room.chain,
    creating: Boolean(room.creating),
    autoStartAt: room.autoStartAt,
    players: [...room.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      color: p.color,
      address: p.address,
      paid: p.paid,
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

// --- Yarışı başlat ---
// Ücretsiz oda: herkes hazır (en az 2 kişi) ya da oda doldu (5).
// Ücretli oda: herkes ödedi (zincirde oda doldu) ve hazır; hazır olmayan varsa FULL_ROOM_GRACE_MS sonra yine başlar
async function maybeStart(room) {
  if (room.status !== 'lobby') return
  let players = [...room.players.values()]

  if (room.chain) {
    const full = players.length === room.chain.maxPlayers && players.every((p) => p.paid)
    if (!full) {
      room.autoStartAt = 0
      return
    }
    const allReady = players.every((p) => p.ready)
    if (!allReady && !room.autoStartAt) {
      room.autoStartAt = Date.now() + FULL_ROOM_GRACE_MS // tick döngüsü bu ana gelince tekrar çağırır
      broadcastRoom(room)
    }
    if (!allReady && Date.now() < room.autoStartAt) return

    // Son kontrol zincirden: oda gerçekten doldu mu, oyuncular bunlar mı?
    room.status = 'starting' // await sırasında ikinci kez başlatılmasın
    let info = null
    try {
      info = await pool.getRoom(room.chain.roomId)
    } catch (err) {
      console.warn(`[${room.id}] zincir okunamadı:`, err.shortMessage ?? err.message)
    }
    if (room.status !== 'starting') return
    players = [...room.players.values()]
    const addresses = new Set(players.map((p) => p.address))
    if (!info || !info.startedAt || info.players.length !== players.length || !info.players.every((a) => addresses.has(a))) {
      room.status = 'lobby'
      console.warn(`[${room.id}] zincir odası #${room.chain.roomId} oyuncularla uyuşmuyor, başlatılmadı`)
      return
    }
  } else {
    const allReady = players.length >= MIN_PLAYERS && players.every((p) => p.ready)
    if (!allReady && players.length < MAX_PLAYERS) return
  }

  room.status = 'racing'
  room.autoStartAt = 0
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
  const paid = room.chain ? ` · ücretli oda #${room.chain.roomId}` : ''
  console.log(`[${room.id}] yarış başlıyor: ${players.map((p) => p.name).join(', ')} · seed ${room.seed.slice(0, 10)}…${paid}`)
  io.to(room.id).emit('start', { seed: room.seed, startAt: room.startAt })
  broadcastRoom(room)
}

// --- Yarış bitti mi? Herkes bitirdi ya da DNF → (imzala) → sonuçları gönder, odayı lobiye döndür ---
function maybeEnd(room) {
  if (room.status !== 'racing') return
  const players = [...room.players.values()]
  if (Date.now() - room.startAt > RACE_TIMEOUT_MS) {
    for (const p of players) if (p.status === 'racing') p.status = 'dnf'
  }
  if (players.some((p) => p.status === 'racing')) return
  room.status = 'ending' // imza beklenirken tick döngüsü tekrar girmesin
  endRace(room)
}

// Ödeme sıralaması: sunucunun sıralaması (bitirenler süreye göre, DNF'ler sonda) → adresler.
// Zincirdeki listede olup bizde olmayan (olmamalı ama) en sona eklenir: kontrat TAM liste ister
async function buildSettlement(room, standings) {
  const info = await pool.getRoom(room.chain.roomId)
  const ranked = standings.map((p) => p.address).filter((a) => a && info.players.includes(a))
  const ranking = [...new Set(ranked)]
  for (const a of info.players) if (!ranking.includes(a)) ranking.push(a)
  const signature = await pool.signRanking(room.chain.roomId, ranking)
  return { pool: pool.address, roomId: room.chain.roomId, entryFee: room.chain.entryFee, ranking, signature }
}

async function endRace(room) {
  const standings = rankPlayers(publicRoom(room).players)
  let settlement = null
  if (room.chain) {
    try {
      settlement = await buildSettlement(room, standings)
      console.log(`[${room.id}] sıralama imzalandı (oda #${settlement.roomId}): ${settlement.ranking.map((a) => a.slice(0, 8)).join(' > ')}`)
    } catch (err) {
      console.error(`[${room.id}] sıralama imzalanamadı:`, err.shortMessage ?? err.message)
    }
  }
  console.log(`[${room.id}] yarış bitti: ${standings.map((p, i) => `${i + 1}. ${p.name} (${p.status})`).join(', ')}`)
  io.to(room.id).emit('results', { standings, settlement })

  // Lobiye dön. Ücretli oda bir kez kullanılır: bir sonraki ücretli yarış yeni zincir odası açar
  room.status = 'lobby'
  room.chain = null
  room.creating = null
  room.autoStartAt = 0
  for (const p of [...room.players.values()]) {
    if (p.left) room.players.delete(p.id) // kopanlar sonuçta göründü, artık listeden çıkar
    p.status = 'lobby'
    p.state = null
    p.paid = false
    p.ready = false
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

  // address + proof: isteğe bağlı. proof = ownershipMessage(socket.id) metninin burner cüzdanla imzası.
  // Kanıt yoksa ücretsiz yarışabilir ama ücretli odaya ödeme yapamaz
  socket.on('join', ({ name, room: roomId, address, proof } = {}, ack = () => {}) => {
    if (typeof ack !== 'function') return
    if (room) return ack({ ok: false, error: 'Zaten bir odadasın' })
    const target = getRoom(cleanRoom(roomId))
    releaseExpiredChain(target)
    const capacity = target.chain?.maxPlayers ?? MAX_PLAYERS
    if (target.status !== 'lobby') return ack({ ok: false, error: 'Bu odada yarış sürüyor, biraz bekle' })
    if (target.players.size >= capacity) return ack({ ok: false, error: `Oda dolu (${capacity} kişi)` })

    let verified = null
    if (address) {
      if (!verifyOwnership(socket.id, address, proof)) return ack({ ok: false, error: 'Cüzdan kanıtı geçersiz' })
      verified = getAddress(address)
      // Bir cüzdan = bir koltuk (aynı burner'la iki sekme ücretli odada iki kez sayılmasın)
      if ([...target.players.values()].some((p) => p.address === verified)) {
        return ack({ ok: false, error: 'Bu cüzdan zaten odada (ikinci oyuncu için gizli pencere aç)' })
      }
    }

    room = target
    player = {
      id: socket.id,
      name: cleanName(name, 'Pilot', 16),
      color: freeColor(room),
      address: verified,
      paid: false,
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
    console.log(`[${room.id}] ${player.name} katıldı (${room.players.size}/${capacity})`)
    ack({ ok: true, you: { id: player.id, color: player.color }, room: publicRoom(room), poolEnabled: Boolean(pool) })
    broadcastRoom(room)
    maybeStart(room) // oda 5 kişiyle dolduysa beklemeden başla
  })

  socket.on('ready', (ready) => {
    if (!room || room.status !== 'lobby') return
    if (room.chain && !player.paid) return // ücretli odada önce ödeme
    player.ready = Boolean(ready)
    broadcastRoom(room)
    maybeStart(room)
  })

  // Ücretli oda: "ödemek istiyorum". Odanın zincir odası varsa numarasını döner;
  // yoksa bu oyuncuya kurma izni (kilit) verir → oyuncu createRoom + joinRoom gönderir
  socket.on('claimChainRoom', ({ maxPlayers } = {}, ack = () => {}) => {
    if (typeof ack !== 'function') return
    if (!pool) return ack({ ok: false, error: 'Sunucuda ücretli oda kapalı' })
    if (!room || room.status !== 'lobby') return ack({ ok: false, error: 'Lobide değilsin' })
    if (!player.address) return ack({ ok: false, error: 'Cüzdan adresi yok' })
    releaseExpiredChain(room)
    if (room.chain) return ack({ ok: true, roomId: room.chain.roomId, entryFee: room.chain.entryFee })

    const lock = room.creating
    if (lock && lock.playerId !== player.id && room.players.has(lock.playerId) && Date.now() - lock.at < CREATE_LOCK_MS) {
      return ack({ ok: false, error: 'Oda zincirde kuruluyor, birkaç saniye sonra tekrar dene' })
    }
    const size = Math.min(MAX_PLAYERS, Math.max(MIN_PLAYERS, room.players.size, Math.floor(Number(maxPlayers)) || MIN_PLAYERS))
    room.creating = { playerId: player.id, at: Date.now(), maxPlayers: size }
    broadcastRoom(room)
    ack({ ok: true, create: true, maxPlayers: size })
  })

  // "joinRoom'u yaptım": zincirden doğrula (getRoom), sonra ödendi say. Doğrulanmazsa hazır olamaz
  socket.on('chainJoined', async ({ roomId } = {}, ack = () => {}) => {
    if (typeof ack !== 'function') return
    if (!pool || !room || room.status !== 'lobby' || !player.address) return ack({ ok: false, error: 'Şu an ödeme kabul edilmiyor' })
    if (!/^\d{1,20}$/.test(String(roomId))) return ack({ ok: false, error: 'Geçersiz oda numarası' })
    const id = String(roomId)
    if (room.chain && room.chain.roomId !== id) return ack({ ok: false, error: `Bu odanın zincir odası #${room.chain.roomId}` })
    if (!room.chain && room.creating?.playerId !== player.id) return ack({ ok: false, error: 'Zincir odasını kurma sırası sende değil' })

    // RPC birkaç düğümden oluşabilir: yeni onaylanan ödemeyi ilk sorduğumuz düğüm henüz görmemiş olabilir → birkaç kez sor
    let info
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        info = await pool.getRoom(id)
      } catch (err) {
        if (attempt === 3) return ack({ ok: false, error: `Zincir okunamadı: ${err.shortMessage ?? err.message}` })
      }
      if (info?.players.includes(player.address)) break
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
    if (!room.players.has(socket.id) || room.status !== 'lobby') return ack({ ok: false, error: 'Odadan çıktın' })
    if (!info.createdAt) return ack({ ok: false, error: `Zincirde #${id} diye bir oda yok` })
    if (info.settled || info.startedAt && !info.players.includes(player.address)) return ack({ ok: false, error: 'Bu zincir odası kapanmış' })
    if (!info.players.includes(player.address)) {
      console.warn(`[${room.id}] ${player.name}: #${id} odasına ödeme zincirde yok → reddedildi`)
      return ack({ ok: false, error: 'Ödemen zincirde görünmüyor' })
    }

    if (!room.chain) {
      // Kurucu ilk ödemeyi yaptı: bu Socket.IO odası artık ücretli, boyutu zincirdeki oda kadar
      room.chain = { roomId: id, entryFee: info.entryFee.toString(), maxPlayers: info.maxPlayers, createdAt: info.createdAt }
      room.creating = null
      for (const p of room.players.values()) if (!p.paid) p.ready = false // ücretsiz "hazır"lar geçersiz
      console.log(`[${room.id}] ücretli oda: zincir odası #${id}, ${info.maxPlayers} kişilik`)
    }
    player.paid = true
    console.log(`[${room.id}] ${player.name} ödedi (zincirde doğrulandı)`)
    ack({ ok: true })
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

  // Bağlantı koptu: lobide listeden çık; yarıştaysa DNF say (sonuçta görünsün diye listede kalır).
  // Ücretli odada ödemiş biri lobide koparsa: aynı cüzdanla geri gelip "yatır ve katıl"a basınca
  // zincirde zaten ödediği görülür, yeniden ödemeden yerine döner
  socket.on('disconnect', () => {
    if (!room) return
    if (room.status === 'racing') {
      if (player.status === 'racing') player.status = 'dnf'
      player.left = true
      console.log(`[${room.id}] ${player.name} koptu → DNF`)
      broadcastRoom(room)
      maybeEnd(room)
    } else if (room.status === 'ending') {
      player.left = true // sonuç imzalanıyor: endRace listeden çıkaracak
    } else {
      room.players.delete(socket.id)
      if (room.creating?.playerId === socket.id) room.creating = null
      console.log(`[${room.id}] ${player.name} ayrıldı`)
      if (room.players.size === 0 && !room.chain) rooms.delete(room.id)
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
    if (room.status === 'lobby' && room.autoStartAt && now >= room.autoStartAt) maybeStart(room) // ücretli oda bekleme süresi doldu
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
