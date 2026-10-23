// İzleyici bahsi (contracts/src/BetPool.sol). Sunucu operatördür (RESULT_SIGNER_KEY): bahsi açar, kazananı imzalayıp
// yazar, ödemeleri 50'şer kişilik partilerle gönderir. İşlemlerin gazı estimateGas + %15: sunucu iyimser akışta
// değil (oyundaki gibi "henüz işlenmedi" durumu yok), tahmin doğru çıkar; Monad ücreti limitten keser, fazlası boşa.
//
// Faucet (FAUCET_KEY): izleyicinin yeni burner'ına bir kez FAUCET_AMOUNT. Monad rezerv kuralı: 10 MON altındaki
// cüzdan son 3 blokta işlem gönderdiyse MON transferi geri çevrilir. 100 izleyici 30 sn'de gelince tek tek beklemek
// yetmez: istekleri biriktirip BetPool.airdrop ile tek işlemde 50 kişiye gönderiyoruz, işlemler arası 4 blok.
import { JsonRpcProvider, Wallet, Contract, NonceManager, AbiCoder, Interface, keccak256, getBytes, formatEther, ZeroAddress } from 'ethers'

const ABI = [
  'function openBets(uint256 roomId, uint64 deadline)',
  'function settleBets(uint256 roomId, address winner, bytes signature)',
  'function payout(uint256 roomId, uint256 start, uint256 count)',
  'function airdrop(address[] to) payable',
  'function getBook(uint256 roomId) view returns (uint64 deadline, bool settled, bool refundAll, address winner, uint256 betCount, address[] racers, uint32[] counts)',
  'function BET_AMOUNT() view returns (uint256)',
  'event BetPlaced(uint256 indexed roomId, address indexed bettor, address indexed racer)',
  'error BetsStillOpen(uint256 roomId)',
  'error AlreadySettled(uint256 roomId)',
  'error AlreadyOpen(uint256 roomId)',
]
const iface = new Interface(ABI)
const PAYOUT_BATCH = 50
const FAUCET_BATCH = 50
const FAUCET_GATHER_MS = 400 // ilk istekten sonra bu kadar bekle: aynı anda gelenler tek işleme binsin
const SAFE_GAP = 4 // blok (rezerv kuralı "son 3 blok")
const SUMMARY_TTL_MS = 1500 // /bets özeti için zincir en fazla bu sıklıkta okunur (RPC sınırı: 15 istek/sn)
// IP başına en fazla kaç cüzdan. Dikkat: salonda herkes aynı Wi-Fi'den (tek ortak IP) gelir → FAUCET_PER_IP'i
// yükselt (ör. 200); bütçe sınırı (FAUCET_BUDGET) yine korur
const MAX_IP_CLAIMS = Number(process.env.FAUCET_PER_IP) || 3
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export function createBetPool({ rpcUrl, address, signerKey, faucetKey, faucetAmount, faucetBudget }) {
  const provider = new JsonRpcProvider(rpcUrl, 10143, { staticNetwork: true, batchMaxCount: 1 })
  const signer = new Wallet(signerKey)
  // NonceManager: art arda işlemlerde (payout partileri) nonce'u kendisi sayar, RPC'yi beklemez
  const operator = new NonceManager(new Wallet(signerKey, provider))
  const reader = new Contract(address, ABI, provider)
  const writer = new Contract(address, ABI, operator)
  const faucetWallet = faucetKey ? new Wallet(faucetKey, provider) : null
  const faucetContract = faucetWallet ? new Contract(address, ABI, faucetWallet) : null

  async function send(contract, method, args, overrides = {}) {
    const gas = await contract[method].estimateGas(...args, overrides)
    const tx = await contract[method](...args, { ...overrides, gasLimit: (gas * 115n) / 100n })
    return tx.wait()
  }

  // --- Bahis turu ---
  // deadlineMs: sunucunun bettingEndsAt'i. Zincir saniye bilir: o saniyenin sonuna kadar açık
  const open = (roomId, deadlineMs) => send(writer, 'openBets', [roomId, Math.floor(deadlineMs / 1000)])

  // Kazananı imzala, yaz, sonra herkese partiler halinde öde. winner: kazanan adres ya da null (kimse bitiremedi → iade)
  async function settleAndPay(roomId, winner) {
    const who = winner ?? ZeroAddress
    const hash = keccak256(AbiCoder.defaultAbiCoder().encode(['string', 'uint256', 'address', 'uint256', 'address'], ['BET', 10143, address, roomId, who]))
    const signature = await signer.signMessage(getBytes(hash))
    // Sonuç ancak bahis süresi zincirde de geçince yazılabilir: blok zamanı birkaç saniye geride olabilir
    for (let attempt = 0; ; attempt++) {
      try {
        await send(writer, 'settleBets', [roomId, who, signature])
        break
      } catch (err) {
        if (err.revert?.name === 'AlreadySettled') break // önceki deneme zaten geçmiş
        if (attempt >= 5 || err.revert?.name !== 'BetsStillOpen') throw err
        await sleep(2000)
      }
    }
    const book = await reader.getBook(roomId)
    const total = Number(book.betCount)
    for (let start = 0; start < total; start += PAYOUT_BATCH) await send(writer, 'payout', [roomId, start, PAYOUT_BATCH])
    summaries.delete(String(roomId))
    return { total, refundAll: book.refundAll }
  }

  // --- /bets özeti (önbellekli) ---
  const summaries = new Map() // roomId → { at, promise }
  function summary(roomId) {
    const key = String(roomId)
    const cached = summaries.get(key)
    if (cached && Date.now() - cached.at < SUMMARY_TTL_MS) return cached.promise
    const promise = reader.getBook(roomId).then((b) => ({
      deadline: Number(b.deadline) * 1000, // ms
      settled: b.settled,
      refundAll: b.refundAll,
      winner: b.winner === ZeroAddress ? null : b.winner,
      betCount: Number(b.betCount),
      racers: [...b.racers],
      counts: [...b.counts].map(Number),
    }))
    summaries.set(key, { at: Date.now(), promise })
    promise.catch(() => summaries.delete(key)) // hata önbellekte kalmasın
    return promise
  }

  // İzleyici "bahsim zincirde, X ms sürdü" dedi: gerçekten bu odaya bir BetPlaced var mı (sahte sayı şişirmesin)
  async function verifyBet(hash, roomId) {
    const receipt = await provider.getTransactionReceipt(hash)
    if (!receipt || receipt.status !== 1 || receipt.to?.toLowerCase() !== address.toLowerCase()) return false
    return receipt.logs.some((log) => {
      const parsed = iface.parseLog({ topics: log.topics, data: log.data })
      return parsed?.name === 'BetPlaced' && parsed.args.roomId === BigInt(roomId)
    })
  }

  // --- Faucet ---
  const funded = new Set() // bir kez aldı (ya da sırada)
  const perIp = new Map() // ip → kaç cüzdan
  const queue = []
  let given = 0n // bütçeden ayrılan (sırada olanlar dahil)
  let draining = false
  let lastBlock = 0
  let gatherTimer = null

  async function requestFaucet(addr, ip) {
    if (!faucetContract) return { ok: false, status: 503, error: 'Faucet kapalı (sunucuda FAUCET_KEY yok)' }
    if (funded.has(addr)) return { ok: true, already: true } // ikinci kez gelirse: zaten yolda / aldı
    if ((perIp.get(ip) ?? 0) >= MAX_IP_CLAIMS) return { ok: false, status: 429, error: `Bu ağdan en fazla ${MAX_IP_CLAIMS} cüzdan` }
    if (given + faucetAmount > faucetBudget) return { ok: false, status: 503, error: 'Faucet bütçesi doldu' }
    // Yeri BEKLEMEDEN önce ayır: aynı anda gelen 4 istek bakiye sorgusunu beklerken sayacı birlikte okuyup
    // hepsi "yer var" sanmasın (yarış durumu). Bakiye zaten yetiyorsa ayrılanı geri bırak
    funded.add(addr)
    perIp.set(ip, (perIp.get(ip) ?? 0) + 1)
    given += faucetAmount
    const release = () => {
      funded.delete(addr)
      perIp.set(ip, Math.max(0, perIp.get(ip) - 1))
      given -= faucetAmount
    }
    const balance = await provider.getBalance(addr).catch(() => null)
    if (balance === null || balance >= faucetAmount) {
      release()
      return balance === null ? { ok: false, status: 502, error: 'Zincire ulaşılamadı' } : { ok: true, enough: true } // yeterliyse bütçe harcanmasın
    }
    queue.push({ addr, ip })
    gatherTimer ??= setTimeout(() => {
      gatherTimer = null
      drain()
    }, FAUCET_GATHER_MS)
    return { ok: true, queued: queue.length }
  }

  async function drain() {
    if (draining) return
    draining = true
    try {
      while (queue.length) {
        while ((await provider.getBlockNumber()) < lastBlock + SAFE_GAP) await sleep(250) // rezerv kuralı
        const batch = queue.splice(0, FAUCET_BATCH)
        try {
          const receipt = await send(faucetContract, 'airdrop', [batch.map((b) => b.addr)], { value: faucetAmount * BigInt(batch.length) })
          lastBlock = receipt.blockNumber
          console.log(`🚰 faucet: ${batch.length} cüzdana ${formatEther(faucetAmount)} MON (bütçeden kalan ${formatEther(faucetBudget - given)})`)
        } catch (err) {
          // Gönderilemedi: bu kişiler tekrar isteyebilsin, bütçe geri
          for (const b of batch) {
            funded.delete(b.addr)
            perIp.set(b.ip, Math.max(0, (perIp.get(b.ip) ?? 1) - 1))
            given -= faucetAmount
          }
          console.warn('faucet gönderilemedi:', err.shortMessage ?? err.message)
          await sleep(2000)
        }
      }
    } finally {
      draining = false
    }
  }

  return {
    address,
    operatorAddress: signer.address,
    faucetAddress: faucetWallet?.address ?? null,
    open,
    settleAndPay,
    summary,
    verifyBet,
    requestFaucet,
    faucetStats: () => ({ given, budget: faucetBudget, amount: faucetAmount, wallets: funded.size }),
  }
}
