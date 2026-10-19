// Uçtan uca test (yerel zincir): iki oyuncu ücret yatırır, yarışır, kazanan imzalı sıralamayla ödülünü çeker.
// Gerekenler: anvil --chain-id 10143, deploy edilmiş RacePool, bu zincire bağlı sunucu.
// Çalıştır: SERVER_URL=http://localhost:3002 RPC_URL=http://127.0.0.1:8545 POOL_ADDRESS=0x... node server/e2e-pool.js
import { io } from 'socket.io-client'
import { JsonRpcProvider, Wallet, Contract, NonceManager, formatEther, parseEther } from 'ethers'
import { ownershipMessage, RACE_LENGTH, SEND_RATE } from '../shared/protocol.js'

const SERVER_URL = process.env.SERVER_URL ?? 'http://localhost:3002'
const provider = new JsonRpcProvider(process.env.RPC_URL ?? 'http://127.0.0.1:8545')
const POOL = process.env.POOL_ADDRESS
const ABI = [
  'function createRoom(uint256 entryFee, uint8 maxPlayers) returns (uint256)',
  'function joinRoom(uint256 roomId) payable',
  'function settle(uint256 roomId, address[] ranking, bytes signature)',
  'function withdraw()',
  'function claimable(address) view returns (uint256)',
  'function treasury() view returns (address)',
  'event RoomCreated(uint256 indexed roomId, address indexed creator, uint256 entryFee, uint8 maxPlayers)',
  'event Withdrawn(address indexed account, uint256 amount)',
]
// anvil'in herkese açık test anahtarları (sadece yerel zincir)
const KEYS = [
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
]

let failures = 0
const check = (ok, text) => {
  console.log(`${ok ? '✓' : '✗'} ${text}`)
  if (!ok) failures++
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function connect() {
  const socket = io(SERVER_URL, { reconnection: false })
  return new Promise((resolve) => socket.once('connect', () => resolve(socket)))
}

async function makePlayer(key, name, room) {
  const wallet = new Wallet(key, provider)
  const signer = new NonceManager(wallet)
  const socket = await connect()
  const proof = await wallet.signMessage(ownershipMessage(socket.id))
  const res = await socket.emitWithAck('join', { name, room, address: wallet.address, proof })
  return { name, wallet, socket, pool: new Contract(POOL, ABI, signer), res }
}

async function main() {
  const room = `e2e${Date.now() % 100000}`

  // --- Kimlik kontrolleri ---
  const a = await makePlayer(KEYS[0], 'Ayse', room)
  check(a.res.ok && a.res.poolEnabled, 'Ayşe odaya katıldı, sunucuda havuz açık')

  const fake = await connect()
  const bad = await fake.emitWithAck('join', { name: 'Sahte', room, address: a.wallet.address, proof: '0x1234' })
  check(!bad.ok && /kanıt/i.test(bad.error), `başkasının adresi kanıtsız reddedildi ("${bad.error}")`)
  fake.disconnect()

  const twin = await makePlayer(KEYS[0], 'Ikiz', room)
  check(!twin.res.ok && /zaten odada/.test(twin.res.error), `aynı cüzdan ikinci kez reddedildi ("${twin.res.error}")`)
  twin.socket.disconnect()

  // --- Ayşe 2 kişilik zincir odasını kurar ve öder ---
  const claim = await a.socket.emitWithAck('claimChainRoom', { maxPlayers: 2 })
  check(claim.ok && claim.create && claim.maxPlayers === 2, 'Ayşe kurma iznini aldı')
  const receipt = await (await a.pool.createRoom(parseEther('1'), 2)).wait()
  const roomId = a.pool.interface.parseLog(receipt.logs[0]).args.roomId.toString()
  await (await a.pool.joinRoom(roomId, { value: parseEther('1') })).wait()
  const aJoined = await a.socket.emitWithAck('chainJoined', { roomId })
  check(aJoined.ok, `Ayşe ödedi, sunucu zincirden doğruladı (oda #${roomId})`)

  // --- Bora ödemeden "ödedim" der → reddedilir; sonra gerçekten öder ---
  const b = await makePlayer(KEYS[1], 'Bora', room)
  check(b.res.ok, 'Bora odaya katıldı')
  b.socket.emit('ready', true) // ödemeden hazır olamaz: sunucu yok saymalı
  const liar = await b.socket.emitWithAck('chainJoined', { roomId })
  check(!liar.ok && /görünmüyor/.test(liar.error), `ödemeden "ödedim" reddedildi ("${liar.error}")`)
  const bClaim = await b.socket.emitWithAck('claimChainRoom', { maxPlayers: 5 })
  check(bClaim.ok && bClaim.roomId === roomId, 'Bora mevcut zincir odasının numarasını aldı')
  await (await b.pool.joinRoom(roomId, { value: parseEther('1') })).wait()
  const bJoined = await b.socket.emitWithAck('chainJoined', { roomId })
  check(bJoined.ok, 'Bora ödedi, doğrulandı')

  // --- Yarış: ikisi hazır → başlar. Ayşe 165 hızla bitirir, Bora 2. sn'de DNF ---
  const started = new Promise((resolve) => a.socket.once('start', resolve))
  const results = new Promise((resolve) => a.socket.once('results', resolve))
  a.socket.emit('ready', true)
  b.socket.emit('ready', true)
  const { startAt } = await started
  check(true, 'yarış başladı')
  const offset = 0 // aynı bilgisayar: saat farkı yok
  const drive = setInterval(() => {
    const t = (Date.now() + offset - startAt) / 1000
    if (t < 0) return
    const progress = Math.min(1, (165 * t) / RACE_LENGTH)
    a.socket.emit('state', { x: 0, y: 0, z: 0, rotation: [0, 0, 0, 1], speed: 165, progress, status: 'racing', t })
    if (progress >= 1) {
      clearInterval(drive)
      a.socket.emit('finish')
    }
  }, 1000 / SEND_RATE)
  setTimeout(() => b.socket.emit('dnf'), startAt - Date.now() + 2000)

  const { standings, settlement } = await results
  check(standings[0].name === 'Ayse' && standings[1].status === 'dnf', `sıralama: ${standings.map((p) => `${p.name}(${p.status})`).join(', ')}`)
  check(Boolean(settlement?.signature), 'sunucu sıralamayı imzaladı')
  check(settlement?.ranking[0] === a.wallet.address && settlement?.ranking[1] === b.wallet.address, 'imzalı sıralama: Ayşe > Bora (DNF sonda)')

  // --- Bora sıralamayı tersine çevirip aynı imzayla settle etmeye çalışır → reddedilir ---
  let rejected = false
  try {
    await b.pool.settle.staticCall(settlement.roomId, [b.wallet.address, a.wallet.address], settlement.signature)
  } catch (err) {
    rejected = /InvalidSignature|0x8baa579f/.test(err.message + (err.data ?? ''))
  }
  check(rejected, 'değiştirilmiş sıralama + gerçek imza reddedildi (InvalidSignature)')

  // --- Ayşe: settle + withdraw ---
  // Önceki koşulardan kalan alacaklar olabilir (aynı anvil): farklara bakıyoruz
  const treasury = await a.pool.treasury()
  const bBefore = await a.pool.claimable(b.wallet.address)
  const tBefore = await a.pool.claimable(treasury)
  const poolBefore = await provider.getBalance(POOL)
  const settleReceipt = await (await a.pool.settle(settlement.roomId, settlement.ranking, settlement.signature)).wait()
  const withdrawReceipt = await (await a.pool.withdraw()).wait()
  const withdrawn = a.pool.interface.parseLog(withdrawReceipt.logs[0]).args.amount
  check(withdrawn === parseEther('1.6'), `Ayşe çekti: ${formatEther(withdrawn)} MON (settle ${settleReceipt.gasUsed} gaz, withdraw ${withdrawReceipt.gasUsed} gaz)`)
  check(poolBefore - (await provider.getBalance(POOL)) === parseEther('1.6'), 'kontrattan sadece 1.6 MON çıktı')
  check((await a.pool.claimable(b.wallet.address)) - bBefore === parseEther('0.3'), 'Bora alacağı +0.3 MON (2. %15)')
  check((await a.pool.claimable(treasury)) - tBefore === parseEther('0.1'), 'treasury alacağı +0.1 MON (%5)')

  let twice = false
  try {
    await a.pool.settle.staticCall(settlement.roomId, settlement.ranking, settlement.signature)
  } catch {
    twice = true
  }
  check(twice, 'ikinci settle reddedildi')

  a.socket.disconnect()
  b.socket.disconnect()
  console.log(failures ? `\n${failures} kontrol BAŞARISIZ` : '\nHepsi geçti')
  process.exit(failures ? 1 : 0)
}

main().catch((err) => {
  console.error('HATA:', err)
  process.exit(1)
})
