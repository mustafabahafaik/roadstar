import * as THREE from 'three'
import { neon } from './neon.js'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'

// Tırın kaba boyutları — ileride çarpışma kontrolünde de kullanacağız
export const TRUCK_SIZE = { width: 6, height: 9, length: 22 }

const W = TRUCK_SIZE.width

// Malzemeler
const white = new THREE.MeshStandardMaterial({ color: 0xf2f4f7, metalness: 0.3, roughness: 0.35 })
const silver = new THREE.MeshStandardMaterial({ color: 0xd9dde3, metalness: 0.5, roughness: 0.4 })
const dark = new THREE.MeshStandardMaterial({ color: 0x15161c, metalness: 0.2, roughness: 0.7 })
const glass = new THREE.MeshStandardMaterial({ color: 0x0a0d18, metalness: 0.9, roughness: 0.1 })
const headlight = neon(0xdffbff)
const amber = neon(0xffa020)
const cyanNeon = neon(0x00f0ff)
const pinkNeon = neon(0xff2bd6)

// Küçük yardımcı: geometri + malzeme + konum → gruba ekle
function part(group, geometry, material, x, y, z) {
  const mesh = new THREE.Mesh(geometry, material)
  mesh.position.set(x, y, z)
  group.add(mesh)
  return mesh
}

// Tır: ön tarafı +z yönünde, tabanı y = 0'da, uzunluk boyunca z = -11 … +11
export function createTruck() {
  const truck = new THREE.Group()

  // Şasi: tüm parçaları taşıyan alçak koyu kiriş
  part(truck, new THREE.BoxGeometry(W - 0.6, 0.8, 22), dark, 0, 1.4, 0)

  // Kabin: yuvarlak köşeli beyaz gövde + üstte rüzgâr kesici (aerodinamik çıkıntı)
  part(truck, new RoundedBoxGeometry(W, 6, 6, 4, 0.8), white, 0, 4.8, 8)
  part(truck, new RoundedBoxGeometry(W * 0.95, 1.8, 4.5, 4, 0.7), white, 0, 8.3, 7.3)

  // Ön cam (kabinin ön yüzünden biraz dışarıda)
  part(truck, new THREE.BoxGeometry(W * 0.85, 2.2, 0.1), glass, 0, 6.1, 11.02)

  // Farlar ve tampon altındaki neon şerit
  part(truck, new THREE.BoxGeometry(1.4, 0.35, 0.1), headlight, -(W / 2 - 1.1), 3.2, 11.05)
  part(truck, new THREE.BoxGeometry(1.4, 0.35, 0.1), headlight, W / 2 - 1.1, 3.2, 11.05)
  part(truck, new THREE.BoxGeometry(W * 0.9, 0.2, 0.1), cyanNeon, 0, 2.1, 11.05)

  // Kabin üstündeki turuncu işaret lambaları
  for (let i = -2; i <= 2; i++) {
    part(truck, new THREE.BoxGeometry(0.35, 0.2, 0.1), amber, i * 0.7, 8.6, 9.57)
  }

  // Dorse: uzun gümüş kasa
  part(truck, new THREE.BoxGeometry(W, 7.5, 15.5), silver, 0, 5.6, -3.25)

  // Dorsenin iki yanında alt ve üst neon çizgiler
  for (const x of [-(W / 2 + 0.05), W / 2 + 0.05]) {
    part(truck, new THREE.BoxGeometry(0.1, 0.25, 15), pinkNeon, x, 2.1, -3.25)
    part(truck, new THREE.BoxGeometry(0.1, 0.15, 15), cyanNeon, x, 9.2, -3.25)
  }

  // Tekerlekler: silindir varsayılan olarak dik durur, z ekseninde 90° çevirince yuvarlanacak hâle gelir
  const wheelGeometry = new THREE.CylinderGeometry(1.1, 1.1, 0.8, 20)
  for (const z of [9, 3, 1.4, -8, -9.6]) {
    for (const x of [-(W / 2 - 0.3), W / 2 - 0.3]) {
      const wheel = part(truck, wheelGeometry, dark, x, 1.1, z)
      wheel.rotation.z = Math.PI / 2
    }
  }

  return truck
}
