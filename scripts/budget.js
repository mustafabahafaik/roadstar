// Testnet MON bütçesi: imzacı, fon (faucet) cüzdanı, deployer, botlar ve verdiğin adreslerin bakiyeleri,
// toplam ve "kaç yarışa / kaç izleyiciye yeter" tahmini.
//
//   node scripts/budget.js                 → .env'lerdeki cüzdanlar (server/.env, contracts/.env)
//   node scripts/budget.js 0xA.. 0xB..     → + verdiğin adresler (ör. tarayıcıdaki burner cüzdan)
//
// Maliyet = gaz LİMİTİ × gaz fiyatı (Monad kullanılan gazı değil limiti keser). Limitler shared/protocol.js'te.
// Anahtarlar ekrana yazılmaz, sadece adresleri.
import { JsonRpcProvider, Wallet, getAddress, formatEther, parseEther, formatUnits } from 'ethers'
import { RACE_GAS_LIMITS as R, POOL_GAS_LIMITS as P, ENTRY_FEE } from '../shared/protocol.js'
import { BOT_NAMES } from '../server/bots.js'
import { readEnv, isPrivateKey } from './env.js'

const RPC_URL = process.env.RPC_URL || 'https://testnet-rpc.monad.xyz'
// Yarış varsayımları (son 8 gerçek yarışta en çok 21 token toplandı; pistte 40 var)
const TYPICAL = { collect: 25n, useSkill: 3n }
const WORST = { collect: 40n, useSkill: 6n }
const VIEWER_RACES = 2n // bir izleyicinin burner'ına kaç yarışlık MON verelim
const RESERVE = parseEther('10') // Monad rezerv kuralı: altındaki cüzdan art arda MON gönderemez

const env = readEnv()
const provider = new JsonRpcProvider(RPC_URL, 10143, { staticNetwork: true, batchMaxCount: 1 })
const gasPrice = BigInt(await provider.send('eth_gasPrice', []))
const mon = (wei, digits = 4) => Number(formatEther(wei)).toFixed(digits)

// --- Maliyetler (wei) ---
const raceGas = (t) => R.startRace + t.collect * R.collect + t.useSkill * R.useSkill + R.finishRace
const freeRace = raceGas(TYPICAL) * gasPrice // oyuncunun bir yarıştaki işlemleri
const worstRace = raceGas(WORST) * gasPrice
const paidExtra = ENTRY_FEE + P.joinRoom * gasPrice // ücretli odada oyuncuya ek (ücret kazanana döner)
const botRace = ENTRY_FEE + (P.joinRoom + P.settle + P.withdraw) * gasPrice // bot: giriş + kazanırsa settle ve withdraw
const perViewer = VIEWER_RACES * freeRace
const botLow = parseEther(env.BOT_LOW_BALANCE || '0.3')

// --- Cüzdanlar ---
const wallets = [] // { role, address, kind }
const add = (role, address, kind) => {
  if (!wallets.some((w) => w.address === address)) wallets.push({ role, address, kind })
  else wallets.find((w) => w.address === address).role += ` + ${role}`
}
if (isPrivateKey(env.FUNDER_KEY)) add('fon (faucet)', new Wallet(env.FUNDER_KEY).address, 'funder')
if (isPrivateKey(env.PRIVATE_KEY)) add('deployer', new Wallet(env.PRIVATE_KEY).address, 'deployer')
if (isPrivateKey(env.RESULT_SIGNER_KEY)) add('imzacı (sunucu)', new Wallet(env.RESULT_SIGNER_KEY).address, 'signer')
const botKeys = (env.BOT_KEYS ?? '').split(',').map((k) => k.trim()).filter(isPrivateKey)
botKeys.forEach((k, i) => add(`BOT·${BOT_NAMES[i % BOT_NAMES.length]}`, new Wallet(k).address, 'bot'))
for (const arg of process.argv.slice(2)) {
  try {
    add('verilen', getAddress(arg.trim().toLowerCase()), 'given') // yapıştırırken kalan boşluk / büyük-küçük harf
  } catch {
    console.warn(`⚠️  geçersiz adres atlandı: ${arg}`)
  }
}
if (!wallets.length) {
  console.log('Hiç cüzdan yok: server/.env (BOT_KEYS, RESULT_SIGNER_KEY) ya da contracts/.env (FUNDER_KEY, PRIVATE_KEY) boş. Adres de verebilirsin.')
  process.exit(1)
}

// --- Bakiyeler (RPC sınırı: saniyede 15 istek → sırayla) ---
let total = 0n
const rows = []
for (const w of wallets) {
  const balance = await provider.getBalance(w.address)
  await new Promise((r) => setTimeout(r, 80))
  total += w.kind === 'signer' ? 0n : balance
  let enough
  if (w.kind === 'signer') enough = 'işlem göndermez (sadece imzalar): MON gerekmez'
  else if (w.kind === 'bot') enough = `${balance / botRace} ücretli yarış${balance < botLow ? `  ⚠ ${formatEther(botLow)} MON altında` : ''}`
  else if (w.kind === 'funder') enough = `${balance / perViewer} izleyici · ${balance / freeRace} yarış${balance < RESERVE ? '  · <10 MON: fund.js aralıklı gönderir' : ''}`
  else enough = `${balance / freeRace} yarış`
  rows.push({ rol: w.role, adres: w.address, MON: mon(balance), 'neye yeter': enough })
}

console.log(`\nMonad testnet bakiyeleri · gaz ${formatUnits(gasPrice, 9)} gwei`)
console.table(rows)
console.log(`Toplam (imzacı hariç): ${mon(total)} MON ≈ ${total / freeRace} tipik yarış · hepsini dağıtsan ${total / perViewer} izleyici`)
if (!isPrivateKey(env.FUNDER_KEY)) console.log("ℹ️  FUNDER_KEY yok: faucet'ten yüklediğin cüzdanın anahtarını contracts/.env'e FUNDER_KEY=0x... olarak ekle (fund.js de kullanır)")
if (!isPrivateKey(env.RESULT_SIGNER_KEY)) console.log('ℹ️  RESULT_SIGNER_KEY yok (server/.env): ücretli oda kapalı, sadece ücretsiz yarış')

const line = (label, wei, note) => console.log(`  ${label.padEnd(36)} ${mon(wei).padStart(7)} MON  ${note}`)
console.log(`
Maliyetler (limit × ${formatUnits(gasPrice, 9)} gwei):`)
line(`tipik yarış (${TYPICAL.collect} token, ${TYPICAL.useSkill} skill)`, freeRace, 'startRace + collect + useSkill + finishRace')
line(`en kötü yarış (${WORST.collect} token, ${WORST.useSkill} skill)`, worstRace, '')
line('ücretli odada oyuncuya ek', paidExtra, `${formatEther(ENTRY_FEE)} giriş (kazanana döner) + joinRoom gazı`)
line('bot, ücretli yarış başına', botRace, 'giriş + joinRoom, kazanırsa settle + withdraw')
line(`izleyici başına (${VIEWER_RACES} yarış)`, perViewer, `→ node scripts/fund.js ${mon(perViewer, 2)} 0x<burner>`)
