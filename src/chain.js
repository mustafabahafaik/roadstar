import { JsonRpcProvider, Wallet, Interface, keccak256, formatEther } from 'ethers'
import { RACE_GAS_LIMITS, POOL_GAS_LIMITS, GARAGE_GAS_LIMITS, ENTRY_FEE } from '../shared/protocol.js'

// --- Ağ ve kontrat ---
export const MONAD_TESTNET = {
  chainId: 10143,
  // VITE_RPC_URL: sadece yerel deneme için (anvil --chain-id 10143). Normalde Monad testnet
  rpcUrl: import.meta.env.VITE_RPC_URL || 'https://testnet-rpc.monad.xyz',
  explorer: 'https://testnet.monadexplorer.com',
  faucet: 'https://faucet.monad.xyz',
}
// contracts/ içinde deploy edince çıkan Race adresi. Boşken oyun zincirsiz çalışır
export const RACE_ADDRESS = import.meta.env.VITE_RACE_ADDRESS || '0x7cBF7eAbB758CD0DBEAd1DFa9Adc8FA9A6e6f434'
// RacePool (giriş ücreti havuzu) adresi. Boşken ücretli oda kapalı. server/.env'deki POOL_ADDRESS ile AYNI olmalı
export const POOL_ADDRESS = import.meta.env.VITE_POOL_ADDRESS || '' // deploy edince adresi '' içine yapıştır
export { ENTRY_FEE } // odayı kuranın seçtiği giriş ücreti: 0.05 MON (shared/protocol.js; lobby.js buradan alır)

// GarageParts (görsel araba parçaları, ERC1155) adresi. Boşken garaj sadece önizleme yapar
export const GARAGE_ADDRESS = import.meta.env.VITE_GARAGE_ADDRESS || '' // deploy edince adresi '' içine yapıştır

export const explorerTx = (hash) => `${MONAD_TESTNET.explorer}/tx/${hash}`

// Race kontratının sadece kullandığımız fonksiyonları ve olayı (insan okunur ABI)
const raceAbi = new Interface([
  'function startRace() returns (uint256 raceId)',
  'function collect(uint256 raceId, uint256 index)',
  'function useSkill(uint256 raceId, uint8 itemType)',
  'function finishRace(uint256 raceId)',
  'event RaceStarted(uint256 indexed raceId, address indexed player, bytes32 seed)',
])

// RacePool: oda, ücret, imzalı sıralama, ödül çekme
const poolAbi = new Interface([
  'function createRoom(uint256 entryFee, uint8 maxPlayers) returns (uint256 roomId)',
  'function joinRoom(uint256 roomId) payable',
  'function settle(uint256 roomId, address[] ranking, bytes signature)',
  'function withdraw()',
  'function getRoom(uint256 roomId) view returns (uint256 entryFee, uint8 maxPlayers, uint64 createdAt, uint64 startedAt, bool settled, address[] players)',
  'function claimable(address account) view returns (uint256)',
  'event RoomCreated(uint256 indexed roomId, address indexed creator, uint256 entryFee, uint8 maxPlayers)',
])

// GarageParts: parça satın al, tak, loadout oku
const garageAbi = new Interface([
  'function buy(uint256 id) payable',
  'function equip(uint256 id)',
  'function loadoutOf(address player) view returns (uint256[5] ids)',
  'function balanceOfBatch(address[] accounts, uint256[] ids) view returns (uint256[])',
])

// Her işlem hangi kontrata gider
const CONTRACTS = {
  race: { address: RACE_ADDRESS, abi: raceAbi },
  pool: { address: POOL_ADDRESS, abi: poolAbi },
  garage: { address: GARAGE_ADDRESS, abi: garageAbi },
}
const POOL_METHODS = new Set(['createRoom', 'joinRoom', 'settle', 'withdraw'])
const GARAGE_METHODS = new Set(['buy', 'equip'])
const contractFor = (method) => CONTRACTS[POOL_METHODS.has(method) ? 'pool' : GARAGE_METHODS.has(method) ? 'garage' : 'race']

// startRace makbuzundaki RaceStarted olayından yarış numarasını ve tohumu oku
export function parseRaceStarted(receipt) {
  for (const log of receipt.logs) {
    const parsed = raceAbi.parseLog({ topics: log.topics, data: log.data })
    if (parsed?.name === 'RaceStarted') return { raceId: parsed.args.raceId, seed: parsed.args.seed }
  }
  throw new Error('RaceStarted olayı bulunamadı')
}

// createRoom makbuzundaki RoomCreated olayından zincir oda numarası
export function parseRoomCreated(receipt) {
  for (const log of receipt.logs) {
    const parsed = poolAbi.parseLog({ topics: log.topics, data: log.data })
    if (parsed?.name === 'RoomCreated') return parsed.args.roomId
  }
  throw new Error('RoomCreated olayı bulunamadı')
}

// Gaz limitleri: ölçülen değer + taban ücret (21k) + pay. Monad ücreti limit üzerinden keser → dar tut.
// Gaz limitleri shared/protocol.js'te (botlar ve betikler de kullanır; ölçüm: scripts/gas-measure.js)
const GAS_LIMITS = { ...RACE_GAS_LIMITS, ...POOL_GAS_LIMITS, ...GARAGE_GAS_LIMITS }
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
  const enabled = RACE_ADDRESS !== ''
  const poolEnabled = POOL_ADDRESS !== ''
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
          settle(p.tx, receipt)
          onChange()
        })
        .catch(() => {}), // geçici ağ hatası: bir sonraki turda tekrar sorulur
    )
    await Promise.all(checks)
    polling = false
  }, RECEIPT_POLL_MS)

  // İşlemin sonucunu bekleyenlere haber ver: onaylandıysa makbuzla çöz, değilse hatayla reddet
  function settle(tx, receipt) {
    if (tx.status === 'confirmed') tx.resolve(receipt)
    else tx.reject(new Error(tx.error || tx.status))
  }

  // İşlem gönder. Beklemez: hemen döner, sonuç onChange ile HUD'a yansır (iyimser arayüz).
  // Sonucu bekleyen olursa (ör. startRace'in tohumu) tx.confirmation sözünü (Promise) await edebilir.
  // value: işlemle birlikte gönderilen para (wei, BigInt) — joinRoom'un giriş ücreti
  function send(method, args, label, { value = 0n } = {}) {
    const tx = { id: txs.length, label, status: 'pending', hash: null, ms: null, error: null }
    tx.confirmation = new Promise((resolve, reject) => Object.assign(tx, { resolve, reject }))
    tx.confirmation.catch(() => {}) // bekleyen yoksa "yakalanmamış hata" uyarısı çıkmasın
    txs.push(tx)
    onChange()
    const target = contractFor(method)
    if (!target.address) {
      tx.status = 'skipped'
      tx.error = 'kontrat adresi yok'
      settle(tx)
      onChange()
      return tx
    }

    ready
      .then(async () => {
        const gasLimit = GAS_LIMITS[method]
        const worstCaseCost = gasLimit * fees.maxFeePerGas + value // gaz + yatırılan para
        // Bakiye yetmiyorsa hiç gönderme: gönderip reddedilirse nonce sırasında boşluk kalır
        if (balance - reserved < worstCaseCost) {
          tx.status = 'skipped'
          tx.error = 'bakiye yetersiz (faucet)'
          settle(tx)
          onChange()
          return
        }
        reserved += worstCaseCost

        const nonce = nextNonce++ // senkron: art arda gelen çağrılar sırayla 0, 1, 2... alır
        const signed = await wallet.signTransaction({
          type: 2, // EIP-1559 işlem
          chainId: MONAD_TESTNET.chainId,
          to: target.address,
          data: target.abi.encodeFunctionData(method, args),
          value,
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
          settle(tx)
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
        settle(tx)
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

  // Kontrattan okuma (işlem değil, ücretsiz): eth_call ile fonksiyonu çalıştırıp sonucu çöz
  async function read({ address, abi }, method, args) {
    const result = await provider.call({ to: address, data: abi.encodeFunctionData(method, args) })
    return abi.decodeFunctionResult(method, result)
  }
  const readPool = (method, args) => read(CONTRACTS.pool, method, args) // getRoom, claimable
  const readGarage = (method, args) => read(CONTRACTS.garage, method, args) // loadoutOf, balanceOfBatch

  return {
    enabled,
    poolEnabled,
    garageEnabled: GARAGE_ADDRESS !== '',
    address: wallet.address,
    txs,
    send,
    stats,
    readPool,
    readGarage,
    // Bu cüzdanın bugüne kadar gönderdiği işlem sayısı = zincirdeki nonce'u (giriş sayfası istatistiği)
    getTxCount: () => provider.getTransactionCount(wallet.address, 'latest'),
    // Sunucuya "bu adres benim" kanıtı: metni burner anahtarıyla imzala (işlem değil, zincire gitmez)
    signMessage: (text) => wallet.signMessage(text),
    get balance() {
      return balance === null ? null : Number(formatEther(balance))
    },
    get lastError() {
      return lastError
    },
  }
}
