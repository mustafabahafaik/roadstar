import { AbiCoder, keccak256 } from 'ethers'

// Tohumlu rastgelelik, zincirle uyumlu: her token için hash = keccak256(abi.encode(roomId, index)).
// Aynı roomId + index → her zaman aynı hash. Kontrat (contracts/src/RaceItems.sol → itemAt)
// birebir aynı hesabı yapar; böylece zincir, oyunun gösterdiği token türünü kendisi doğrulayabilir.

// Token hash'i: iki sayıyı 32'şer bayt yan yana diz (abi.encode), keccak256'dan geçir.
// BigInt: 256 bitlik sayılar için (normal JS sayıları ~2^53'ten sonra hassasiyet kaybeder)
const abi = AbiCoder.defaultAbiCoder() // Solidity'deki abi.encode'un JS karşılığı

export function itemHash(roomId, index) {
  const data = abi.encode(['uint256', 'uint256'], [BigInt(roomId), BigInt(index)])
  return BigInt(keccak256(data))
}

// Tür: kontrattaki itemAt ile AYNI eşikler (tam sayılarla, ondalık yok → iki tarafta bit bit aynı sonuç)
// hash % 10000 → 0..9999: 0-499 Altın (%5); kalan 9500'ün %40'ı Thrust, %20'şer Kalkan / Mıknatıs / Rush
export function itemTypeFromHash(hash) {
  let roll = hash % 10000n
  if (roll < 500n) return 4 // Altın
  roll -= 500n
  if (roll < 3800n) return 0 // Thrust Cell
  if (roll < 5700n) return 1 // Kalkan
  if (roll < 7600n) return 2 // Mıknatıs
  return 3 // Block Rush
}

// Konum gibi zincirin bilmesi gerekmeyen özellikler için 0–1 arası sayı.
// slot 0, 1, 2…: hash'in farklı 32 bitlik parçaları (>> kaydır, & 0xffffffff ile 32 bit al)
export function hashFraction(hash, slot) {
  const shift = BigInt(64 + slot * 32)
  return Number((hash >> shift) & 0xffffffffn) / 4294967296
}
