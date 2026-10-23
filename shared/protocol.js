// Sunucu (server/index.js) ve oyun (src/) AYNI dosyayı kullanır: iki taraf farklı sayılara bakarsa
// (ör. azami hız) hile kontrolü dürüst oyuncuyu reddeder. Bu dosyada three.js ya da tarayıcı kodu yok.

export const RACE_LENGTH = 3000 // pist uzunluğu (birim). track.js buradan alır
export const MAX_PLAYERS = 5 // bir odada en fazla
export const MIN_PLAYERS = 2 // "herkes hazır" ile başlamak için en az (tek kişi: lobide "Tek başına")
export const COUNTDOWN_MS = 3000 // sunucu "şu kadar ms sonra başla" der
// Herkes hazır olunca yarıştan önce bahis süresi: izleyiciler QR'dan "kim kazanır?" der. Kapanış anı sunucunun
// bettingEndsAt'i (herkese aynı sayı); sonra COUNTDOWN_MS'lik geri sayım ve yarış
export const BETTING_MS = 30 * 1000
// DNF (bitiremedi) sadece: bağlantı kopması, bu süre içinde bitirememek ya da "Yarıştan çık". Düşmek DNF değil
export const RACE_TIMEOUT_MS = 5 * 60 * 1000

// Saniyede kaç kez durum gönderilir. 60 yerine 20: ağ trafiği 3 kat az, aradaki kareleri alıcı
// interpolasyonla (ara değerleme) kendisi doldurur. Sunucu her durumu beklemeden odadakilere iletir
export const SEND_RATE = 20 // oyuncu → sunucu → odadaki diğerleri
// Sunucunun oda bakım döngüsü (lobi zamanlayıcıları, botlar, zaman aşımı). Durum YAYMAZ: o artık anında
export const TICK_RATE = 15

// Hile kontrolü: pist boyunca en yüksek hız. car.js MAX_SPEED 70 × boost 2 = 140
export const MAX_TRACK_SPEED = 140 // birim / saniye

// Gaz limitleri: oyun (src/chain.js), botlar ve betikler (scripts/) aynı sayıları kullanır.
// Monad ücreti KULLANILAN gazdan değil LİMİTTEN keser: limit = ölçülen en kötü durum + %15 (scripts/gas-measure.js).
// Ölçüm 2026-10-24, Monad testnet, eth_estimateGas + state override. En kötü durumlar: yeni kontratta ilk yarış
// (startRace 100.3k), yarışın ilk toplaması (collect 102.8k), odanın ilk girişi (joinRoom 110.3k), 5 kişilik settle (193.1k).
// İşlem anında estimateGas kullanmıyoruz: fazladan RPC (gecikme) ve iyimser akışta yanlış sonuç (ör. collect
// henüz işlenmeden useSkill tahmini "token yok" der; aynı anda giren iki kişiden hangisinin odayı başlatacağı belli değil)
export const RACE_GAS_LIMITS = { startRace: 116000n, collect: 119000n, useSkill: 74000n, finishRace: 44000n }
export const POOL_GAS_LIMITS = { createRoom: 115000n, joinRoom: 127000n, settle: 223000n, withdraw: 50000n, refund: 63000n }
export const GARAGE_GAS_LIMITS = { buy: 86000n, equip: 90000n }
// BetPool (izleyici bahsi). Sadece izleyicinin işlemleri sabit limitli; sunucunun işlemleri (openBets, settleBets,
// payout, airdrop) estimateGas ile: sunucu iyimser akışta değil, tahmin doğru çıkar
// Ölçüm (scripts/gas-measure.js, Monad): placeBet 104.2k (ilk ve 51. bahis aynı), claim 41.9k
export const BET_GAS_LIMITS = { placeBet: 120000n, claim: 49000n }
export const TRANSFER_GAS = 21000n // düz MON gönderimi: her zaman tam bu kadar (scripts/fund.js)

// Ücretli odanın giriş ücreti (wei): odayı kuran oyun bunu yazar, botlar ve sunucu zincirdeki odadan okur.
// 0.05 MON: testnet bütçesi kısıtlı. Değiştirirsen server BOT_LOW_BALANCE'ı da düşün (scripts/budget.js gösterir)
export const ENTRY_FEE = 50_000_000_000_000_000n

// İzleyici bahsi (BetPool.BET_AMOUNT ile aynı): herkes aynı tutarı yatırır, oran = havuz / kazanana yatırılan
export const BET_AMOUNT = 10_000_000_000_000_000n // 0.01 MON
// Faucet: yeni izleyicinin burner'ına bir kez. 0.01 bahis + placeBet gazı (120k × ~112 gwei ≈ 0.0134) sığar
export const FAUCET_AMOUNT = 25_000_000_000_000_000n // 0.025 MON

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
