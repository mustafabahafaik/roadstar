import { io } from 'socket.io-client'

// Sunucu adresi TEK yerden: kök klasördeki .env → VITE_SERVER_URL=http://localhost:3001
// (Vite sadece VITE_ ile başlayan değişkenleri oyuna verir). İnternete yükleyince burayı değiştirmek yeter
export const SERVER_URL = import.meta.env.VITE_SERVER_URL || 'http://localhost:3001'

const CLOCK_SAMPLES = 5 // saat eşitlemede kaç ping/pong
const CLOCK_RESYNC_MS = 10000 // saatler zamanla kayar: arada bir yeniden eşitle
const CONNECT_TIMEOUT_MS = 4000

// Çok oyunculu bağlantı: sunucuyla tüm konuşma buradan geçer
export function createNet() {
  const socket = io(SERVER_URL, { autoConnect: false, reconnection: false })
  let offset = 0 // sunucu saati − bizim saatimiz (ms)
  let rtt = null // gidiş-dönüş süresi (ms): HUD'da "ping"
  let resyncTimer = null

  // Ping/pong ile saat farkı: t0 (gönderdik) → sunucu ts yazar → t1 (cevap geldi).
  // Cevap yolun ortasında yazıldı → o an bizim saatimiz ≈ (t0 + t1) / 2. Fark = ts − (t0 + t1) / 2.
  // Birkaç deneme içinden RTT'si en kısa olanı seç: yolculuk kısaysa tahmin hatası da küçüktür
  async function syncClock() {
    let best = null
    for (let i = 0; i < CLOCK_SAMPLES; i++) {
      const t0 = Date.now()
      const ts = await socket.timeout(2000).emitWithAck('clock')
      const t1 = Date.now()
      if (!best || t1 - t0 < best.rtt) best = { rtt: t1 - t0, offset: ts - (t0 + t1) / 2 }
    }
    offset = best.offset
    rtt = best.rtt
  }

  // Bağlan + saati eşitle. Sunucu yoksa hata fırlatır (lobi "Tek başına" seçeneği sunar)
  function connect() {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => fail(new Error('zaman aşımı')), CONNECT_TIMEOUT_MS)
      const fail = (err) => {
        clearTimeout(timer)
        socket.off('connect', ok)
        socket.disconnect()
        reject(err)
      }
      const ok = async () => {
        clearTimeout(timer)
        socket.off('connect_error', fail)
        try {
          await syncClock()
          resyncTimer = setInterval(() => syncClock().catch(() => {}), CLOCK_RESYNC_MS)
          resolve()
        } catch (err) {
          reject(err)
        }
      }
      socket.once('connect', ok)
      socket.once('connect_error', fail)
      socket.connect()
    })
  }
  socket.on('disconnect', () => clearInterval(resyncTimer))

  return {
    connect,
    get connected() {
      return socket.connected
    },
    get id() {
      return socket.id
    },
    get rtt() {
      return rtt
    },
    // Sunucunun şu anki saati (ms). Başlangıç anı ve yarış süresi bu saatle hesaplanır
    serverNow: () => Date.now() + offset,
    join: (name, room) => socket.timeout(4000).emitWithAck('join', { name, room }),
    setReady: (ready) => socket.emit('ready', ready),
    // volatile: bağlantı o an meşgulse bu paketi at, 66 ms sonra yenisi zaten gelecek
    sendState: (state) => socket.volatile.emit('state', state),
    // Son durum volatile DEĞİL: sunucu bitişi kabul etmek için son ilerlemeyi mutlaka görmeli
    finish: (finalState) => {
      socket.emit('state', finalState)
      socket.emit('finish')
    },
    dnf: () => socket.emit('dnf'),
    on: (event, listener) => socket.on(event, listener),
  }
}
