import './style.css'
import * as THREE from 'three'

// --- 1. Sahne: tüm 3B nesnelerin içine konduğu "dünya" ---
const scene = new THREE.Scene()
scene.background = new THREE.Color(0x0b0b1a)

// --- 2. Kamera: sahneye hangi açıdan baktığımızı belirler ---
// PerspectiveCamera(görüş açısı, en/boy oranı, yakın düzlem, uzak düzlem)
const camera = new THREE.PerspectiveCamera(
  60,
  window.innerWidth / window.innerHeight,
  0.1,
  1000,
)
camera.position.set(0, 1.5, 4)
camera.lookAt(0, 0, 0)

// --- 3. Renderer: sahneyi kameranın gözünden <canvas>'a çizer ---
const renderer = new THREE.WebGLRenderer({ antialias: true })
renderer.setSize(window.innerWidth, window.innerHeight)
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
document.body.appendChild(renderer.domElement)

// --- 4. Işıklar: Standard malzeme ışık olmadan simsiyah görünür ---
// Ortam ışığı her yeri eşit aydınlatır, yönlü ışık güneş gibi tek yönden gelir
const ambientLight = new THREE.AmbientLight(0xffffff, 0.4)
scene.add(ambientLight)

const directionalLight = new THREE.DirectionalLight(0xffffff, 2)
directionalLight.position.set(3, 5, 2)
scene.add(directionalLight)

// --- 5. Küp: Mesh = geometri (şekil) + malzeme (yüzey görünümü) ---
const geometry = new THREE.BoxGeometry(1, 1, 1)
const material = new THREE.MeshStandardMaterial({ color: 0x8a5cff })
const cube = new THREE.Mesh(geometry, material)
scene.add(cube)

// --- 6. Pencere boyutu değişince kamera ve canvas'ı güncelle ---
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight
  camera.updateProjectionMatrix()
  renderer.setSize(window.innerWidth, window.innerHeight)
})

// --- 7. Animasyon döngüsü: her karede küpü döndür ve yeniden çiz ---
// Timer, kareler arası geçen süreyi (delta) verir; böylece dönüş hızı FPS'ten bağımsız olur
const timer = new THREE.Timer()

renderer.setAnimationLoop((time) => {
  timer.update(time)
  const delta = timer.getDelta()

  cube.rotation.x += 0.5 * delta
  cube.rotation.y += 1.0 * delta

  renderer.render(scene, camera)
})
