import { trackLength, trackDistance, TRACK_WIDTH } from './track.js'
import { itemHash, hashFraction } from './random.js'
import { TRUCK_SIZE } from './truck.js'

// Parkur: engellerin ve rampaların yeri TEK bir seed'den üretilir. Aynı seed → birebir aynı parkur.
// Çok oyunculuda herkes aynı seed'i alır ve parkuru kendi bilgisayarında aynı şekilde üretir:
// yüzlerce nesneyi ağdan göndermek yerine 32 baytlık tek bir sayı yeter.

export const TOWER_TOP_RATIO = 0.6 // kulenin tepesi tabanının bu oranı kadar geniş
export const RAMP_LENGTH = 16 // rampanın pist boyunca uzunluğu (ramps.js de kullanır)

const ROAD_HALF = TRACK_WIDTH / 2
const START_CLEAR = 120 // başlangıçtan sonra bu kadar birim engelsiz (kalkış için)
const FINISH_CLEAR = 80 // bitiş kapısından önce bu kadar birim engelsiz
const OBSTACLE_SLOTS = 18 // pist kaç dilime bölünsün (her dilime bir engel)

// Her üretim akışı ayrı bir "kanal". Token türleri zincirde keccak(seed, 0…39) ile hesaplanır;
// parkur için büyük sayılardan başlıyoruz ki asla aynı hash'i kullanmasınlar
const STREAM = { obstacle: 100000, ramp: 200000 }
function random(seed, stream, index) {
  const hash = itemHash(seed, stream + index)
  return (slot) => hashFraction(hash, slot) // aynı hash'in farklı parçaları: 0–1 arası sayılar
}

// Tek, paylaşılan parkur nesnesi: car.js (çarpışma), items.js (token yerleşimi), ramps.js (zemin) okur.
// Seed gelene kadar (lobi) boştur
export const course = { seed: null, obstacles: [], obstacleBoxes: [], ramps: [] }

function generateObstacles(seed) {
  const usable = trackLength - START_CLEAR - FINISH_CLEAR
  const slot = usable / OBSTACLE_SLOTS
  const list = []
  for (let i = 0; i < OBSTACLE_SLOTS; i++) {
    const r = random(seed, STREAM.obstacle, i)
    // Dilimin ortasına yakın (0.35–0.65): iki engel arası en az ~110 birim kalır
    const u = (START_CLEAR + (i + 0.35 + 0.3 * r(0)) * slot) / trackLength
    const kind = r(1)
    const lane = r(2) < 0.5 ? -0.5 : 0.5 // sol / sağ şerit
    if (kind < 0.3) list.push({ u, type: 'wall', offset: 0, width: TRACK_WIDTH, height: 4 + Math.round(r(3) * 2) })
    else if (kind < 0.7) list.push({ u, type: 'tower', offset: lane, width: 8, height: 7 })
    else list.push({ u, type: 'truck', offset: lane, color: r(3) < 0.35 ? 'blue' : 'white' })
  }
  return list
}

// Engellerin pist koordinatlarındaki çarpışma kutuları (car.js AABB kontrolü için)
function toBoxes(obstacles) {
  return obstacles.map((o) => {
    const center = o.offset * ROAD_HALF
    if (o.type === 'wall') return { u: o.u, center, halfDepth: 1, halfWidth: o.width / 2, top: o.height }
    if (o.type === 'tower') {
      const bottomHalf = o.width / 2 // kule yukarı doğru incelir: car.js yüksekliğe göre daraltır
      return { u: o.u, center, bottomHalf, topHalf: bottomHalf * TOWER_TOP_RATIO, top: o.height + 0.4 }
    }
    return { u: o.u, center, halfDepth: TRUCK_SIZE.length / 2, halfWidth: TRUCK_SIZE.width / 2, top: TRUCK_SIZE.height }
  })
}

function generateRamps(seed, obstacles, boxes) {
  const ramps = []
  // Rampa (başından dudağına) hiçbir engelin kutusuna 6 birimden yakın olmasın
  const isClear = (startU, lipU) =>
    boxes.every((b) => {
      const half = (b.halfDepth ?? b.bottomHalf) + 6
      return trackDistance(lipU, b.u) > half || trackDistance(b.u, startU) > half
    })
  const add = (lipAlong, offset, width) => {
    const lipU = lipAlong / trackLength
    const startU = lipU - RAMP_LENGTH / trackLength
    if (lipAlong > RAMP_LENGTH && isClear(startU, lipU)) ramps.push({ lipU, startU, offset, width })
  }

  obstacles.forEach((o, i) => {
    const r = random(seed, STREAM.ramp, i)
    if (o.type === 'wall' && r(0) < 0.6) {
      add(o.u * trackLength - 30, 0, 12) // duvarın 30 birim önünde tam genişlik: hızlı gelen üstünden uçar
    } else if (o.type !== 'wall' && i > 0 && r(0) < 0.3) {
      // Serbest takla rampası: önceki engelle bu engelin arasında, bu engelin KARŞI şeridinde
      const mid = ((obstacles[i - 1].u + o.u) / 2) * trackLength
      add(mid, -Math.sign(o.offset) * 4, 7)
    }
  })
  return ramps
}

// Seed'den parkuru (yeniden) kur. Aynı seed her zaman aynı sonucu verir
export function buildCourse(seed) {
  course.seed = seed
  course.obstacles = generateObstacles(seed)
  course.obstacleBoxes = toBoxes(course.obstacles)
  course.ramps = generateRamps(seed, course.obstacles, course.obstacleBoxes)
  return course
}
