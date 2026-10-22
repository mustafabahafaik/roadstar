import './style.css'
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { createPostFX } from './postfx.js'
import { quality, DEBUG } from './settings.js'
import { createTrack } from './track.js'
import { createCar } from './car.js'
import { createSmoke } from './smoke.js'
import { createTricks } from './tricks.js'
import { createBoost } from './boost.js'
import { createGameState, GAME_STATE } from './gameState.js'
import { createCameraModes } from './cameraModes.js'
import { createFall } from './fall.js'
import { createItems, TOKEN_TYPES } from './items.js'
import { createChain } from './chain.js'
import { createTxHud } from './txHud.js'
import { isTyping } from './input.js'
import { createRace } from './race.js'
import { createNet } from './net.js'
import { createRouter } from './router.js'
import { createLanding } from './landing.js'
import { createGarage } from './garage.js'
import { DEFAULT_LOADOUT, applyLoadout } from './parts.js'
import { createWorld } from './world.js'
import { DEFAULT_MAP } from './maps.js'
import { createMeteors } from './meteors.js'
import { createAudio, createSoundToggle } from './audio.js'
import { createTouchControls } from './touch.js'
import { createDebugPanel } from './debugPanel.js'

// --- 1. Sahne ---
const scene = new THREE.Scene()

// --- 2. Kamera: okyanus çok büyük olduğu için "far" değeri yüksek ---
const camera = new THREE.PerspectiveCamera(
  55,
  window.innerWidth / window.innerHeight,
  1,
  20000,
)
camera.position.set(0, 180, 380)

// --- 3. Renderer ---
// Tone mapping: gökyüzünün çok parlak (HDR) renklerini ekranın gösterebileceği aralığa sıkıştırır
const renderer = new THREE.WebGLRenderer({ antialias: true })
renderer.setSize(window.innerWidth, window.innerHeight)
renderer.setPixelRatio(Math.min(window.devicePixelRatio, quality.pixelRatio)) // settings.js
renderer.toneMapping = THREE.ACESFilmicToneMapping
renderer.toneMappingExposure = 0.5

// Gölgeler: güneş, sahneyi kendi bakış açısından bir "derinlik fotoğrafı" (shadow map) olarak çizer.
// Bir piksel o fotoğraftaki nesnelerin arkasında kalıyorsa gölgededir.
renderer.shadowMap.enabled = true
renderer.shadowMap.type = THREE.PCFShadowMap // kenarları yumuşatılmış gölge
renderer.shadowMap.autoUpdate = false // her karede bir kez, postfx.js içinde güncelliyoruz
document.body.appendChild(renderer.domElement)

// --- 4-6. Gökyüzü, su / uzay, ışıklar, sis: haritaya göre world.js kurar (maps.js ayar objeleri) ---

// --- 7. Pist: gökyüzünde kıvrılan neon rota (track.js) ---
const track = createTrack()
scene.add(track)

// Dünya (world.js): seçili haritanın gökyüzü, ışığı, sisi, arka plan nesneleri ve pist renkleri.
// Giriş sayfası haritayı seçince, yarış başlarken (sunucunun haritası) değişir
const world = createWorld({ scene, renderer, track })

// Engeller ve rampalar artık burada değil: seed gelince race.js kurar (course.js)

// Ekran yazısı (HUD: oyunun üstüne bindirilen bilgi). Stili style.css'te
const hudMessage = document.createElement('div')
hudMessage.className = 'hud-message'
document.body.appendChild(hudMessage)
function showMessage(text) {
  hudMessage.textContent = text
  hudMessage.classList.remove('show', 'hold')
  void hudMessage.offsetWidth // tarayıcıyı yeniden hesaplamaya zorla → animasyon baştan başlasın
  hudMessage.classList.add('show')
}
// Sönmeyen yazı (geri sayım, bekleme): bir sonraki showMessage'a kadar ekranda kalır
function holdMessage(text) {
  hudMessage.textContent = text
  hudMessage.classList.remove('show')
  hudMessage.classList.add('hold')
}

// Sesler (audio.js): hepsi prosedürel, dosya yok. Tarayıcı izin verene kadar (ilk tıklama) sessiz.
// Sağ üstte aç/kapa düğmesi; tercih localStorage'da
const audio = createAudio()
createSoundToggle(audio)

// Ortak duman havuzu (smoke.js): alt itici, yan iticiler, takla pufları, patlama
const smoke = createSmoke(scene, renderer)

// Oyun durumu (gameState.js): lobby → countdown → racing ⇄ falling → finished / dnf
const gameState = createGameState()

// Araba: W/S gaz-fren, A/D sağ-sol, Space zıpla (basılı tut → roketle süzül) (car.js)
const car = createCar(scene, smoke, {
  onCrash: () => {
    showMessage('ÇARPTIN!')
    audio.explosion()
  },
  onFall: () => {
    fall.start() // altında yol kalmadı: düşüş sahnesi (fall.js)
    audio.explosion() // ağır çekim başlarken: patlama da yavaşlayıp pesleşir
  },
  onShieldBlock: () => showMessage('KALKAN!'),
  // reason: 'lap' (bitiş kapısı) | 'quit' / 'timeout' / 'disconnect' (DNF → zincire finishRace gitmez). race.js sonucu gösterir
  onFinish: (reason) => race.finish(reason),
})

// Boost (boost.js): bar dolunca Shift → 3 sn 2x hız. Durum: hazır → aktif → bekliyor
const boost = createBoost(car, {
  onStart: () => {
    showMessage('BOOST!')
    audio.boostStart()
  },
})

// Havada takla (tricks.js): W/S öne-arkaya, Q/E barrel roll; temiz inişte skor + boost barı
const tricks = createTricks(car, smoke, {
  onTrick: (text) => showMessage(text),
  onBadLanding: (text) => showMessage(text),
  onCleanLanding: (turns) => boost.addCharge(0.25 * turns), // her tam tur: barın %25'i
  onSidePuff: () => audio.sidePuff(), // havadaki yan iticiler
})

// Zincir (chain.js): burner cüzdan + kendi nonce takibimizle işlem gönderme.
// txHud.js: sağ üstte canlı işlem akışı ve yarış sonu özeti
let txHud = null
const chain = createChain(() => txHud?.refresh())
txHud = createTxHud(() => chain)

// Çok oyunculu sunucu bağlantısı (net.js): odalar, saat eşitleme, durum gönderme. Adres .env → VITE_SERVER_URL
const net = createNet()

// Ekranlar arası geçiş (router.js): giriş → garaj → lobi → yarış → sonuç → giriş
const router = createRouter()
let landing = null // giriş sayfası (aşağıda): seçili harita

// Garaj parçaları (parts.js, SADECE GÖRSEL): zincirde takılı loadout. Garaj değiştirir, lobi odaya girerken gönderir
let loadout = [...DEFAULT_LOADOUT]
function setLoadout(ids) {
  loadout = [...ids]
  applyLoadout(car.model, loadout, { thrusters: car.thrusters, boost })
}

// Yarış akışı (race.js): lobi → geri sayım (sunucunun başlangıç anı) → yarış → bitiş / DNF + sonuç ekranı.
// Seed gelince parkuru race.js kurar, tokenları burada oluşturuyoruz (boost ve zincirle konuşuyorlar)
let items = null
const race = createRace({
  scene,
  car,
  chain,
  gameState,
  net,
  router,
  world,
  getMapId: () => landing?.map ?? DEFAULT_MAP,
  getLoadout: () => loadout,
  audio,
  getScore: () => tricks.score,
  getFallStats: () => fall.stats, // fall aşağıda oluşuyor: ilk çağrı yarış sonunda
  showMessage,
  holdMessage,
  // info: { id, seed, onChain }. İyimser arayüz: etki oyunda hemen uygulanır, işlem arkada gider
  onCourse: (seed, label, info) => {
    items = createItems(scene, car, seed, label, {
      onCollect: (index, type) => {
        audio.collect(type) // türüne göre "çın" (altın daha parlak)
        if (type === 3) boost.fill() // Block Rush toplandı: boost barı anında dolu
        if (info.onChain) chain.send('collect', [info.id, index], `collect #${index} ${TOKEN_TYPES[type].name}`)
      },
      startBoost: () => boost.startBoost({ free: true, source: 'rush' }), // Block Rush skill'i (tuş 3)
      onSkill: (type) => info.onChain && chain.send('useSkill', [info.id, type], `useSkill ${TOKEN_TYPES[type].name}`),
    })
    return items
  },
})
scene.add(car.model)

// Hangi nesne gölge düşürür (castShadow), hangisi üstüne gölge alır (receiveShadow)
for (const group of [track, car.model]) {
  group.traverse((obj) => {
    // ?. → malzeme dizisi ([boya, cam, ...]) ise userData yoktur, hata vermeden undefined döner
    if (!obj.isMesh || obj.material.userData?.bloom) return // neonlar ve alevler gölge düşürmez
    obj.castShadow = true
    obj.receiveShadow = true
  })
}

// --- 8. OrbitControls: sol tık döndür, sağ tık kaydır, tekerlek yakınlaş ---
const controls = new OrbitControls(camera, renderer.domElement)
controls.target.set(0, 50, 0) // pistin ortası
controls.maxPolarAngle = Math.PI * 0.495 // kamera suyun altına inmesin
controls.minDistance = 10
controls.maxDistance = 1000 // büyük pistin tamamı görünebilsin
controls.enableDamping = true // bırakınca yumuşakça yavaşlasın
controls.enabled = false // başlangıçta takip kamerası aktif

// C tuşu: takip kamerası ↔ serbest kamera. SADECE ?debug ile: yarışta D'nin hemen altındaki C'ye yanlışlıkla
// basınca takip kamerası duruyor, kamera olduğu yerde donuyor ve araba kadrajdan çıkıp gidiyordu
window.addEventListener('keydown', (e) => {
  if (e.code !== 'KeyC' || isTyping(e) || !DEBUG) return
  controls.enabled = !controls.enabled
  if (controls.enabled) {
    controls.target.copy(car.model.position)
    controls.update()
  }
})

// Kamera modları (cameraModes.js): takip + düşüş yan kamerası, aralarında yumuşak geçiş
const cameraModes = createCameraModes({
  camera,
  domElement: renderer.domElement,
  car,
  boost,
  isOrbitEnabled: () => controls.enabled,
  isRacing: () => router.current === 'race', // emniyet kemeri sadece yarış ekranında
})

// Geri sayım başlarken: serbest kamera kapalı, mod ne olursa olsun takip, kamera arabanın arkasında
gameState.onChange((next) => {
  if (next !== GAME_STATE.COUNTDOWN) return
  controls.enabled = false
  cameraModes.resetForRace()
})

// F3: kamera ve araba durumu paneli (debugPanel.js). Telefonda adrese ?debug ekle
const debugPanel = createDebugPanel({
  car,
  camera,
  cameraModes,
  gameState,
  router,
  isOrbitEnabled: () => controls.enabled,
  getNetStats: () => race.netStats(),
  getPing: () => net.rtt,
})

// Kayan yıldızlar ve meteorlar (meteors.js, SADECE GÖRSEL): sadece haritanın "meteors" ayarı varsa (Satürn)
const meteors = createMeteors({
  scene,
  camera,
  smoke,
  getFocus: () => car.model.position,
  getMap: () => world.map,
  shake: (strength, duration) => cameraModes.shake(strength, duration),
})

// Düşüş sahnesi (fall.js): ağır çekim, yan kamera, dönüş, kesik duman, vignette, kalkan cezası
const fall = createFall({
  car,
  smoke,
  scene,
  gameState,
  cameraModes,
  getItems: () => items,
  onMessage: (text) => showMessage(text),
  onFallStart: (info) => race.flashPenalty(info), // saatin altında "+2 sn" ya da "KALKAN"
})

// Dokunmatik kontroller (touch.js): telefon / tablette ekranın altında yön, itici, boost, takla düğmeleri
const touch = createTouchControls({ car, router })

// Giriş sayfası (landing.js) ve garaj (garage.js): arkada araba vitrin kamerasında döner
landing = createLanding({ router, chain, cameraModes, world })
createGarage({ router, cameraModes, chain, car, boost, getEquipped: () => loadout, setEquipped: setLoadout })

// Açılışta: zincirdeki parçalarını arabaya uygula (garaja girmesen de yarışa kendi parçalarınla çıkarsın)
setLoadout(loadout)
if (chain.garageEnabled) {
  chain
    .readGarage('loadoutOf', [chain.address])
    .then(([ids]) => setLoadout(ids.map(Number)))
    .catch((err) => console.warn('loadoutOf okunamadı, varsayılan parçalar:', err.shortMessage ?? err.message))
}
router.start() // ilk ekran: adresteki (#/ giriş, #/garaj, #/lobi)

// --- 9. Post-processing: seçici bloom + kenar yumuşatma (postfx.js) ---
// Gökyüzü ve su bloom geçişinde gizlenir → güneşe bakınca ekran artık beyaza boğulmaz
const postfx = createPostFX(renderer, scene, camera, world.bloomHidden, quality.msaa) // gizlenecekler haritaya göre


// --- 10. Pencere boyutu değişince güncelle ---
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight
  camera.updateProjectionMatrix()
  renderer.setSize(window.innerWidth, window.innerHeight)
  postfx.setSize(window.innerWidth, window.innerHeight)
})

// --- 11. Animasyon döngüsü ---
const timer = new THREE.Timer()

// FPS sınırı: 120-144 Hz ekranlarda saniyede 144 kare yerine en fazla maxFps kare çiz → ekran kartı daha az ısınır.
// Giriş sayfası ve garajda araba sadece yavaşça döner: 30 kare yeter (telefonun pili, bilgisayarın ısısı)
const IDLE_FPS = 30
let lastFrameTime = -Infinity

renderer.setAnimationLoop((time) => {
  const idle = router.current === 'landing' || router.current === 'garage'
  const minFrameTime = 1000 / (idle ? IDLE_FPS : quality.maxFps)
  if (time - lastFrameTime < minFrameTime - 2) return // -2 ms tolerans: 60 Hz ekranda kare atlamasın
  lastFrameTime = time
  timer.update(time)
  // 0 → ilk karede negatif çıkabiliyor, 0.05 → sekme değişince dev bir sıçrama olmasın
  simulate(THREE.MathUtils.clamp(timer.getDelta(), 0, 0.05))
  world.followSun(car.model.position) // güneş ışığı ve gölge kamerası arabayla birlikte hareket eder
  postfx.render() // renderer.render yerine: efektlerle birlikte çiz
})

// Bir karelik oyun güncellemesi (çizim hariç). realDelta: gerçek geçen süre (saniye)
function simulate(realDelta) {
  // Zaman ölçeği TEK NOKTADAN: oyundaki her hareket bu delta'yı kullanır → ağır çekimde dünya
  // aynı oranda yavaşlar, hiçbir sistemin "ağır çekim var mı?" diye bilmesi gerekmez
  const delta = realDelta * fall.timeScale
  touch.update() // dokunmatik: otomatik gaz + havadayken takla düğmeleri (car.update'ten ÖNCE: bu karenin girdisi)

  world.update(delta) // dalgalar, bulutlar ya da dönen Satürn ve süzülen asteroitler
  meteors.update(delta) // oyun zamanı: düşüşteki ağır çekimde meteorlar da yavaşlar

  car.update(delta)
  tricks.update(delta) // car.update'ten sonra: inişi yakalar, sonraki karenin takla dönüşünü hazırlar
  boost.update(delta) // durum makinesi + sonraki kare için hız çarpanı + alev / hız çizgisi / HUD
  smoke.update(delta) // bu karede üretilen tüm pufları da ilerlet
  items?.update(delta) // ?. → items henüz yoksa (geri sayım) atla
  fall.update(realDelta, delta) // düşüş süresi gerçek zamanla, dönüş ve duman oyun zamanıyla
  race.update(realDelta) // süre gerçek zamanla + ilerleme çubuğu + oyuncu durumu nesnesi

  if (controls.enabled) controls.update() // damping açıkken her karede çağrılmalı
  else cameraModes.update(realDelta) // kamera gerçek zamanla: ağır çekimde de akıcı
  debugPanel.update(realDelta)

  // Sesler: motor (hız + boost), itici (roket gücü), ağır çekim, dinleyici = kamera, rakip motorları
  audio.update({
    speedRatio: Math.min(1, car.speedRatio()),
    boost: boost.intensity,
    thrust: car.thrust,
    active: router.current === 'race' || router.current === 'results', // giriş / garaj / lobide motor sussun
    timeScale: fall.timeScale,
    camera,
    remotes: race.remoteVoices(),
  })
}
