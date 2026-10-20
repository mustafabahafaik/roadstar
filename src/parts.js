import catalog from '../shared/parts.json' with { type: 'json' }

// Garaj parçaları: katalog (shared/parts.json: oyun, sunucu ve deploy betiği AYNI dosyayı okur) ve
// parçaları bir arabaya uygulama.
//
// ⚠️ PARÇALAR SADECE GÖRSEL. Burada yalnızca malzeme rengi, parlaklık ve görünürlük değişir:
//   - Hız: car.js MAX_SPEED / ACCELERATION parçalara hiç bakmaz
//   - Boyut ve çarpışma kutusu: car.js CAR_HALF_WIDTH / CAR_HALF_LENGTH sabit; modelin ölçüleri değişmez
//   - Sunucunun hile kontrolü (MAX_TRACK_SPEED) de parçalardan habersiz
// Yani parası olan daha hızlı ya da daha "ince" olamaz: parça sadece arabanın nasıl göründüğüdür.

export const SLOTS = catalog.slots // ['Boya', 'Jant', 'Arka kanat', 'Alt neon', 'İtici alevi']
export const SLOT = { PAINT: 0, RIMS: 1, WING: 2, UNDERGLOW: 3, FLAME: 4 }
export const PARTS = catalog.parts.map((p) => ({ ...p, price: BigInt(p.priceWei) })) // fiyat wei (BigInt)
export const partById = new Map(PARTS.map((p) => [p.id, p]))
export const partsInSlot = (slot) => PARTS.filter((p) => p.slot === slot)
// Her slotun ilk parçası ücretsiz varsayılan (kontrat da böyle tanımlar)
export const DEFAULT_LOADOUT = SLOTS.map((_, slot) => partsInSlot(slot)[0].id)

// Dışarıdan gelen loadout'u temizle: 5 eleman, her id kataloğda ve DOĞRU slotta; değilse o slotun varsayılanı.
// Sunucu da kullanır (rakip ne gönderirse göndersin, sadece var olan parçalar çizilir)
export function sanitizeLoadout(list) {
  return DEFAULT_LOADOUT.map((fallback, slot) => {
    const id = Number(Array.isArray(list) ? list[slot] : NaN)
    return partById.get(id)?.slot === slot ? id : fallback
  })
}

// Malzemeye parçanın rengini, metalikliğini, pürüzlülüğünü ve (varsa) neon parlamasını ver
function paintMaterial(material, part, color = part.color) {
  material.color.set(color)
  if (part.metal !== undefined) material.metalness = part.metal
  if (part.rough !== undefined) material.roughness = part.rough
  material.emissive.set(part.glow ? color : 0x000000)
  material.emissiveIntensity = part.glow ? 1.6 : 1
  material.userData.bloom = Boolean(part.glow) // postfx.js: neon parçalar parlasın
}

// model: createCarModel() sonucu. loadout: 5 parça id'si.
// playerColor: rakip arabalar için — varsayılan boyadaysa oyuncu rengiyle boya (yarışta birbirinden ayırt edilsin)
// thrusters / boost: sadece bizim arabamız için (alev rengi); rakiplerin alevi çizilmiyor
export function applyLoadout(model, loadout, { playerColor, thrusters, boost } = {}) {
  const custom = model.userData.custom
  const [paint, rims, wing, underglow, flame] = sanitizeLoadout(loadout).map((id) => partById.get(id))

  const paintColor = paint.id === DEFAULT_LOADOUT[SLOT.PAINT] && playerColor !== undefined ? playerColor : paint.color
  paintMaterial(custom.paint, paint, paintColor)
  paintMaterial(custom.rim, rims)
  paintMaterial(custom.wing, wing, wing.color === 'paint' ? paintColor : wing.color) // "Gövde Rengi": boyayla aynı

  custom.underglow.visible = underglow.color !== 'none'
  if (custom.underglow.visible) custom.underglow.material.color.set(underglow.color).multiplyScalar(1.6)

  thrusters?.setColor(flame.color)
  boost?.setFlameColor(flame.color)
}

// Kart üstündeki küçük renk örneği (CSS arka planı)
export function swatchCss(part, paintColor = '#f2f4f6') {
  if (part.color === 'none') return 'repeating-linear-gradient(45deg, #2a2d3a 0 4px, #11131c 4px 8px)'
  const color = part.color === 'paint' ? paintColor : part.color
  return part.glow || part.slot >= SLOT.UNDERGLOW
    ? `radial-gradient(circle, #fff 0 12%, ${color} 40%, transparent 72%)` // neon / alev: parlayan
    : `linear-gradient(135deg, #fff6 0 18%, ${color} 40%, #0006 100%)` // boya / jant: metalik
}
