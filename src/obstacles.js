import * as THREE from 'three'
import { neon } from './neon.js'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'
import { trackCurve, TRACK_WIDTH } from './track.js'
import { createTruck } from './truck.js'

// Her engel bir veri satırı. İleride arabayla çarpışmayı da bu listeden kontrol edeceğiz.
// u      → turun neresinde (0 = başlangıç, 0.5 = yarısı, 1 = tur sonu)
// type   → 'wall' (tam duvar, atla) | 'tower' (yarım blok: kaç ya da Space basılı uç) | 'truck' (tır, kaç ya da atla)
// offset → yolda yan konum (-1 = sol kenar, 0 = orta, 1 = sağ kenar)
// width / height → wall ve tower için boyut (tırın boyutu truck.js'te sabit)
// color  → tır rengi: 'white' | 'blue'
// Aralık 0.075 ≈ 145 birim ≈ tam hızda 2 saniye: bir engeli aşıp yere inmeye vakit kalır
export const obstacles = [
  { u: 0.07, type: 'wall', offset: 0, width: 16, height: 4 },
  { u: 0.145, type: 'tower', offset: -0.5, width: 8, height: 7 },
  { u: 0.22, type: 'tower', offset: 0.5, width: 8, height: 7 },
  { u: 0.295, type: 'truck', offset: 0.5, color: 'white' },
  { u: 0.37, type: 'wall', offset: 0, width: 16, height: 5 },
  { u: 0.445, type: 'truck', offset: -0.5, color: 'blue' },
  { u: 0.52, type: 'tower', offset: 0.5, width: 8, height: 7 },
  { u: 0.595, type: 'wall', offset: 0, width: 16, height: 4 },
  { u: 0.67, type: 'tower', offset: -0.5, width: 8, height: 7 },
  { u: 0.745, type: 'truck', offset: 0.5, color: 'white' },
  { u: 0.82, type: 'wall', offset: 0, width: 16, height: 6 },
  { u: 0.895, type: 'tower', offset: 0.5, width: 8, height: 7 },
]

const ROAD_HALF_WIDTH = TRACK_WIDTH / 2
export const TOWER_TOP_RATIO = 0.6 // kulenin tepesi tabanının bu oranı kadar geniş (car.js çarpışmada da kullanır)

// Malzemeler bir kez oluşturulup tüm engellerde paylaşılır (GPU için daha ucuz)
// MeshStandardMaterial ışığa tepki verir: metalness = metalik görünüm, roughness = pürüzlülük
const bodyMaterial = new THREE.MeshStandardMaterial({
  color: 0x1b0a35,
  metalness: 0.6,
  roughness: 0.35,
})
const pinkNeon = neon(0xff2bd6)
const cyanNeon = neon(0x00f0ff)

// Bariyer: yuvarlak köşeli koyu gövde + üstte ve ortada parlayan şeritler
function createWall(width, height) {
  const group = new THREE.Group()
  const depth = 2

  // RoundedBoxGeometry(genişlik, yükseklik, derinlik, köşe parça sayısı, köşe yarıçapı)
  const body = new THREE.Mesh(new RoundedBoxGeometry(width, height, depth, 4, 0.5), bodyMaterial)
  body.position.y = height / 2 // tabanı y = 0'a otursun
  group.add(body)

  // Şeritler gövdeden biraz daha derin → ön ve arka yüzden dışarı taşar, çizgi gibi görünür
  const topStrip = new THREE.Mesh(new THREE.BoxGeometry(width - 0.6, 0.35, depth + 0.1), pinkNeon)
  topStrip.position.y = height - 0.4
  group.add(topStrip)

  const midStrip = new THREE.Mesh(new THREE.BoxGeometry(width * 0.85, 0.25, depth + 0.12), cyanNeon)
  midStrip.position.y = height * 0.45
  group.add(midStrip)

  return group
}

// Kule: yukarı doğru incelen kare gövde + etrafında neon halkalar
function createTower(width, height) {
  const group = new THREE.Group()
  const topWidth = width * TOWER_TOP_RATIO

  // 4 kenarlı silindir = kare kesitli kule. Yarıçap köşeye kadar olan uzaklık, yani kenar / √2
  const body = new THREE.Mesh(
    new THREE.CylinderGeometry(topWidth / Math.SQRT2, width / Math.SQRT2, height, 4),
    bodyMaterial,
  )
  body.rotation.y = Math.PI / 4 // köşeler yerine düz yüzler yola baksın
  body.position.y = height / 2
  group.add(body)

  // Halkalar: kulenin o yükseklikteki genişliğinden biraz büyük ince dilimler
  for (const t of [0.2, 0.5, 0.8]) {
    const w = THREE.MathUtils.lerp(width, topWidth, t) + 0.3 // lerp: iki değer arasında t oranında ara değer
    const ring = new THREE.Mesh(new THREE.CylinderGeometry(w / Math.SQRT2, w / Math.SQRT2, 0.3, 4), pinkNeon)
    ring.rotation.y = Math.PI / 4
    ring.position.y = height * t
    group.add(ring)
  }

  // Tepede parlayan küçük bir başlık
  const cap = new THREE.Mesh(new THREE.BoxGeometry(topWidth * 0.7, 0.4, topWidth * 0.7), cyanNeon)
  cap.position.y = height + 0.2
  group.add(cap)

  return group
}

export function createObstacles() {
  const group = new THREE.Group()
  const up = new THREE.Vector3(0, 1, 0)

  for (const o of obstacles) {
    const center = trackCurve.getPointAt(o.u)
    const tangent = trackCurve.getTangentAt(o.u)
    const side = new THREE.Vector3().crossVectors(tangent, up).normalize()

    let model
    if (o.type === 'wall') model = createWall(o.width, o.height)
    else if (o.type === 'tower') model = createTower(o.width, o.height)
    else model = createTruck(o.color)

    // Yolda yana kaydır (modellerin tabanı y = 0'da, ekstra kaldırmaya gerek yok)
    model.position.copy(center).addScaledVector(side, o.offset * ROAD_HALF_WIDTH)

    if (o.type === 'truck') {
      // Tır yokuşa yatsın ve önü bize (gelen arabaya) dönük dursun → ters yöne bak
      model.lookAt(model.position.clone().sub(tangent))
    } else {
      // Duvar ve kuleler yokuşta da dimdik dursun → tangent'ın y'sini sıfırla
      const flatTangent = new THREE.Vector3(tangent.x, 0, tangent.z)
      model.lookAt(model.position.clone().add(flatTangent))
    }

    group.add(model)
  }

  return group
}
