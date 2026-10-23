// Tek komutla MON dağıt: FUNDER_KEY cüzdanından verdiğin her adrese aynı miktar.
//
//   node scripts/fund.js 1.0 0xA.. 0xB.. 0xC.. 0xD..
//   node scripts/fund.js 0.5 0xA.. --kuru        → sadece planı göster, gönderme
//
// FUNDER_KEY: faucet'ten MON yüklediğin cüzdanın anahtarı. contracts/.env (ya da server/.env) içine
// FUNDER_KEY=0x... yaz; ikisi de .gitignore'da. Anahtar ekrana asla yazılmaz.
//
// Monad rezerv kuralı: 10 MON'un altındaki bir cüzdan son 3 blokta başka işlem gönderdiyse MON transferi geri
// çevrilir (gaz yine kesilir, makbuz "gas bitti" gibi görünür). O durumda her gönderimden sonra 4 blok bekleriz.
// Gaz limiti tam 21 000: düz transfer hep bu kadar tutar, fazlasını yazmak boşuna ödemek (Monad limiti keser)
import { JsonRpcProvider, Wallet, getAddress, parseEther, formatEther } from 'ethers'
import { TRANSFER_GAS } from '../shared/protocol.js'
import { readEnv, isPrivateKey } from './env.js'

const RPC_URL = process.env.RPC_URL || 'https://testnet-rpc.monad.xyz'
const EXPLORER = 'https://testnet.monadexplorer.com/tx/'
const RESERVE = parseEther('10')
const SAFE_GAP = 4 // blok: son işlemden sonra bu kadar bekle (kural "son 3 blok")

const args = process.argv.slice(2)
const dry = args.includes('--kuru')
const [amountArg, ...rest] = args.filter((a) => !a.startsWith('--'))
const fail = (msg) => {
  console.error(`❌ ${msg}`)
  process.exit(1)
}

let amount
try {
  amount = parseEther(String(amountArg ?? '').replace(',', '.')) // "0,5" da olur
} catch {
  fail('Kullanım: node scripts/fund.js <MON> <adres> [adres...]   örn: node scripts/fund.js 1.0 0xA.. 0xB..')
}
if (amount <= 0n) fail('Miktar 0\'dan büyük olmalı')

// Adresler: yapıştırırken kalan boşluk / satır sonu ve büyük-küçük harf karışıklığı sorun olmasın
const recipients = []
for (const raw of rest.flatMap((a) => a.split(','))) {
  const text = raw.trim()
  if (!text) continue
  try {
    const address = getAddress(text.toLowerCase())
    if (!recipients.includes(address)) recipients.push(address)
  } catch {
    fail(`Geçersiz adres: "${text}"`)
  }
}
if (!recipients.length) fail('En az bir adres ver')

const env = readEnv()
if (!isPrivateKey(env.FUNDER_KEY)) fail("FUNDER_KEY yok: contracts/.env'e FUNDER_KEY=0x... ekle (faucet'ten MON yüklediğin cüzdan)")
const provider = new JsonRpcProvider(RPC_URL, 10143, { staticNetwork: true, batchMaxCount: 1, cacheTimeout: -1 })
const funder = new Wallet(env.FUNDER_KEY, provider)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const [balance, fees, startNonce] = await Promise.all([provider.getBalance(funder.address), provider.getFeeData(), provider.getTransactionCount(funder.address, 'pending')])
const maxFeePerGas = fees.maxFeePerGas ?? fees.gasPrice
const maxPriorityFeePerGas = fees.maxPriorityFeePerGas ?? 0n
const gasCost = TRANSFER_GAS * maxFeePerGas
const total = (amount + gasCost) * BigInt(recipients.length)
if (recipients.includes(funder.address)) fail('Fon cüzdanı kendine gönderemez')

console.log(`Fon cüzdanı ${funder.address}: ${formatEther(balance)} MON`)
console.log(`Plan: ${recipients.length} adrese ${formatEther(amount)} MON (+ işlem başı en fazla ${formatEther(gasCost)} MON gaz) = ${formatEther(total)} MON`)
if (balance < total) fail(`Bakiye yetmiyor: ${formatEther(total - balance)} MON eksik → https://faucet.monad.xyz`)
const slow = balance - total < RESERVE // kalan 10 MON'un altına iniyor: rezerv kuralı
if (slow) console.log('ℹ️  Kalan bakiye 10 MON altında: Monad rezerv kuralı yüzünden her gönderimden sonra 4 blok (~2 sn) beklenecek')

const plan = []
for (const to of recipients) {
  const [code, before] = await Promise.all([provider.getCode(to), provider.getBalance(to)])
  if (code !== '0x') console.warn(`⚠️  ${to} bir kontrat: 21 000 gaz yetmeyebilir, atlanıyor`)
  else plan.push({ to, before })
  await sleep(80)
}
console.table(plan.map((p) => ({ alıcı: p.to, 'şu anki MON': formatEther(p.before), 'gönderilecek': formatEther(amount) })))
if (dry) {
  console.log('--kuru: hiçbir şey gönderilmedi')
  process.exit(0)
}

let nonce = startNonce
let lastBlock = null
for (const p of plan) {
  if (slow && lastBlock !== null) {
    const giveUp = Date.now() + 30000 // bloklar ilerlemiyorsa (RPC takıldı) sonsuza kadar bekleme
    while ((await provider.getBlockNumber()) < lastBlock + SAFE_GAP) {
      if (Date.now() > giveUp) fail('Bloklar 30 sn ilerlemedi (RPC sorunu?). Kalan adreslerle tekrar çalıştır')
      await sleep(300)
    }
  }
  const tx = await funder.sendTransaction({ to: p.to, value: amount, gasLimit: TRANSFER_GAS, maxFeePerGas, maxPriorityFeePerGas, nonce: nonce++ })
  const receipt = await tx.wait()
  if (receipt.status !== 1) {
    fail(`${p.to} gönderimi geri çevrildi (${EXPLORER}${tx.hash}). 10 MON altındaki cüzdan art arda gönderince Monad bunu yapar; birkaç saniye bekleyip yalnızca kalan adreslerle tekrar çalıştır`)
  }
  lastBlock = receipt.blockNumber
  console.log(`✅ ${p.to} ← ${formatEther(amount)} MON  ${EXPLORER}${tx.hash}`)
}
console.log(`Bitti. Fon cüzdanında kalan: ${formatEther(await provider.getBalance(funder.address))} MON`)
