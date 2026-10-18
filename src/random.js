// Tohumlu rastgelelik (seeded random): aynı girdiler → her zaman aynı "rastgele" sayı.
// Math.random() her açılışta farklıdır; bu fonksiyonlar ise roomId ve index'ten sayı HESAPLAR.
// Böylece aynı odadaki herkes aynı tokenları aynı yerlerde görür.

// 1) Yazıyı sayıya çevir: FNV-1a hash.
// Her karakteri sayıya karıştırıp asal bir sayıyla çarpar. "monad-1" ile "monad-2" çok farklı sayılar verir.
export function hashString(text) {
  let h = 0x811c9dc5 // FNV başlangıç değeri
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i) // ^ = XOR: bitleri karıştırır
    h = Math.imul(h, 0x01000193) // Math.imul: 32 bitlik tam sayı çarpımı (taşan kısım atılır)
  }
  return h >>> 0 // >>> 0 → işaretsiz 32 bitlik sayıya çevir (negatif olmasın)
}

// 2) seed + index + salt → 0 ile 1 arası sayı.
// salt: aynı token için farklı özellikler (konum, şerit, tür...) farklı sayılar alsın diye
export function seededRandom(seed, index, salt = 0) {
  let h = seed ^ Math.imul(index + 1, 0x9e3779b1) ^ Math.imul(salt + 1, 0x85ebca6b)
  // Karıştırma (murmur3'ün son adımı): kaydır, XOR'la, çarp. Yakın girdiler (index 5 ve 6)
  // tamamen farklı sonuçlar verir; sonuçlar 0–1 arasına eşit dağılır
  h ^= h >>> 16
  h = Math.imul(h, 0x85ebca6b)
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35)
  h ^= h >>> 16
  return (h >>> 0) / 4294967296 // 2^32'ye böl → [0, 1)
}
