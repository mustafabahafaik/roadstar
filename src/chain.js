import { JsonRpcProvider, Wallet, Interface, keccak256, formatEther } from 'ethers'

// --- Ağ ve kontrat ---
export const MONAD_TESTNET = {
  chainId: 10143,
  rpcUrl: 'https://testnet-rpc.monad.xyz',
  explorer: 'https://testnet.monadexplorer.com',
  faucet: 'https://faucet.monad.xyz',
}
// contracts/ içinde deploy edince çıkan adres. Boşken oyun zincirsiz çalışır
export const RACE_ITEMS_ADDRESS = '0x312Bce31256FC237DFAb4B289879942D17456Efd'

// Kontratın sadece kullandığımız fonksiyonları (insan okunur ABI)
const raceItems = new Interface([
  'function joinRoom(uint256 roomId)',
  'function collect(uint256 roomId, uint256 index)',
  'function useSkill(uint256 roomId, uint8 itemType)',
])

// Gaz limitleri: ölçülen değer + taban ücret (21k) + pay. Monad ücreti limit üzerinden keser → dar tut.
// estimateGas kullanmıyoruz: hem fazladan RPC (gecikme) hem de iyimser akışta yanlış sonuç verir
// (ör. collect henüz işlenmeden useSkill tahmini "token yok" der)
const GAS_LIMITS = { joinRoom: 80000n, collect: 120000n, useSkill: 75000n }
const RECEIPT_POLL_MS = 150 // onayı kaç ms'de bir soralım (ölçüm hassasiyeti)
const FEE_REFRESH_MS = 20000 // gas fiyatını ne sıklıkla güncelleyelim
const BALANCE_REFRESH_MS = 8000

// --- Burner cüzdan ---
// ⚠️ SADECE TESTNET: özel anahtar tarayıcının localStorage'ında ŞİFRESİZ durur.
// Aynı bilgisayardaki herhangi bir kod onu okuyabilir. Buraya asla gerçek değeri olan para koyma.
const BURNER_STORAGE_KEY = 'monad-racer:testnet-burner-key'

function loadBurnerWallet() {
  let saved = null
  try {
    saved = localStorage.getItem(BURNER_STORAGE_KEY)
  } catch {
    // gizli pencere vb.: localStorage yoksa her açılışta yeni cüzdan
  }
  if (saved) return new Wallet(saved)
  const wallet = Wallet.createRandom()
  try {
    localStorage.setItem(BURNER_STORAGE_KEY, wallet.privateKey)
  } catch {
    // kaydedilemedi: bu oturumluk cüzdan
  }
  return new Wallet(wallet.privateKey)
}

const shortError = (err) => {
  const text = err?.info?.error?.message || err?.shortMessage || err?.message || String(err)
  return text.replace(/^.*?:\s*/, '').slice(0, 60)
}

// onChange: işlem listesi / bakiye değişince çağrılır (HUD'u güncellemek için)
export function createChain(onChange = () => {}) {
  const enabled = RACE_ITEMS_ADDRESS !== ''
  // staticNetwork: ağı her seferinde sormasın (chainId sabit) → daha az RPC çağrısı
  const provider = new JsonRpcProvider(MONAD_TESTNET.rpcUrl, MONAD_TESTNET.chainId, { staticNetwork: true })
  const wallet = loadBurnerWallet()

  const txs = [] // tüm işlemler: { id, label, status, hash, ms, error }
  const pending = new Map() // hash → { tx, startedAt }
  let nextNonce = null // bir sonraki işlemin sıra numarası (kendimiz takip ediyoruz)
  let fees = null // { maxFeePerGas, maxPriorityFeePerGas }
  let balance = null // wei (BigInt)
  let reserved = 0n // gönderilmiş ama henüz onaylanmamış işlemlerin en kötü durum ücreti (bakiyeden ayrılan)
  let polling = false // onay sorgusu sürüyor mu (üst üste binmesin)
  let lastError = null

  async function refreshFees() {
    const data = await provider.getFeeData()
    fees = { maxFeePerGas: data.maxFeePerGas, maxPriorityFeePerGas: data.maxPriorityFeePerGas }
  }

  async function refreshBalance() {
    balance = await provider.getBalance(wallet.address)
    onChange()
  }

  // Başlangıç: nonce, ücret ve bakiyeyi BİR KEZ sor. Sonra nonce'u kendimiz artırırız
  const ready = (async () => {
    try {
      const [nonce] = await Promise.all([provider.getTransactionCount(wallet.address, 'pending'), refreshFees(), refreshBalance()])
      nextNonce = nonce
    } catch (err) {
      lastError = shortError(err)
      onChange()
      throw err
    }
  })()
  ready.catch(() => {}) // hata HUD'da gösteriliyor, oyun devam etsin

  setInterval(() => refreshFees().catch(() => {}), FEE_REFRESH_MS)
  setInterval(() => refreshBalance().catch(() => {}), BALANCE_REFRESH_MS)

  // Onay takibi: bekleyen her işlemin makbuzunu (receipt) kısa aralıklarla sor.
  // Aynı anda yapılan çağrıları ethers tek bir toplu (batch) RPC isteğinde birleştirir
  setInterval(async () => {
    if (polling || pending.size === 0) return // önceki sorgu bitmeden yenisini başlatma
    polling = true
    const checks = [...pending].map(([hash, p]) =>
      provider
        .send('eth_getTransactionReceipt', [hash])
        .then((receipt) => {
          if (!receipt || !pending.has(hash)) return
          pending.delete(hash)
          reserved -= p.cost
          p.tx.ms = Math.round(performance.now() - p.startedAt)
          p.tx.status = receipt.status === '0x1' ? 'confirmed' : 'reverted'
          if (p.tx.status === 'reverted') p.tx.error = 'revert'
          onChange()
        })
        .catch(() => {}), // geçici ağ hatası: bir sonraki turda tekrar sorulur
    )
    await Promise.all(checks)
    polling = false
  }, RECEIPT_POLL_MS)

  // İşlem gönder. Beklemez: hemen döner, sonuç onChange ile HUD'a yansır (iyimser arayüz)
  function send(method, args, label) {
    const tx = { id: txs.length, label, status: 'pending', hash: null, ms: null, error: null }
    txs.push(tx)
    onChange()
    if (!enabled) {
      tx.status = 'skipped'
      tx.error = 'kontrat adresi yok'
      onChange()
      return tx
    }

    ready
      .then(async () => {
        const gasLimit = GAS_LIMITS[method]
        const worstCaseCost = gasLimit * fees.maxFeePerGas
        // Bakiye yetmiyorsa hiç gönderme: gönderip reddedilirse nonce sırasında boşluk kalır
        if (balance - reserved < worstCaseCost) {
          tx.status = 'skipped'
          tx.error = 'bakiye yetersiz (faucet)'
          onChange()
          return
        }
        reserved += worstCaseCost

        const nonce = nextNonce++ // senkron: art arda gelen çağrılar sırayla 0, 1, 2... alır
        const signed = await wallet.signTransaction({
          type: 2, // EIP-1559 işlem
          chainId: MONAD_TESTNET.chainId,
          to: RACE_ITEMS_ADDRESS,
          data: raceItems.encodeFunctionData(method, args),
          nonce,
          gasLimit,
          maxFeePerGas: fees.maxFeePerGas,
          maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
        })
        tx.hash = keccak256(signed) // hash'i imzalı veriden kendimiz hesaplıyoruz (RPC'yi beklemeden)

        const startedAt = performance.now() // onay süresi buradan başlar
        try {
          await provider.send('eth_sendRawTransaction', [signed])
          pending.set(tx.hash, { tx, startedAt, cost: worstCaseCost })
        } catch (err) {
          tx.status = 'error'
          tx.error = shortError(err)
          reserved -= worstCaseCost
          // Bu nonce kullanılmadı: zincire tekrar sor ki sonraki işlemler boşluğu doldursun
          provider
            .getTransactionCount(wallet.address, 'pending')
            .then((n) => (nextNonce = n))
            .catch(() => {})
        }
        onChange()
      })
      .catch((err) => {
        tx.status = 'error'
        tx.error = shortError(err)
        onChange()
      })
    return tx
  }

  // Sunum metrikleri
  function stats() {
    const confirmed = txs.filter((t) => t.status === 'confirmed')
    const times = confirmed.map((t) => t.ms)
    const sent = txs.filter((t) => t.hash && t.status !== 'error').length
    return {
      sent,
      confirmed: confirmed.length,
      failed: txs.filter((t) => t.status === 'error' || t.status === 'reverted').length,
      skipped: txs.filter((t) => t.status === 'skipped').length,
      pending: pending.size,
      avgMs: times.length ? Math.round(times.reduce((a, b) => a + b, 0) / times.length) : null,
      minMs: times.length ? Math.min(...times) : null,
      maxMs: times.length ? Math.max(...times) : null,
    }
  }

  return {
    enabled,
    address: wallet.address,
    txs,
    send,
    stats,
    get balance() {
      return balance === null ? null : Number(formatEther(balance))
    },
    get lastError() {
      return lastError
    },
  }
}
