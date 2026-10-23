// Uçtan uca bahis testi (yerel zincir): iki yarışçı ücretli odayı doldurur, herkes hazır → bahis açılır,
// izleyiciler faucet'ten MON alıp bahis yapar, yarış biter, sunucu kazananı yazıp öder.
// Gerekenler: anvil --chain-id 10143 --block-time 1 (faucet blok bekler; 1 sn: zincir saati gerçek saatle aynı aksın), deploy edilmiş RacePool + BetPool,
// bu zincire bağlı sunucu (RESULT_SIGNER_KEY, FAUCET_KEY; bahis süresi varsayılan 30 sn: faucet + bahisler sığsın).
// Çalıştır: SERVER_URL=http://localhost:3002 RPC_URL=http://127.0.0.1:8545 POOL_ADDRESS=0x.. BET_POOL_ADDRESS=0x.. node server/e2e-bets.js
import { io } from 'socket.io-client'
import { JsonRpcProvider, Wallet, Contract, NonceManager, formatEther, parseEther } from 'ethers'
import { ownershipMessage, RACE_LENGTH, SEND_RATE, BET_AMOUNT, FAUCET_AMOUNT, BET_GAS_LIMITS } from '../shared/protocol.js'

const SERVER_URL = process.env.SERVER_URL ?? 'http://localhost:3002'
const provider = new JsonRpcProvider(process.env.RPC_URL ?? 'http://127.0.0.1:8545', 10143, { cacheTimeout: -1 })
const POOL = process.env.POOL_ADDRESS
const BETS = process.env.BET_POOL_ADDRESS
const POOL_ABI = ['function createRoom(uint256 entryFee, uint8 maxPlayers) returns (uint256)', 'function joinRoom(uint256 roomId) payable', 'event RoomCreated(uint256 indexed roomId, address indexed creator, uint256 entryFee, uint8 maxPlayers)']
const BET_ABI = [
  'function placeBet(uint256 roomId, address racer) payable',
  'error AlreadyBet(uint256 roomId, address bettor)',
  'error BetsNotOpen(uint256 roomId)',
  'error BetsClosed(uint256 roomId)',
  'error WrongAmount(uint256 sent, uint256 expected)',
  'error NotARacer(address racer)',
]
// anvil'in herkese açık test anahtarları (sadece yerel zincir)
const KEYS = ['0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d', '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a']
const ENTRY = parseEther('0.05')

let failures = 0
const check = (ok, text) => {
  console.log(`${ok ? '✓' : '✗'} ${text}`)
  if (!ok) failures++
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const get = (path) => fetch(SERVER_URL + path).then((r) => r.json())
const post = (path, body) => fetch(SERVER_URL + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, ...(await r.json()) }))
async function until(fn, ms = 20000, what = '') {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > end) throw new Error(`zaman aşımı: ${what}`)
    await sleep(300)
  }
}

async function makeRacer(key, name, room) {
  const wallet = new Wallet(key, provider)
  const socket = io(SERVER_URL, { reconnection: false })
  await new Promise((r) => socket.once('connect', r))
  const proof = await wallet.signMessage(ownershipMessage(socket.id))
  const res = await socket.emitWithAck('join', { name, room, address: wallet.address, proof })
  return { name, wallet, socket, pool: new Contract(POOL, POOL_ABI, new NonceManager(wallet)), res }
}

async function main() {
  const room = `bets${Date.now() % 100000}`

  // --- Yarışçılar 2 kişilik ücretli odayı doldurur ---
  const a = await makeRacer(KEYS[0], 'Ayse', room)
  const b = await makeRacer(KEYS[1], 'Bora', room)
  check(a.res.ok && b.res.ok, 'iki yarışçı odada')
  const free = await get(`/bets/${room}`)
  check(free.status === 'free', `zincir odası yokken bahis yok ("${free.status}")`)
  await a.socket.emitWithAck('claimChainRoom', { maxPlayers: 2 })
  const receipt = await (await a.pool.createRoom(ENTRY, 2)).wait()
  const roomId = a.pool.interface.parseLog(receipt.logs[0]).args.roomId.toString()
  await (await a.pool.joinRoom(roomId, { value: ENTRY })).wait()
  await a.socket.emitWithAck('chainJoined', { roomId })
  await b.socket.emitWithAck('claimChainRoom', { maxPlayers: 5 })
  await (await b.pool.joinRoom(roomId, { value: ENTRY })).wait()
  check((await b.socket.emitWithAck('chainJoined', { roomId })).ok, `ikisi de ödedi (oda #${roomId})`)
  check((await get(`/bets/${room}`)).status === 'waiting', 'ücretli oda: bahis "herkes hazır olunca" açılacak')

  // --- Herkes hazır → bahis açılır (sunucu openBets gönderir) ---
  const started = new Promise((r) => a.socket.once('start', r))
  const results = new Promise((r) => a.socket.once('results', r))
  a.socket.emit('ready', true)
  b.socket.emit('ready', true)
  const open = await until(async () => {
    const d = await get(`/bets/${room}`)
    return d.status === 'open' && d
  }, 15000, 'bahis açılmadı')
  check(open.racers.length === 2 && open.chainRoomId === roomId, `bahis açık: ${open.racers.map((r) => r.name).join(', ')}, ${Math.round((open.bettingEndsAt - open.now) / 1000)} sn`)

  // --- İzleyiciler: faucet (aynı IP'den en fazla 3) ---
  const fans = Array.from({ length: 4 }, () => Wallet.createRandom().connect(provider))
  const faucet = await Promise.all(fans.map((f) => post('/faucet', { address: f.address })))
  check(faucet.slice(0, 3).every((r) => r.ok), '3 izleyici faucet sırasına girdi')
  check(faucet[3].status === 429, `4. cüzdan aynı IP'den reddedildi ("${faucet[3].error}")`)
  check((await post('/faucet', { address: fans[0].address })).already, 'aynı adres ikinci kez: zaten verildi')
  await provider.send('anvil_setBalance', [fans[3].address, '0x' + FAUCET_AMOUNT.toString(16)]) // 4.'sü başka ağdan gelmiş gibi
  await until(async () => (await Promise.all(fans.map((f) => provider.getBalance(f.address)))).every((x) => x >= FAUCET_AMOUNT), 20000, 'faucet MON gelmedi')
  check(true, `faucet: ${formatEther(FAUCET_AMOUNT)} MON 3 cüzdana tek airdrop'la geldi`)

  // --- Bahisler: Ayşe'ye 3, Bora'ya 1 (tarayıcıdaki limitle: 0.025 MON'a sığmalı) ---
  const fee = await provider.getFeeData()
  const block = await provider.getBlock('latest')
  const txOpts = { value: BET_AMOUNT, gasLimit: BET_GAS_LIMITS.placeBet, maxFeePerGas: (block.baseFeePerGas * 11n) / 10n + fee.maxPriorityFeePerGas, maxPriorityFeePerGas: fee.maxPriorityFeePerGas }
  const picks = [a, a, b, a]
  for (let i = 0; i < fans.length; i++) {
    const t0 = performance.now()
    const bets = new Contract(BETS, BET_ABI, fans[i])
    await bets.placeBet.staticCall(roomId, picks[i].wallet.address, txOpts).catch((err) => {
      throw new Error(`placeBet reddedilirdi: ${err.revert ? `${err.revert.name}(${err.revert.args.join(', ')})` : err.shortMessage}`)
    })
    const tx = await bets.placeBet(roomId, picks[i].wallet.address, txOpts)
    await tx.wait()
    await post(`/bets/${room}/confirm`, { hash: tx.hash, ms: Math.round(performance.now() - t0) })
  }
  let twice = false
  try {
    await new Contract(BETS, BET_ABI, fans[0]).placeBet.staticCall(roomId, b.wallet.address, txOpts)
  } catch (err) {
    twice = err.revert?.name === 'AlreadyBet'
  }
  check(twice, 'aynı izleyicinin ikinci bahsi reddedildi (AlreadyBet)')
  const counted = await until(async () => {
    const d = await get(`/bets/${room}`)
    return d.totalBets === 4 && d
  }, 5000, 'bahis sayısı')
  const ra = counted.racers.find((r) => r.name === 'Ayse')
  const rb = counted.racers.find((r) => r.name === 'Bora')
  check(ra.bets === 3 && rb.bets === 1, `/bets: Ayşe ${ra.bets} (${ra.odds.toFixed(2)}x), Bora ${rb.bets} (${rb.odds.toFixed(2)}x), havuz ${formatEther(counted.pool)} MON`)
  check(Math.abs(ra.odds - 4 / 3) < 1e-9 && rb.odds === 4, 'oranlar parimutuel: havuz / kazanana yatırılan')
  check(counted.avgConfirmMs !== null && counted.txCount === 4, `ortalama onay ${counted.avgConfirmMs} ms, ${counted.txCount} işlem`)

  // --- Yarış: Ayşe 165 hızla bitirir, Bora DNF ---
  const { startAt } = await started
  check(startAt - open.bettingEndsAt >= 2900 && startAt - open.bettingEndsAt < 3300, 'bahis bitince 3 sn geri sayım ve yarış')
  const before = await Promise.all(fans.map((f) => provider.getBalance(f.address)))
  const drive = setInterval(() => {
    const t = (Date.now() - startAt) / 1000
    if (t < 0) return
    const progress = Math.min(1, (165 * t) / RACE_LENGTH)
    a.socket.emit('state', { x: 0, y: 0, z: 0, rotation: [0, 0, 0, 1], speed: 165, progress, status: 'racing', t, sentAt: Date.now() })
    if (progress >= 1) {
      clearInterval(drive)
      a.socket.emit('finish')
    }
  }, 1000 / SEND_RATE)
  setTimeout(() => b.socket.emit('dnf'), startAt - Date.now() + 2000)
  const { standings } = await results
  check(standings[0].name === 'Ayse', 'Ayşe kazandı')

  // --- Sunucu kazananı yazar ve öder ---
  const settled = await until(async () => {
    const d = await get(`/bets/${room}`)
    return d.status === 'settled' && d
  }, 30000, 'bahis sonuçlanmadı')
  const share = (BET_AMOUNT * 4n) / 3n
  check(settled.winner === a.wallet.address && settled.payoutPerWinner === share.toString(), `sonuç: kazanan Ayşe, kişi başı ${formatEther(share)} MON`)
  const after = await until(async () => {
    const now = await Promise.all(fans.map((f) => provider.getBalance(f.address)))
    return now.every((x, i) => (picks[i] === a ? x - before[i] === share : x === before[i])) && now
  }, 20000, 'ödemeler gelmedi')
  check(Boolean(after), `ödeme: Ayşe'ye yatıran 3 kişi +${formatEther(share)} MON, Bora'ya yatıran 0`)

  for (const r of [a, b]) r.socket.disconnect()
  console.log(failures ? `\n${failures} kontrol KALDI` : '\nHepsi geçti')
  process.exit(failures ? 1 : 0)
}

main().catch((err) => {
  console.error('✗', err.message)
  process.exit(1)
})
