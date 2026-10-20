// Test botu (komut satırından): odaya katılır, hazır olur, botPilot.js'in sürüşüyle yarışır, bitince yeniden katılır.
// Tek tarayıcı sekmesiyle çok oyunculu denemek için (iki 3D sekme ekran kartını çok yorar).
// Not: bu bot sunucunun gizli bot anahtarını bilmez → sunucu onu insan sayar, cüzdanı yoktur (ücretli odaya giremez).
// Boş koltukları dolduran gerçek botlar sunucunun içinde çalışır (bots.js, BOT_KEYS).
//
// Kullanım (kök klasörde, sunucu açıkken):  node server/bot.js [oda] [isim] [azami hız]
//   örnek: node server/bot.js monad Test 60
import { createBotPilot } from './botPilot.js'

const [room = 'monad', name = 'Test', speedArg = '66'] = process.argv.slice(2)
const SERVER_URL = process.env.SERVER_URL ?? 'http://localhost:3001'

function race() {
  createBotPilot({
    serverUrl: SERVER_URL,
    room,
    name,
    topSpeed: Number(speedArg),
    onDone: () => setTimeout(race, 2000), // bir sonraki yarış için yeniden katıl
  })
}
race()
