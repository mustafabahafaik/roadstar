import * as THREE from 'three'
import { trackCurve, trackLength, trackDistance, ROAD_WIDTH } from './track.js'
import { obstacles, TOWER_TOP_RATIO } from './obstacles.js'
import { TRUCK_SIZE } from './truck.js'
import { input } from './input.js'
import { createCarModel } from './carModel.js'
import { createThrusters } from './thrusters.js'

// --- Ayarlar: oyun hissini bu sayılarla değiştirebilirsin ---
const MAX_SPEED = 70 // birim / saniye
const ACCELERATION = 30 // gaza basınca hız artışı (birim / saniye²)
const BRAKE = 60 // frenleme
const DRAG = 8 // gaz bırakılınca yavaşlama
const STRAFE_SPEED = 14 // sağa-sola kayma hızı
const JUMP_VELOCITY = 22 // zıplama anındaki yukarı hız (bırakınca ~6.7 yükselir: duvarları aşar)
const GRAVITY = 36 // aşağı çeken ivme
const HOVER_GRAVITY = 22 // havada Space basılı tutulunca roketler yerçekimini azaltır (~11 yükselir: tırları aşar)
const ROAD_HALF = ROAD_WIDTH / 2 // arabanın merkezi bundan daha yana çıkarsa altında yol kalmaz → düşer
const OFFSET_LIMIT = ROAD_HALF + 12 // yolun dışında da bir yere kadar kayabilir
const FALL_RESPAWN_BACK = 40 // düştüğü yerin kaç birim gerisinde yeniden doğsun
const CRASH_RESPAWN_BACK = 70 // çarptığı yerin kaç birim gerisinde yeniden doğsun
const RESPAWN_SPEED = 15 // yeniden doğunca başlangıç hızı
const FALL_TIME = 2 // en fazla kaç saniye düşsün
const FALL_DEPTH = 40 // ya da yolun kaç birim altına inince yeniden doğsun
const CRASH_TIME = 1.2 // çarptıktan kaç saniye sonra yeniden doğsun
const OBSTACLE_CLEARANCE = 20 // yeniden doğma noktası bir engele bundan yakın olmasın (birim)
const FUEL_USE = 0.45 // süzülürken saniyede harcanan yakıt (dolu depo ≈ 2.2 sn süzülme)
const FUEL_REGEN = 0.05 // yerdeyken saniyede dolan yakıt (boştan dolmaya 20 sn; Thrust Cell anında doldurur)
const BOOST_SLOWDOWN = 40 // Block Rush bitince fazla hız saniyede bu kadar azalır

// Arabanın çarpışma kutusu (carModel.js ölçüleri: boy ≈ 9.7, genişlik ≈ 4.1)
const CAR_HALF_LENGTH = 4.8
const CAR_HALF_WIDTH = 2.0

const up = new THREE.Vector3(0, 1, 0)

// Engellerin pist koordinatlarındaki kutuları: pist boyunca yarım derinlik, yandaki merkez ve
// yarım genişlik, yükseklik. AABB (eksenlere hizalı kutu): her eksende ayrı ayrı üst üste binme kontrolü
export const obstacleBoxes = obstacles.map((o) => {
  const center = o.offset * ROAD_HALF
  if (o.type === 'wall') return { u: o.u, center, halfDepth: 1, halfWidth: o.width / 2, top: o.height }
  if (o.type === 'tower') {
    // Kule yukarı doğru incelir: kutunun boyutu yüksekliğe göre hesaplanır (bkz. boxSizeAt)
    const bottomHalf = o.width / 2
    return { u: o.u, center, bottomHalf, topHalf: bottomHalf * TOWER_TOP_RATIO, top: o.height + 0.4 }
  }
  return { u: o.u, center, halfDepth: TRUCK_SIZE.length / 2, halfWidth: TRUCK_SIZE.width / 2, top: TRUCK_SIZE.height }
})

// events: { onCrash, onFall } → main.js ekrana yazı çıkarmak için kullanır
export function createCar(scene, events = {}) {
  const model = createCarModel()
  const thrusters = createThrusters(model, scene)

  // Arabanın durumu: konumu bu sayılardan hesaplıyoruz
  const state = {
    u: 0.0, // turun neresinde (0 → 1)
    speed: 0, // pist boyunca hız
    offset: 0, // yandaki konum: - sol, + sağ
    height: 0, // yoldan yükseklik
    vy: 0, // dikey hız
    falling: false, // yolun dışına çıktı, aşağı düşüyor
    fallTime: 0, // ne zamandır düşüyor (saniye)
    crashed: false, // bir engele çarptı
    crashTime: 0, // ne zamandır çarpmış durumda (saniye)
    respawned: false, // bu karede yeniden doğdu mu (kamera ani geçiş yapsın diye main.js okur)
    blink: 0, // yeniden doğduktan sonra yanıp sönme süresi (saniye); bu sürede çarpışma yok
    fuel: 1, // itici yakıtı (0 → 1). items.js: Thrust Cell doldurur
    shield: false, // kalkan açık mı. items.js: 1 tuşu açar; bir çarpışmayı affeder
    boost: 1, // hız çarpanı. items.js: Block Rush sırasında 1.6
  }
  let thrustPower = 0 // roketlerin gücü (0 → 1), görsel efektler için
  let roll = 0 // yana yatma açısı (radyan)
  let pitch = 0 // burun yukarı/aşağı açısı (radyan)
  let crashBackSpeed = 0 // çarpınca geriye sekme hızı
  let crashSpinSide = 1 // çarpınca hangi yöne dönsün
  const previousPosition = new THREE.Vector3()
  const velocity = new THREE.Vector3() // arabanın dünyadaki hızı (duman için)

  // Engelin, arabanın altının bulunduğu yükseklikteki yarım genişliği.
  // Kule için tabandan tepeye doğru daralır (lerp); diğerleri her yükseklikte aynı
  function halfSizeAt(b, height) {
    if (b.bottomHalf === undefined) return { depth: b.halfDepth, width: b.halfWidth }
    const t = THREE.MathUtils.clamp(height / b.top, 0, 1)
    const half = THREE.MathUtils.lerp(b.bottomHalf, b.topHalf, t) * 0.9 // %10 tolerans: sıyırınca çarpmasın
    return { depth: half, width: half }
  }

  // Araba kutusu herhangi bir engel kutusuyla üç eksende de üst üste biniyor mu?
  function hitsObstacle() {
    return obstacleBoxes.some((b) => {
      if (state.height >= b.top) return false // arabanın altı engelin tepesinden yukarıda: üstünden geçiyor
      const half = halfSizeAt(b, state.height)
      return (
        Math.abs(trackDistance(state.u, b.u)) < CAR_HALF_LENGTH + half.depth && // pist boyunca
        Math.abs(state.offset - b.center) < CAR_HALF_WIDTH + half.width // yanlara
      )
    })
  }

  function moveAlongTrack(distance) {
    // u her zaman 0 ile 1 arasında kalsın: tur bitince başa dön (+1 negatif değere karşı)
    state.u = (((state.u + distance / trackLength) % 1) + 1) % 1
  }

  // Yerçekimi + yola iniş. Altında yol yoksa düşmeye başlar
  function applyGravity(dt, gravity) {
    state.vy -= gravity * dt // her karede aşağı doğru hız ekle
    state.height += state.vy * dt
    if (state.height >= 0) return
    const overRoad = Math.abs(state.offset) <= ROAD_HALF // altında yol var mı?
    if (overRoad && !state.falling) {
      state.height = 0 // yol var: üstüne in, içine gömülme
      state.vy = 0
    } else if (!state.falling) {
      state.falling = true // altında yol yok: düşmeye başla
      events.onFall?.()
    }
  }

  function updateDriving(dt) {
    // 1) Hız: gaz, fren, sürtünme. Block Rush (boost) en yüksek hızı ve ivmeyi artırır
    const maxSpeed = MAX_SPEED * state.boost
    if (input.forward) state.speed += ACCELERATION * state.boost * dt
    else if (input.brake) state.speed -= BRAKE * dt
    else state.speed -= DRAG * dt
    // Sınırın üstündeyse (Rush yeni bittiyse) birden değil yavaşça normale in
    if (state.speed > maxSpeed) state.speed = Math.max(maxSpeed, state.speed - BOOST_SLOWDOWN * dt)
    state.speed = Math.max(0, state.speed)

    // 2) Pist boyunca ilerle
    moveAlongTrack(state.speed * dt)

    // 3) Sağa-sola kayma (havadayken de çalışır)
    if (input.left) state.offset -= STRAFE_SPEED * dt
    if (input.right) state.offset += STRAFE_SPEED * dt
    state.offset = THREE.MathUtils.clamp(state.offset, -OFFSET_LIMIT, OFFSET_LIMIT)

    // 4) Zıplama, roketle süzülme ve yerçekimi
    const onGround = state.height <= 0 && !state.falling
    if (onGround && input.jump) {
      state.vy = JUMP_VELOCITY
      thrustPower = 1 // kalkışta roketler tam güç ateşlenir
    }
    // Süzülme yakıt harcar; yakıt bitince roketler yerçekimini karşılayamaz
    const hovering = !onGround && input.jump && state.fuel > 0
    if (hovering) state.fuel = Math.max(0, state.fuel - FUEL_USE * dt)
    else if (onGround) state.fuel = Math.min(1, state.fuel + FUEL_REGEN * dt)
    applyGravity(dt, hovering ? HOVER_GRAVITY : GRAVITY)

    // Roket gücü: yerdeyken söner, havada Space basılıysa tam, değilse yarım
    const targetPower = state.height <= 0 ? 0 : hovering ? 1 : 0.35
    thrustPower += (targetPower - thrustPower) * Math.min(1, dt * 6)

    // 5) Düşüş bitti mi? Yeterince aşağı indiyse ya da süre dolduysa geride yeniden doğ
    if (state.falling) {
      state.fallTime += dt
      if (state.fallTime > FALL_TIME || state.height < -FALL_DEPTH) respawn(FALL_RESPAWN_BACK)
      return
    }

    // 6) Çarpışma (yeniden doğduktan sonraki yanıp sönme süresinde yok)
    if (state.blink <= 0 && hitsObstacle()) {
      if (state.shield) {
        // Kalkan çarpışmayı affeder: kırılır, araba kısa süre yanıp sönerek engelin içinden geçer
        state.shield = false
        state.blink = 1.2
        events.onShieldBlock?.()
      } else {
        crash()
      }
    }
  }

  function crash() {
    state.crashed = true
    state.crashTime = 0
    state.speed = 0
    crashBackSpeed = -18 // geriye sek
    crashSpinSide = Math.random() < 0.5 ? -1 : 1
    state.vy = 9 // biraz havaya fırla
    thrustPower = 0
    thrusters.burst(model.position) // patlama: parlama + duman
    events.onCrash?.()
  }

  function updateCrash(dt) {
    state.crashTime += dt
    crashBackSpeed *= 1 - Math.min(1, 2.5 * dt) // geri sekme yavaşça durur
    moveAlongTrack(crashBackSpeed * dt)
    applyGravity(dt, GRAVITY)
    if (state.falling) state.fallTime += dt
    if (state.crashTime > CRASH_TIME) respawn(CRASH_RESPAWN_BACK)
  }

  function update(dt) {
    if (state.crashed) updateCrash(dt)
    else updateDriving(dt)
    if (state.blink > 0) state.blink -= dt

    // Durumu dünyadaki konuma çevir
    const center = trackCurve.getPointAt(state.u)
    const tangent = trackCurve.getTangentAt(state.u)
    const side = new THREE.Vector3().crossVectors(tangent, up).normalize()

    model.position
      .copy(center)
      .addScaledVector(side, state.offset)
      .addScaledVector(up, state.height)
    model.lookAt(model.position.clone().add(tangent)) // burnu gidiş yönüne

    // Yatma ve yunuslama: sağa kayarken sağa yatar, yükselirken burnu kalkar.
    // rotateZ/rotateX arabanın kendi eksenlerinde döndürür (lookAt'tan sonra çağrılmalı)
    const strafe = state.crashed ? 0 : (input.right ? 1 : 0) - (input.left ? 1 : 0)
    roll += (strafe * 0.2 - roll) * Math.min(1, dt * 7)
    pitch += (THREE.MathUtils.clamp(-state.vy * 0.012, -0.2, 0.2) - pitch) * Math.min(1, dt * 5)
    model.rotateZ(roll)
    model.rotateX(pitch)
    // Düşerken burnunun üstüne doğru takla atsın
    if (state.falling) model.rotateX(Math.min(state.fallTime * 1.4, 1.3))
    // Çarpınca kendi etrafında savrulsun (giderek yavaşlayan dönüş)
    if (state.crashed) model.rotateY(crashSpinSide * 2.2 * (1 - Math.exp(-3 * state.crashTime)))

    // Yeniden doğduktan sonra yanıp sön (saniyede ~8 kez görünür/görünmez)
    model.visible = state.blink <= 0 || Math.floor(state.blink * 16) % 2 === 0
    model.updateMatrixWorld() // duman, arabanın güncel konumundan çıksın

    // Dünya hızı = konum farkı / geçen süre
    if (dt > 0) velocity.subVectors(model.position, previousPosition).divideScalar(dt)
    previousPosition.copy(model.position)

    thrusters.update(dt, thrustPower, velocity, side)
  }

  // Verilen mesafe kadar geride, yolun ortasında yeniden başlat
  function respawn(backDistance) {
    let u = state.u - backDistance / trackLength
    // Doğma noktası bir engelin dibine denk gelmesin: yakın engel varsa onun da gerisine al
    for (let tries = 0; tries < obstacles.length; tries++) {
      const blocking = obstacles.find((o) => Math.abs(trackDistance(u, o.u)) < OBSTACLE_CLEARANCE)
      if (!blocking) break
      u = blocking.u - (OBSTACLE_CLEARANCE * 1.5) / trackLength
    }
    state.u = ((u % 1) + 1) % 1
    state.offset = 0
    state.height = 0
    state.vy = 0
    state.speed = RESPAWN_SPEED
    state.falling = false
    state.fallTime = 0
    state.crashed = false
    state.crashTime = 0
    state.blink = 1.5
    state.respawned = true
    roll = 0
    pitch = 0
    thrustPower = 0
  }

  // 0 → 1: kamera efektleri için hızın maksimuma oranı
  const speedRatio = () => state.speed / MAX_SPEED

  return { model, state, update, speedRatio }
}
