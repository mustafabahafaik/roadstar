import './style.css'
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { Sky } from 'three/addons/objects/Sky.js'
import { Water } from 'three/addons/objects/Water.js'
import { createPostFX } from './postfx.js'
import { quality } from './settings.js'
import { createTrack } from './track.js'
import { createObstacles } from './obstacles.js'
import { createCar } from './car.js'
import { createSmoke } from './smoke.js'
import { createTricks } from './tricks.js'
import { createItems, TOKEN_TYPES, TOKEN_COUNT } from './items.js'
import { createChain, parseRaceStarted } from './chain.js'
import { hexlify, randomBytes } from 'ethers'
import { createTxHud } from './txHud.js'

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

// Engeller: atlanacak duvarlar ve sağa-sola kaçılacak bloklar (obstacles.js)
const obstacleGroup = createObstacles()
scene.add(obstacleGroup)

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

// Araba: W/S gaz-fren, A/D sağ-sol, Space zıpla (basılı tut → roketle süzül) (car.js)
const car = createCar(scene, smoke, {
  onCrash: () => showMessage('ÇARPTIN!'),
  onFall: () => showMessage('DÜŞTÜN!'),
  onShieldBlock: () => showMessage('KALKAN!'),
  onFinish: () => {
    showMessage('BİTİŞ!')
    if (race.onChain) chain.send('finishRace', [race.id], `finishRace #${race.id}`)
    const collected = items?.collected ?? []
    txHud.showSummary({
      time: car.state.raceTime,
      collected: collected.length,
      total: TOKEN_COUNT,
      gold: collected.filter((c) => c.type === 4).length,
      score: tricks.score,
    })
  },
})

// Havada takla (tricks.js): W/S öne-arkaya, Q/E barrel roll; temiz inişte skor + boost
const tricks = createTricks(car, smoke, {
  onTrick: (text) => showMessage(text),
  onBadLanding: (text) => showMessage(text),
})

// Zincir (chain.js): burner cüzdan + kendi nonce takibimizle işlem gönderme.
// txHud.js: sağ üstte canlı işlem akışı ve yarış sonu özeti
let txHud = null
const chain = createChain(() => txHud?.refresh())
txHud = createTxHud(() => chain)

// Yarış: numarayı ve tokenların tohumunu zincir verir (Race.startRace). Oyuncu tohumu seçemez,
// önceden bilemez → "altını bol yarış" aranamaz. Zincir yoksa / cevap gelmezse zincirsiz yarış
const race = { id: null, seed: null, onChain: false }
let items = null // tohum gelince oluşturulur
const START_TIMEOUT_MS = 15000
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function startRace() {
  // Geri sayım sürerken startRace zincire gider (Monad'da ~0.5 sn: çoğu zaman geri sayım bitmeden döner)
  const startTx = chain.enabled ? chain.send('startRace', [], 'startRace') : null
  for (const n of ['3', '2', '1']) {
    holdMessage(n)
    await sleep(700)
  }

  if (startTx) {
    if (startTx.status === 'pending') holdMessage('ZİNCİR BEKLENİYOR…')
    try {
      const timeout = sleep(START_TIMEOUT_MS).then(() => Promise.reject(new Error('zaman aşımı')))
      const receipt = await Promise.race([startTx.confirmation, timeout]) // hangisi önce biterse
      const { raceId, seed } = parseRaceStarted(receipt)
      Object.assign(race, { id: raceId, seed, onChain: true })
    } catch (err) {
      console.warn('startRace olmadı, zincirsiz yarış:', err.message)
    }
  }
  if (!race.onChain) {
    // Zincirsiz: ?seed=123 verilirse hep aynı yerleşim (deneme için), yoksa rastgele 32 bayt
    race.seed = new URLSearchParams(window.location.search).get('seed') ?? hexlify(randomBytes(32))
  }

  // İyimser arayüz: etki oyunda hemen uygulanır (items.js), işlem arkada gider, oyun beklemez
  const label = race.onChain ? `Yarış #${race.id}` : 'Zincirsiz yarış'
  items = createItems(scene, car, race.seed, label, {
    onCollect: (index, type) =>
      race.onChain && chain.send('collect', [race.id, index], `collect #${index} ${TOKEN_TYPES[type].name}`),
    onSkill: (type) => race.onChain && chain.send('useSkill', [race.id, type], `useSkill ${TOKEN_TYPES[type].name}`),
  })
  car.state.locked = false
  showMessage(race.onChain ? 'BAŞLA!' : 'BAŞLA! (zincirsiz)')
}
startRace()
scene.add(car.model)

// Hangi nesne gölge düşürür (castShadow), hangisi üstüne gölge alır (receiveShadow)
for (const group of [track, obstacleGroup, car.model]) {
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
  if (e.code !== 'KeyC') return
  controls.enabled = !controls.enabled
  if (controls.enabled) {
    controls.target.copy(car.model.position)
    controls.update()
  }
})

// Takip kamerası: arabanın arkasında ve yukarısında durur.
// Farenin sol tuşuyla sürükleyince arabanın etrafında döner, bırakınca yavaşça arkaya geri gelir.
const look = {
  yaw: 0, // arabanın etrafındaki açı (0 = tam arkası, π = önü)
  height: 0, // varsayılan yüksekliğe eklenen
  distance: 16, // arabaya uzaklık (tekerlekle değişir)
  dragging: false,
}
const CAMERA_HEIGHT = 5.6
const desiredPosition = new THREE.Vector3()
const lookTarget = new THREE.Vector3()

renderer.domElement.addEventListener('pointerdown', (e) => {
  if (controls.enabled || e.button !== 0) return
  look.dragging = true
  renderer.domElement.setPointerCapture(e.pointerId) // fare pencereden çıksa da sürükleme sürsün
})
renderer.domElement.addEventListener('pointermove', (e) => {
  if (!look.dragging) return
  look.yaw -= e.movementX * 0.006 // movementX: son olaydan beri farenin yatay hareketi (piksel)
  look.height = THREE.MathUtils.clamp(look.height + e.movementY * 0.03, -3.5, 10)
})
renderer.domElement.addEventListener('pointerup', () => (look.dragging = false))
renderer.domElement.addEventListener(
  'wheel',
  (e) => {
    if (controls.enabled) return
    look.distance = THREE.MathUtils.clamp(look.distance + e.deltaY * 0.01, 9, 34)
  },
  { passive: true },
)

function updateChaseCamera(dt) {
  // Fare bırakılınca açı ve yükseklik yavaşça sıfıra döner
  if (!look.dragging) {
    const back = 1 - Math.exp(-1.5 * dt)
    look.yaw -= look.yaw * back
    look.height -= look.height * back
  }

  // Arabanın kendi ekseninde kamera noktası: açıya göre çember üzerinde (sin → yan, cos → arka)
  desiredPosition.set(
    Math.sin(look.yaw) * look.distance,
    CAMERA_HEIGHT + look.height,
    -Math.cos(look.yaw) * look.distance,
  )
  // Arkadan bakarken arabanın önüne, yandan bakarken arabanın kendisine bak
  lookTarget.set(0, 1.6, 12 * Math.cos(look.yaw))

  // localToWorld: arabaya göre verilen noktayı dünya koordinatına çevirir (araba dönünce o da döner)
  // car.frame: arabanın konumu + pist yönü, takla dahil değil → araba dönerken ekran dönmez
  car.frame.localToWorld(desiredPosition)
  car.frame.localToWorld(lookTarget)

  if (car.state.falling || car.state.crashed) {
    // Düşerken / çarpınca kamera yerinde kalır, sadece arabaya bakar
    lookTarget.copy(car.model.position)
    // Çarpmanın ilk yarım saniyesinde sarsıntı: bakılan noktayı rastgele titret
    const shake = car.state.crashed ? Math.max(0, 0.5 - car.state.crashTime) * 1.6 : 0
    lookTarget.x += (Math.random() - 0.5) * shake
    lookTarget.y += (Math.random() - 0.5) * shake
    camera.lookAt(lookTarget)
  } else {
    if (car.state.respawned) {
      camera.position.copy(desiredPosition) // yeniden doğunca hemen arkasına geç (aşağıdan uçarak gelmesin)
      car.state.respawned = false
    }
    // lerp ile hedefe yavaşça yaklaş → kamera sarsılmadan, yumuşak takip eder
    camera.position.lerp(desiredPosition, 1 - Math.exp(-10 * dt))
    camera.lookAt(lookTarget)
  }

  // Hız hissi: hızlandıkça görüş açısı (FOV) genişler
  const targetFov = 60 + 18 * car.speedRatio()
  camera.fov += (targetFov - camera.fov) * (1 - Math.exp(-4 * dt))
  camera.updateProjectionMatrix()
}

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

// FPS sınırı: 120-144 Hz ekranlarda saniyede 144 kare yerine en fazla maxFps kare çiz → ekran kartı daha az ısınır
const minFrameTime = 1000 / quality.maxFps
let lastFrameTime = -Infinity

renderer.setAnimationLoop((time) => {
  if (time - lastFrameTime < minFrameTime - 2) return // -2 ms tolerans: 60 Hz ekranda kare atlamasın
  lastFrameTime = time
  timer.update(time)
  // 0 → ilk karede negatif çıkabiliyor, 0.05 → sekme değişince dev bir sıçrama olmasın
  const delta = THREE.MathUtils.clamp(timer.getDelta(), 0, 0.05)

  water.material.uniforms.time.value += delta // dalgaları ilerlet
  skyUniforms.time.value = time // bulutları kaydır

  car.update(delta)
  tricks.update(delta) // car.update'ten sonra: inişi yakalar, sonraki karenin takla dönüşünü hazırlar
  smoke.update(delta) // bu karede üretilen tüm pufları da ilerlet
  items?.update(delta) // ?. → items henüz yoksa (geri sayım) atla
  txHud.setProgress(car.progress())

  if (controls.enabled) controls.update() // damping açıkken her karede çağrılmalı
  else updateChaseCamera(delta)

  updateSunLight()
  postfx.render() // renderer.render yerine: efektlerle birlikte çiz
})
