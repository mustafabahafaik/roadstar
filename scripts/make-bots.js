// Bot cüzdanları: 4 testnet cüzdanı üretir, anahtarlarını server/.env'e (BOT_KEYS) yazar, adreslerini gösterir.
// Anahtarlar ekrana YAZILMAZ. Cüzdanlar zaten varsa üzerine yazmaz: adresleri ve bakiyeleri listeler.
//
// Kullanım (kök klasörde):  node scripts/make-bots.js           → üret ya da listele
//                           node scripts/make-bots.js --count 3 → kaç cüzdan (varsayılan 4)
// ⚠️ SADECE TESTNET: anahtarlar server/.env'de şifresiz durur. Gerçek değeri olan para koyma.
import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Wallet, JsonRpcProvider, formatEther } from 'ethers'

const ENV_PATH = fileURLToPath(new URL('../server/.env', import.meta.url))
const EXAMPLE_PATH = fileURLToPath(new URL('../server/.env.example', import.meta.url))
const FAUCET = 'https://faucet.monad.xyz'
const countArg = process.argv.indexOf('--count')
const COUNT = countArg > 0 ? Number(process.argv[countArg + 1]) : 4

// .env yoksa örnekten oluştur (diğer ayarlar da yerinde dursun)
if (!existsSync(ENV_PATH)) {
  copyFileSync(EXAMPLE_PATH, ENV_PATH)
  console.log('server/.env oluşturuldu (server/.env.example kopyası)')
}
let env = readFileSync(ENV_PATH, 'utf8')
const line = env.match(/^BOT_KEYS=(.*)$/m)
const existing = (line?.[1] ?? '')
  .split(',')
  .map((k) => k.trim())
  .filter((k) => /^0x[0-9a-fA-F]{64}$/.test(k))

if (existing.length) {
  // Var olanları listele (yeniden üretmek yüklenmiş parayı kaybettirirdi)
  const rpc = env.match(/^RPC_URL=(.+)$/m)?.[1]?.trim() || 'https://testnet-rpc.monad.xyz'
  const provider = new JsonRpcProvider(rpc)
  console.log(`server/.env'de zaten ${existing.length} bot cüzdanı var (üzerine yazılmadı):\n`)
  for (const key of existing) {
    const { address } = new Wallet(key)
    const balance = await provider.getBalance(address).then(formatEther, () => '?')
    console.log(`  ${address}  ${balance} MON`)
  }
  console.log(`\nFaucet: ${FAUCET}`)
  process.exit(0)
}

const wallets = Array.from({ length: COUNT }, () => Wallet.createRandom())
const value = wallets.map((w) => w.privateKey).join(',')
env = line ? env.replace(/^BOT_KEYS=.*$/m, `BOT_KEYS=${value}`) : `${env.trimEnd()}\n\nBOT_KEYS=${value}\n`
writeFileSync(ENV_PATH, env)

console.log(`${COUNT} bot cüzdanı üretildi, anahtarlar server/.env → BOT_KEYS (paylaşma, repoya girmez).`)
console.log(`Her birine faucet'ten MON yükle (${FAUCET}):\n`)
for (const w of wallets) console.log(`  ${w.address}`)
console.log('\nKontrol için tekrar çalıştır: node scripts/make-bots.js (bakiyeleri gösterir)')
