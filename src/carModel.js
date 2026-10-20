import * as THREE from 'three'
import { neon } from './neon.js'
import { smoothTable, loft } from './loft.js'

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
const basePaint = new THREE.MeshPhysicalMaterial({
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
// rim: jant malzemesi (her arabanın kendi kopyası: garajdaki jant parçası bunu boyar)
function createWheel(outerSign, rim) {
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
  add(wheel, new THREE.CylinderGeometry(0.5, 0.5, WHEEL_WIDTH * 0.85, 40, 1, true), rim, 0, 0, 0)
  add(wheel, new THREE.CylinderGeometry(0.4, 0.4, 0.06, 32), carbon, 0, 0, 0)

  // Dış yüzde 10 ince kol + orta kapak
  const face = outerSign * (hw - 0.08)
  for (let i = 0; i < 10; i++) {
    const spoke = add(wheel, new THREE.BoxGeometry(0.07, 0.05, 0.46), rim, 0, face, 0)
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
// wingMaterial: kanat bıçağının malzemesi (her arabanın kendi kopyası: garajdaki kanat parçası bunu boyar)
function createWing(car, paint, wingMaterial) {
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
  const blade = add(car, bladeGeometry, wingMaterial, 0, wingY, wingZ)
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

// Alt neon: arabanın altında yola vuran parıltı (ortası parlak, kenarlara doğru sönen yuvarlak doku).
// Garajdaki "alt neon" parçası açar ve boyar; varsayılan kapalı
let underglowTexture = null
function createUnderglow() {
  if (!underglowTexture) {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 128
    const ctx = canvas.getContext('2d')
    const gradient = ctx.createRadialGradient(64, 64, 4, 64, 64, 64)
    gradient.addColorStop(0, 'rgba(255,255,255,1)')
    gradient.addColorStop(0.5, 'rgba(255,255,255,0.45)')
    gradient.addColorStop(1, 'rgba(255,255,255,0)')
    ctx.fillStyle = gradient
    ctx.fillRect(0, 0, 128, 128)
    underglowTexture = new THREE.CanvasTexture(canvas)
  }
  const material = new THREE.MeshBasicMaterial({
    map: underglowTexture,
    transparent: true,
    blending: THREE.AdditiveBlending, // ışık gibi: yolun rengine eklenir
    depthWrite: false,
  })
  material.userData.bloom = true // postfx.js: parlasın
  const glow = new THREE.Mesh(new THREE.PlaneGeometry(5.2, 11), material)
  glow.rotation.x = -Math.PI / 2 // yere yatır
  glow.position.y = 0.06 // yolun hemen üstü (araba tabanı y = 0)
  glow.renderOrder = 2
  glow.visible = false
  return glow
}

// color: boya rengi (rakip arabalar için). Verilmezse beyaz.
// Her araba boya, jant ve kanat malzemesinin KENDİ kopyasını alır: garaj parçaları (parts.js) sadece o arabayı boyar.
// ⚠️ Parçalar sadece görünüşü değiştirir: modelin ölçüleri ve car.js'teki çarpışma kutusu sabittir
export function createCarModel(color) {
  const car = new THREE.Group()
  const paint = basePaint.clone()
  if (color !== undefined) paint.color.set(color)
  const rim = alloy.clone()
  const wingMaterial = carbon.clone()
  const underglow = createUnderglow()
  car.add(underglow)
  car.userData.custom = { paint, rim, wing: wingMaterial, underglow, baseColor: paint.color.getHex() }

  // Gövde ve cam kabin
  car.add(new THREE.Mesh(loft(-4.75, 5.0, 150, 48, bodySection), paint))
  car.add(new THREE.Mesh(loft(-3.0, 1.95, 60, 40, canopySection), glass))

  // Şasi: tekerleklerin arasını dolduran koyu iç gövde (kemerlerden bakınca içi boş görünmesin)
  add(car, new THREE.BoxGeometry(2.5, 1.0, 7.6), satinBlack, 0, 0.95, -0.1)

  // Tekerlekler
  for (const p of WHEEL_POSITIONS) {
    const wheel = createWheel(p.x > 0 ? 1 : -1, rim)
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

  createWing(car, paint, wingMaterial)

  return car
}
