import * as THREE from 'three'
import { trackCurve, trackLength, trackDistance, TRACK_WIDTH } from './track.js'
import { course } from './course.js'
import { input } from './input.js'

// Yarış bitince kullanılan "kontroller": gaz yok, fren basılı → araba yavaşça durur
const FINISHED_INPUT = { forward: false, brake: true, left: false, right: false, jump: false }
import { createCarModel } from './carModel.js'
import { createThrusters } from './thrusters.js'
import { rampSurface } from './ramps.js'

// --- Ayarlar: oyun hissini bu sayılarla değiştirebilirsin ---
const MAX_SPEED = 70 // birim / saniye
const ACCELERATION = 30 // gaza basınca hız artışı (birim / saniye²)
const BRAKE = 60 // frenleme
const DRAG = 8 // gaz bırakılınca yavaşlama
const STRAFE_SPEED = 14 // sağa-sola kayma hızı
const JUMP_VELOCITY = 22 // zıplama anındaki yukarı hız (bırakınca ~6.7 yükselir: duvarları aşar)
const GRAVITY = 36 // aşağı çeken ivme
const HOVER_GRAVITY = 22 // havada Space basılı tutulunca roketler yerçekimini azaltır (~11 yükselir: tırları aşar)
const ROAD_HALF = TRACK_WIDTH / 2 // pistin kenarı (merkezden uzaklık)
const FALL_MARGIN = 1 // hoşgörü: arabanın MERKEZİ kenarı bu kadar geçince düşer (gövdenin yarısı zaten dışarıda)
export const FALL_EDGE = ROAD_HALF + FALL_MARGIN // düşme sınırı: merkez bundan daha yana çıkarsa altında yol yok
const OFFSET_LIMIT = ROAD_HALF + 12 // yolun dışında da bir yere kadar kayabilir
const FALL_RESPAWN_BACK = 40 // düştüğü yerin kaç birim gerisinde yeniden doğsun
const CRASH_RESPAWN_BACK = 70 // çarptığı yerin kaç birim gerisinde yeniden doğsun
const RESPAWN_SPEED = 15 // yeniden doğunca başlangıç hızı
const CRASH_TIME = 1.2 // çarptıktan kaç saniye sonra yeniden doğsun
const OBSTACLE_CLEARANCE = 20 // yeniden doğma noktası bir engele bundan yakın olmasın (birim)
const FUEL_USE = 0.45 // süzülürken saniyede harcanan yakıt (dolu depo ≈ 2.2 sn süzülme)
const FUEL_REGEN = 0.05 // yerdeyken saniyede dolan yakıt (boştan dolmaya 20 sn; Thrust Cell anında doldurur)
const BOOST_THRUST = 2.5 // boost aktifken hedef hıza yaklaşma hızı (büyüdükçe daha sert hızlanır)
const OVERSPEED_DECAY = 2 // boost bitince sınırın üstündeki fazla hızın sönme hızı (üstel, yumuşak)

// Arabanın çarpışma kutusu (carModel.js ölçüleri: boy ≈ 9.7, genişlik ≈ 4.1)
const CAR_HALF_LENGTH = 4.8
export const CAR_HALF_WIDTH = 2.0

const up = new THREE.Vector3(0, 1, 0)


// smoke: ortak duman havuzu (smoke.js). events: { onCrash, onFall, ... } → main.js ekrana yazı çıkarır
export function createCar(scene, smoke, events = {}) {
  const model = createCarModel()
  const thrusters = createThrusters(model, scene, smoke)
  // Kamera çerçevesi: arabanın konumu + pist yönü (takla ve yatma YOK) → araba dönerken ekran dönmesin
  const frame = new THREE.Object3D()

  // Arabanın durumu: konumu bu sayılardan hesaplıyoruz
  const state = {
    u: 0.0, // turun neresinde (0 → 1)
    speed: 0, // pist boyunca hız
    offset: 0, // yandaki konum: - sol, + sağ
    height: 0, // yoldan yükseklik
    vy: 0, // dikey hız
    falling: false, // yolun dışına çıktı, aşağı düşüyor
    onGround: true, // yolda ya da rampanın üstünde mi (applyGravity günceller; tricks.js de okur)
    fallTime: 0, // ne zamandır düşüyor (saniye)
    crashed: false, // bir engele çarptı
    crashTime: 0, // ne zamandır çarpmış durumda (saniye)
    respawned: false, // bu karede yeniden doğdu mu (kamera ani geçiş yapsın diye main.js okur)
    blink: 0, // yeniden doğduktan sonra yanıp sönme süresi (saniye); bu sürede çarpışma yok
    fuel: 1, // itici yakıtı (0 → 1). items.js: Thrust Cell doldurur
    shield: false, // kalkan açık mı. items.js: 1 tuşu açar; bir çarpışmayı affeder
    boost: 1, // en yüksek hız çarpanı (boost.js yazar: 1 → 2 yumuşak geçiş)
    boostThrust: false, // boost aktif mi (boost.js): aktifken gaza basılmasa da hedef hıza yaklaşır
    distance: 0, // başlangıçtan beri net ilerleme (birim). Geri sekme ve yeniden doğma düşülür
    finished: false, // yarış bitti mi (bitiş kapısı ya da DNF)
    locked: true, // geri sayım bitene kadar sürülemez (main.js açar)
    trickQuat: new THREE.Quaternion(), // havadaki takla dönüşü (tricks.js yönetir), pist yönüne göre
    wobble: 0, // kötü inişte sarsılma süresi (saniye)
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
    return course.obstacleBoxes.some((b) => { // course.js: seed'den üretilmiş engeller
      if (state.height >= b.top) return false // arabanın altı engelin tepesinden yukarıda: üstünden geçiyor
      const half = halfSizeAt(b, state.height)
      return (
        Math.abs(trackDistance(state.u, b.u)) < CAR_HALF_LENGTH + half.depth && // pist boyunca
        Math.abs(state.offset - b.center) < CAR_HALF_WIDTH + half.width // yanlara
      )
    })
  }

  function moveAlongTrack(distance) {
    state.distance += distance
    // u her zaman 0 ile 1 arasında kalsın: tur bitince başa dön (+1 negatif değere karşı)
    state.u = (((state.u + distance / trackLength) % 1) + 1) % 1
  }

  // Yerçekimi + yola iniş. Altında yol yoksa düşmeye başlar
  // Yerçekimi + zemine iniş. Zemin: yol (0) ya da rampa yüzeyi (ramps.js). Altında yol yoksa düşer
  function applyGravity(dt, gravity) {
    state.vy -= gravity * dt // her karede aşağı doğru hız ekle
    state.height += state.vy * dt
    if (state.falling) {
      state.onGround = false // düşüyor: zemin yok, yerçekimiyle inmeye devam
      return
    }
    const ground = rampSurface(state.u, state.offset)
    if (state.height > ground.height) {
      state.onGround = false // zeminin üstünde: havada
      return
    }
    const overRoad = Math.abs(state.offset) <= FALL_EDGE // altında yol var mı? (merkez + hoşgörü payı)
    if (overRoad && !state.falling) {
      state.height = ground.height // zemine otur, içine gömülme
      // Dikey hız = zeminin eğimi × ileri hız. Düz yolda 0; rampada yukarı. Dudakta zemin bitince
      // araba bu hızı korur → kendiliğinden havaya fırlar (ayrı bir "zıplatma" kodu gerekmez)
      state.vy = ground.slope * state.speed
      state.onGround = true
    } else if (!state.falling) {
      state.falling = true // altında yol yok: düşmeye başla
      state.onGround = false
      events.onFall?.()
    }
  }

  function updateDriving(dt) {
    const controls = state.finished || state.locked ? FINISHED_INPUT : input
    // 1) Hız: gaz, fren, sürtünme. Block Rush (boost) en yüksek hızı ve ivmeyi artırır.
    // Havadayken W/S takla tuşudur (tricks.js): hız korunur, gaz/fren işlemez
    const maxSpeed = MAX_SPEED * state.boost
    const airborne = !state.onGround && !state.falling
    if (!airborne) {
      if (controls.forward) {
        // Gaz hızı en fazla sınıra kadar artırır; sınırın üstündeyse (boost yeni bittiyse) ekleme yapmaz
        if (state.speed < maxSpeed) state.speed = Math.min(maxSpeed, state.speed + ACCELERATION * state.boost * dt)
      } else if (controls.brake) state.speed -= BRAKE * dt
      else state.speed -= DRAG * dt
    }
    // Boost: hedef hıza yumuşakça yaklaş (lerp). 1 − e^(−k·dt) → her kare hızında aynı ivme eğrisi
    if (state.boostThrust) state.speed += (maxSpeed - state.speed) * (1 - Math.exp(-BOOST_THRUST * dt))
    // Sınırın üstündeyse (boost yeni bittiyse) birden değil, fazlası üstel olarak sönsün
    if (state.speed > maxSpeed) state.speed = maxSpeed + (state.speed - maxSpeed) * Math.exp(-OVERSPEED_DECAY * dt)
    state.speed = Math.max(0, state.speed)

    // 2) Pist boyunca ilerle
    moveAlongTrack(state.speed * dt)

    // 3) Sağa-sola kayma (havadayken de çalışır)
    if (controls.left) state.offset -= STRAFE_SPEED * dt
    if (controls.right) state.offset += STRAFE_SPEED * dt
    state.offset = THREE.MathUtils.clamp(state.offset, -OFFSET_LIMIT, OFFSET_LIMIT)

    // 4) Zıplama, roketle süzülme ve yerçekimi
    const onGround = state.onGround && !state.falling // yolda ya da rampanın üstünde
    if (onGround && controls.jump) {
      state.vy = JUMP_VELOCITY
      thrustPower = 1 // kalkışta roketler tam güç ateşlenir
    }
    // Süzülme yakıt harcar; yakıt bitince roketler yerçekimini karşılayamaz
    const hovering = !onGround && controls.jump && state.fuel > 0
    if (hovering) state.fuel = Math.max(0, state.fuel - FUEL_USE * dt)
    else if (onGround) state.fuel = Math.min(1, state.fuel + FUEL_REGEN * dt)
    applyGravity(dt, hovering ? HOVER_GRAVITY : GRAVITY)

    // Roket gücü: yerdeyken söner, havada Space basılıysa tam, değilse yarım
    const targetPower = state.onGround ? 0 : hovering ? 1 : 0.35
    thrustPower += (targetPower - thrustPower) * Math.min(1, dt * 6)

    // 5) Düşüyorsa: süreyi say, geri dönüşü fall.js yönetir (gerçek zamanla 2 sn sonra respawnAfterFall)
    if (state.falling) {
      state.fallTime += dt
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
    // Pistin sonuna (bitiş kapısı, u = 0) varınca yarış biter. Süreyi race.js ölçer (ms, gerçek saat)
    if (!state.finished && state.distance >= trackLength) endRace('lap')

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
    frame.position.copy(model.position)
    frame.quaternion.copy(model.quaternion)
    frame.updateMatrixWorld() // kamera bu çerçeveyi kullanır (localToWorld için güncel olmalı)

    // Yatma ve yunuslama: sağa kayarken sağa yatar, yükselirken burnu kalkar.
    // rotateZ/rotateX arabanın kendi eksenlerinde döndürür (lookAt'tan sonra çağrılmalı)
    const controls = state.finished || state.locked ? FINISHED_INPUT : input
    const strafe = state.crashed ? 0 : (controls.right ? 1 : 0) - (controls.left ? 1 : 0)
    roll += (strafe * 0.2 - roll) * Math.min(1, dt * 7)
    pitch += (THREE.MathUtils.clamp(-state.vy * 0.012, -0.2, 0.2) - pitch) * Math.min(1, dt * 5)
    model.rotateZ(roll)
    model.rotateX(pitch)
    // Çarpınca kendi etrafında savrulsun (giderek yavaşlayan dönüş)
    if (state.crashed) model.rotateY(crashSpinSide * 2.2 * (1 - Math.exp(-3 * state.crashTime)))

    // Takla: tricks.js'in quaternion'ı. Sağdan çarpmak = arabanın KENDİ (yerel) eksenlerinde döndürmek
    model.quaternion.multiply(state.trickQuat)

    // Kötü iniş sarsıntısı: hızlı, giderek sönen yalpalama
    if (state.wobble > 0) {
      state.wobble = Math.max(0, state.wobble - dt)
      model.rotateZ(Math.sin(state.wobble * 45) * 0.2 * state.wobble)
    }

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
    for (let tries = 0; tries < course.obstacles.length; tries++) {
      const blocking = course.obstacles.find((o) => Math.abs(trackDistance(u, o.u)) < OBSTACLE_CLEARANCE)
      if (!blocking) break
      u = blocking.u - (OBSTACLE_CLEARANCE * 1.5) / trackLength
    }
    const newU = ((u % 1) + 1) % 1
    state.distance += trackDistance(state.u, newU) // geri gidilen mesafe ilerlemeden düşülür
    state.u = newU
    state.offset = 0
    state.height = 0
    state.vy = 0
    state.speed = RESPAWN_SPEED
    state.falling = false
    state.onGround = true
    state.fallTime = 0
    state.crashed = false
    state.crashTime = 0
    state.blink = 1.5
    state.respawned = true
    roll = 0
    pitch = 0
    thrustPower = 0
    state.trickQuat.identity() // takla sıfırlansın: yeniden doğan araba düz dursun
    state.wobble = 0
  }

  // Yarışı bitir. reason: 'lap' (bitiş kapısından geçti) | 'dnf' (kalkansız düştü)
  function endRace(reason) {
    if (state.finished) return
    state.finished = true
    events.onFinish?.(reason)
  }

  // 0 → 1: kamera efektleri için hızın maksimuma oranı
  const speedRatio = () => state.speed / MAX_SPEED
  // 0 → 1: pistin ne kadarı tamamlandı (race.js: ilerleme çubuğu ve sıralama)
  const progress = () => THREE.MathUtils.clamp(state.distance / trackLength, 0, 1)

  return {
    model,
    frame,
    state,
    velocity,
    update,
    speedRatio,
    progress,
    endRace,
    respawnAfterFall: () => respawn(FALL_RESPAWN_BACK), // fall.js çağırır
  }
}
