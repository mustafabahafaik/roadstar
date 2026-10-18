import * as THREE from 'three'
import { trackCurve } from './track.js'
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
const ROAD_LIMIT = 5.5 // merkezden en fazla bu kadar yana gidebilir (yol yarı genişliği 8, araba yarı genişliği ~2)

const trackLength = trackCurve.getLength() // pistin toplam uzunluğu (birim)
const up = new THREE.Vector3(0, 1, 0)

export function createCar(scene) {
  const model = createCarModel()
  const thrusters = createThrusters(model, scene)

  // Arabanın durumu: konumu bu sayılardan hesaplıyoruz
  const state = {
    u: 0.0, // turun neresinde (0 → 1)
    speed: 0, // pist boyunca hız
    offset: 0, // yandaki konum: - sol, + sağ
    height: 0, // yoldan yükseklik
    vy: 0, // dikey hız
  }
  let thrustPower = 0 // roketlerin gücü (0 → 1), görsel efektler için
  let roll = 0 // yana yatma açısı (radyan)
  let pitch = 0 // burun yukarı/aşağı açısı (radyan)
  const previousPosition = new THREE.Vector3()
  const velocity = new THREE.Vector3() // arabanın dünyadaki hızı (duman için)

  function update(dt) {
    // 1) Hız: gaz, fren, sürtünme
    if (input.forward) state.speed += ACCELERATION * dt
    else if (input.brake) state.speed -= BRAKE * dt
    else state.speed -= DRAG * dt
    state.speed = THREE.MathUtils.clamp(state.speed, 0, MAX_SPEED) // clamp: değeri iki sınır arasında tut

    // 2) Pist boyunca ilerle: mesafe / toplam uzunluk = u'daki değişim.
    // u her zaman 0 ile 1 arasında kalsın: tur bitince başa dön (+1 negatif değere karşı)
    state.u = (((state.u + (state.speed * dt) / trackLength) % 1) + 1) % 1

    // 3) Sağa-sola kayma (havadayken de çalışır)
    if (input.left) state.offset -= STRAFE_SPEED * dt
    if (input.right) state.offset += STRAFE_SPEED * dt
    state.offset = THREE.MathUtils.clamp(state.offset, -ROAD_LIMIT, ROAD_LIMIT)

    // 4) Zıplama, roketle süzülme ve yerçekimi
    const onGround = state.height <= 0
    if (onGround && input.jump) {
      state.vy = JUMP_VELOCITY
      thrustPower = 1 // kalkışta roketler tam güç ateşlenir
    }
    const hovering = !onGround && input.jump
    state.vy -= (hovering ? HOVER_GRAVITY : GRAVITY) * dt // her karede aşağı doğru hız ekle
    state.height += state.vy * dt
    if (state.height < 0) {
      state.height = 0 // yolun içine gömülmesin
      state.vy = 0
    }

    // Roket gücü: yerdeyken söner, havada Space basılıysa tam, değilse yarım
    const targetPower = state.height <= 0 ? 0 : hovering ? 1 : 0.35
    thrustPower += (targetPower - thrustPower) * Math.min(1, dt * 6)

    // 5) Durumu dünyadaki konuma çevir
    const center = trackCurve.getPointAt(state.u)
    const tangent = trackCurve.getTangentAt(state.u)
    const side = new THREE.Vector3().crossVectors(tangent, up).normalize()

    model.position
      .copy(center)
      .addScaledVector(side, state.offset)
      .addScaledVector(up, state.height)
    model.lookAt(model.position.clone().add(tangent)) // burnu gidiş yönüne

    // 6) Yatma ve yunuslama: sağa kayarken sağa yatar, yükselirken burnu kalkar.
    // rotateZ/rotateX arabanın kendi eksenlerinde döndürür (lookAt'tan sonra çağrılmalı)
    const strafe = (input.right ? 1 : 0) - (input.left ? 1 : 0)
    roll += (strafe * 0.2 - roll) * Math.min(1, dt * 7)
    pitch += (THREE.MathUtils.clamp(-state.vy * 0.012, -0.2, 0.2) - pitch) * Math.min(1, dt * 5)
    model.rotateZ(roll)
    model.rotateX(pitch)
    model.updateMatrixWorld() // duman, arabanın güncel konumundan çıksın

    // Dünya hızı = konum farkı / geçen süre
    if (dt > 0) velocity.subVectors(model.position, previousPosition).divideScalar(dt)
    previousPosition.copy(model.position)

    thrusters.update(dt, thrustPower, velocity, side)
  }

  // 0 → 1: kamera efektleri için hızın maksimuma oranı
  const speedRatio = () => state.speed / MAX_SPEED

  return { model, state, update, speedRatio }
}
