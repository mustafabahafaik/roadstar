import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'
import { neon } from './neon.js'
import { smoothTable, loft } from './loft.js'

// Tırın kaba boyutları — ileride çarpışma kontrolünde de kullanacağız
export const TRUCK_SIZE = { width: 6, height: 9, length: 22 }

// --- Ölçüler (ön taraf +z, taban y = 0, z = -11 … +11) ---
const HALF_W = TRUCK_SIZE.width / 2
const TIRE_R = 1.15
const TIRE_W = 0.75
const FRONT_AXLE = 9.2
const DRIVE_AXLES = [2.4, 0.9] // çekici arka aksları (dorsenin önünün altında)
const TRAILER_AXLES = [-7.6, -9.1]
const CAB_REAR = 4.0
const CAB_FRONT = 11.0
const TRAILER_FRONT = 3.6
const TRAILER_REAR = -11.0
const TRAILER_FLOOR = 2.5 // lastiklerin üstünde kalmalı (2 × 1.15 = 2.3)
const TRAILER_TOP = 9.0

// --- Malzemeler ---
const PAINTS = {
  white: { color: 0xf3f5f7, metalness: 0.15, roughness: 0.32 },
  blue: { color: 0x1d5bd8, metalness: 0.55, roughness: 0.28 },
}
const paintCache = {}
function paintMaterial(name) {
  // ??= → yoksa oluştur, varsa aynısını kullan (her tır için yeni malzeme yaratmayalım)
  return (paintCache[name] ??= new THREE.MeshPhysicalMaterial({
    ...(PAINTS[name] ?? PAINTS.white),
    clearcoat: 1,
    clearcoatRoughness: 0.05,
  }))
}
const glass = new THREE.MeshPhysicalMaterial({ color: 0x03050a, metalness: 0.3, roughness: 0.04, clearcoat: 1 })
const trim = new THREE.MeshStandardMaterial({ color: 0x111317, metalness: 0.3, roughness: 0.55 })
const chassisMat = new THREE.MeshStandardMaterial({ color: 0x1a1c21, metalness: 0.5, roughness: 0.5 })
const rubber = new THREE.MeshStandardMaterial({ color: 0x0b0b0c, roughness: 0.92 })
const hubMat = new THREE.MeshStandardMaterial({ color: 0x2b2e35, metalness: 0.85, roughness: 0.3 })
const chrome = new THREE.MeshStandardMaterial({ color: 0xc9cdd3, metalness: 1, roughness: 0.15 })
const headlight = neon(0xeaf6ff, 3)
const amber = neon(0xffa024, 3)
const red = neon(0xff1a24, 3)

// --- Kabin profili: arkadan (z = 4) buruna (z = 11) ---
// Çatı dorse hizasında düz, sonra büyük ön cam boyunca kısa buruna doğru alçalır (mermi şekli)
const cabTop = smoothTable([
  [4.0, 8.75], [7.4, 8.8], [8.05, 8.55], [8.7, 7.75], [9.5, 6.6], [10.15, 5.3], [10.6, 4.25], [10.88, 3.3], [11.0, 2.3],
])
const cabBaseBottom = smoothTable([[4.0, 0.95], [10.5, 0.95], [11.0, 1.15]])
const cabHalfWidth = smoothTable([[4.0, 2.95], [8.0, 3.0], [9.8, 2.97], [10.6, 2.82], [11.0, 2.45]])
const ARCH_R = TIRE_R + 0.2

function cabBottom(z) {
  const dz = z - FRONT_AXLE
  const arch = Math.abs(dz) < ARCH_R ? TIRE_R + Math.sqrt(ARCH_R ** 2 - dz * dz) : 0
  return Math.max(cabBaseBottom(z), arch) // ön tekerleğin üstünde kemer
}

const cabSection = (z) => ({
  top: cabTop(z),
  bottom: cabBottom(z),
  halfWidth: cabHalfWidth(z),
  powerTop: 3.6,
  powerBottom: 7,
  tumble: 0.13,
})

// Malzeme sınır çizgileri (yükseklik, z'ye göre):
// trimTop  → altı siyah (alt etek, önde tampon), beltLine → camın alt kenarı, windowTop → camın üst kenarı
const WINDOW_START = 6.9 // camın arka kenarı (bir kesite denk gelecek şekilde seçildi)
const trimTop = smoothTable([[4.0, 1.45], [10.0, 1.45], [10.4, 2.15], [11.0, 2.15]])
const beltLine = smoothTable([[6.9, 5.45], [9.0, 5.25], [10.0, 4.75], [10.6, 4.35]])
const windowTop = smoothTable([[6.9, 7.25], [7.8, 7.6], [8.35, 8.15], [11.0, 8.15]])

// Her üçgen için malzeme: 0 = boya, 1 = cam, 2 = siyah alt etek ve tampon
function classifyCab(x, y, z) {
  if (y < trimTop(z)) return 2
  if (z > WINDOW_START && y > beltLine(z) && y < windowTop(z)) return 1
  return 0
}

// Verilen yüksekliğe denk gelen halka açısı (sağ taraf, -π/2 … π/2).
// loft'taki süper elips formülünün tersi: sy = |sin|^(2/p)  →  |sin| = |sy|^(p/2)
function angleForY(y, s) {
  const cy = (s.top + s.bottom) / 2
  const hy = (s.top - s.bottom) / 2
  const sy = THREE.MathUtils.clamp((y - cy) / hy, -1, 1)
  const p = sy >= 0 ? s.powerTop : s.powerBottom
  return Math.asin(Math.sign(sy) * Math.abs(sy) ** (p / 2))
}

// Halka açıları: her sınır çizgisinde bir köşe olacak şekilde bantlara bölünmüş.
// Bantlardaki nokta sayısı her kesitte aynı → sınırlar üçgen kenarlarından geçer, tırtık olmaz
const BANDS = [6, 12, 8, 8] // alt-orta→tampon, tampon→bel, bel→cam üstü, cam üstü→tavan ortası
const CAB_RING = BANDS.reduce((sum, n) => sum + n, 0) * 2

function cabRingAngles(z, s) {
  const half = Math.PI / 2
  const aTrim = angleForY(trimTop(z), s)
  const aBelt = Math.max(aTrim, angleForY(beltLine(z), s)) // sınırlar sıralı kalsın
  const aTop = Math.max(aBelt, angleForY(windowTop(z), s))
  const edges = [-half, aTrim, aBelt, aTop, half]

  const right = [] // sağ taraf: alttan (-π/2) üste (π/2), üst nokta hariç
  BANDS.forEach((n, k) => {
    for (let i = 0; i < n; i++) right.push(edges[k] + ((edges[k + 1] - edges[k]) * i) / n)
  })
  // Sol taraf ayna görüntüsü: açı → π - açı. Tavan ortasından (π/2) başlayıp alta iner
  const left = [half]
  for (let k = right.length - 1; k >= 1; k--) left.push(Math.PI - right[k])
  return [...right, ...left]
}

// Küçük yardımcı: geometri + malzeme + konum → gruba ekle
function part(group, geometry, material, x, y, z) {
  const mesh = new THREE.Mesh(geometry, material)
  mesh.position.set(x, y, z)
  group.add(mesh)
  return mesh
}

// --- Tekerlek: yuvarlak omuzlu lastik + aerodinamik jant kapağı ---
function createWheel(outerSign) {
  const wheel = new THREE.Group()
  const hw = TIRE_W / 2
  const profile = [
    [0.72, -hw], [1.0, -hw], [1.1, -hw + 0.06], [TIRE_R, -hw + 0.18],
    [TIRE_R, hw - 0.18], [1.1, hw - 0.06], [1.0, hw], [0.72, hw],
  ].map(([x, y]) => new THREE.Vector2(x, y))
  wheel.add(new THREE.Mesh(new THREE.LatheGeometry(profile, 40), rubber))

  part(wheel, new THREE.CylinderGeometry(0.78, 0.78, TIRE_W * 0.9, 32), hubMat, 0, 0, 0)
  const face = outerSign * (hw - 0.02)
  const ring = part(wheel, new THREE.TorusGeometry(0.5, 0.03, 8, 32), chrome, 0, face, 0)
  ring.rotation.x = Math.PI / 2 // halkayı jant yüzeyine yatır
  part(wheel, new THREE.CylinderGeometry(0.2, 0.2, 0.08, 20), chrome, 0, face, 0)

  wheel.rotation.z = -Math.PI / 2 // silindirin ekseni (y) → x ekseni
  return wheel
}

// Bir aksa tekerlek koy: dual = true ise her tarafta yan yana iki lastik (ağır yük aksları)
function addAxle(truck, z, dual) {
  const outerX = HALF_W - 0.45
  for (const side of [-1, 1]) {
    const xs = dual ? [outerX, outerX - 0.8] : [outerX]
    for (const x of xs) {
      const wheel = createWheel(side)
      wheel.position.set(side * x, TIRE_R, z)
      truck.add(wheel)
    }
  }
}

// --- Kabin ---
function createCab(truck, paint) {
  // Tek parça gövde: üçgenler classifyCab'e göre boya / cam / siyah olarak çizilir
  // 140 kesit: (6.9 - 4) / 7 × 140 = 58 → camın arka kenarı tam bir kesite denk gelir
  const geometry = loft(CAB_REAR, CAB_FRONT, 140, CAB_RING, cabSection, classifyCab, cabRingAngles)
  const cab = new THREE.Mesh(geometry, [paint, glass, trim])
  truck.add(cab)

  // İç gövde: tekerlek kemerinden bakınca içi boş görünmesin
  part(truck, new THREE.BoxGeometry(3.6, 1.5, 6.2), chassisMat, 0, 1.65, 7.3)

  for (const side of [-1, 1]) {
    // İnce, açılı LED farlar: burnun köşelerini sarar
    const light = part(truck, new THREE.BoxGeometry(1.0, 0.13, 0.22), headlight, side * 2.05, 3.15, 10.83)
    light.rotation.y = side * 0.5
    light.rotation.x = -0.35

    // Ayna yerine kamera kolu: ön camın köşesinden dışarı uzanır
    const arm = part(truck, new THREE.BoxGeometry(0.75, 0.08, 0.08), trim, side * 3.05, 6.35, 9.35)
    arm.rotation.y = side * 0.3
    part(truck, new THREE.BoxGeometry(0.2, 0.32, 0.42), trim, side * 3.42, 6.3, 9.5)

    // Kapı kolu
    part(truck, new THREE.BoxGeometry(0.04, 0.08, 0.55), trim, side * 2.99, 5.0, 7.5)

    // Kabin ile dorse arasındaki boşluğu kapatan yan rüzgâr panelleri
    part(truck, new THREE.BoxGeometry(0.08, 7.1, 0.9), paint, side * 2.96, 5.05, 3.8)
  }

  // Çatının ön kenarında turuncu işaret lambaları
  for (let i = -2; i <= 2; i++) {
    const marker = part(truck, new THREE.BoxGeometry(0.3, 0.07, 0.14), amber, i * 0.6, cabTop(8.2) + 0.03, 8.2)
    marker.rotation.x = 0.55
  }
}

// --- Dorse ---
function createTrailer(truck, paint) {
  const length = TRAILER_FRONT - TRAILER_REAR
  const centerZ = (TRAILER_FRONT + TRAILER_REAR) / 2
  const height = TRAILER_TOP - TRAILER_FLOOR

  // Kasa: köşeleri hafif yuvarlatılmış uzun kutu + koyu alt şasi rayı
  part(truck, new RoundedBoxGeometry(HALF_W * 2, height, length, 4, 0.3), paint, 0, TRAILER_FLOOR + height / 2, centerZ)
  part(truck, new THREE.BoxGeometry(HALF_W * 2 + 0.04, 0.3, length), chassisMat, 0, TRAILER_FLOOR + 0.1, centerZ)

  // Çekici şasisi (dorsenin önünün altında)
  part(truck, new THREE.BoxGeometry(2.2, 0.8, 9.0), chassisMat, 0, 1.3, 3.0)

  for (const side of [-1, 1]) {
    // Aerodinamik yan etekler (iki aks grubu arasında)
    part(truck, new THREE.BoxGeometry(0.08, 1.3, 5.8), paint, side * (HALF_W - 0.08), 1.75, -3.4)

    // Yan işaret lambaları (alt rayın üstünde)
    for (const z of [-10.5, -7, -3.5, 0, 3.2]) {
      part(truck, new THREE.BoxGeometry(0.05, 0.14, 0.14), amber, side * (HALF_W + 0.04), TRAILER_FLOOR + 0.3, z)
    }

    // Arka stop lambaları
    part(truck, new THREE.BoxGeometry(0.7, 0.2, 0.05), red, side * 2.3, TRAILER_FLOOR + 0.6, TRAILER_REAR - 0.03)
  }

  // Arka kapılar: orta ek yeri + kilit çubukları
  part(truck, new THREE.BoxGeometry(0.05, height - 0.4, 0.04), trim, 0, TRAILER_FLOOR + height / 2, TRAILER_REAR - 0.02)
  for (const x of [-2.1, -0.9, 0.9, 2.1]) {
    part(truck, new THREE.BoxGeometry(0.07, height - 0.6, 0.06), chrome, x, TRAILER_FLOOR + height / 2, TRAILER_REAR - 0.04)
  }
  for (let i = -1; i <= 1; i++) {
    part(truck, new THREE.BoxGeometry(0.25, 0.1, 0.05), red, i * 0.5, TRAILER_TOP - 0.25, TRAILER_REAR - 0.03)
  }

  // Arka çarpışma barı ve ayakları
  part(truck, new THREE.BoxGeometry(5.2, 0.22, 0.22), chassisMat, 0, 1.1, TRAILER_REAR + 0.15)
  for (const x of [-1.8, 1.8]) {
    part(truck, new THREE.BoxGeometry(0.15, 1.3, 0.15), chassisMat, x, 1.8, TRAILER_REAR + 0.15)
  }
}

// Tır: color → 'white' | 'blue'
export function createTruck(color = 'white') {
  const truck = new THREE.Group()
  const paint = paintMaterial(color)

  createCab(truck, paint)
  createTrailer(truck, paint)

  addAxle(truck, FRONT_AXLE, false)
  for (const z of DRIVE_AXLES) addAxle(truck, z, true)
  for (const z of TRAILER_AXLES) addAxle(truck, z, true)

  return truck
}
