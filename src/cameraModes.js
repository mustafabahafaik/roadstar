import * as THREE from 'three'

// Kamera modları:
//   'chase' → takip: arabanın arkasında ve yukarısında (fareyle sürükleyince etrafına bakar)
//   'fall'  → düşüş: arabanın düştüğü tarafta, yanında ve biraz yukarıda durup arabaya bakar
// Geçiş ani değil: iki modun hedef noktası her karede hesaplanır, blend (0 → 1) yumuşakça değişir
// ve kamera bu ikisinin arasına konur.

const CAMERA_HEIGHT = 5.6
const FALL_SIDE_DISTANCE = 16 // düşüş: kamera arabanın kaç birim yanında
const FALL_SIDE_HEIGHT = 5 // düşüş: kamera arabanın kaç birim yukarısında
const FALL_SIDE_AHEAD = 4 // düşüş: kamera biraz önde dursun → araba ve arkadaki pist birlikte görünür
const MODE_BLEND_SPEED = 3 // mod geçişinin hızı (büyüdükçe daha çabuk)

// isOrbitEnabled: serbest kamera (C tuşu) açıksa fare olaylarını OrbitControls'e bırak
export function createCameraModes({ camera, domElement, car, boost, isOrbitEnabled }) {
  // Fareyle sürükleyince arabanın etrafında dönme, bırakınca yavaşça arkaya geri gelme
  const look = { yaw: 0, height: 0, distance: 16, dragging: false }
  let mode = 'chase'
  let blend = 0 // 0 = tamamen takip, 1 = tamamen düşüş kamerası
  let fallSide = 1 // düşülen taraf: +1 sağ, −1 sol

  const chasePosition = new THREE.Vector3()
  const chaseLook = new THREE.Vector3()
  const fallPosition = new THREE.Vector3()
  const desiredPosition = new THREE.Vector3()
  const lookTarget = new THREE.Vector3()

  domElement.addEventListener('pointerdown', (e) => {
    if (isOrbitEnabled() || e.button !== 0) return
    look.dragging = true
    domElement.setPointerCapture(e.pointerId) // fare pencereden çıksa da sürükleme sürsün
  })
  domElement.addEventListener('pointermove', (e) => {
    if (!look.dragging) return
    look.yaw -= e.movementX * 0.006 // movementX: son olaydan beri farenin yatay hareketi (piksel)
    look.height = THREE.MathUtils.clamp(look.height + e.movementY * 0.03, -3.5, 10)
  })
  domElement.addEventListener('pointerup', () => (look.dragging = false))
  domElement.addEventListener(
    'wheel',
    (e) => {
      if (isOrbitEnabled()) return
      look.distance = THREE.MathUtils.clamp(look.distance + e.deltaY * 0.01, 9, 34)
    },
    { passive: true },
  )

  // side: düşülen taraf (+1 sağ, −1 sol). Sadece 'fall' modunda anlamlı
  function setMode(next, { side = 1 } = {}) {
    mode = next
    if (next === 'fall') fallSide = side
  }

  // dt: GERÇEK zaman. Kamera ağır çekimden etkilenmesin (yoksa geçiş de ağır çekimde yavaşlar)
  function update(dt) {
    if (!look.dragging) {
      const back = 1 - Math.exp(-1.5 * dt)
      look.yaw -= look.yaw * back
      look.height -= look.height * back
    }
    blend += ((mode === 'fall' ? 1 : 0) - blend) * (1 - Math.exp(-MODE_BLEND_SPEED * dt))

    // --- Takip modu hedefi (arabanın kendi ekseninde; car.frame takla içermez) ---
    const distance = look.distance + 5 * boost.intensity // boost: biraz geri çekil
    chasePosition.set(Math.sin(look.yaw) * distance, CAMERA_HEIGHT + look.height, -Math.cos(look.yaw) * distance)
    chaseLook.set(0, 1.6, 12 * Math.cos(look.yaw)) // arkadan bakarken önüne, yandan bakarken kendisine
    car.frame.localToWorld(chasePosition)
    car.frame.localToWorld(chaseLook)

    // --- Düşüş modu hedefi: yanda + yukarıda, arabaya bak. Yerel +x arabanın SOLU (lookAt kuralı) ---
    fallPosition.set(-fallSide * FALL_SIDE_DISTANCE, FALL_SIDE_HEIGHT, FALL_SIDE_AHEAD)
    car.frame.localToWorld(fallPosition) // car.frame yüksekliği de içerir → kamera düşen arabayla iner

    // İki hedefin arası: blend 0 → takip, 1 → yan kamera
    desiredPosition.lerpVectors(chasePosition, fallPosition, blend)
    lookTarget.lerpVectors(chaseLook, car.model.position, blend)

    if (car.state.crashed && !car.state.falling) {
      // Çarpınca kamera yerinde kalır, arabaya bakar; ilk yarım saniyede sarsılır
      lookTarget.copy(car.model.position)
      const shake = Math.max(0, 0.5 - car.state.crashTime) * 1.6
      lookTarget.x += (Math.random() - 0.5) * shake
      lookTarget.y += (Math.random() - 0.5) * shake
    } else {
      if (car.state.respawned) {
        // Yeniden doğunca hemen arkasına geç: yan kameradan 40 birim geriye uçarak gelip pistin içinden geçmesin
        blend = mode === 'fall' ? blend : 0
        camera.position.copy(mode === 'fall' ? desiredPosition : chasePosition)
        car.state.respawned = false
      }
      camera.position.lerp(desiredPosition, 1 - Math.exp(-10 * dt)) // yumuşak takip
      // Boost başlangıcında kısa sarsıntı: bakılan noktayı titret (kamera konumu bozulmaz)
      if (boost.shake > 0) {
        lookTarget.x += (Math.random() - 0.5) * 1.2 * boost.shake
        lookTarget.y += (Math.random() - 0.5) * 1.2 * boost.shake
      }
    }
    camera.lookAt(lookTarget)

    // Hız hissi: FOV hızla 62 → 72, boost'ta 90'a kadar; düşüşte biraz daralır (yakın çekim)
    const targetFov = 62 + 10 * Math.min(1, car.speedRatio()) + 18 * boost.intensity - 8 * blend
    camera.fov += (targetFov - camera.fov) * (1 - Math.exp(-4 * dt))
    camera.updateProjectionMatrix()
  }

  return {
    update,
    setMode,
    get mode() {
      return mode
    },
  }
}
