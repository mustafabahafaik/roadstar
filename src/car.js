import * as THREE from 'three'
import { trackCurve, ROAD_WIDTH } from './track.js'
import { obstacles } from './obstacles.js'
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
const RESPAWN_BACK = 40 // düştüğü yerin kaç birim gerisinde yeniden doğsun
const RESPAWN_SPEED = 15 // yeniden doğunca başlangıç hızı
const FALL_TIME = 2 // en fazla kaç saniye düşsün
const FALL_DEPTH = 40 // ya da yolun kaç birim altına inince yeniden doğsun
const OBSTACLE_CLEARANCE = 20 // yeniden doğma noktası bir engele bundan yakın olmasın (birim)

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
    falling: false, // yolun dışına çıktı, aşağı düşüyor
    fallTime: 0, // ne zamandır düşüyor (saniye)
    respawned: false, // bu karede yeniden doğdu mu (kamera ani geçiş yapsın diye main.js okur)
    blink: 0, // yeniden doğduktan sonra yanıp sönme süresi (saniye)
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
    state.offset = THREE.MathUtils.clamp(state.offset, -OFFSET_LIMIT, OFFSET_LIMIT)

    // 4) Zıplama, roketle süzülme ve yerçekimi
    const overRoad = Math.abs(state.offset) <= ROAD_HALF // altında yol var mı?
    const onGround = state.height <= 0 && !state.falling
    if (onGround && input.jump) {
      state.vy = JUMP_VELOCITY
      thrustPower = 1 // kalkışta roketler tam güç ateşlenir
    }
    const hovering = !onGround && input.jump
    state.vy -= (hovering ? HOVER_GRAVITY : GRAVITY) * dt // her karede aşağı doğru hız ekle
    state.height += state.vy * dt
    if (state.height < 0) {
      if (overRoad && !state.falling) {
        state.height = 0 // yol var: üstüne in, içine gömülme
        state.vy = 0
      } else {
        state.falling = true // altında yol yok (ya da zaten düşüyor): düşmeye devam
      }
    }

    // Düşüş bitti mi? Yeterince aşağı indiyse ya da süre dolduysa geride yeniden doğ
    if (state.falling) {
      state.fallTime += dt
      if (state.fallTime > FALL_TIME || state.height < -FALL_DEPTH) respawn()
    }
    if (state.blink > 0) state.blink -= dt

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
    // Düşerken burnunun üstüne doğru takla atsın
    if (state.falling) model.rotateX(Math.min(state.fallTime * 1.4, 1.3))

    // Yeniden doğduktan sonra yanıp sön (saniyede ~8 kez görünür/görünmez)
    model.visible = state.blink <= 0 || Math.floor(state.blink * 16) % 2 === 0
    model.updateMatrixWorld() // duman, arabanın güncel konumundan çıksın

    // Dünya hızı = konum farkı / geçen süre
    if (dt > 0) velocity.subVectors(model.position, previousPosition).divideScalar(dt)
    previousPosition.copy(model.position)

    thrusters.update(dt, thrustPower, velocity, side)
  }

  // Düştüğü yerin biraz gerisinde, yolun ortasında yeniden başlat
  function respawn() {
    let u = state.u - RESPAWN_BACK / trackLength
    // Doğma noktası bir engelin dibine denk gelmesin: yakın engel varsa onun da gerisine al
    for (let tries = 0; tries < obstacles.length; tries++) {
      const blocking = obstacles.find((o) => {
        const gap = ((((o.u - u) % 1) + 1.5) % 1) - 0.5 // turun başı/sonu dahil en kısa fark (-0.5 … 0.5)
        return Math.abs(gap) * trackLength < OBSTACLE_CLEARANCE
      })
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
