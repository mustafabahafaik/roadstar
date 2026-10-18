import * as THREE from 'three'
import { WHEEL_POSITIONS } from './carModel.js'

const SMOKE_COUNT = 500 // havuzdaki duman parçacığı sayısı
const SMOKE_LIFE = 1.4 // bir parçacığın ömrü (saniye)
const SPAWN_RATE = 320 // saniyede doğan toplam parçacık (tam güçte) → sık doğunca birleşip sütun gibi görünür

// Yumuşak kenarlı yuvarlak duman dokusu: canvas'a radyal gradyan çizip doku yapıyoruz
function createSmokeTexture() {
  const size = 64
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d')
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
  g.addColorStop(0, 'rgba(255,255,255,1)')
  g.addColorStop(0.4, 'rgba(235,240,255,0.55)')
  g.addColorStop(1, 'rgba(220,230,255,0)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, size, size)
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

// Alev: aşağı bakan, içi boş koni. AdditiveBlending → rengi arkasındakine ekler, ışık gibi parlar
function createFlame() {
  const flame = new THREE.Group()
  const outer = new THREE.Mesh(
    new THREE.ConeGeometry(0.42, 2.6, 20, 1, true),
    new THREE.MeshBasicMaterial({
      color: new THREE.Color(0x6aa8ff).multiplyScalar(2.5),
      transparent: true,
      opacity: 0.55,
      blending: THREE.AdditiveBlending,
      depthWrite: false, // saydam nesneler birbirini "kesmesin"
    }),
  )
  const core = new THREE.Mesh(
    new THREE.ConeGeometry(0.2, 1.5, 16, 1, true),
    new THREE.MeshBasicMaterial({
      color: new THREE.Color(0xeaf4ff).multiplyScalar(5),
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  )
  // Koninin ucu varsayılan olarak yukarı bakar → ters çevir, tabanı tekerleğin altına gelsin
  for (const cone of [outer, core]) {
    cone.material.userData.bloom = true // postfx.js: alevler parlasın
    cone.rotation.x = Math.PI
    cone.position.y = -cone.geometry.parameters.height / 2
    flame.add(cone)
  }
  return flame
}

export function createThrusters(carModel, scene) {
  // Alevler arabanın parçası: araba ile birlikte hareket eder
  const flames = WHEEL_POSITIONS.map((p) => {
    const flame = createFlame()
    flame.position.set(p.x, p.y - 0.75, p.z) // tekerleğin hemen altı
    flame.scale.setScalar(0.001)
    carModel.add(flame)
    return flame
  })

  // Duman dünyada kalır (arabayla taşınmaz) → doğrudan sahneye ekleniyor
  const smokeTexture = createSmokeTexture()
  const particles = []
  for (let i = 0; i < SMOKE_COUNT; i++) {
    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: smokeTexture, color: 0xdde3ec, transparent: true, depthWrite: false, opacity: 0 }),
    )
    sprite.visible = false
    scene.add(sprite)
    // velocity: roketten çıkış hızı (havada yavaşlar), carry: arabadan miras alınan hız
    particles.push({ sprite, velocity: new THREE.Vector3(), carry: new THREE.Vector3(), age: SMOKE_LIFE })
  }

  let nextParticle = 0
  let spawnAccumulator = 0 // kesirli parçacıkları biriktir (ör. 0.4 + 0.7 = 1 parçacık)
  const worldPos = new THREE.Vector3()
  const down = new THREE.Vector3()
  const carry = new THREE.Vector3()
  const lateral = new THREE.Vector3()

  function spawn(position) {
    const p = particles[nextParticle]
    nextParticle = (nextParticle + 1) % SMOKE_COUNT // halka gibi: en eski parçacığı yeniden kullan
    p.age = 0
    p.sprite.visible = true
    p.sprite.position.copy(position)
    p.velocity.copy(down).multiplyScalar(14 + Math.random() * 6)
    p.velocity.x += (Math.random() - 0.5) * 1.5
    p.velocity.z += (Math.random() - 0.5) * 1.5
    p.carry.copy(carry)
  }

  // power: 0 = kapalı, 1 = tam güç
  // carVelocity: arabanın dünya hızı, right: arabanın sağ yönü (birim vektör)
  function update(dt, power, carVelocity, right) {
    // Miras hız: ileri hızın çoğu (duman arabayla gider, sütun gibi altında kalır),
    // yan hızın azı (sağa-sola kayınca sütunlar geride kalıp yana yatar)
    lateral.copy(right).multiplyScalar(carVelocity.dot(right))
    carry.copy(carVelocity).sub(lateral).multiplyScalar(0.88).addScaledVector(lateral, 0.3)

    // Alevler: güce göre boy, küçük titreme ile canlı görünsün
    for (const flame of flames) {
      const flicker = 0.85 + Math.random() * 0.3
      const target = power * flicker
      flame.scale.y += (target - flame.scale.y) * Math.min(1, dt * 20)
      flame.scale.x = flame.scale.z = Math.max(0.001, Math.min(1, power * 1.2))
    }

    // Yeni duman: tekerleklerin altındaki dünya konumundan
    if (power > 0.05) {
      down.set(0, -1, 0).transformDirection(carModel.matrixWorld) // arabanın "aşağı" yönü
      spawnAccumulator += SPAWN_RATE * power * dt
      while (spawnAccumulator >= 1) {
        spawnAccumulator -= 1
        const wheel = WHEEL_POSITIONS[Math.floor(Math.random() * 4)]
        worldPos.set(wheel.x, wheel.y - 2.0, wheel.z + (Math.random() - 0.5) * 0.6)
        carModel.localToWorld(worldPos)
        spawn(worldPos)
      }
    }

    // Var olan dumanı yaşlandır: yavaşla, büyü, saydamlaş
    for (const p of particles) {
      if (p.age >= SMOKE_LIFE) continue
      p.age += dt
      const t = p.age / SMOKE_LIFE // 0 → 1
      if (t >= 1) {
        p.sprite.visible = false
        continue
      }
      p.velocity.multiplyScalar(1 - 2.2 * dt) // hava direnci
      p.velocity.y += 1.5 * dt // sıcak duman hafifçe yükselir
      p.carry.multiplyScalar(1 - 0.35 * dt) // miras hız yavaşça söner → sütunun ucu geride kalır
      p.sprite.position.addScaledVector(p.velocity, dt).addScaledVector(p.carry, dt)
      p.sprite.scale.setScalar(0.7 + t * 5.5) // önce ince, aşağı indikçe genişleyen sütun
      p.sprite.material.opacity = 0.38 * (1 - t) * Math.min(1, t * 10)
    }
  }

  return { update }
}
