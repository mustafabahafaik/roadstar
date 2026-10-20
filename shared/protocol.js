// Sunucu (server/index.js) ve oyun (src/) AYNI dosyayı kullanır: iki taraf farklı sayılara bakarsa
// (ör. azami hız) hile kontrolü dürüst oyuncuyu reddeder. Bu dosyada three.js ya da tarayıcı kodu yok.

export const RACE_LENGTH = 3000 // pist uzunluğu (birim). track.js buradan alır
export const MAX_PLAYERS = 5 // bir odada en fazla
export const MIN_PLAYERS = 2 // "herkes hazır" ile başlamak için en az (tek kişi: lobide "Tek başına")
export const COUNTDOWN_MS = 3000 // sunucu "şu kadar ms sonra başla" der

// Tick rate: saniyede kaç kez durum gönderilir. 60 yerine 15: ağ trafiği 4 kat az,
// aradaki kareleri alıcı interpolasyonla (ara değerleme) kendisi doldurur
export const SEND_RATE = 15 // oyuncu → sunucu
export const TICK_RATE = 15 // sunucu → odadaki herkes

// Hile kontrolü: pist boyunca en yüksek hız. car.js MAX_SPEED 70 × boost 2 = 140
export const MAX_TRACK_SPEED = 140 // birim / saniye

// RacePool işlemlerinin gaz limitleri (oyun ve botlar aynı değeri kullanır). Ölçüm: en kötü durum
// (5 kişilik oda, ilk kez yazılan alacaklar) + 21k taban + ~%30 pay. Monad ücreti LİMİT üzerinden keser.
// estimateGas kullanmıyoruz: aynı anda giren iki oyuncudan biri tahmin anında "son giren" değilken
// işlendiğinde son giren olabilir (odayı başlatmak daha pahalı) → tahmin edilen gaz yetmez
export const POOL_GAS_LIMITS = { createRoom: 140000n, joinRoom: 150000n, settle: 220000n, withdraw: 75000n, refund: 90000n }

// Oyuncu renkleri: odaya giriş sırasına göre (lobi listesi, araba boyası, isim etiketi)
export const PLAYER_COLORS = [0x00f0ff, 0xff3bd6, 0xffd23f, 0x7dff6b, 0xff7a3d]

// Oyuncunun "bu cüzdan adresi benim" kanıtı için imzaladığı metin (oyun imzalar, sunucu doğrular).
// socket.id her bağlantıda farklı → eski bir kanıt başka bir bağlantıda tekrar kullanılamaz
export const ownershipMessage = (socketId) => `Monad Racer: bu adres benim (${socketId})`

// Sıralama (sunucu da oyun da aynı kuralı kullanır):
// önce bitirenler (süreye göre), sonra yarışanlar ve en son DNF (ikisi de ilerlemeye göre)
const ORDER = { finished: 0, racing: 1, dnf: 2 }
export function rankPlayers(players) {
  return [...players].sort((a, b) => {
    const oa = ORDER[a.status] ?? 1 // countdown, falling... → yarışıyor say
    const ob = ORDER[b.status] ?? 1
    if (oa !== ob) return oa - ob
    if (a.status === 'finished') return a.finishMs - b.finishMs
    return b.progress - a.progress
  })
}
