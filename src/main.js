import './style.css'
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { Sky } from 'three/addons/objects/Sky.js'
import { Water } from 'three/addons/objects/Water.js'
import { createPostFX } from './postfx.js'
import { quality } from './settings.js'
import { createTrack } from './track.js'
import { createCar } from './car.js'
import { createSmoke } from './smoke.js'
import { createTricks } from './tricks.js'
import { createBoost } from './boost.js'
import { createGameState } from './gameState.js'
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

// --- 4. Güneş yönü: Sky ve Water aynı vektörü kullanır ---
// setFromSphericalCoords(yarıçap, tepeden açı, yatay açı) → x, y, z vektörü
const sun = new THREE.Vector3()
const elevation = 20 // güneşin ufuktan yüksekliği (derece)
const azimuth = 135 // güneşin yatay yönü (derece)
const phi = THREE.MathUtils.degToRad(90 - elevation)
const theta = THREE.MathUtils.degToRad(azimuth)
sun.setFromSphericalCoords(1, phi, theta)

// --- 5. Gökyüzü: dev bir kutunun içini shader ile boyar ---
// uniform = shader'a JavaScript'ten gönderdiğimiz ayar değeri
const sky = new Sky()
sky.scale.setScalar(10000)
scene.add(sky)

const skyUniforms = sky.material.uniforms
skyUniforms.turbidity.value = 10 // havadaki pus
skyUniforms.rayleigh.value = 2 // mavi saçılma (gökyüzünün mavisi)
skyUniforms.mieCoefficient.value = 0.005 // güneş etrafındaki hale
skyUniforms.mieDirectionalG.value = 0.8
skyUniforms.sunPosition.value.copy(sun)

// Ortam haritası (environment map): gökyüzünün bir "fotoğrafını" çekip tüm metal/parlak
// yüzeylere yansıma olarak veriyoruz. PMREM bu fotoğrafı pürüzlülüğe göre bulanıklaştırır.
const pmrem = new THREE.PMREMGenerator(renderer)
const envScene = new THREE.Scene()
envScene.add(sky) // geçici olarak ayrı sahneye al, sadece gökyüzünü çek
scene.environment = pmrem.fromScene(envScene).texture
scene.environmentIntensity = 0.25 // gökyüzünün ham değerleri çok parlak, yansımayı kıs
scene.add(sky) // gökyüzünü asıl sahneye geri koy

// --- 6. Su: gökyüzünü yansıtan, normal map ile dalgalanan düzlem ---
const waterNormals = new THREE.TextureLoader().load(
  '/textures/waternormals.jpg',
  (texture) => {
    // Doku 10000 birimlik düzlemde tekrar tekrar döşensin
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping
  },
  undefined,
  () => console.warn('waternormals.jpg bulunamadı → public/textures/ içine koy'),
)

const water = new Water(new THREE.PlaneGeometry(10000, 10000), {
  textureWidth: quality.waterResolution, // yansıma dokusu (settings.js)
  textureHeight: quality.waterResolution,
  waterNormals,
  sunDirection: sun.clone(),
  sunColor: 0xffffff,
  waterColor: 0x00557a,
  distortionScale: 3.7, // dalga yansımalarının ne kadar bozulacağı
})
water.rotation.x = -Math.PI / 2 // düzlem dikey gelir, yere yatır
scene.add(water)

// Işıklar: MeshStandardMaterial kullanan tır ve engel gövdeleri için.
// HemisphereLight üstten gök rengi, alttan deniz rengi verir; DirectionalLight güneşin kendisi
scene.add(new THREE.HemisphereLight(0xcfe8ff, 0x0b3a55, 0.5)) // ortam haritası da ışık verdiği için düşük
const sunLight = new THREE.DirectionalLight(0xfff2e0, 1.8) // hafif sıcak güneş rengi
sunLight.castShadow = true
sunLight.shadow.mapSize.set(quality.shadowMapSize, quality.shadowMapSize) // gölge fotoğrafının çözünürlüğü
sunLight.shadow.radius = 3 // gölge kenarı yumuşaklığı
sunLight.shadow.bias = -0.0004 // "gölge sivilcesi" (shadow acne) denen çizgili hatayı önler
sunLight.shadow.normalBias = 0.04
// Gölge kamerası arabanın etrafındaki 80×80'lik alanı kapsar; tüm pisti kapsasaydı gölgeler bulanık olurdu
const shadowCam = sunLight.shadow.camera
shadowCam.left = shadowCam.bottom = -40
shadowCam.right = shadowCam.top = 40
shadowCam.near = 1
shadowCam.far = 400
scene.add(sunLight)
scene.add(sunLight.target) // ışığın baktığı nokta; arabayı takip edecek

// Hafif sis: uzaktaki nesneler havanın rengine karışır (atmosfer derinliği hissi)
scene.fog = new THREE.FogExp2(0xc4d6e4, 0.0006)

// --- 7. Pist: gökyüzünde kıvrılan neon rota (track.js) ---
const track = createTrack()
scene.add(track)

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

// Ortak duman havuzu (smoke.js): alt itici, yan iticiler, takla pufları, patlama
const smoke = createSmoke(scene, renderer)

// Oyun durumu (gameState.js): lobby → countdown → racing ⇄ falling → finished / dnf
const gameState = createGameState()

// Araba: W/S gaz-fren, A/D sağ-sol, Space zıpla (basılı tut → roketle süzül) (car.js)
const car = createCar(scene, smoke, {
  onCrash: () => showMessage('ÇARPTIN!'),
  onFall: () => fall.start(), // altında yol kalmadı: düşüş sahnesi (fall.js)
  onShieldBlock: () => showMessage('KALKAN!'),
  // reason: 'lap' (bitiş kapısı) | 'dnf' (kalkansız düştü → zincire finishRace gitmez). race.js sonucu gösterir
  onFinish: (reason) => race.finish(reason),
})

// Boost (boost.js): bar dolunca Shift → 3 sn 2x hız. Durum: hazır → aktif → bekliyor
const boost = createBoost(car, {
  onStart: () => showMessage('BOOST!'),
})

// Havada takla (tricks.js): W/S öne-arkaya, Q/E barrel roll; temiz inişte skor + boost barı
const tricks = createTricks(car, smoke, {
  onTrick: (text) => showMessage(text),
  onBadLanding: (text) => showMessage(text),
  onCleanLanding: (turns) => boost.addCharge(0.25 * turns), // her tam tur: barın %25'i
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
  getLoadout: () => loadout,
  getScore: () => tricks.score,
  showMessage,
  holdMessage,
  // info: { id, seed, onChain }. İyimser arayüz: etki oyunda hemen uygulanır, işlem arkada gider
  onCourse: (seed, label, info) => {
    items = createItems(scene, car, seed, label, {
      onCollect: (index, type) => {
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

// C tuşu: takip kamerası ↔ serbest kamera
window.addEventListener('keydown', (e) => {
  if (e.code !== 'KeyC' || isTyping(e)) return
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
})

// Giriş sayfası (landing.js) ve garaj (garage.js): arkada araba vitrin kamerasında döner
createLanding({ router, chain, cameraModes })
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
const postfx = createPostFX(renderer, scene, camera, [sky, water], quality.msaa)

// Güneş ışığı ve gölge kamerası arabayla birlikte hareket eder
function updateSunLight() {
  sunLight.target.position.copy(car.model.position)
  sunLight.position.copy(car.model.position).addScaledVector(sun, 150)
}

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
  updateSunLight()
  postfx.render() // renderer.render yerine: efektlerle birlikte çiz
})

// Bir karelik oyun güncellemesi (çizim hariç). realDelta: gerçek geçen süre (saniye)
function simulate(realDelta) {
  // Zaman ölçeği TEK NOKTADAN: oyundaki her hareket bu delta'yı kullanır → ağır çekimde dünya
  // aynı oranda yavaşlar, hiçbir sistemin "ağır çekim var mı?" diye bilmesi gerekmez
  const delta = realDelta * fall.timeScale

  water.material.uniforms.time.value += delta // dalgaları ilerlet
  skyUniforms.time.value += delta * 1000 // bulutları kaydır (ms)

  car.update(delta)
  tricks.update(delta) // car.update'ten sonra: inişi yakalar, sonraki karenin takla dönüşünü hazırlar
  boost.update(delta) // durum makinesi + sonraki kare için hız çarpanı + alev / hız çizgisi / HUD
  smoke.update(delta) // bu karede üretilen tüm pufları da ilerlet
  items?.update(delta) // ?. → items henüz yoksa (geri sayım) atla
  fall.update(realDelta, delta) // düşüş süresi gerçek zamanla, dönüş ve duman oyun zamanıyla
  race.update(realDelta) // süre gerçek zamanla + ilerleme çubuğu + oyuncu durumu nesnesi

  if (controls.enabled) controls.update() // damping açıkken her karede çağrılmalı
  else cameraModes.update(realDelta) // kamera gerçek zamanla: ağır çekimde de akıcı
}
