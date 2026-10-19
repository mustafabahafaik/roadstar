import * as THREE from 'three'
import { neon } from './neon.js'
import { RACE_LENGTH } from '../shared/protocol.js'

// Yarışın uzunluğu: pistin bir turu tam bu kadar (birim ≈ metre). Başlangıç ve bitiş aynı nokta (u = 0).
// Değer shared/protocol.js'te: sunucunun hile kontrolü de aynı sayıyı kullanır
export { RACE_LENGTH }

// Pistin şekli: kontrol noktaları (x, y, z). y = yükseklik: hepsi suyun (y = 0) epey üstünde
const BASE_POINTS = [
  [150, 40, 0],
  [100, 60, 110],
  [0, 75, 150],
  [-110, 55, 100],
  [-160, 35, 0],
  [-90, 50, -120],
  [0, 70, -90],
  [90, 45, -140],
]

// CatmullRomCurve3: noktaların hepsinden yumuşakça geçen eğri. true → kapalı tur.
// scale: yatay büyütme (yükseklik aynı kalır)
function buildCurve(scale) {
  const points = BASE_POINTS.map(([x, y, z]) => new THREE.Vector3(x * scale, y, z * scale))
  return new THREE.CatmullRomCurve3(points, true)
}

// Uzunluğu tam RACE_LENGTH yapan ölçeği bul. Yükseklikler ölçeklenmediği için uzunluk ölçekle tam
// orantılı değil → ölç, oranla düzelt, birkaç kez tekrarla (her adımda hata küçülür)
let trackScale = 2
for (let i = 0; i < 4; i++) trackScale *= RACE_LENGTH / buildCurve(trackScale).getLength()

export const trackCurve = buildCurve(trackScale)
trackCurve.arcLengthDivisions = 2000 // uzunluk tablosunu daha ince örnekle: getPointAt daha hassas
export const trackLength = trackCurve.getLength() // ≈ RACE_LENGTH

// İki u değeri arasındaki en kısa uzaklık (birim, işaretli). Turun başı/sonu dahil: 0.99 → 0.01 = +0.02 tur
export function trackDistance(fromU, toU) {
  return (((((toU - fromU) % 1) + 1.5) % 1) - 0.5) * trackLength
}

// Pist genişliği: TEK kaynak. Yol geometrisi, düşme kontrolü (car.js), engeller (obstacles.js) bunu kullanır
export const TRACK_WIDTH = 16
const SEGMENTS = 900 // eğri boyunca kaç noktada örnek alacağız (pist uzadıkça artmalı)

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

    left.push(center.clone().addScaledVector(side, -TRACK_WIDTH / 2))
    right.push(center.clone().addScaledVector(side, TRACK_WIDTH / 2))
  }

  return { left, right }
}

const ROAD_THICKNESS = 1.4 // yolun kalınlığı (yan duvar yüksekliği)
const TEXTURE_LENGTH = 24 // asfalt dokusu kaç birimde bir tekrar etsin

// Asfalt dokusu: canvas'a koyu zemin, ince taneler ve şerit çizgileri çizip doku yapıyoruz.
// Dokunun yatay ekseni (u) yolun genişliği, dikey ekseni (v) yolun uzunluğu
function createAsphaltTexture() {
  const w = 256
  const h = 512
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')

  ctx.fillStyle = '#25272c'
  ctx.fillRect(0, 0, w, h)
  // Asfalt taneleri: rastgele açık/koyu küçük noktalar
  for (let i = 0; i < 9000; i++) {
    const shade = 30 + Math.random() * 40
    ctx.fillStyle = `rgba(${shade},${shade},${shade + 4},${0.25 + Math.random() * 0.35})`
    ctx.fillRect(Math.random() * w, Math.random() * h, 1 + Math.random() * 1.5, 1 + Math.random() * 1.5)
  }
  // Tekerlek izleri: her şeritte iki hafif koyu iz
  ctx.fillStyle = 'rgba(0,0,0,0.12)'
  for (const x of [0.22, 0.32, 0.68, 0.78]) ctx.fillRect(x * w - 8, 0, 16, h)

  // Kenar çizgileri (düz) ve orta çizgi (kesikli)
  ctx.fillStyle = 'rgba(235,238,242,0.9)'
  ctx.fillRect(0.045 * w, 0, 4, h)
  ctx.fillRect(0.955 * w - 4, 0, 4, h)
  ctx.fillRect(0.5 * w - 2, 0, 4, h * 0.45)

  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.wrapS = THREE.ClampToEdgeWrapping
  texture.wrapT = THREE.RepeatWrapping // yol boyunca tekrar et
  texture.anisotropy = 8 // yola yatık açıyla bakınca dokunun bulanıklaşmasını azaltır
  return texture
}

// İki nokta dizisi (a ve b) arasına üçgenlerle şerit örer.
// a[i] → b[i] yönü ile pistin gidiş yönü, yüzeyin hangi tarafa baktığını (normal) belirler
function createStrip(a, b) {
  const positions = []
  const uvs = []
  const indices = []
  const repeats = Math.round(trackCurve.getLength() / TEXTURE_LENGTH) // tam sayı → dokuda ek yeri olmaz

  // Son satır ilk satırın kopyası: v değeri tur sonunda kesintisiz "repeats" değerine ulaşsın
  for (let i = 0; i <= SEGMENTS; i++) {
    const k = i % SEGMENTS
    const v = (i / SEGMENTS) * repeats
    positions.push(a[k].x, a[k].y, a[k].z, b[k].x, b[k].y, b[k].z)
    uvs.push(0, v, 1, v) // uv: bu köşeye dokunun hangi noktası gelecek
  }

  for (let i = 0; i < SEGMENTS; i++) {
    const p = 2 * i // a, şimdiki
    const q = 2 * i + 1 // b, şimdiki
    const r = 2 * i + 2 // a, sonraki
    const t = 2 * i + 3 // b, sonraki
    indices.push(p, q, r, q, t, r)
  }

  // BufferGeometry: köşe koordinatlarını doğrudan GPU'ya gidecek dizi olarak verdiğimiz geometri
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
  geometry.setIndex(indices) // index: hangi 3 köşe bir üçgen oluşturuyor
  geometry.computeVertexNormals() // ışık hesabı için her köşenin baktığı yön
  return geometry
}

// Kenar noktalarından ince neon boru üretir
function createEdgeLine(edgePoints) {
  const curve = new THREE.CatmullRomCurve3(edgePoints, true)
  const geometry = new THREE.TubeGeometry(curve, SEGMENTS, 0.35, 8, true)
  // bloom: false → kenarlar ekranda çok uzun ve yakın, hâleleri tüm yolu turkuaza boyuyordu
  return new THREE.Mesh(geometry, neon(0x00f0ff, 1.6, false))
}

export function createTrack() {
  const { left, right } = computeEdges()
  const down = new THREE.Vector3(0, -ROAD_THICKNESS, 0)
  const leftBottom = left.map((p) => p.clone().add(down))
  const rightBottom = right.map((p) => p.clone().add(down))
  const group = new THREE.Group() // yolu ve kenarları tek nesne gibi taşımak için

  // Üst yüzey: asfalt. MeshStandardMaterial ışık ve gölge alır
  const asphalt = new THREE.MeshStandardMaterial({
    map: createAsphaltTexture(),
    roughness: 0.85, // pürüzlü: güneşi ayna gibi yansıtmasın
    metalness: 0.05,
  })
  group.add(new THREE.Mesh(createStrip(left, right), asphalt))

  // Yan duvarlar ve alt yüzey: koyu metal köprü gövdesi
  const steel = new THREE.MeshStandardMaterial({ color: 0x2c3039, metalness: 0.75, roughness: 0.35 })
  group.add(new THREE.Mesh(createStrip(leftBottom, left), steel)) // sol duvar (dışa bakar)
  group.add(new THREE.Mesh(createStrip(right, rightBottom), steel)) // sağ duvar (dışa bakar)
  group.add(new THREE.Mesh(createStrip(rightBottom, leftBottom), steel)) // alt yüzey (aşağı bakar)

  // Neon kenar çizgileri: üst kenarda ve alt kenarda
  group.add(createEdgeLine(left))
  group.add(createEdgeLine(right))
  group.add(createEdgeLine(leftBottom))
  group.add(createEdgeLine(rightBottom))

  return group
}
