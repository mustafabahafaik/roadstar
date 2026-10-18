import * as THREE from 'three'
import { neon } from './neon.js'

// --- Ölçüler (ön taraf +z, taban y = 0, uzunluk ≈ 9.7, genişlik ≈ 4.1) ---
const WHEEL_RADIUS = 0.72
const WHEEL_WIDTH = 0.7
const WHEEL_X = 1.68 // tekerleklerin merkeze yanal uzaklığı
const FRONT_AXLE = 2.95
const REAR_AXLE = -2.85
const ARCH_RADIUS = 0.86 // tekerlek kemeri yarıçapı (tekerlekten biraz büyük)

export const WHEEL_POSITIONS = [
  new THREE.Vector3(WHEEL_X, WHEEL_RADIUS, FRONT_AXLE),
  new THREE.Vector3(-WHEEL_X, WHEEL_RADIUS, FRONT_AXLE),
  new THREE.Vector3(WHEEL_X, WHEEL_RADIUS, REAR_AXLE),
  new THREE.Vector3(-WHEEL_X, WHEEL_RADIUS, REAR_AXLE),
]

// --- Malzemeler ---
const paint = new THREE.MeshPhysicalMaterial({
  color: 0xf2f4f6,
  metalness: 0.1,
  roughness: 0.3,
  clearcoat: 1, // araba boyasının üstündeki şeffaf vernik: keskin yansımalar verir
  clearcoatRoughness: 0.04,
})
const glass = new THREE.MeshPhysicalMaterial({
  color: 0x020306,
  metalness: 0.3,
  roughness: 0.03,
  clearcoat: 1,
  clearcoatRoughness: 0.02,
})
const carbon = new THREE.MeshStandardMaterial({ color: 0x14161b, metalness: 0.5, roughness: 0.4 })
const satinBlack = new THREE.MeshStandardMaterial({ color: 0x0c0d10, metalness: 0.2, roughness: 0.55 })
const rubber = new THREE.MeshStandardMaterial({ color: 0x0b0b0c, roughness: 0.92 })
const alloy = new THREE.MeshStandardMaterial({ color: 0x3a3e46, metalness: 1, roughness: 0.28 })
const chrome = new THREE.MeshStandardMaterial({ color: 0xc8ccd2, metalness: 1, roughness: 0.15 })
const plateMat = new THREE.MeshStandardMaterial({ color: 0xe9ebee, roughness: 0.5 })
const redPaint = new THREE.MeshStandardMaterial({ color: 0xb3121f, metalness: 0.3, roughness: 0.35 })
const tailLight = neon(0xff1424, 3)
const ledWhite = neon(0xe6f4ff, 3)

// --- Yardımcı: tablo değerleri arasını yumuşakça doldur (Hermite interpolasyonu) ---
// keys: [[z, değer], ...] — z sırasına göre. Her noktada eğim komşu noktalardan hesaplanır
function smoothTable(keys) {
  const n = keys.length
  const slope = (i) => {
    const a = keys[Math.max(0, i - 1)]
    const b = keys[Math.min(n - 1, i + 1)]
    return (b[1] - a[1]) / (b[0] - a[0])
  }
  return (z) => {
    if (z <= keys[0][0]) return keys[0][1]
    if (z >= keys[n - 1][0]) return keys[n - 1][1]
    let i = 0
    while (z > keys[i + 1][0]) i++
    const [z1, v1] = keys[i]
    const [z2, v2] = keys[i + 1]
    const h = z2 - z1
    const t = (z - z1) / h
    const t2 = t * t
    const t3 = t2 * t
    return (
      (2 * t3 - 3 * t2 + 1) * v1 +
      (t3 - 2 * t2 + t) * h * slope(i) +
      (-2 * t3 + 3 * t2) * v2 +
      (t3 - t2) * h * slope(i + 1)
    )
  }
}

// --- Gövde profili: burundan (z = 5) kuyruğa (z = -4.75) ---
const bodyTop = smoothTable([
  [-4.75, 1.42], [-4.58, 2.02], [-4.3, 2.13], [-3.6, 2.06], [-2.6, 1.98], [-1.2, 1.93],
  [0.4, 1.9], [1.5, 1.86], [2.4, 1.8], [2.95, 1.75], [3.7, 1.52], [4.35, 1.22], [4.8, 0.94], [5.0, 0.74],
])
const bodyBaseBottom = smoothTable([[-4.75, 0.62], [-4.4, 0.42], [4.4, 0.42], [5.0, 0.56]])
const bodyHalfWidth = smoothTable([
  [-4.75, 1.6], [-4.3, 1.9], [-3.4, 2.05], [-2.85, 2.08], [-2.0, 2.0], [-0.5, 1.94],
  [1.0, 1.94], [2.2, 1.98], [2.95, 2.03], [3.8, 1.9], [4.5, 1.56], [5.0, 0.98],
])
// Alt çizgi tekerleklerin üstünde yay çizerek yükselir → tekerlek kemerleri
function bodyBottom(z) {
  let y = bodyBaseBottom(z)
  for (const axle of [FRONT_AXLE, REAR_AXLE]) {
    const dz = z - axle
    if (Math.abs(dz) < ARCH_RADIUS) y = Math.max(y, WHEEL_RADIUS + Math.sqrt(ARCH_RADIUS ** 2 - dz * dz))
  }
  return y
}

// Kabin (cam kubbe): gövdeden dar, üstü daha çok daralan
const canopyTop = smoothTable([
  [-3.0, 2.0], [-2.4, 2.3], [-1.4, 2.56], [-0.3, 2.68], [0.6, 2.56], [1.3, 2.2], [1.95, 1.84],
])
const canopyHalfWidth = smoothTable([[-3.0, 1.15], [-2.0, 1.42], [-0.5, 1.5], [0.8, 1.45], [1.95, 1.18]])

// --- Loft: arka arkaya dizilmiş kesitlerden (halka) yüzey örer ---
// section(z) → { top, bottom, halfWidth, powerTop, powerBottom, tumble }
//   power  → kesitin köşeliliği (2 = elips, büyüdükçe yuvarlatılmış dikdörtgen)
//   tumble → üst kısmın ne kadar daraldığı (arabaların yanları yukarı doğru içe yatar)
function loft(zStart, zEnd, slices, ringSize, section) {
  const positions = []
  const indices = []

  const ringPoint = (z, angle, s) => {
    const c = Math.cos(angle)
    const sn = Math.sin(angle)
    const power = sn >= 0 ? s.powerTop : s.powerBottom
    // Süper elips: |x|^p + |y|^p = 1 eğrisi üzerinde nokta
    const sx = Math.sign(c) * Math.abs(c) ** (2 / power)
    const sy = Math.sign(sn) * Math.abs(sn) ** (2 / power)
    const cy = (s.top + s.bottom) / 2
    const hy = (s.top - s.bottom) / 2
    const narrow = 1 - s.tumble * Math.max(0, sy)
    return [sx * s.halfWidth * narrow, cy + sy * hy, z]
  }

  for (let i = 0; i <= slices; i++) {
    const z = zStart + ((zEnd - zStart) * i) / slices
    const s = section(z)
    for (let j = 0; j < ringSize; j++) positions.push(...ringPoint(z, (j / ringSize) * Math.PI * 2, s))
  }
  for (let i = 0; i < slices; i++) {
    for (let j = 0; j < ringSize; j++) {
      const a = i * ringSize + j
      const b = i * ringSize + ((j + 1) % ringSize)
      const c = a + ringSize
      const d = b + ringSize
      indices.push(a, b, c, b, d, c) // bu sıra yüzeyin dışarı bakmasını sağlar
    }
  }

  // Uç kapakları (ayrı köşelerle, kenarları keskin kalsın)
  const addCap = (z, facingFront) => {
    const s = section(z)
    const center = positions.length / 3
    positions.push(0, (s.top + s.bottom) / 2, z)
    for (let j = 0; j < ringSize; j++) positions.push(...ringPoint(z, (j / ringSize) * Math.PI * 2, s))
    for (let j = 0; j < ringSize; j++) {
      const p = center + 1 + j
      const q = center + 1 + ((j + 1) % ringSize)
      if (facingFront) indices.push(center, p, q)
      else indices.push(center, q, p)
    }
  }
  addCap(zEnd, true)
  addCap(zStart, false)

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setIndex(indices)
  geometry.computeVertexNormals()
  return geometry
}

const bodySection = (z) => ({
  top: bodyTop(z),
  bottom: bodyBottom(z),
  halfWidth: bodyHalfWidth(z),
  powerTop: 3.2,
  powerBottom: 6, // alt kısım daha köşeli: yanlar dik iner
  tumble: 0.12,
})
const canopySection = (z) => ({
  top: canopyTop(z),
  bottom: bodyTop(z) - 0.1, // alt yarısı gövdenin içinde kalır
  halfWidth: canopyHalfWidth(z),
  powerTop: 2.6,
  powerBottom: 2.6,
  tumble: 0.35,
})

// Gövde yüzeyinde, verilen z ve yükseklikteki yan noktanın x değeri (parçaları yüzeye oturtmak için)
function bodySideX(z, y) {
  const s = bodySection(z)
  const sy = THREE.MathUtils.clamp(((y - s.bottom) / (s.top - s.bottom)) * 2 - 1, -1, 1)
  const p = sy >= 0 ? s.powerTop : s.powerBottom
  return s.halfWidth * (1 - Math.abs(sy) ** p) ** (1 / p) * (1 - s.tumble * Math.max(0, sy))
}

// Küçük yardımcı: geometri + malzeme + konum → gruba ekle
function add(group, geometry, material, x, y, z) {
  const mesh = new THREE.Mesh(geometry, material)
  mesh.position.set(x, y, z)
  group.add(mesh)
  return mesh
}

// --- Tekerlek: yuvarlak omuzlu lastik + çok kollu jant + fren diski ---
function createWheel(outerSign) {
  const wheel = new THREE.Group()
  const r = WHEEL_RADIUS
  const hw = WHEEL_WIDTH / 2

  // LatheGeometry: 2B profili bir eksen etrafında döndürerek şekil yapar (çömlekçi tornası gibi)
  const tireProfile = [
    [0.5, -hw], [0.64, -hw], [0.7, -hw + 0.05], [r, -hw + 0.16],
    [r, hw - 0.16], [0.7, hw - 0.05], [0.64, hw], [0.5, hw],
  ].map(([x, y]) => new THREE.Vector2(x, y))
  wheel.add(new THREE.Mesh(new THREE.LatheGeometry(tireProfile, 48), rubber))

  // Jant göbeği ve fren diski
  add(wheel, new THREE.CylinderGeometry(0.5, 0.5, WHEEL_WIDTH * 0.85, 40, 1, true), alloy, 0, 0, 0)
  add(wheel, new THREE.CylinderGeometry(0.4, 0.4, 0.06, 32), carbon, 0, 0, 0)

  // Dış yüzde 10 ince kol + orta kapak
  const face = outerSign * (hw - 0.08)
  for (let i = 0; i < 10; i++) {
    const spoke = add(wheel, new THREE.BoxGeometry(0.07, 0.05, 0.46), alloy, 0, face, 0)
    const angle = (i / 10) * Math.PI * 2
    spoke.rotation.y = angle
    spoke.position.x = Math.sin(angle) * 0.25
    spoke.position.z = Math.cos(angle) * 0.25
  }
  add(wheel, new THREE.CylinderGeometry(0.1, 0.1, 0.08, 20), chrome, 0, face, 0)

  // Silindirler y ekseninde durur; z etrafında 90° çevirince aks x ekseni olur
  wheel.rotation.z = -Math.PI / 2
  return wheel
}

// --- Arka kanat: kuğu boynu taşıyıcılar + karbon kanat + açılı beyaz yan plakalar ---
function createWing(car) {
  const wingZ = -4.2
  const wingY = 3.05

  // Taşıyıcılar: kanadı üstten tutan "kuğu boynu" şeklinde kavisli borular
  for (const x of [-0.65, 0.65]) {
    const curve = new THREE.QuadraticBezierCurve3(
      new THREE.Vector3(x, bodyTop(-3.6) - 0.05, -3.6),
      new THREE.Vector3(x, wingY + 0.55, -3.7),
      new THREE.Vector3(x, wingY + 0.05, wingZ),
    )
    car.add(new THREE.Mesh(new THREE.TubeGeometry(curve, 16, 0.055, 8), carbon))
  }

  // Kanat profili: önü kalın, arkası ince damla (ExtrudeGeometry ile genişliğine uzatılır)
  const foil = new THREE.Shape()
  foil.moveTo(0.55, 0)
  foil.quadraticCurveTo(0.5, 0.1, 0.1, 0.09)
  foil.quadraticCurveTo(-0.4, 0.06, -0.55, 0.02)
  foil.lineTo(-0.55, -0.01)
  foil.quadraticCurveTo(0.0, -0.03, 0.55, 0)
  const bladeGeometry = new THREE.ExtrudeGeometry(foil, { depth: 3.7, bevelEnabled: false, curveSegments: 12 })
  bladeGeometry.rotateY(-Math.PI / 2) // şeklin x'i → arabanın z'si
  bladeGeometry.translate(1.85, 0, 0) // genişlikte ortala
  const blade = add(car, bladeGeometry, carbon, 0, wingY, wingZ)
  blade.rotation.x = -0.12 // hücum açısı: arabayı yola bastırır

  // Yan plakalar: geriye doğru genişleyen yamuk
  const plate = new THREE.Shape()
  plate.moveTo(0.6, -0.15)
  plate.lineTo(-0.7, -0.35)
  plate.lineTo(-0.85, 0.55)
  plate.lineTo(0.35, 0.3)
  plate.lineTo(0.6, -0.15)
  for (const x of [-1.88, 1.88]) {
    const g = new THREE.ExtrudeGeometry(plate, { depth: 0.05, bevelEnabled: false })
    g.rotateY(-Math.PI / 2)
    g.translate(0.025, 0, 0)
    add(car, g, paint, x, wingY, wingZ)
  }
}

export function createCarModel() {
  const car = new THREE.Group()

  // Gövde ve cam kabin
  car.add(new THREE.Mesh(loft(-4.75, 5.0, 150, 48, bodySection), paint))
  car.add(new THREE.Mesh(loft(-3.0, 1.95, 60, 40, canopySection), glass))

  // Şasi: tekerleklerin arasını dolduran koyu iç gövde (kemerlerden bakınca içi boş görünmesin)
  add(car, new THREE.BoxGeometry(2.5, 1.0, 7.6), satinBlack, 0, 0.95, -0.1)

  // Tekerlekler
  for (const p of WHEEL_POSITIONS) {
    const wheel = createWheel(p.x > 0 ? 1 : -1)
    wheel.position.copy(p)
    car.add(wheel)
  }

  for (const side of [-1, 1]) {
    // Yan etek (iki aks arasında)
    add(car, new THREE.BoxGeometry(0.14, 0.2, 4.0), carbon, side * (bodySideX(0, 0.55) - 0.02), 0.52, 0.05)

    // Yan hava girişi: kapının arkasında koyu panel
    const intake = add(car, new THREE.BoxGeometry(0.06, 0.48, 1.1), satinBlack, side * bodySideX(-1.4, 1.25), 1.25, -1.4)
    intake.rotation.y = side * 0.06

    // Yan ayna: ince karbon kol + beyaz kapak
    add(car, new THREE.BoxGeometry(0.35, 0.06, 0.12), carbon, side * 1.5, 1.98, 1.35)
    add(car, new THREE.BoxGeometry(0.34, 0.2, 0.42), paint, side * 1.78, 2.06, 1.32)

    // İnce LED far: burnun köşelerinde, yatık
    const z = 4.45
    const light = add(car, new THREE.BoxGeometry(0.75, 0.05, 0.1), ledWhite, side * 1.1, bodyTop(z) - 0.04, z)
    light.rotation.y = side * 0.35
    light.rotation.x = 0.35
  }

  // Ön: kırmızı splitter dudağı ve alt hava girişi
  add(car, new THREE.BoxGeometry(2.3, 0.05, 0.7), redPaint, 0, 0.4, 4.72)
  const grille = add(car, new THREE.BoxGeometry(1.9, 0.2, 0.08), satinBlack, 0, 0.6, 4.96)
  grille.rotation.x = -0.4

  // Arka: tam genişlik kırmızı ışık şeritleri, plaka, difüzör, 4 egzoz
  add(car, new THREE.BoxGeometry(2.6, 0.07, 0.05), tailLight, 0, 1.3, -4.77)
  add(car, new THREE.BoxGeometry(3.0, 0.05, 0.05), tailLight, 0, 1.92, -4.62)
  add(car, new THREE.BoxGeometry(0.8, 0.32, 0.03), plateMat, 0, 1.0, -4.77)

  add(car, new THREE.BoxGeometry(2.9, 0.34, 0.7), carbon, 0, 0.42, -4.45)
  for (let i = -2; i <= 2; i++) {
    add(car, new THREE.BoxGeometry(0.04, 0.32, 0.65), carbon, i * 0.55, 0.36, -4.6) // difüzör kanatçıkları
  }
  for (const x of [-0.95, -0.32, 0.32, 0.95]) {
    const pipe = add(car, new THREE.CylinderGeometry(0.13, 0.13, 0.3, 24, 1, true), chrome, x, 0.74, -4.7)
    pipe.rotation.x = Math.PI / 2
    add(car, new THREE.TorusGeometry(0.13, 0.022, 8, 28), tailLight, x, 0.74, -4.85)
  }

  createWing(car)

  return car
}
