import * as THREE from 'three'

// --- Ayarlar: boost hissini bu sayılarla değiştirebilirsin ---
const MULTIPLIER = 2 // boost aktifken en yüksek hız normalin kaç katı
const DURATION = 2 // boost süresi (saniye) — kısa ama nadir: güçlü bir an, sık değil
const COOLDOWN = 4 // boost bitince bekleme süresi (saniye)
const RAMP_SPEED = 3 // geçiş yumuşaklığı: büyüdükçe çarpan 1 ↔ 2 arasında daha hızlı geçer
const SHAKE_TIME = 0.35 // boost başlarken kamera sarsıntısı süresi (saniye)
const SPEED_LINES = 60 // ekrandaki hız çizgisi sayısı

// Durum makinesi: boost aynı anda yalnızca bir durumdadır, geçişler kurallıdır:
//   HAZIR ──startBoost()──▶ AKTİF ──DURATION──▶ BEKLİYOR ──COOLDOWN──▶ HAZIR
// startBoost sadece HAZIR'da çalışır → aktifken Shift'e basmak süreyi uzatmaz
export const BOOST_STATE = { READY: 'hazır', ACTIVE: 'aktif', COOLDOWN: 'bekliyor' }

// Arka egzoz noktaları (carModel.js'teki 4 egzoz borusunun ağzı), alev arkaya (−z) uzanır
const EXHAUSTS = [-0.95, -0.32, 0.32, 0.95].map((x) => new THREE.Vector3(x, 0.74, -4.86))
const FLAME_BLUE = new THREE.Color(0x4aa8ff)
const FLAME_PINK = new THREE.Color(0xff3bd6)

function createExhaustFlames(carModel) {
  const material = new THREE.MeshBasicMaterial({
    color: FLAME_BLUE.clone(),
    transparent: true,
    blending: THREE.AdditiveBlending, // rengi arkasındakine ekler: ışık gibi parlar
    depthWrite: false,
  })
  material.userData.bloom = true // postfx.js: alevler parlasın
  // Koni: ucu yukarı bakar → x ekseninde çevir, ucu arkaya (−z) baksın; tabanı egzoz ağzında dursun
  const geometry = new THREE.ConeGeometry(0.12, 1, 12, 1, true)
  geometry.rotateX(-Math.PI / 2)
  geometry.translate(0, 0, -0.5)
  return EXHAUSTS.map((p) => {
    const flame = new THREE.Mesh(geometry, material)
    flame.position.copy(p)
    carModel.add(flame)
    return flame
  })
}

// Hız çizgileri: oyunun üstünde şeffaf bir 2D canvas. Boost sırasında her karede kenarlardan
// içeri doğru rastgele çizgiler çizilir (ortası boş). Her karede yeniden rastgele → titreşen hız hissi
function createSpeedLines() {
  const canvas = document.createElement('canvas')
  canvas.className = 'speed-lines'
  document.body.appendChild(canvas)
  const ctx = canvas.getContext('2d')
  let wasDrawn = false

  function draw(intensity) {
    if (intensity < 0.02) {
      if (wasDrawn) ctx.clearRect(0, 0, canvas.width, canvas.height) // bir kez temizle, sonra hiç dokunma
      wasDrawn = false
      return
    }
    if (canvas.width !== window.innerWidth || canvas.height !== window.innerHeight) {
      canvas.width = window.innerWidth
      canvas.height = window.innerHeight
    }
    const w = canvas.width
    const h = canvas.height
    const cx = w / 2
    const cy = h / 2
    const radius = Math.hypot(cx, cy) // merkezden köşeye uzaklık
    ctx.clearRect(0, 0, w, h)
    ctx.lineCap = 'round'
    for (let i = 0; i < SPEED_LINES; i++) {
      const angle = Math.random() * Math.PI * 2
      const start = radius * (0.55 + Math.random() * 0.25) // ortadan uzakta başla → merkez temiz kalır
      const length = radius * (0.12 + Math.random() * 0.25)
      const dx = Math.cos(angle)
      const dy = Math.sin(angle)
      ctx.strokeStyle = `rgba(255,255,255,${(0.15 + Math.random() * 0.35) * intensity})`
      ctx.lineWidth = 1 + Math.random() * 2
      ctx.beginPath()
      ctx.moveTo(cx + dx * start, cy + dy * start)
      ctx.lineTo(cx + dx * (start + length), cy + dy * (start + length))
      ctx.stroke()
    }
    wasDrawn = true
  }
  return { draw }
}

// HUD: ekranın alt ortasında boost barı + durum
function createBoostHud() {
  const el = document.createElement('div')
  el.className = 'boost-hud'
  el.innerHTML = `
    <span class="boost-label">BOOST</span>
    <div class="boost-bar"><div class="boost-fill"></div></div>
    <span class="boost-state"></span>`
  document.body.appendChild(el)
  const fill = el.querySelector('.boost-fill')
  const stateEl = el.querySelector('.boost-state')
  const last = {}

  function update(charge, state, timeLeft) {
    // Aktifken bar kalan süreyi gösterir (boşalır), değilse dolum seviyesini
    const ratio = state === BOOST_STATE.ACTIVE ? timeLeft / DURATION : charge
    const width = `${Math.round(ratio * 100)}%`
    const label =
      state === BOOST_STATE.ACTIVE
        ? `${timeLeft.toFixed(1)} sn`
        : state === BOOST_STATE.COOLDOWN
          ? `bekle ${timeLeft.toFixed(1)}`
          : charge >= 1
            ? 'SHIFT'
            : `%${Math.floor(charge * 100)}`
    const mode = state === BOOST_STATE.READY && charge >= 1 ? 'full' : state
    if (last.width !== width) fill.style.width = last.width = width
    if (last.label !== label) stateEl.textContent = last.label = label
    if (last.mode !== mode) el.dataset.mode = last.mode = mode // CSS renkleri bu duruma göre
  }
  return { update }
}

// car: createCar'ın döndürdüğü nesne. events: { onStart(source) }
export function createBoost(car, events = {}) {
  let state = BOOST_STATE.READY
  let timeLeft = 0 // aktif / bekliyor durumunda kalan süre
  let charge = 0 // bar: 0 → 1 (1 = dolu)
  let intensity = 0 // 0 → 1 yumuşak geçiş: hız çarpanı, kamera ve görseller bunu kullanır
  let shake = 0 // 1 → 0: boost başlangıcındaki kamera sarsıntısı

  const flames = createExhaustFlames(car.model)
  const speedLines = createSpeedLines()
  const hud = createBoostHud()

  // Boost'u başlatan TEK fonksiyon. Shift, Block Rush skill'i ve istenirse başka sistemler çağırır.
  // free: true → bar harcanmaz (ör. Block Rush skill'i). Başladıysa true döner
  function startBoost({ free = false, source = 'shift' } = {}) {
    if (state !== BOOST_STATE.READY) return false // aktif ya da bekliyor: süre uzamaz
    if (car.state.crashed || car.state.falling || car.state.finished || car.state.locked) return false
    if (!free) {
      if (charge < 1) return false // bar dolu değil
      charge = 0
    }
    state = BOOST_STATE.ACTIVE
    timeLeft = DURATION
    shake = 1
    events.onStart?.(source)
    return true
  }

  // Barı doldur (amount: 0-1 arası pay, ör. 0.25 = %25)
  function addCharge(amount) {
    charge = Math.min(1, charge + amount)
  }

  // Shift (sol ya da sağ). e.repeat: basılı tutunca tekrar tetiklenmesin
  window.addEventListener('keydown', (e) => {
    if (!e.repeat && (e.code === 'ShiftLeft' || e.code === 'ShiftRight')) startBoost()
  })

  function update(dt) {
    // --- Durum makinesi: süreler dt ile azalır → her bilgisayarda aynı uzunlukta ---
    if (state === BOOST_STATE.ACTIVE) {
      timeLeft -= dt
      // Süre bittiyse ya da araba çarptı / düştü / yarış bitti → beklemeye geç
      if (timeLeft <= 0 || car.state.crashed || car.state.falling || car.state.finished) {
        state = BOOST_STATE.COOLDOWN
        timeLeft = COOLDOWN
      }
    } else if (state === BOOST_STATE.COOLDOWN) {
      timeLeft -= dt
      if (timeLeft <= 0) {
        state = BOOST_STATE.READY
        timeLeft = 0
      }
    }

    // --- Yumuşak geçiş: hedefe her karede kalan farkın bir kısmı kadar yaklaş ---
    // (1 − e^(−k·dt)): kare hızından bağımsız. Sabit "0.1 yaklaş" yazsaydık 144 Hz'de 2.4 kat hızlı olurdu
    const target = state === BOOST_STATE.ACTIVE ? 1 : 0
    intensity += (target - intensity) * (1 - Math.exp(-RAMP_SPEED * dt))
    shake = Math.max(0, shake - dt / SHAKE_TIME)

    // Arabaya bildir: en yüksek hız çarpanı ve "itme" (aktifken gaz basılmasa da hızlan)
    car.state.boost = 1 + (MULTIPLIER - 1) * intensity
    car.state.boostThrust = state === BOOST_STATE.ACTIVE

    // --- Egzoz alevleri: normalde kısa ve mavi, boost'ta uzun ve pembe-mor ---
    const idle = Math.min(1, car.state.speed / 70) * 0.5 // sürerken küçük bir alev
    const flicker = 0.85 + Math.random() * 0.3
    const length = (0.15 + idle * 0.6 + intensity * 2.6) * flicker
    for (const flame of flames) {
      flame.scale.set(1 + intensity * 1.8, 1 + intensity * 1.8, length)
      flame.visible = length > 0.2
    }
    flames[0].material.color.lerpColors(FLAME_BLUE, FLAME_PINK, intensity).multiplyScalar(3 + intensity * 3)
    flames[0].material.opacity = 0.5 + intensity * 0.5

    speedLines.draw(intensity)
    hud.update(charge, state, Math.max(0, timeLeft))
  }

  return {
    startBoost,
    addCharge,
    fill: () => addCharge(1),
    update,
    get state() {
      return state
    },
    get intensity() {
      return intensity
    },
    get shake() {
      return shake
    },
    duration: DURATION,
  }
}
