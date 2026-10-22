import * as THREE from 'three'

// Kamera modları:
//   'chase' → takip: arabanın arkasında ve yukarısında (fareyle sürükleyince etrafına bakar)
//   'fall'  → düşüş: arabanın düştüğü tarafta, yanında ve biraz yukarıda durup arabaya bakar
//   'showcase' → vitrin (giriş sayfası): arabanın etrafında yavaşça döner
//   'garage' → garaj: seçili parçaya yaklaşır (jant → tekerlek), fareyle / parmakla çevrilir
// Geçiş ani değil: iki modun hedef noktası her karede hesaplanır, blend (0 → 1) yumuşakça değişir
// ve kamera bu ikisinin arasına konur.

const CAMERA_HEIGHT = 5.6
const FALL_SIDE_DISTANCE = 16 // düşüş: kamera arabanın kaç birim yanında
const FALL_SIDE_HEIGHT = 5 // düşüş: kamera arabanın kaç birim yukarısında
const FALL_SIDE_AHEAD = 4 // düşüş: kamera biraz önde dursun → araba ve arkadaki pist birlikte görünür
const MODE_BLEND_SPEED = 3 // mod geçişinin hızı (büyüdükçe daha çabuk)
const SHOWCASE_SPEED = 0.22 // vitrin: dönüş hızı (rad/sn) → bir tur ~29 sn
const SHOWCASE_RADIUS = 14 // bitiş kapısının sütunları ~10.7 birimde: içinden geçmesin
const SHOWCASE_HEIGHT = 3.2
// Emniyet kemeri: yarışta takip kamerası arabadan bu kadar uzakta bu kadar uzun kalırsa bir şey bozulmuştur.
// Normalde en fazla ~50 birim (en uzak zoom 34 + boost 5 + 140 hızda takip gecikmesi ~14)
const RESCUE_DISTANCE = 60
const RESCUE_AFTER = 1 // saniye

// Garaj odakları (arabanın kendi ekseninde: +z burun, +x sol). target: bakılan nokta, yaw: kameranın açısı
const GARAGE_FOCUS = [
  { target: [0, 1.4, 0], radius: 11, height: 2.4, yaw: 0.8 }, // 0 boya: tüm araba, önden-yandan (cos > 0 → önde)
  { target: [1.68, 0.72, 2.95], radius: 4.4, height: 0.5, yaw: 1.25 }, // 1 jant: sol ön tekerlek, yandan
  { target: [0, 3.0, -4.2], radius: 6.2, height: 2.4, yaw: -2.5 }, // 2 arka kanat: arkadan, yukarıdan
  { target: [0, 0.3, 0], radius: 8.5, height: 0.25, yaw: 1.57 }, // 3 alt neon: yandan, yola yakın
  { target: [0, 0.8, -4.9], radius: 5.5, height: 0.9, yaw: -2.85 }, // 4 itici alevi: arka egzoz
]

// isOrbitEnabled: serbest kamera (C tuşu) açıksa fare olaylarını OrbitControls'e bırak
// isRacing: yarış ekranında mıyız (emniyet kemeri sadece yarışta çalışır)
export function createCameraModes({ camera, domElement, car, boost, isOrbitEnabled, isRacing = () => false }) {
  // Fareyle sürükleyince arabanın etrafında dönme, bırakınca yavaşça arkaya geri gelme
  const look = { yaw: 0, height: 0, distance: 16, dragging: false }
  let mode = 'chase'
  let blend = 0 // 0 = tamamen takip, 1 = tamamen düşüş kamerası
  let fallSide = 1 // düşülen taraf: +1 sağ, −1 sol
  let showcaseAngle = 2.4 // vitrin: kameranın arabaya göre açısı (önden-yandan başla)
  const showcasePosition = new THREE.Vector3()
  const garage = { focus: GARAGE_FOCUS[0], yaw: 0, zoom: 1 } // yaw / zoom: kullanıcının sürükleme ve tekerlek payı
  // Kameranın arabaya göre şu anki yörüngesi (arabanın ekseninde). Geçişte KONUM değil bu değerler kayar:
  // kamera arabanın etrafında dönerek yeni odağa gider, düz çizgide gövdenin içinden geçmez
  const orbit = { yaw: 0, radius: 11, height: 2.4, target: new THREE.Vector3(0, 1.4, 0) }
  const impulse = { time: 0, duration: 1, strength: 0 } // dışarıdan gelen kısa sarsıntı (ör. yakın geçen meteor)
  const goalTarget = new THREE.Vector3()
  const orbitWorld = new THREE.Vector3()
  const lookWorld = new THREE.Vector3()

  const chasePosition = new THREE.Vector3()
  const chaseLook = new THREE.Vector3()
  const fallPosition = new THREE.Vector3()
  const desiredPosition = new THREE.Vector3()
  const lookTarget = new THREE.Vector3()
  let farTime = 0 // kamera ne zamandır arabadan çok uzakta (emniyet kemeri)
  const stats = { distance: 0, respawns: 0, rescues: 0 } // F3 paneli (debugPanel.js) okur

  domElement.addEventListener('pointerdown', (e) => {
    if (isOrbitEnabled() || e.button !== 0) return
    look.dragging = true
    domElement.setPointerCapture(e.pointerId) // fare pencereden çıksa da sürükleme sürsün
  })
  domElement.addEventListener('pointermove', (e) => {
    if (!look.dragging) return
    // movementX: son olaydan beri farenin yatay hareketi (piksel). Bazı telefon tarayıcıları dokunmada
    // vermiyor (undefined): undefined × sayı = NaN → kamera bozulurdu. || 0 → hareket yok say
    const dx = e.movementX || 0
    const dy = e.movementY || 0
    if (mode === 'garage') {
      garage.yaw -= dx * 0.008 // garajda çevirme kalıcı (bırakınca geri dönmez)
      return
    }
    look.yaw -= dx * 0.006
    look.height = THREE.MathUtils.clamp(look.height + dy * 0.03, -3.5, 10)
  })
  // pointercancel: gelen arama / bildirim parmağı iptal eder, pointerup hiç gelmez → sürükleme takılı kalmasın
  const endDrag = () => (look.dragging = false)
  domElement.addEventListener('pointerup', endDrag)
  domElement.addEventListener('pointercancel', endDrag)
  domElement.addEventListener('lostpointercapture', endDrag)
  domElement.addEventListener(
    'wheel',
    (e) => {
      if (isOrbitEnabled()) return
      if (mode === 'garage') garage.zoom = THREE.MathUtils.clamp(garage.zoom + e.deltaY * 0.001, 0.6, 1.8)
      else look.distance = THREE.MathUtils.clamp(look.distance + e.deltaY * 0.01, 9, 34)
    },
    { passive: true },
  )

  // side: düşülen taraf (+1 sağ, −1 sol). Sadece 'fall' modunda anlamlı
  function setMode(next, { side = 1 } = {}) {
    if (next === 'garage' && mode !== 'garage') {
      // Yörüngeyi kameranın şu anki yerinden başlat: vitrinden garaja ani sıçrama olmasın
      orbitWorld.copy(camera.position)
      car.frame.worldToLocal(orbitWorld)
      orbit.target.set(0, 1.4, 0)
      orbit.yaw = Math.atan2(orbitWorld.x, orbitWorld.z)
      orbit.radius = Math.hypot(orbitWorld.x, orbitWorld.z)
      orbit.height = orbitWorld.y - orbit.target.y
    }
    mode = next
    if (next === 'fall') fallSide = side
  }

  // Yarış başlarken (geri sayım): mod ne olursa olsun takip, kamera doğrudan arabanın arkasında
  function resetForRace() {
    mode = 'chase'
    snapBehind()
  }

  // Kamerayı takip noktasına ışınla: sürükleme ve mod geçişi sıfırlanır (bozuk look.yaw da temizlenir)
  function snapBehind() {
    look.yaw = 0
    look.height = 0
    look.dragging = false
    blend = 0
    farTime = 0
    computeChase()
    camera.position.copy(chasePosition)
    lookTarget.copy(chaseLook)
  }

  // Takip modu hedefi (arabanın kendi ekseninde; car.frame takla içermez)
  function computeChase() {
    const distance = look.distance + 5 * boost.intensity // boost: biraz geri çekil
    chasePosition.set(Math.sin(look.yaw) * distance, CAMERA_HEIGHT + look.height, -Math.cos(look.yaw) * distance)
    chaseLook.set(0, 1.6, 12 * Math.cos(look.yaw)) // arkadan bakarken önüne, yandan bakarken kendisine
    car.frame.localToWorld(chasePosition)
    car.frame.localToWorld(chaseLook)
  }

  // Garaj: hangi slota odaklanılsın (0 boya … 4 itici alevi). Kullanıcının çevirmesi sıfırlanır
  function focusSlot(slot) {
    garage.focus = GARAGE_FOCUS[slot] ?? GARAGE_FOCUS[0]
    garage.yaw = 0
    garage.zoom = 1
  }

  function updateGarage(dt) {
    const f = garage.focus
    const ease = 1 - Math.exp(-4 * dt) // yumuşak yaklaşma: slot değişince kamera kayarak gelir
    // Açı en kısa yoldan dönsün (350° → 10° giderken 340° geri değil 20° ileri)
    const yawDiff = Math.atan2(Math.sin(f.yaw + garage.yaw - orbit.yaw), Math.cos(f.yaw + garage.yaw - orbit.yaw))
    orbit.yaw += yawDiff * ease
    orbit.radius += (f.radius * garage.zoom - orbit.radius) * ease
    orbit.height += (f.height - orbit.height) * ease
    orbit.target.lerp(goalTarget.set(f.target[0], f.target[1], f.target[2]), ease)

    orbitWorld.set(
      orbit.target.x + Math.sin(orbit.yaw) * orbit.radius,
      orbit.target.y + orbit.height,
      orbit.target.z + Math.cos(orbit.yaw) * orbit.radius,
    )
    // Gövdenin dışında kal: kamera arabanın kutusuna (yarım genişlik ~2.1, boy ~4.9) girerse yana it
    if (Math.abs(orbitWorld.x) < 2.6 && Math.abs(orbitWorld.z) < 5.4 && orbitWorld.y < 3.2) {
      orbitWorld.x = Math.sign(orbitWorld.x || 1) * 2.6
    }
    car.frame.localToWorld(orbitWorld) // arabanın ekseninden dünyaya (takla yok: car.frame)
    camera.position.copy(orbitWorld)
    lookWorld.copy(orbit.target)
    camera.lookAt(car.frame.localToWorld(lookWorld))
    camera.fov += ((camera.aspect < 1 ? 60 : 45) - camera.fov) * ease
    camera.updateProjectionMatrix()
  }

  // Vitrin: arabanın çevresinde daire (yatay açı zamanla artar), yükseklik hafifçe nefes alır
  function updateShowcase(dt) {
    showcaseAngle += SHOWCASE_SPEED * dt
    const center = car.model.position
    showcasePosition.set(
      center.x + Math.cos(showcaseAngle) * SHOWCASE_RADIUS,
      center.y + SHOWCASE_HEIGHT + Math.sin(showcaseAngle * 0.7) * 0.8,
      center.z + Math.sin(showcaseAngle) * SHOWCASE_RADIUS,
    )
    camera.position.lerp(showcasePosition, 1 - Math.exp(-3 * dt))
    // Arabanın biraz ÜSTÜNE bak: araba ekranda aşağı iner, başlık ve butonların arkasında kalmaz
    lookTarget.copy(center).y += 3
    camera.lookAt(lookTarget)
    // Dar açı (telefonda dikey ekranda biraz geniş): araba ekranı doldursun
    const targetFov = camera.aspect < 1 ? 58 : 42
    camera.fov += (targetFov - camera.fov) * (1 - Math.exp(-3 * dt))
    camera.updateProjectionMatrix()
  }

  // Kısa sarsıntı başlat. strength: en büyük açı (radyan), duration: süre (sn). Daha güçlüsü gelirse onu al
  function shake(strength, duration) {
    if (impulse.time > 0 && impulse.strength * (impulse.time / impulse.duration) > strength) return
    Object.assign(impulse, { time: duration, duration, strength })
  }

  // Sarsıntı: kameranın KONUMUNU değil açısını çok az titret. Açı her karede lookAt ile yeniden hesaplandığı
  // için titreşim birikmez, kamera yolundan sapmaz; azalarak söner
  function applyShake(dt) {
    if (impulse.time <= 0) return
    impulse.time -= dt
    const k = impulse.strength * Math.max(0, impulse.time / impulse.duration)
    camera.rotateX((Math.random() - 0.5) * 2 * k)
    camera.rotateY((Math.random() - 0.5) * 2 * k)
  }

  // dt: GERÇEK zaman. Kamera ağır çekimden etkilenmesin (yoksa geçiş de ağır çekimde yavaşlar)
  function update(dt) {
    if (mode === 'showcase') updateShowcase(dt)
    else if (mode === 'garage') updateGarage(dt)
    else updateFollow(dt)
    applyShake(dt)
  }

  // Takip ve düşüş kamerası
  function updateFollow(dt) {
    if (!look.dragging) {
      const back = 1 - Math.exp(-1.5 * dt)
      look.yaw -= look.yaw * back
      look.height -= look.height * back
    }
    blend += ((mode === 'fall' ? 1 : 0) - blend) * (1 - Math.exp(-MODE_BLEND_SPEED * dt))

    computeChase()

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
        stats.respawns++
      }
      camera.position.lerp(desiredPosition, 1 - Math.exp(-10 * dt)) // yumuşak takip
      // Boost başlangıcında kısa sarsıntı: bakılan noktayı titret (kamera konumu bozulmaz)
      if (boost.shake > 0) {
        lookTarget.x += (Math.random() - 0.5) * 1.2 * boost.shake
        lookTarget.y += (Math.random() - 0.5) * 1.2 * boost.shake
      }
    }
    guard(dt)
    camera.lookAt(lookTarget)

    // Hız hissi: FOV hızla 62 → 72, boost'ta 90'a kadar; düşüşte biraz daralır (yakın çekim)
    const targetFov = 62 + 10 * Math.min(1, car.speedRatio()) + 18 * boost.intensity - 8 * blend
    camera.fov += (targetFov - camera.fov) * (1 - Math.exp(-4 * dt))
    camera.updateProjectionMatrix()
  }

  // Emniyet kemeri: kamera konumu NaN olduysa (bir kez bulaşınca her karede yayılır) ya da yarışta takip
  // modundayken 1 sn'den uzun süre arabadan çok uzak kaldıysa → arabanın arkasına ışınla, konsola yaz
  function guard(dt) {
    if (!Number.isFinite(car.model.position.lengthSq())) return // araba bozuksa kamera düzeltemez: her kare uyarı yağmasın
    stats.distance = camera.position.distanceTo(car.model.position)
    const broken = !Number.isFinite(stats.distance)
    const far = isRacing() && mode === 'chase' && stats.distance > RESCUE_DISTANCE
    farTime = far ? farTime + dt : 0
    if (!broken && farTime <= RESCUE_AFTER) return
    const before = stats.distance
    snapBehind()
    stats.rescues++
    console.warn(
      `[kamera] ${broken ? 'konum NaN' : `${Math.round(before)} birim uzakta kaldı`} → arabanın arkasına ışınlandı`,
      { mode, crashed: car.state.crashed, falling: car.state.falling, onGround: car.state.onGround },
    )
  }

  return {
    update,
    setMode,
    resetForRace,
    focusSlot,
    shake,
    get mode() {
      return mode
    },
    get blend() {
      return blend
    },
    stats,
  }
}
