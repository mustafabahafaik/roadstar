import * as THREE from 'three'

// Pistin geçeceği kontrol noktaları (x, y, z).
// y = yükseklik: hepsi suyun (y = 0) epey üstünde, inip çıkan bir rota
const points = [
  new THREE.Vector3(150, 40, 0),
  new THREE.Vector3(100, 60, 110),
  new THREE.Vector3(0, 75, 150),
  new THREE.Vector3(-110, 55, 100),
  new THREE.Vector3(-160, 35, 0),
  new THREE.Vector3(-90, 50, -120),
  new THREE.Vector3(0, 70, -90),
  new THREE.Vector3(90, 45, -140),
]

// CatmullRomCurve3: noktaların hepsinden yumuşakça geçen eğri.
// İkinci parametre true → son nokta ilk noktaya bağlanır, pist kapalı tur olur
export const trackCurve = new THREE.CatmullRomCurve3(points, true)

const ROAD_WIDTH = 16 // yolun genişliği
const SEGMENTS = 400 // eğri boyunca kaç noktada örnek alacağız

// Eğri boyunca yolun sol ve sağ kenar noktalarını hesaplar
function computeEdges() {
  const up = new THREE.Vector3(0, 1, 0)
  const left = []
  const right = []

  for (let i = 0; i < SEGMENTS; i++) {
    const u = i / SEGMENTS // 0 → 1 arası: turun yüzde kaçındayız
    const center = trackCurve.getPointAt(u)
    const tangent = trackCurve.getTangentAt(u) // pistin bu noktadaki gidiş yönü

    // Çapraz çarpım: iki vektöre de dik üçüncü bir vektör verir.
    // gidiş yönü × yukarı = yolun sağ tarafını gösteren yatay vektör
    const side = new THREE.Vector3().crossVectors(tangent, up).normalize()

    left.push(center.clone().addScaledVector(side, -ROAD_WIDTH / 2))
    right.push(center.clone().addScaledVector(side, ROAD_WIDTH / 2))
  }

  return { left, right }
}

// Kenar noktalarından üçgenlerle düz bir şerit (ribbon) örer
function createRoadGeometry(left, right) {
  const positions = []
  const indices = []

  for (let i = 0; i < SEGMENTS; i++) {
    positions.push(left[i].x, left[i].y, left[i].z) // köşe 2*i
    positions.push(right[i].x, right[i].y, right[i].z) // köşe 2*i + 1
  }

  // Her ardışık kenar çifti bir dörtgen = 2 üçgen.
  // % ile son dörtgen ilk noktaya bağlanır, tur kapanır
  for (let i = 0; i < SEGMENTS; i++) {
    const a = 2 * i // sol, şimdiki
    const b = 2 * i + 1 // sağ, şimdiki
    const c = (2 * (i + 1)) % (2 * SEGMENTS) // sol, sonraki
    const d = (2 * (i + 1) + 1) % (2 * SEGMENTS) // sağ, sonraki
    indices.push(a, c, b)
    indices.push(b, c, d)
  }

  // BufferGeometry: köşe koordinatlarını doğrudan GPU'ya gidecek dizi olarak verdiğimiz geometri
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setIndex(indices) // index: hangi 3 köşe bir üçgen oluşturuyor
  return geometry
}

// Kenar noktalarından ince neon boru üretir
function createEdgeLine(edgePoints) {
  const curve = new THREE.CatmullRomCurve3(edgePoints, true)
  const geometry = new THREE.TubeGeometry(curve, SEGMENTS, 0.6, 8, true)
  const material = new THREE.MeshBasicMaterial({ color: 0x00f0ff, toneMapped: false })
  return new THREE.Mesh(geometry, material)
}

export function createTrack() {
  const { left, right } = computeEdges()
  const group = new THREE.Group() // yolu ve kenarları tek nesne gibi taşımak için

  const road = new THREE.Mesh(
    createRoadGeometry(left, right),
    // DoubleSide: alttan bakınca da görünsün
    new THREE.MeshBasicMaterial({ color: 0x1a0b33, side: THREE.DoubleSide }),
  )
  group.add(road)

  group.add(createEdgeLine(left))
  group.add(createEdgeLine(right))

  return group
}
