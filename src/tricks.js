import * as THREE from 'three'
import { input } from './input.js'
import { WHEEL_POSITIONS } from './carModel.js'

// --- Ayarlar: takla hissini bu sayılarla değiştirebilirsin ---
const MAX_FLIP_SPEED = 6.5 // rad/sn: W / S öne-arkaya takla (360° ≈ 1 sn)
const MAX_ROLL_SPEED = 7.5 // rad/sn: Q / E barrel roll
const SPIN_ACCEL = 20 // rad/sn²: tuşa basınca açısal hız bu ivmeyle artar (yumuşak başlangıç)
const SPIN_DAMPING = 6 // tuş bırakılınca açısal hız saniyede e^-6 oranında söner (yavaşça durur; tam hızdan ~70° daha döner)
const CLEAN_LANDING = THREE.MathUtils.degToRad(30) // bundan az eğik iniş = temiz iniş
const SETTLE_SPEED = 12 // yerde düzleşme hızı (slerp)
const SCORE_PER_ROLL = 100
const SCORE_PER_FLIP = 150
const BOOST_PER_TURN = 12 // temiz inişte tur başına hız artışı (birim/sn), fazlası yavaşça söner
const MAX_BOOST = 36
const SIDE_PUFF_RATE = 70 // yan itici: saniyede puf (her meme için)
const TRICK_PUFF_RATE = 40 // takla sırasında tam hızda saniyede puf

const FULL_TURN = Math.PI * 2
const AXIS_X = new THREE.Vector3(1, 0, 0) // arabanın yerel yan ekseni → öne/arkaya takla
const AXIS_Z = new THREE.Vector3(0, 0, 1) // arabanın yerel uzun ekseni → barrel roll
const WORLD_UP = new THREE.Vector3(0, 1, 0)

// Yan itici memeleri: arabaya göre (yerel) noktalar. lookAt kuralı gereği yerel +x arabanın SOLU,
// −x SAĞI. A'ya basınca araba sola gider → onu sola iten duman SAĞ memelerden sağa doğru çıkar
const RIGHT_NOZZLES = [new THREE.Vector3(-2.15, 1.2, 2.3), new THREE.Vector3(-2.15, 1.2, -2.3)]
const LEFT_NOZZLES = [new THREE.Vector3(2.15, 1.2, 2.3), new THREE.Vector3(2.15, 1.2, -2.3)]
const LOCAL_RIGHT = new THREE.Vector3(-1, 0, 0)
const LOCAL_LEFT = new THREE.Vector3(1, 0, 0)

// current'ı target'a en fazla maxDelta kadar yaklaştır (ivmeli artış)
function moveTowards(current, target, maxDelta) {
  if (Math.abs(target - current) <= maxDelta) return target
  return current + Math.sign(target - current) * maxDelta
}

// events: { onTrick(text), onBadLanding(text) } → main.js ekrana yazı çıkarır
export function createTricks(car, smoke, events = {}) {
  const spin = { flip: 0, roll: 0 } // açısal hız (rad/sn), arabanın yerel X ve Z eksenleri
  const spun = { flip: 0, roll: 0 } // bu sıçrayışta toplam dönüş (işaretli: sağa + sola = sıfırlar)
  let wasAirborne = false
  let score = 0
  // Kalkış anında zaten basılı olan W/S (gaz/fren) takla sayılmaz; bırakıp yeniden basınca sayılır.
  // Yoksa gaza basarak zıplayan oyuncu istemeden öne takla atar
  const heldAtTakeoff = { forward: false, brake: false }
  const puffAccumulator = { left: 0, right: 0, trick: 0 } // kesirli pufları biriktir

  const delta = new THREE.Quaternion()
  const identity = new THREE.Quaternion() // dönüşsüz (düz) duruş
  const carUp = new THREE.Vector3()
  const worldPos = new THREE.Vector3()
  const direction = new THREE.Vector3()
  const velocity = new THREE.Vector3()

  // Küçük bir dönüşü arabanın KENDİ eksenine uygula: sağdan çarpım = yerel eksen
  function rotateLocal(axis, angle) {
    delta.setFromAxisAngle(axis, angle)
    car.state.trickQuat.multiply(delta)
  }

  function updateSpin(dt, axis, inputValue, maxSpeed) {
    if (inputValue !== 0) spin[axis] = moveTowards(spin[axis], inputValue * maxSpeed, SPIN_ACCEL * dt)
    else spin[axis] *= Math.exp(-SPIN_DAMPING * dt) // tuş bırakıldı: sönümle
    spun[axis] += spin[axis] * dt
  }

  // --- İniş: düz mü? kaç tur? ---
  function land() {
    // Arabanın yukarısı (takla dönüşüyle çevrilmiş) ile dünyanın yukarısı arasındaki açı
    carUp.set(0, 1, 0).applyQuaternion(car.state.trickQuat)
    const tilt = carUp.angleTo(WORLD_UP)

    if (tilt < CLEAN_LANDING) {
      // Tam tur sayısı: 30° pay ile (340° dönüp düz inen de 1 tur sayılır)
      const rolls = Math.floor((Math.abs(spun.roll) + CLEAN_LANDING) / FULL_TURN)
      const flips = Math.floor((Math.abs(spun.flip) + CLEAN_LANDING) / FULL_TURN)
      if (rolls + flips > 0) {
        const points = rolls * SCORE_PER_ROLL + flips * SCORE_PER_FLIP
        score += points
        car.state.speed += Math.min(MAX_BOOST, (rolls + flips) * BOOST_PER_TURN) // kısa boost
        const parts = []
        if (rolls) parts.push(`BARREL ROLL x${rolls}`)
        if (flips) parts.push(`${spun.flip > 0 ? 'FRONT FLIP' : 'BACKFLIP'} x${flips}`)
        events.onTrick?.(`${parts.join(' + ')}  +${points}`)
      }
    } else if (car.state.shield) {
      car.state.shield = false // kötü iniş: kalkan darbeyi alır
      events.onBadLanding?.('KALKAN KIRILDI!')
    } else {
      car.state.wobble = 0.8 // kötü iniş: sarsıl ve yavaşla
      car.state.speed *= 0.5
      events.onBadLanding?.('SERT İNİŞ!')
    }
    spin.flip = spin.roll = 0
    spun.flip = spun.roll = 0
  }

  // --- Duman ---
  function emitFrom(nozzles, localDirection, accumulatorKey, rate, dt) {
    puffAccumulator[accumulatorKey] += rate * dt
    if (puffAccumulator[accumulatorKey] < 1) return
    // Yön: arabanın yerel yönünü dünyaya çevir (ters dönmüşken de doğru tarafa)
    direction.copy(localDirection).transformDirection(car.model.matrixWorld)
    while (puffAccumulator[accumulatorKey] >= 1) {
      puffAccumulator[accumulatorKey] -= 1
      for (const nozzle of nozzles) {
        car.model.localToWorld(worldPos.copy(nozzle)) // meme noktası → dünya koordinatı
        // Dışa doğru fırlar + arabanın hızının bir kısmı; sonra dünyada yavaşlar (arabayla gitmez)
        velocity.copy(direction).multiplyScalar(20 + Math.random() * 8).addScaledVector(car.velocity, 0.35)
        velocity.x += (Math.random() - 0.5) * 2
        velocity.y += (Math.random() - 0.5) * 2
        smoke.emit({ position: worldPos, velocity, life: 0.9, startSize: 0.5, endSize: 3.4, opacity: 0.55, drag: 3.5, rise: 0.8 })
      }
    }
  }

  function emitTrickPuffs(dt) {
    const intensity = Math.max(Math.abs(spin.flip) / MAX_FLIP_SPEED, Math.abs(spin.roll) / MAX_ROLL_SPEED)
    if (intensity < 0.2) return
    puffAccumulator.trick += TRICK_PUFF_RATE * intensity * dt
    while (puffAccumulator.trick >= 1) {
      puffAccumulator.trick -= 1
      const wheel = WHEEL_POSITIONS[Math.floor(Math.random() * WHEEL_POSITIONS.length)]
      car.model.localToWorld(worldPos.copy(wheel))
      velocity.randomDirection().multiplyScalar(4).addScaledVector(car.velocity, 0.3)
      smoke.emit({ position: worldPos, velocity, life: 0.6, startSize: 0.4, endSize: 1.8, opacity: 0.35, drag: 3 })
    }
  }

  // main.js her karede car.update'ten SONRA çağırır
  function update(dt) {
    const s = car.state
    const airborne = s.height > 0 && !s.falling && !s.crashed
    const canControl = !s.finished && !s.locked

    // Kalkış: o an basılı W/S'yi kilitle. Tuş bırakılınca kilit açılır
    if (airborne && !wasAirborne) {
      heldAtTakeoff.forward = input.forward
      heldAtTakeoff.brake = input.brake
    }
    if (!input.forward) heldAtTakeoff.forward = false
    if (!input.brake) heldAtTakeoff.brake = false
    const flipForward = input.forward && !heldAtTakeoff.forward
    const flipBack = input.brake && !heldAtTakeoff.brake

    if (airborne && canControl) {
      // W öne takla (+), S geriye (−) — havada YENİDEN basılınca; E sağa yuvarlan (+), Q sola (−)
      updateSpin(dt, 'flip', (flipForward ? 1 : 0) - (flipBack ? 1 : 0), MAX_FLIP_SPEED)
      updateSpin(dt, 'roll', (input.rollRight ? 1 : 0) - (input.rollLeft ? 1 : 0), MAX_ROLL_SPEED)
      rotateLocal(AXIS_X, spin.flip * dt)
      rotateLocal(AXIS_Z, spin.roll * dt)

      if (input.left) emitFrom(RIGHT_NOZZLES, LOCAL_RIGHT, 'right', SIDE_PUFF_RATE, dt) // sola kay
      if (input.right) emitFrom(LEFT_NOZZLES, LOCAL_LEFT, 'left', SIDE_PUFF_RATE, dt) // sağa kay
      emitTrickPuffs(dt)
    }

    // Yere değdiği kare: inişi değerlendir
    if (wasAirborne && !airborne && !s.falling && !s.crashed) land()

    if (!airborne) {
      // Yerde (ya da düşerken / çarpınca): taklayı bırak, araba yavaşça düzleşsin.
      // slerp: iki dönüş arasında küresel yumuşak geçiş; her karede kalan farkın bir kısmı kapanır
      spin.flip = spin.roll = 0
      s.trickQuat.slerp(identity, 1 - Math.exp(-SETTLE_SPEED * dt))
      if (s.falling || s.crashed) spun.flip = spun.roll = 0
    }
    wasAirborne = airborne
  }

  return {
    update,
    get score() {
      return score
    },
  }
}
