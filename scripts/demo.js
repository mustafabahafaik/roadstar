// Yedek plan: internet gitse de demo yerel ağda tek komutla çalışsın.
// Oyun sunucusu (botlar onun içinde) + oyun (Vite, --host: aynı Wi-Fi'deki telefonlar da bağlanır).
//
//   npm run demo           → server/.env ayarlarıyla (zincire ulaşılırsa ücretli oda da çalışır)
//   npm run demo:offline   → internetsiz: ücretli oda kapalı, botlar ücretsiz odaları doldurur
//
// Ctrl + C ikisini birden kapatır. Biri çökerse öteki de kapanır (yarım kalmış demo olmasın).
import { spawn } from 'node:child_process'
import { networkInterfaces } from 'node:os'
import { fileURLToPath } from 'node:url'

const offline = process.argv.includes('--offline')
const root = fileURLToPath(new URL('..', import.meta.url))
const GAME_PORT = 5173
const SERVER_PORT = 3001 // oyun, sunucuyu "sayfayı açtığım bilgisayarın 3001 portu"nda arar (src/net.js)

// Komut satırından verilen ortam değişkeni server/.env'dekini ezer (process.loadEnvFile var olanı ezmez)
const serverEnv = { ...process.env, PORT: String(SERVER_PORT), CLIENT_ORIGIN: '*' }
if (offline) serverEnv.POOL_ADDRESS = '' // zincirsiz: sunucu ücretli odayı hiç açmaz

const children = []
let stopping = false

function stopAll(code = 0) {
  if (stopping) return
  stopping = true
  for (const child of children) child.kill()
  setTimeout(() => process.exit(code), 300)
}

// npm yerine doğrudan node ile başlat: Windows'ta kabuk / PATH farkı sorun çıkarmasın
function run(name, args, env) {
  const child = spawn(process.execPath, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
  const print = (data) => {
    for (const line of String(data).split(/\r?\n/)) if (line.trim()) console.log(`[${name}] ${line}`)
  }
  child.stdout.on('data', print)
  child.stderr.on('data', print)
  child.on('exit', (code) => {
    if (stopping) return
    console.log(`[${name}] kapandı (çıkış kodu ${code}): demo durduruluyor`)
    stopAll(code ?? 1)
  })
  children.push(child)
}

console.log(`\nROADSTAR demo ${offline ? '(İNTERNETSİZ: ücretli oda kapalı, botlar ücretsiz)' : ''}\n`)
run('sunucu', ['server/index.js'], serverEnv)
run('oyun', ['node_modules/vite/bin/vite.js', '--host', '--port', String(GAME_PORT), '--strictPort'], process.env)

// Telefonun açacağı adresler: bilgisayarın yerel ağ adresleri (192.168.x.x gibi)
setTimeout(() => {
  const ips = Object.values(networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address)
  console.log('\n──────────────────────────────────────────────')
  console.log(` Bu bilgisayarda:  http://localhost:${GAME_PORT}`)
  for (const ip of ips) console.log(` Telefondan:       http://${ip}:${GAME_PORT}/?room=demo#/lobi`)
  console.log(' Telefon aynı Wi-Fi ağında olmalı. Windows güvenlik duvarı sorarsa "Özel ağlar"a izin ver.')
  console.log(' Lobideki QR kod da bu adresi gösterir (oyunu ağ adresinden açtıysan).')
  console.log(' Durdurmak için: Ctrl + C')
  console.log('──────────────────────────────────────────────\n')
}, 1500)

process.on('SIGINT', () => stopAll(0))
process.on('SIGTERM', () => stopAll(0))
