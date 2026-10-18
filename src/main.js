import './style.css'
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { Sky } from 'three/addons/objects/Sky.js'
import { Water } from 'three/addons/objects/Water.js'

// --- 1. Sahne ---
const scene = new THREE.Scene()

// --- 2. Kamera: okyanus çok büyük olduğu için "far" değeri yüksek ---
const camera = new THREE.PerspectiveCamera(
  55,
  window.innerWidth / window.innerHeight,
  1,
  20000,
)
camera.position.set(30, 30, 100)

// --- 3. Renderer ---
// Tone mapping: gökyüzünün çok parlak (HDR) renklerini ekranın gösterebileceği aralığa sıkıştırır
const renderer = new THREE.WebGLRenderer({ antialias: true })
renderer.setSize(window.innerWidth, window.innerHeight)
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
renderer.toneMapping = THREE.ACESFilmicToneMapping
renderer.toneMappingExposure = 0.5
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
  textureWidth: 512,
  textureHeight: 512,
  waterNormals,
  sunDirection: sun.clone(),
  sunColor: 0xffffff,
  waterColor: 0x00557a,
  distortionScale: 3.7, // dalga yansımalarının ne kadar bozulacağı
})
water.rotation.x = -Math.PI / 2 // düzlem dikey gelir, yere yatır
scene.add(water)

// --- 7. OrbitControls: sol tık döndür, sağ tık kaydır, tekerlek yakınlaş ---
const controls = new OrbitControls(camera, renderer.domElement)
controls.target.set(0, 10, 0)
controls.maxPolarAngle = Math.PI * 0.495 // kamera suyun altına inmesin
controls.minDistance = 40
controls.maxDistance = 200
controls.enableDamping = true // bırakınca yumuşakça yavaşlasın
controls.update()

// --- 8. Pencere boyutu değişince güncelle ---
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight
  camera.updateProjectionMatrix()
  renderer.setSize(window.innerWidth, window.innerHeight)
})

// --- 9. Animasyon döngüsü ---
const timer = new THREE.Timer()

renderer.setAnimationLoop((time) => {
  timer.update(time)
  const delta = timer.getDelta()

  water.material.uniforms.time.value += delta // dalgaları ilerlet
  skyUniforms.time.value = time // bulutları kaydır

  controls.update() // damping açıkken her karede çağrılmalı
  renderer.render(scene, camera)
})
