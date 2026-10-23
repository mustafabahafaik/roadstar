// Bot yöneticisi: server/.env'deki BOT_KEYS cüzdanlarını tutar, boş koltuklara bot gönderir,
// bakiyeleri izler, yarış olmadan ayrılan botun parasını süre dolunca iade alır.
import { randomBytes } from 'node:crypto'
import { JsonRpcProvider, Wallet, Contract, formatEther } from 'ethers'
import { POOL_GAS_LIMITS } from '../shared/protocol.js'
import { createBotPilot } from './botPilot.js'

export const BOT_NAMES = ['nova', 'zeta', 'volt', 'kuzgun', 'neon', 'turbo', 'pulsar', 'atlas'] // scripts/budget.js de kullanır
const FAUCET = 'https://faucet.monad.xyz'
const REFUND_AFTER_MS = (10 * 60 + 15) * 1000 // RacePool.JOIN_WINDOW (10 dk) + blok zamanı payı
const REFUND_RETRIES = 3

export function createBotManager({ keys, serverUrl, rpcUrl, poolAddress, lowBalance }) {
  // Sunucu botları bu gizli anahtarla tanır: insan adını "BOT·x" yapsa da bot sayılmaz
  const token = randomBytes(16).toString('hex')
  const provider = new JsonRpcProvider(rpcUrl)
  const bots = keys.map((key, i) => ({ key, name: `BOT·${BOT_NAMES[i % BOT_NAMES.length]}`, address: new Wallet(key).address, busy: false }))

  async function checkBalance(bot) {
    try {
      const balance = await provider.getBalance(bot.address)
      if (balance < lowBalance) {
        console.warn(`⚠️  ${bot.name} bakiyesi düşük: ${formatEther(balance)} MON (${bot.address}) → ${FAUCET}`)
      }
      return balance
    } catch {
      return null // RPC geçici hata: bir dahaki kontrolde
    }
  }

  async function checkBalances() {
    const lines = await Promise.all(
      bots.map(async (b) => {
        const balance = await checkBalance(b)
        return `${b.name} ${b.address} ${balance === null ? '?' : formatEther(balance)} MON`
      }),
    )
    console.log(`${bots.length} bot cüzdanı:\n  ${lines.join('\n  ')}`)
  }

  // Yarış olmadan ayrıldıysa (oda dolmadı / insan kaçtı): 10 dk sonra refund dene
  function scheduleRefund(bot, roomId, attempt = 1) {
    if (!poolAddress) return
    setTimeout(
      async () => {
        const pool = new Contract(poolAddress, ['function refund(uint256 roomId)'], new Wallet(bot.key, provider))
        try {
          await (await pool.refund(roomId, { gasLimit: POOL_GAS_LIMITS.refund })).wait()
          console.log(`${bot.name}: zincir odası #${roomId} ücreti iade alındı`)
        } catch (err) {
          // Oda bu arada dolup başladıysa iade yok (ve gerek yok); değilse biraz sonra tekrar dene
          if (attempt < REFUND_RETRIES) scheduleRefund(bot, roomId, attempt + 1)
          else console.warn(`${bot.name}: #${roomId} iadesi alınamadı (${err.shortMessage ?? err.message})`)
        }
      },
      attempt === 1 ? REFUND_AFTER_MS : 60 * 1000,
    )
  }

  // roomId odasına en fazla count bot gönder. entryFee (wei): ücretli odada bakiyesi ücret + gaza
  // yetmeyen bot gönderilmez (gelip ödeyemeyen bot koltuğu boşuna tutmasın). Gönderilen sayıyı döner
  async function fill(roomId, count, entryFee = 0n) {
    let free = bots.filter((b) => !b.busy)
    if (entryFee > 0n) {
      const feeData = await provider.getFeeData().catch(() => null)
      const gas = POOL_GAS_LIMITS.joinRoom * (feeData?.maxFeePerGas ?? feeData?.gasPrice ?? 0n)
      const balances = await Promise.all(free.map((b) => provider.getBalance(b.address).catch(() => 0n)))
      free = free.filter((b, i) => {
        if (balances[i] >= entryFee + gas) return true
        console.warn(`⚠️  ${b.name} gönderilmedi: bakiye ${formatEther(balances[i])} MON, giriş ${formatEther(entryFee)} MON + gaz (${b.address}) → ${FAUCET}`)
        return false
      })
    }
    free = free.filter((b) => !b.busy).slice(0, count) // await sırasında başka odaya gitmiş olabilir
    if (free.length < count) console.warn(`[${roomId}] ${count} bot gerekiyordu, gönderilebilen ${free.length}`)
    for (const bot of free) {
      bot.busy = true
      createBotPilot({
        serverUrl,
        room: roomId,
        name: bot.name,
        key: bot.key,
        provider,
        poolAddress,
        botToken: token,
        log: (text) => console.log(`[${roomId}] ${text}`),
        onDone: ({ paidRoomId }) => {
          bot.busy = false
          if (paidRoomId) scheduleRefund(bot, paidRoomId)
          checkBalance(bot) // her yarıştan sonra: azaldıysa uyar
        },
      })
    }
    return free.length
  }

  return { token, fill, checkBalances, count: bots.length }
}
