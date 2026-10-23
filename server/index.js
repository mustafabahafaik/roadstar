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
import { getAddress, parseEther } from 'ethers'
import {
  RACE_LENGTH,
  MAX_PLAYERS,
  MIN_PLAYERS,
  COUNTDOWN_MS,
  BETTING_MS,
  TICK_RATE,
  RACE_TIMEOUT_MS, // 5 dakikada bitiremeyen DNF sayılır
  MAX_TRACK_SPEED,
  PLAYER_COLORS,
  BET_AMOUNT,
  FAUCET_AMOUNT,
  rankPlayers,
} from '../shared/protocol.js'
import { createPool, verifyOwnership } from './pool.js'
import { createBotManager } from './bots.js'
import { createBetPool } from './betpool.js'
import { sanitizeLoadout } from '../src/parts.js'
import { isMapId, DEFAULT_MAP } from '../src/maps.js'

// server/.env → process.env (RESULT_SIGNER_KEY, POOL_ADDRESS...). Dosya yoksa ücretli oda kapalı çalışır
try {
  process.loadEnvFile(fileURLToPath(new URL('.env', import.meta.url)))
} catch {
  // .env yok: sorun değil
}

const PORT = Number(process.env.PORT) || 3001
// Hangi sitelerden bağlanılabilir (CORS). İnternete yüklerken oyunun adresini yaz: CLIENT_ORIGIN=https://...
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN?.split(',').map((o) => o.trim().replace(/\/$/, '')) ?? '*' // sondaki / ve boşluklar: panelde sık yapılan hata
const CREATE_LOCK_MS = 60 * 1000 // zincir odasını kuran oyuncuya ayrılan süre
const FULL_ROOM_GRACE_MS = 15 * 1000 // ücretli oda zincirde dolunca, hazır olmayan varsa en geç bu sürede başla
const POOL_JOIN_WINDOW_S = 10 * 60 // RacePool.JOIN_WINDOW ile aynı: bu sürede dolmayan zincir odasına giriş kapanır
const BOT_FILL_MS = 20 * 1000 // AUTO_BOTS açıksa: oda açıldıktan sonra bu sürede dolmazsa boş koltuklara bot
// Otomatik bot doldurma ve "oda 5'e dolunca hazır olmayan varsa da başla" varsayılan KAPALI: yarış herkes
// hazır deyince başlar, host isterse lobide botları kendisi çağırır. Eski davranış: AUTO_BOTS=1
const AUTO_BOTS = process.env.AUTO_BOTS === '1'
const BETTING_DURATION_MS = Number(process.env.BETTING_MS) || BETTING_MS // testte kısaltmak için: BETTING_MS=3000

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

// --- İzleyici bahsi (BetPool). Bahis sadece ücretli odada: yarışçılar RacePool odasından okunur ---
const betPool =
  process.env.BET_POOL_ADDRESS && /^0x[0-9a-fA-F]{64}$/.test(process.env.RESULT_SIGNER_KEY ?? '')
    ? createBetPool({
        rpcUrl: process.env.RPC_URL || 'https://testnet-rpc.monad.xyz',
        address: process.env.BET_POOL_ADDRESS,
        signerKey: process.env.RESULT_SIGNER_KEY,
        faucetKey: /^0x[0-9a-fA-F]{64}$/.test(process.env.FAUCET_KEY ?? '') ? process.env.FAUCET_KEY : null,
        faucetAmount: process.env.FAUCET_AMOUNT ? parseEther(process.env.FAUCET_AMOUNT) : FAUCET_AMOUNT,
        faucetBudget: parseEther(process.env.FAUCET_BUDGET || '3'),
      })
    : null
if (betPool) {
  console.log(`BetPool ${betPool.address} · operatör ${betPool.operatorAddress} · faucet ${betPool.faucetAddress ?? 'KAPALI (FAUCET_KEY yok)'}`)
  if (!pool) console.warn('⚠️  BetPool var ama RacePool yok: bahis sadece ücretli odada açılır')
} else {
  console.log('BetPool ayarlı değil (BET_POOL_ADDRESS + RESULT_SIGNER_KEY): izleyici bahsi kapalı')
}

// --- Botlar (BOT_KEYS): boş koltukları doldurur. Ücretli modda kendi cüzdanlarıyla gerçekten öderler ---
const botKeys = (process.env.BOT_KEYS ?? '')
  .split(',')
  .map((k) => k.trim())
  .filter((k) => /^0x[0-9a-fA-F]{64}$/.test(k))
const bots = botKeys.length
  ? createBotManager({
      keys: botKeys,
      serverUrl: `http://localhost:${PORT}`,
      rpcUrl: process.env.RPC_URL || 'https://testnet-rpc.monad.xyz',
      poolAddress: pool?.address,
      // Ücretli yarış başına bot en kötü ~0.09 MON harcar: 0.05 giriş + joinRoom, settle, withdraw gazı
      // (limit × ~102 gwei). 0.3 ≈ 3 yarış: altına düşünce uyar (scripts/budget.js ile de bakılır)
      lowBalance: parseEther(process.env.BOT_LOW_BALANCE || '0.3'),
    })
  : null
if (bots) bots.checkBalances()
else console.log('BOT_KEYS yok: boş koltuklar botla dolmaz (node scripts/make-bots.js)')

// --- Bahis turu: bahis başlayınca aç, yarış bitince kazananı yaz ve öde ---
function openBetRound(room) {
  if (!betPool || !room.chain) return // ücretsiz oda: bahis yok (yarışçılar RacePool odasından okunur)
  const round = {
    chainRoomId: room.chain.roomId,
    bettingEndsAt: room.bettingEndsAt,
    racers: [...room.players.values()].filter((p) => !p.left).map((p) => ({ id: p.id, name: p.name, color: p.color, address: p.address })),
    winner: null,
    settledAt: 0,
    confirms: new Map(),
  }
  betRounds.set(room.id, round)
  betPool
    .open(round.chainRoomId, round.bettingEndsAt)
    .then(() => console.log(`[${room.id}] 🎲 bahis açık: oda #${round.chainRoomId}, ${round.racers.length} yarışçı`))
    .catch((err) => console.warn(`[${room.id}] bahis açılamadı:`, err.shortMessage ?? err.message))
}

function settleBetRound(room, standings) {
  const round = betRounds.get(room.id)
  if (!betPool || !round || round.settledAt || round.chainRoomId !== room.chain?.roomId) return
  const first = standings[0]
  round.winner = first?.status === 'finished' ? first.address : null // kimse bitiremediyse herkese iade
  round.settledAt = Date.now()
  betPool
    .settleAndPay(round.chainRoomId, round.winner)
    .then(({ total, refundAll }) => console.log(`[${room.id}] 🎲 bahis sonuçlandı: ${total} bahis${refundAll ? ' (herkese iade)' : ''}, ödemeler gönderildi`))
    .catch((err) => console.warn(`[${room.id}] bahis sonuçlanamadı:`, err.shortMessage ?? err.message))
}

// GET /bets/:room → izleyici sayfası ve ana ekran (2 sn'de bir sorar). Zincir okuması önbellekli (betpool.js)
async function betsView(roomName) {
  const room = rooms.get(roomName)
  const round = betRounds.get(roomName)
  const base = { room: roomName, now: Date.now(), betAmount: BET_AMOUNT.toString(), raceStatus: room?.status ?? 'none' }
  if (!betPool || !round) {
    // Henüz tur yok: lobideki yarışçıları göster (bahis herkes hazır olunca açılacak)
    const racers = room ? [...room.players.values()].map((p) => ({ id: p.id, name: p.name, color: p.color, address: p.address })) : []
    // disabled: sunucuda bahis yok · free: ücretsiz oda (bahis ücretli odada) · waiting: herkes hazır olunca açılacak
    return { ...base, status: !betPool ? 'disabled' : room?.chain ? 'waiting' : 'free', racers, bettingEndsAt: room?.bettingEndsAt ?? 0 }
  }
  const book = await betPool.summary(round.chainRoomId)
  const live = new Map(room ? [...room.players.values()].map((p) => [p.id, p]) : [])
  const total = book.betCount
  const racers = round.racers.map((r) => {
    const i = book.racers.findIndex((a) => a.toLowerCase() === r.address?.toLowerCase())
    const bets = i >= 0 ? book.counts[i] : 0
    const p = live.get(r.id)
    // index: kontrattaki sırası (pickOf bunu döndürür: sayfa yenilenince "kime yatırmıştım?")
    return { ...r, index: i, bets, odds: bets ? total / bets : null, progress: p?.last.progress ?? 0, status: p?.status ?? 'left', finishMs: p?.finishMs ?? null }
  })
  const winnerCount = book.winner ? racers.find((r) => r.address === book.winner)?.bets ?? 0 : 0
  const times = [...round.confirms.values()]
  return {
    ...base,
    status: book.settled ? 'settled' : book.deadline === 0 ? 'opening' : Date.now() <= book.deadline + 999 ? 'open' : 'closed',
    chainRoomId: String(round.chainRoomId),
    bettingEndsAt: round.bettingEndsAt,
    racers,
    totalBets: total,
    pool: (BET_AMOUNT * BigInt(total)).toString(),
    winner: book.winner,
    refundAll: book.refundAll,
    payoutPerWinner: book.settled ? (book.refundAll ? BET_AMOUNT : winnerCount ? (BET_AMOUNT * BigInt(total)) / BigInt(winnerCount) : 0n).toString() : null,
    txCount: total, // her bahis bir işlem
    avgConfirmMs: times.length ? Math.round(times.reduce((a, b) => a + b, 0) / times.length) : null,
  }
}

// CORS: tarayıcı başka adresten (Vercel) gelen istekte izin ister. Sadece oyunun adresi(leri)
function cors(req, res) {
  const origin = req.headers.origin
  const allowed = CLIENT_ORIGIN === '*' ? '*' : CLIENT_ORIGIN.includes(origin) ? origin : null
  if (allowed) res.setHeader('access-control-allow-origin', allowed)
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS')
  res.setHeader('access-control-allow-headers', 'content-type')
}
function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
      if (raw.length > 2048) reject(new Error('çok büyük')) // küçük istekler bekliyoruz
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(raw || '{}'))
      } catch {
        reject(new Error('JSON değil'))
      }
    })
  })
}
// Render gibi bir proxy'nin arkasında gerçek IP x-forwarded-for'un ilk elemanı
const clientIp = (req) => String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() || req.socket.remoteAddress

async function handleHttp(req, res) {
  cors(req, res)
  if (req.method === 'OPTIONS') return res.writeHead(204).end()
  const url = new URL(req.url, 'http://x')
  const bets = url.pathname.match(/^\/bets\/([a-z0-9-]{1,20})(\/confirm)?$/)

  if (req.method === 'GET' && bets && !bets[2]) return json(res, 200, await betsView(bets[1]))

  // İzleyici "bahsim zincirde, şu kadar ms" der → doğrulayıp ortalama onay süresine kat
  if (req.method === 'POST' && bets?.[2]) {
    const round = betRounds.get(bets[1])
    const { hash, ms } = await readJson(req)
    if (!round || !/^0x[0-9a-fA-F]{64}$/.test(hash ?? '') || !isNum(ms)) return json(res, 400, { ok: false })
    if (!round.confirms.has(hash) && (await betPool.verifyBet(hash, round.chainRoomId))) {
      round.confirms.set(hash, Math.min(Math.max(ms, 0), 60000))
    }
    return json(res, 200, { ok: true })
  }

  // Faucet: yeni izleyicinin burner'ına bir kez FAUCET_AMOUNT (adres başına bir, IP başına en fazla 3, bütçe kadar)
  if (req.method === 'POST' && url.pathname === '/faucet') {
    if (!betPool) return json(res, 503, { ok: false, error: 'Bahis kapalı' })
    const { address } = await readJson(req)
    let addr
    try {
      addr = getAddress(String(address ?? '').trim().toLowerCase())
    } catch {
      return json(res, 400, { ok: false, error: 'Geçersiz adres' })
    }
    const result = await betPool.requestFaucet(addr, clientIp(req))
    return json(res, result.status ?? 200, result)
  }

  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
  res.end('ROADSTAR sunucusu çalışıyor\n') // tarayıcıdan açınca "çalışıyor mu?" kontrolü
}

const httpServer = createServer((req, res) =>
  handleHttp(req, res).catch((err) => {
    console.warn('HTTP hatası:', err.shortMessage ?? err.message)
    if (!res.headersSent) json(res, 500, { ok: false, error: 'Sunucu hatası' })
  }),
)
const io = new Server(httpServer, { cors: { origin: CLIENT_ORIGIN } })

// --- Odalar ---
// Durum makinesi: lobby ──herkes hazır──▶ betting (30 sn) ──bettingEndsAt──▶ racing (3 sn geri sayım + yarış)
//                  ──herkes bitirdi / DNF──▶ ending (sonuç imzası) ──▶ lobby   ('starting': ücretli oda zincirde doğrulanıyor)
// room: { id, status: 'lobby' | 'starting' | 'betting' | 'racing' | 'ending', seed, startAt, bettingEndsAt,
//         hostId (odayı açan insan: botları o çağırır), players: Map<socketId, player>,
//         chain: null | { roomId, entryFee, maxPlayers }  (bağlı RacePool odası),
//         creating: null | { playerId, at, maxPlayers },  (zincir odasını kuran oyuncunun kilidi)
//         autoStartAt: 0 }  (ücretli oda dolunca en geç başlama anı)
// player: { id, name, color, address, paid, ready, status, state, last, finishMs, left, rejected, lastCheatLog }
const rooms = new Map()
// Bahis turları oda adıyla (oda silinse de izleyici sonucu görebilsin):
// { chainRoomId, bettingEndsAt, racers: [{ id, name, color, address }], winner, settledAt, confirms: Map<hash, ms> }
const betRounds = new Map()

const cleanName = (text, fallback, max) => String(text ?? '').trim().slice(0, max) || fallback
const cleanRoom = (text) =>
  String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '')
    .slice(0, 20) || 'monad'

function getRoom(id) {
  if (!rooms.has(id)) {
    rooms.set(id, { id, status: 'lobby', seed: null, startAt: 0, bettingEndsAt: 0, hostId: null, players: new Map(), chain: null, creating: null, autoStartAt: 0, botFillAt: 0, map: null })
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
  room.botFillAt = 0
  for (const p of [...room.players.values()]) {
    if (p.left) room.players.delete(p.id) // koltuğu tutulan kopmuş oyuncu: oda artık ücretsiz, gerek yok
    p.paid = false
    p.ready = false
  }
  broadcastRoom(room)
}

// Bot geri sayımını başlat (lobide görünür). Ücretli modda zincir odası bağlanınca, ücretsiz modda ilk insan girince
function startBotTimer(room) {
  if (!AUTO_BOTS || !bots || room.botFillAt || room.status !== 'lobby') return
  room.botFillAt = Date.now() + BOT_FILL_MS
  console.log(`[${room.id}] ${BOT_FILL_MS / 1000} sn içinde dolmazsa boş koltuklar botla dolacak`)
}

// Boş koltuk sayısı kadar bot gönder (oda boyutu: zincir odası ya da 5). Host'un düğmesi ya da AUTO_BOTS süresi
function fillWithBots(room) {
  room.botFillAt = 0
  const capacity = room.chain?.maxPlayers ?? MAX_PLAYERS
  const empty = capacity - room.players.size
  const hasHuman = [...room.players.values()].some((p) => !p.bot)
  if (empty > 0 && hasHuman) {
    bots.fill(room.id, empty, BigInt(room.chain?.entryFee ?? 0)).then((sent) => console.log(`[${room.id}] ${sent} bot geliyor (${empty} boş koltuk)`))
  }
  broadcastRoom(room)
}

// Odadaki herkese gönderilen özet (lobi listesi, sıralama). Sadece paylaşılabilir alanlar
function publicRoom(room) {
  return {
    id: room.id,
    status: room.status,
    map: room.map, // odanın haritası (maps.js): ilk giren seçer
    chain: room.chain,
    creating: Boolean(room.creating),
    autoStartAt: room.autoStartAt,
    botFillAt: room.botFillAt, // lobide geri sayım (0 = yok)
    bettingEndsAt: room.bettingEndsAt, // bahis kapanış anı (sunucu saati, ms; 0 = bahis yok)
    hostId: room.hostId, // "Boş koltukları botla doldur" düğmesini bu oyuncu görür
    botsAvailable: Boolean(bots), // sunucuda bot cüzdanı var mı
    players: [...room.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      bot: p.bot,
      color: p.color,
      address: p.address,
      loadout: p.loadout, // garaj parçaları (sadece görsel): rakipler arabayı bununla çizer
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

// --- Bahsi başlat (yarış bahisten sonra) ---
// Ücretsiz oda: odadaki HERKES hazır (en az 2 kişi). AUTO_BOTS=1 ise eski kural da geçerli: oda doldu (5).
// Ücretli oda: herkes ödedi (zincirde oda doldu) ve hazır; hazır olmayan varsa FULL_ROOM_GRACE_MS sonra yine başlar.
// Bu istisna bilerek duruyor: zincirde dolan odanın parası kilitli, iade ancak 1 gün sonra; hazır demeyen biri
// herkesin parasını bir gün kilitlemesin
async function maybeStart(room) {
  if (room.status !== 'lobby') return
  let players = [...room.players.values()]

  if (room.chain) {
    const full = players.length === room.chain.maxPlayers && players.every((p) => p.paid)
    if (!full) {
      room.autoStartAt = 0
      return
    }
    const allReady = players.every((p) => p.ready || p.left)
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
    if (!allReady && !(AUTO_BOTS && players.length >= MAX_PLAYERS)) return
  }
  startBetting(room)
}

// Herkes hazır: bahis açılır. Kapanış anı sunucunun saatiyle tek bir sayı (herkesin ekranında aynı geri sayım,
// bahis sunucusu da bu anda kapatır). Bakım döngüsü bu ana gelince startRace'i çağırır
function startBetting(room) {
  room.status = 'betting'
  room.autoStartAt = 0
  room.botFillAt = 0
  room.bettingEndsAt = Date.now() + BETTING_DURATION_MS
  const names = [...room.players.values()].filter((p) => !p.left).map((p) => p.name)
  console.log(`[${room.id}] herkes hazır → ${BETTING_DURATION_MS / 1000} sn bahis: ${names.join(', ')}`)
  openBetRound(room)
  io.to(room.id).emit('betting', { bettingEndsAt: room.bettingEndsAt })
  broadcastRoom(room)
}

// Bahis bitti: seed, başlangıç anı ve 3 sn geri sayım. Bahiste kopan ücretsiz oyuncu zaten odadan çıktı (koltuk
// boş kalır); ücretli odada kopanın koltuğu tutulur ve yarışa DNF başlar
function startRace(room) {
  const players = [...room.players.values()]
  room.status = 'racing'
  room.bettingEndsAt = 0
  room.autoStartAt = 0
  room.botFillAt = 0
  room.seed = '0x' + randomBytes(32).toString('hex') // herkes bu seed'den AYNI parkuru üretir
  // "Şimdi başla" demiyoruz: mesaj herkese farklı gecikmeyle varır. Gelecekte bir AN veriyoruz;
  // her oyuncu bu anı kendi saatine çevirip (saat farkı: ping/pong) aynı anda başlar
  room.startAt = Date.now() + COUNTDOWN_MS
  for (const p of players) {
    p.status = p.left ? 'dnf' : 'racing' // ödeyip lobide kopan: yarışa DNF başlar (koltuğu zincirde dolu)
    p.ready = false
    p.lastSentAt = 0
    p.last = { progress: 0, time: room.startAt }
    p.finishMs = null
  }
  const paid = room.chain ? ` · ücretli oda #${room.chain.roomId}` : ''
  console.log(`[${room.id}] yarış başlıyor: ${players.map((p) => p.name).join(', ')} · ${room.map} · seed ${room.seed.slice(0, 10)}…${paid}`)
  // Seed + harita birlikte: herkes aynı parkuru aynı haritada (gökyüzü, yerçekimi, engel görünüşü) kurar
  io.to(room.id).emit('start', { seed: room.seed, startAt: room.startAt, map: room.map })
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
  settleBetRound(room, standings)

  // Lobiye dön. Ücretli oda bir kez kullanılır: bir sonraki ücretli yarış yeni zincir odası açar
  room.status = 'lobby'
  room.chain = null
  room.creating = null
  room.autoStartAt = 0
  room.botFillAt = 0
  for (const p of [...room.players.values()]) {
    if (p.left) room.players.delete(p.id) // kopanlar sonuçta göründü, artık listeden çıkar
    p.status = 'lobby'
    p.lastSentAt = 0
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
  // botToken: sadece sunucunun kendi botları bilir (bots.js). Lobide "BOT" rozeti buna göre
  // loadout: garaj parçaları. Sadece görsel olduğu için sahiplik zincirden doğrulanmıyor; katalogda olmayan
  // ya da yanlış slottaki id varsayılana döner (sanitizeLoadout). Hız / çarpışma hesabı parçalara hiç bakmaz
  // map: oyuncunun giriş sayfasında seçtiği harita. Oda BOŞSA odanın haritası olur; doluysa odanınki geçerli
  socket.on('join', ({ name, room: roomId, address, proof, botToken, loadout, map } = {}, ack = () => {}) => {
    if (typeof ack !== 'function') return
    if (room) return ack({ ok: false, error: 'Zaten bir odadasın' })
    const target = getRoom(cleanRoom(roomId))
    releaseExpiredChain(target)
    if (target.status !== 'lobby') return ack({ ok: false, error: target.status === 'betting' ? 'Bu odada bahis başladı, yarıştan sonra gel' : 'Bu odada yarış sürüyor, biraz bekle' })

    let verified = null
    if (address) {
      if (!verifyOwnership(socket.id, address, proof)) return ack({ ok: false, error: 'Cüzdan kanıtı geçersiz' })
      verified = getAddress(address)
      const same = [...target.players.values()].find((p) => p.address === verified)
      // Ödeyip lobide kopan oyuncu geri döndü: tutulan koltuğunu devralır ("yatır"a basınca yeniden ödemez)
      if (same?.left) target.players.delete(same.id)
      // Bir cüzdan = bir koltuk (aynı burner'la iki sekme ücretli odada iki kez sayılmasın)
      else if (same) return ack({ ok: false, error: 'Bu cüzdan zaten odada (ikinci oyuncu için gizli pencere aç)' })
    }
    const capacity = target.chain?.maxPlayers ?? MAX_PLAYERS
    if (target.players.size >= capacity) return ack({ ok: false, error: `Oda dolu (${capacity} kişi)` })

    const isBot = Boolean(bots) && botToken === bots.token
    // İnsan "BOT" diye başlayan bir ad seçemez (bot taklidi yapmasın)
    const cleanedName = cleanName(name, 'Pilot', 16)
    const safeName = isBot ? cleanedName : cleanName(cleanedName.replace(/^\s*bot(\W+|$)/i, ''), 'Pilot', 16)

    room = target
    if (!room.map || room.players.size === 0) room.map = isMapId(map) ? map : DEFAULT_MAP
    player = {
      id: socket.id,
      name: safeName,
      bot: isBot,
      loadout: sanitizeLoadout(loadout),
      color: freeColor(room),
      address: verified,
      paid: false,
      ready: false,
      status: 'lobby',
      lastSentAt: 0, // son iletilen durumun sentAt'ı (alıcıya zaman hep ileri aksın)
      last: { progress: 0, time: 0 },
      finishMs: null,
      left: false,
      rejected: 0, // reddedilen güncelleme sayısı
      lastCheatLog: 0,
    }
    room.players.set(socket.id, player)
    if (!isBot && !room.players.has(room.hostId)) room.hostId = socket.id // odayı açan (ya da host gittiyse ilk gelen) insan
    socket.join(room.id) // Socket.IO odası: io.to(room.id) bu odadaki herkese gönderir
    console.log(`[${room.id}] ${player.name} katıldı (${room.players.size}/${capacity})`)
    if (!pool && !isBot) startBotTimer(room) // ücretsiz mod: ilk insan girince geri sayım
    ack({ ok: true, you: { id: player.id, color: player.color }, room: publicRoom(room), poolEnabled: Boolean(pool) })
    broadcastRoom(room)
    maybeStart(room) // oda 5 kişiyle dolduysa beklemeden başla
  })

  // Host'un "Boş koltukları botla doldur" düğmesi: arkadaşlardan biri gelmezse. AUTO_BOTS kapalıyken botları sadece
  // o çağırır. Botlar hazır gelir; insanların hepsi de hazırsa bahis başlar
  socket.on('fillBots', (ack) => {
    if (typeof ack !== 'function') return
    if (!room || room.status !== 'lobby') return ack({ ok: false, error: 'Bahis ya da yarış başladı' })
    if (room.hostId !== socket.id) return ack({ ok: false, error: 'Botları sadece odayı açan çağırabilir' })
    if (!bots) return ack({ ok: false, error: 'Sunucuda bot cüzdanı yok (BOT_KEYS)' })
    const empty = (room.chain?.maxPlayers ?? MAX_PLAYERS) - room.players.size
    if (empty <= 0) return ack({ ok: false, error: 'Boş koltuk yok' })
    console.log(`[${room.id}] host ${player.name} boş koltukları botla dolduruyor`)
    fillWithBots(room)
    ack({ ok: true, empty })
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
      startBotTimer(room) // ücretli mod: oda zincirde açıldı → 20 sn geri sayım
    }
    player.paid = true
    console.log(`[${room.id}] ${player.name} ödedi (zincirde doğrulandı)`)
    ack({ ok: true })
    broadcastRoom(room)
    maybeStart(room)
  })

  // Oyuncunun durumu (saniyede 20 kez). Kontrol edip BEKLETMEDEN odadaki diğerlerine iletiriz.
  // Eskiden 15 Hz'lik ayrı bir döngü toplu yayıyordu: iki saat senkron olmadığı için bazı durumlar
  // eziliyor, 130+ ms boşluk oluşuyordu; üstelik her durum döngüyü beklerken 0–66 ms daha eskiyordu
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

    // sentAt: oyuncunun ortak saatle gönderdiği an (alıcı interpolasyonu buna göre yapar). Sadece ÇİZİM için:
    // hile kontrolü yukarıda bizim saatimizle yapıldı. Saçma bir değer (saat bozuk, hile) gelirse aldığımız an
    let sentAt = isNum(s.sentAt) && s.sentAt > now - 1000 && s.sentAt < now + 250 ? Math.round(s.sentAt) : now
    if (sentAt <= player.lastSentAt) sentAt = player.lastSentAt + 1 // zaman geriye gitmesin (saat yeniden eşitlenince)
    player.lastSentAt = sentAt
    // Sadece doğrulanmış alanlar (istemcinin nesnesini olduğu gibi yaymıyoruz). u / off / h: pist üzerindeki
    // konum, alıcının tahmini için. Eski sürüm göndermezse alıcı düz çizgide tahmin eder
    const peer = { id: player.id, sentAt, x: s.x, y: s.y, z: s.z, rotation: s.rotation.slice(0, 4), speed: s.speed, progress }
    if ([s.u, s.off, s.h].every(isNum)) Object.assign(peer, { u: s.u, off: s.off, h: s.h })
    // volatile: alıcının bağlantısı o an meşgulse bu paketi at (50 ms sonra yenisi gelecek, eskisi işe yaramaz)
    socket.to(room.id).volatile.emit('peer', peer)
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

  // Oyuncu "Yarıştan çık" dedi. Düşmek DNF DEĞİL: istemci düşünce bunu göndermez, pistin gerisinde yeniden
  // doğar ve yarışmaya devam eder (sıralamada ilerlemesiyle yer alır)
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
    } else if (room.chain && player.paid) {
      // Zincirde ödedi: koltuğu tutulur. Oda dolarsa yarış onsuz başlar (DNF) ve para yine dağıtılabilir;
      // silseydik oda bir daha "dolu" olmaz, zincirde başlamış odanın parası 1 gün kilitli kalırdı
      player.left = true
      player.ready = false
      console.log(`[${room.id}] ${player.name} koptu (ödemiş: koltuğu tutuluyor)`)
      broadcastRoom(room)
      maybeStart(room)
    } else {
      room.players.delete(socket.id)
      if (room.creating?.playerId === socket.id) room.creating = null
      if (room.hostId === socket.id) room.hostId = [...room.players.values()].find((p) => !p.bot)?.id ?? null // host gitti: sıradaki insan
      console.log(`[${room.id}] ${player.name} ${room.status === 'betting' ? 'bahis sırasında koptu (koltuk boş kalır)' : 'ayrıldı'}`)
      if (room.players.size === 0 && !room.chain) rooms.delete(room.id)
      else {
        broadcastRoom(room)
        maybeStart(room) // kalanların hepsi hazırsa başlasın
      }
    }
  })
})

// --- Bakım döngüsü: lobi zamanlayıcıları, botlar, yarış zaman aşımı. Durum yaymaz ('state' anında iletir) ---
setInterval(() => {
  const now = Date.now()
  for (const room of rooms.values()) {
    if (room.status === 'lobby' && room.autoStartAt && now >= room.autoStartAt) maybeStart(room) // ücretli oda bekleme süresi doldu
    if (room.status === 'lobby' && room.botFillAt && now >= room.botFillAt) fillWithBots(room)
    if (room.status === 'lobby' && room.chain) releaseExpiredChain(room)
    if (room.status === 'lobby' && room.players.size === 0 && !room.chain) rooms.delete(room.id)
    if (room.status === 'betting' && room.players.size === 0) {
      rooms.delete(room.id) // bahiste herkes koptu
      continue
    }
    if (room.status === 'betting' && now >= room.bettingEndsAt) startRace(room) // bahis kapandı: 3 sn geri sayım
    if (room.status !== 'racing') continue
    maybeEnd(room) // zaman aşımı kontrolü
  }
}, 1000 / TICK_RATE)

httpServer.listen(PORT, () => console.log(`ROADSTAR sunucusu: http://localhost:${PORT}`))
