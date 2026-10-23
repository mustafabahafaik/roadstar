// Sunucunun iki cüzdanı: RESULT_SIGNER_KEY (sıralamayı ve bahis sonucunu imzalar, bahis operatörü) ve FAUCET_KEY
// (izleyicilere MON). Boş olanları üretip server/.env'e yazar, sadece ADRESLERİ gösterir. Anahtarlar ekrana yazılmaz.
// Doluysa üzerine yazmaz (yüklenmiş para ve deploy edilmiş kontratın imzacısı kaybolmasın): adres ve bakiye gösterir.
//
// Kullanım (kök klasörde): node scripts/make-server-keys.js
// ⚠️ SADECE TESTNET: anahtarlar server/.env'de şifresiz durur. Render'a da panelden (Environment) girilir.
import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Wallet, JsonRpcProvider, formatEther } from 'ethers'

const ENV_PATH = fileURLToPath(new URL('../server/.env', import.meta.url))
const EXAMPLE_PATH = fileURLToPath(new URL('../server/.env.example', import.meta.url))
const KEYS = [
  { name: 'RESULT_SIGNER_KEY', role: 'imzacı / bahis operatörü (RacePool ve BetPool deploy\'unda RESULT_SIGNER bu adres)' },
  { name: 'FAUCET_KEY', role: 'izleyici faucet\'i (bütçe + gaz: 100 izleyici ≈ 3.1 MON)' },
]

if (!existsSync(ENV_PATH)) copyFileSync(EXAMPLE_PATH, ENV_PATH)
let env = readFileSync(ENV_PATH, 'utf8')
const provider = new JsonRpcProvider(env.match(/^RPC_URL=(.+)$/m)?.[1]?.trim() || 'https://testnet-rpc.monad.xyz')

for (const { name, role } of KEYS) {
  const current = env.match(new RegExp(`^${name}=(.*)$`, 'm'))?.[1]?.trim()
  let wallet
  if (/^0x[0-9a-fA-F]{64}$/.test(current ?? '')) {
    wallet = new Wallet(current)
    console.log(`${name}: zaten var (üzerine yazılmadı)`)
  } else {
    wallet = Wallet.createRandom()
    const line = `${name}=${wallet.privateKey}`
    // Boş satır varsa onu doldur; yorum satırı (# FAUCET_KEY=…) ya da hiç yoksa sona ekle
    env = new RegExp(`^${name}=.*$`, 'm').test(env) ? env.replace(new RegExp(`^${name}=.*$`, 'm'), line) : `${env.trimEnd()}\n${line}\n`
    console.log(`${name}: üretildi, server/.env'e yazıldı`)
  }
  const balance = await provider.getBalance(wallet.address).then(formatEther, () => '?')
  console.log(`  ${wallet.address}  ${balance} MON  · ${role}\n`)
}
writeFileSync(ENV_PATH, env)
console.log('MON yüklemek için: node scripts/fund.js <miktar> <adres>  (ya da https://faucet.monad.xyz)')
