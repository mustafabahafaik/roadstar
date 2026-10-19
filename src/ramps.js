import * as THREE from 'three'
import { trackCurve, trackLength, trackDistance } from './track.js'
import { neon } from './neon.js'

// --- Ayarlar ---
const RAMP_LENGTH = 16 // rampanın pist boyunca uzunluğu (birim)
const RAMP_HEIGHT = 2.6 // dudaktaki (en uç) yükseklik
const SEGMENTS = 24 // eğrinin kaç parçayla çizileceği

// Rampa profili: zemin = H × t² (t: rampanın ne kadarındayız, 0 → 1).
// t² → önce yatık, dudağa doğru dikleşir ("kıvrık" rampa).
// Eğim (dh/ds) = 2·H·t / L → dudakta 2H/L ≈ 0.33: 70 hızla girersen ~22 yukarı hızla fırlarsın
const heightAt = (t) => RAMP_HEIGHT * t * t
const slopeAt = (t) => (2 * RAMP_HEIGHT * t) / RAMP_LENGTH

// lipU: dudağın (rampanın bittiği uç) pistteki yeri, offset: yanal merkez (birim), width: genişlik
// Engellerin u'ları: 0.07 + k·0.075 (obstacles.js). Dudak, duvarlardan 30 birim önce → üstünden uçarsın
export const ramps = [
  { lipU: 0.37 - 30 / trackLength, offset: 0, width: 12 }, // 0.37'deki duvarın önünde
  { lipU: 0.4825, offset: -4, width: 7 }, // sol şeritte serbest takla rampası (sağdaki kuleden uzak)
  { lipU: 0.82 - 30 / trackLength, offset: 0, width: 12 }, // 0.82'deki duvarın önünde
].map((r) => ({ ...r, startU: r.lipU - RAMP_LENGTH / trackLength }))

// Pistte (u, offset) noktasındaki rampa yüzeyi: { height, slope }. Rampa yoksa { 0, 0 }
const flat = { height: 0, slope: 0 }
export function rampSurface(u, offset) {
  for (const r of ramps) {
    const along = trackDistance(r.startU, u) // rampanın başından bu yana kaç birim (işaretli)
    if (along < 0 || along > RAMP_LENGTH) continue
    if (Math.abs(offset - r.offset) > r.width / 2) continue
    const t = along / RAMP_LENGTH
    return { height: heightAt(t), slope: slopeAt(t) }
  }
  return flat
}

// Rampa yüzeyi dokusu: koyu zemin + ileriyi gösteren pembe oklar (canvas, harici dosya yok)
function createChevronTexture() {
  const canvas = document.createElement('canvas')
  canvas.width = 128
  canvas.height = 256
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#1a1030'
  ctx.fillRect(0, 0, 128, 256)
  ctx.strokeStyle = '#ff3bd6'
  ctx.lineWidth = 10
  ctx.lineCap = 'round'
  for (let i = 0; i < 3; i++) {
    const y = 40 + i * 80 // dokunun v ekseni rampa boyunca: oklar ileriyi (dudağı) gösterir
    ctx.beginPath()
    ctx.moveTo(24, y)
    ctx.lineTo(64, y + 34)
    ctx.lineTo(104, y)
    ctx.stroke()
  }
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

const UP = new THREE.Vector3(0, 1, 0)

// Rampa noktaları: her kesitte sol/sağ, üst (rampa yüzeyi) ve alt (yol seviyesi)
function rampPoints(r) {
  const rows = []
  for (let i = 0; i <= SEGMENTS; i++) {
    const t = i / SEGMENTS
    const u = r.startU + (t * RAMP_LENGTH) / trackLength
    const center = trackCurve.getPointAt(((u % 1) + 1) % 1)
    const side = new THREE.Vector3().crossVectors(trackCurve.getTangentAt(((u % 1) + 1) % 1), UP).normalize()
    const left = center.clone().addScaledVector(side, r.offset - r.width / 2)
    const right = center.clone().addScaledVector(side, r.offset + r.width / 2)
    const h = heightAt(t)
    rows.push({
      t,
      leftTop: left.clone().addScaledVector(UP, h),
      rightTop: right.clone().addScaledVector(UP, h),
      leftBottom: left.addScaledVector(UP, -0.05), // yolun hemen altından başla: boşluk görünmesin
      rightBottom: right.addScaledVector(UP, -0.05),
    })
  }
  return rows
}

// a[i] → b[i] şeridi (track.js'teki createStrip gibi). withUv: üst yüzey için doku koordinatı
function strip(rows, keyA, keyB, withUv) {
  const positions = []
  const uvs = []
  const indices = []
  rows.forEach((row, i) => {
    positions.push(...row[keyA].toArray(), ...row[keyB].toArray())
    uvs.push(0, row.t, 1, row.t)
    if (i < rows.length - 1) {
      const p = 2 * i
      indices.push(p, p + 1, p + 2, p + 1, p + 3, p + 2)
    }
  })
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  if (withUv) geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
  geometry.setIndex(indices)
  geometry.computeVertexNormals()
  return geometry
}

export function createRamps() {
  const group = new THREE.Group()
  const chevrons = createChevronTexture()
  const top = new THREE.MeshStandardMaterial({
    map: chevrons,
    emissiveMap: chevrons, // oklar hafifçe kendi ışığını versin
    emissive: 0xffffff,
    emissiveIntensity: 0.9,
    roughness: 0.6,
    metalness: 0.2,
  })
  const body = new THREE.MeshStandardMaterial({ color: 0x241b3a, metalness: 0.6, roughness: 0.4, side: THREE.DoubleSide })
  const edgeNeon = neon(0x00f0ff, 2)
  const lipNeon = neon(0xff3bd6, 3)

  for (const r of ramps) {
    const rows = rampPoints(r)
    group.add(new THREE.Mesh(strip(rows, 'leftTop', 'rightTop', true), top)) // üst yüzey (yukarı bakar)
    group.add(new THREE.Mesh(strip(rows, 'leftBottom', 'leftTop'), body)) // sol yan duvar
    group.add(new THREE.Mesh(strip(rows, 'rightTop', 'rightBottom'), body)) // sağ yan duvar

    // Dudak: rampanın ucundaki dikey yüz (DoubleSide olduğu için yönü önemli değil)
    const end = rows[rows.length - 1]
    const lip = new THREE.BufferGeometry().setFromPoints([end.leftBottom, end.rightBottom, end.leftTop, end.rightTop])
    lip.setIndex([0, 1, 2, 1, 3, 2])
    lip.computeVertexNormals()
    group.add(new THREE.Mesh(lip, body))

    // Neon çizgiler: üst kenarlar camgöbeği, dudak pembe (bloom ile parlar)
    for (const key of ['leftTop', 'rightTop']) {
      const curve = new THREE.CatmullRomCurve3(rows.map((row) => row[key]))
      group.add(new THREE.Mesh(new THREE.TubeGeometry(curve, SEGMENTS, 0.12, 6), edgeNeon))
    }
    const lipLine = new THREE.LineCurve3(end.leftTop, end.rightTop)
    group.add(new THREE.Mesh(new THREE.TubeGeometry(lipLine, 1, 0.16, 8), lipNeon))
  }
  return group
}
