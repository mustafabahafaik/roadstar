// Gerçek gaz kullanımını Monad'ın KENDİ kurallarıyla ölç → shared/protocol.js'teki limitleri ayarla.
// Neden önemli: Monad ücreti KULLANILAN gazdan değil, işlemde yazdığımız LİMİTTEN keser. Limit gereğinden
// büyükse her işlemde boşuna MON yakılır; küçükse işlem "gas bitti" diye düşer. Hedef: ölçülen en yüksek + %15.
//
// Neden makbuz (receipt) değil? Monad makbuza da gasUsed olarak LİMİTİ yazıyor (ölçtük: 42 collect'in
// hepsi tam 140 000). Neden Foundry raporu değil? Monad'ın gaz tablosu Ethereum'dan farklı.
// Yöntem: eth_estimateGas + state override. Tahmin sırasında depolamaya geçici değer yazarız ("bu oyuncunun
// aktif yarışı var", "bu adreste RacePool kodu var"). Zincirde hiçbir şey değişmez, MON harcanmaz.
//
//   node scripts/gas-measure.js
//
// Race ve GarageParts: zincirdeki kontratlar. RacePool (henüz zincirde yok): yerel anvil'de kurulur, senaryo
// adım adım oynanır, her adımdan önceki durum Monad'a override olarak verilip tahmin edilir.
// RPC sınırı (Monad genel RPC): saniyede 15 istek → istekleri sırayla, aralıklı atıyoruz
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { JsonRpcProvider, Interface, AbiCoder, Wallet, ContractFactory, keccak256, getBytes, toBeHex, parseEther, formatEther, formatUnits, hexlify, randomBytes } from 'ethers'
import { RACE_GAS_LIMITS, POOL_GAS_LIMITS, GARAGE_GAS_LIMITS } from '../shared/protocol.js'

const RPC_URL = process.env.RPC_URL || 'https://testnet-rpc.monad.xyz'
const RACE = process.env.RACE_ADDRESS || '0x7cBF7eAbB758CD0DBEAd1DFa9Adc8FA9A6e6f434'
const GARAGE = process.env.GARAGE_ADDRESS || '0x8fcbf1ae2a4183a612be64fdb1f9afff2dc1893b'
const MARGIN = 1.15
const MIN_INTERVAL_MS = 85 // ~12 istek / sn
const root = fileURLToPath(new URL('..', import.meta.url))
const parts = JSON.parse(readFileSync(new URL('../shared/parts.json', import.meta.url))).parts

const monad = new JsonRpcProvider(RPC_URL, 10143, { staticNetwork: true, batchMaxCount: 1 })
const coder = AbiCoder.defaultAbiCoder()
const RICH = toBeHex(parseEther('1000')) // tahminde gönderenin bakiyesi (override)
const fresh = () => Wallet.createRandom().address
const slot32 = (v) => toBeHex(BigInt(v), 32)
const mapSlot = (key, slot) => keccak256(coder.encode(['uint256', 'uint256'], [key, slot])) // mapping(uint256 => ...)
// ERC1155 (OpenZeppelin v5) _balances: mapping(uint256 id => mapping(address => uint256)), 0. yuva
const balanceSlot = (id, account) => keccak256(coder.encode(['address', 'bytes32'], [account, mapSlot(id, 0)]))

let last = 0
async function throttle() {
  const wait = last + MIN_INTERVAL_MS - Date.now()
  if (wait > 0) await new Promise((r) => setTimeout(r, wait))
  last = Date.now()
}
async function estimate(tx, overrides) {
  await throttle()
  const params = [{ ...tx, value: toBeHex(tx.value ?? 0n) }, 'latest']
  if (overrides) params.push(overrides)
  return parseInt(await monad.send('eth_estimateGas', params), 16)
}
async function call(to, data) {
  await throttle()
  return monad.call({ to, data })
}

const results = {} // fonksiyon → [{ case, gas }]
function record(fn, label, gas) {
  ;(results[fn] ??= []).push({ label, gas })
  console.log(`  ${fn.padEnd(10)} ${label.padEnd(38)} ${gas.toLocaleString('tr-TR').padStart(8)}`)
}
async function measure(fn, label, tx, overrides) {
  try {
    record(fn, label, await estimate(tx, overrides))
  } catch (err) {
    console.log(`  ${fn.padEnd(10)} ${label.padEnd(38)} ÖLÇÜLEMEDİ: ${(err.shortMessage ?? err.message).slice(0, 70)}`)
  }
}

// ---------------------------------------------------------------- Race (zincirde)
const raceAbi = new Interface([
  'function startRace()',
  'function collect(uint256,uint256)',
  'function useSkill(uint256,uint8)',
  'function finishRace(uint256)',
  'function items() view returns (address)',
])
const itemsAbi = new Interface(['function tokenId(uint256,uint8) pure returns (uint256)'])
const nowSec = BigInt(Math.floor(Date.now() / 1000))
// Sahte aktif yarış: races[id] (1. yuvadaki mapping, yapı 3 yuva) → oyuncu, başlangıç, toplanan bitleri
function raceState(id, player, { startAgo = 300n, mask = 0n, count = 0n } = {}) {
  const base = BigInt(mapSlot(id, 1))
  return {
    [slot32(base)]: slot32(BigInt(player) | ((nowSec - startAgo) << 160n) | (count << 224n)),
    [slot32(base + 1n)]: slot32(mask << 64n), // finishTime 0 (bitmedi) + toplanan bitler
    [slot32(base + 2n)]: hexlify(randomBytes(32)), // seed
  }
}

console.log(`\nRace ${RACE}`)
const itemsAddress = coder.decode(['address'], await call(RACE, raceAbi.encodeFunctionData('items')))[0]
{
  const p = fresh()
  await measure('startRace', 'yeni oyuncu', { from: p, to: RACE, data: raceAbi.encodeFunctionData('startRace') }, { [p]: { balance: RICH } })
  // Kontrat yeniden deploy edilince ilk yarış: sayaç 0 → 1 ve 1 numaralı kayıt boş (sıfırdan yazmak daha pahalı)
  const first = BigInt(mapSlot(1, 1))
  await measure('startRace', 'yeni kontratta ilk yarış (sayaç 0)', { from: p, to: RACE, data: raceAbi.encodeFunctionData('startRace') }, {
    [p]: { balance: RICH },
    [RACE]: { stateDiff: { [slot32(0)]: slot32(0), [slot32(first)]: slot32(0), [slot32(first + 1n)]: slot32(0), [slot32(first + 2n)]: slot32(0) } },
  })
}
{
  // İlk toplama: her token türü yarışta ilk kez mint edilir, toplanan bitleri 0'dan yazılır → en kötü durum
  const id = 900001n
  let worst = 0
  let ok = 0
  for (let index = 0; index < 40; index++) {
    const p = fresh()
    try {
      worst = Math.max(worst, await estimate({ from: p, to: RACE, data: raceAbi.encodeFunctionData('collect', [id, index]) }, { [p]: { balance: RICH }, [RACE]: { stateDiff: raceState(id, p) } }))
      ok++
    } catch {}
  }
  if (ok) record('collect', `yarışın ilk toplaması (${ok}/40 index, en kötü)`, worst)
  const p = fresh()
  await measure('collect', 'sonraki toplama (20 token alınmış)', { from: p, to: RACE, data: raceAbi.encodeFunctionData('collect', [id, 39]) }, {
    [p]: { balance: RICH },
    [RACE]: { stateDiff: raceState(id, p, { mask: (1n << 20n) - 1n, count: 20n }) },
  })
}
for (const type of [1, 2, 3]) {
  // Skill: envanterde 1 token var (RaceItems bakiyesi override), yakılır
  const id = 900002n
  const p = fresh()
  const tokenId = coder.decode(['uint256'], await call(itemsAddress, itemsAbi.encodeFunctionData('tokenId', [id, type])))[0]
  await measure('useSkill', `tür ${type}`, { from: p, to: RACE, data: raceAbi.encodeFunctionData('useSkill', [id, type]) }, {
    [p]: { balance: RICH },
    [RACE]: { stateDiff: raceState(id, p, { mask: 1n, count: 1n }) },
    [itemsAddress]: { stateDiff: { [balanceSlot(tokenId, p)]: slot32(1) } },
  })
}
{
  const id = 900003n
  const p = fresh()
  await measure('finishRace', '100 sn süren yarış', { from: p, to: RACE, data: raceAbi.encodeFunctionData('finishRace', [id]) }, {
    [p]: { balance: RICH },
    [RACE]: { stateDiff: raceState(id, p, { startAgo: 100n, mask: 0xffn, count: 8n }) },
  })
}

// ---------------------------------------------------------------- GarageParts (zincirde)
console.log(`\nGarageParts ${GARAGE}`)
const garageAbi = new Interface(['function buy(uint256) payable', 'function equip(uint256)'])
{
  const paid = parts.find((x) => BigInt(x.priceWei) > 0n)
  const free = parts.find((x) => BigInt(x.priceWei) === 0n && x.slot === paid.slot)
  const p = fresh()
  await measure('buy', `${paid.name} (ilk parça)`, { from: p, to: GARAGE, data: garageAbi.encodeFunctionData('buy', [paid.id]), value: BigInt(paid.priceWei) }, { [p]: { balance: RICH } })
  await measure('equip', `${paid.name} (sahip, ilk takma)`, { from: p, to: GARAGE, data: garageAbi.encodeFunctionData('equip', [paid.id]) }, {
    [p]: { balance: RICH },
    [GARAGE]: { stateDiff: { [balanceSlot(paid.id, p)]: slot32(1) } },
  })
  await measure('equip', `${free.name} (varsayılana dönüş)`, { from: p, to: GARAGE, data: garageAbi.encodeFunctionData('equip', [free.id]) }, { [p]: { balance: RICH } })
}

// ---------------------------------------------------------------- RacePool (anvil'de kur, Monad'da tahmin et)
await measureRacePool().catch((err) => console.log(`\nRacePool ölçülemedi: ${err.message}`))

async function measureRacePool() {
  const anvilBin = [process.env.ANVIL, `${homedir()}/.foundry/bin/anvil.exe`, `${homedir()}/.foundry/bin/anvil`].find((p) => p && existsSync(p))
  const artifact = `${root}contracts/out/RacePool.sol/RacePool.json`
  if (!anvilBin) throw new Error('anvil bulunamadı (Foundry kurulu mu?)')
  if (!existsSync(artifact)) throw new Error('önce: cd contracts && forge build')
  const { abi, bytecode } = JSON.parse(readFileSync(artifact, 'utf8'))
  const pool = new Interface(abi)

  const port = 8611
  const now = Math.floor(Date.now() / 1000)
  // anvil'in saati geri alınamaz: zincir 35 dk önce başlasın, iade senaryosu için "27 dk önce" kurulabilsin
  const anvil = spawn(anvilBin, ['--port', String(port), '--chain-id', '10143', '--timestamp', String(now - 2100), '--silent'], { stdio: 'ignore' })
  try {
    // cacheTimeout -1: ethers aynı isteğin cevabını kısa süre saklar → art arda işlemde eski nonce verirdi
    const local = new JsonRpcProvider(`http://127.0.0.1:${port}`, 10143, { staticNetwork: true, cacheTimeout: -1 })
    for (let i = 0; i < 50; i++) {
      if (await local.getBlockNumber().then(() => true, () => false)) break
      await new Promise((r) => setTimeout(r, 200))
    }
    const wallets = Array.from({ length: 7 }, () => Wallet.createRandom().connect(local))
    for (const w of wallets) await local.send('anvil_setBalance', [w.address, RICH])
    const [deployer, treasury, ...players] = wallets
    const signer = Wallet.createRandom() // sunucunun imza anahtarı (sadece bu ölçüm için)
    await local.send('evm_setNextBlockTimestamp', [now - 1600])
    const factory = new ContractFactory(abi, bytecode.object, deployer)
    const contract = await factory.deploy(signer.address, treasury.address)
    await contract.waitForDeployment()
    const address = (await contract.getAddress()).toLowerCase()
    console.log(`\nRacePool (anvil'de ${address}, ölçüm Monad'da)`)
    const fee = parseEther('0.05')

    // anvil'deki kontratın şu anki kodu + depolaması + bakiyesi → Monad tahmini için override
    async function poolOverride(from) {
      const dump = await local.send('anvil_dumpState', [])
      const raw = Buffer.from(dump.slice(2), 'hex')
      const state = JSON.parse((raw[0] === 0x1f ? gunzipSync(raw) : raw).toString())
      const acc = state.accounts[address] ?? state.accounts[Object.keys(state.accounts).find((k) => k.toLowerCase() === address)]
      const storage = {}
      for (const [k, v] of Object.entries(acc.storage)) storage[slot32(k)] = slot32(v)
      return { [address]: { code: acc.code, state: storage, balance: toBeHex(BigInt(acc.balance)) }, [from]: { balance: RICH } }
    }
    // Önce Monad'da ölç (işlemden ÖNCEKİ durumla), sonra anvil'de gerçekten yap (sonraki adımın durumu için).
    // fn null: sadece anvil'de yap (ölçülemeyen ara adım)
    async function step(fn, label, wallet, data, value = 0n) {
      if (fn) await measure(fn, label, { from: wallet.address, to: address, data, value }, await poolOverride(wallet.address))
      await (await wallet.sendTransaction({ to: address, data, value })).wait()
    }

    // Oda 1 (iade senaryosu): ~27 dk önce kuruldu, 2 kişi girdi, dolmadı. Girişler Monad'da ölçülmez:
    // Monad'ın "şimdi"sine göre bu odanın katılma süresi çoktan doldu (girişleri oda 2'de ölçüyoruz)
    await step('createRoom', 'kontratın ilk odası (sayaç 0)', players[0], pool.encodeFunctionData('createRoom', [fee, 5]))
    await step(null, '', players[0], pool.encodeFunctionData('joinRoom', [1]), fee)
    await step(null, '', players[1], pool.encodeFunctionData('joinRoom', [1]), fee)

    // Oda 2: şimdi kuruldu, 5 kişi doldurur (son giren odayı başlatır), sonuçlanır, ödül çekilir
    await local.send('evm_setNextBlockTimestamp', [now - 60])
    await step('createRoom', 'sonraki oda', players[0], pool.encodeFunctionData('createRoom', [fee, 5]))
    for (let i = 0; i < 5; i++) {
      await step('joinRoom', i === 4 ? '5. oyuncu (odayı başlatır)' : `${i + 1}. oyuncu (5 kişilik oda)`, players[i], pool.encodeFunctionData('joinRoom', [2]), fee)
    }
    const ranking = [players[2], players[4], players[0], players[1], players[3]].map((w) => w.address)
    const hash = keccak256(coder.encode(['uint256', 'address', 'uint256', 'address[]'], [10143, address, 2, ranking]))
    const signature = await signer.signMessage(getBytes(hash))
    await step('settle', '5 kişi, alacaklar ilk kez yazılır', players[3], pool.encodeFunctionData('settle', [2, ranking, signature]))
    await step('withdraw', '1. olan çeker', players[2], pool.encodeFunctionData('withdraw'))
    await step('withdraw', 'hazine çeker', treasury, pool.encodeFunctionData('withdraw'))
    await step('refund', 'dolmayan odadan iade', players[0], pool.encodeFunctionData('refund', [1]))
  } finally {
    anvil.kill()
  }
}

// ---------------------------------------------------------------- Sonuç
const current = { ...RACE_GAS_LIMITS, ...GARAGE_GAS_LIMITS, ...POOL_GAS_LIMITS }
await throttle()
const gasPrice = BigInt(await monad.send('eth_gasPrice', []))
const table = {}
const suggested = {}
for (const [fn, list] of Object.entries(results)) {
  const max = Math.max(...list.map((r) => r.gas))
  suggested[fn] = Math.ceil((max * MARGIN) / 1000) * 1000
  const limit = Number(current[fn] ?? 0n)
  table[fn] = {
    'ölçülen en yüksek': max.toLocaleString('tr-TR'),
    'şu anki limit': limit ? limit.toLocaleString('tr-TR') : '-',
    'önerilen (+%15)': suggested[fn].toLocaleString('tr-TR'),
    'işlem başı fark (MON)': limit ? formatEther(BigInt(limit - suggested[fn]) * gasPrice).slice(0, 9) : '-',
  }
}
console.log(`\nGaz fiyatı ${formatUnits(gasPrice, 9)} gwei · Monad limit × fiyat keser · artı = tasarruf, eksi = limit yetmiyordu`)
console.table(table)
console.log('\nshared/protocol.js için öneri:')
for (const [fn, gas] of Object.entries(suggested)) console.log(`  ${fn}: ${gas}n,`)
