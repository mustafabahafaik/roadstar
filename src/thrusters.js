import * as THREE from 'three'
import { WHEEL_POSITIONS } from './carModel.js'

const SMOKE_LIFE = 1.4 // bir parçacığın ömrü (saniye)
const SPAWN_RATE = 320 // saniyede doğan toplam parçacık (tam güçte) → sık doğunca birleşip sütun gibi görünür

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

// smoke: smoke.js'teki ortak duman havuzu (alt itici dumanı da oradan çıkar)
export function createThrusters(carModel, scene, smoke) {
  // Alevler arabanın parçası: araba ile birlikte hareket eder
  const flames = WHEEL_POSITIONS.map((p) => {
    const flame = createFlame()
    flame.position.set(p.x, p.y - 0.75, p.z) // tekerleğin hemen altı
    flame.scale.setScalar(0.001)
    carModel.add(flame)
    return flame
  })

  let spawnAccumulator = 0 // kesirli parçacıkları biriktir (ör. 0.4 + 0.7 = 1 parçacık)
  const worldPos = new THREE.Vector3()
  const down = new THREE.Vector3()
  const carry = new THREE.Vector3()
  const lateral = new THREE.Vector3()

  const velocity = new THREE.Vector3()

  // Alt itici pufu: aşağı doğru fırlar, arabanın hızının bir kısmını miras alır (sütun gibi altında kalır)
  function spawn(position) {
    velocity.copy(down).multiplyScalar(14 + Math.random() * 6)
    velocity.x += (Math.random() - 0.5) * 1.5
    velocity.z += (Math.random() - 0.5) * 1.5
    smoke.emit({ position, velocity, carry, life: SMOKE_LIFE, startSize: 0.7, endSize: 6.2, opacity: 0.38 })
  }

  // power: 0 = kapalı, 1 = tam güç
  // carVelocity: arabanın dünya hızı, right: arabanın sağ yönü (birim vektör)
  // Patlama parlaması: hızla büyüyüp sönen turuncu küre (bloom ile parlar)
  const flash = new THREE.Mesh(
    new THREE.SphereGeometry(1, 24, 16),
    new THREE.MeshBasicMaterial({
      color: new THREE.Color(0xff8a2a).multiplyScalar(4),
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  )
  flash.material.userData.bloom = true
  flash.visible = false
  scene.add(flash)
  let flashAge = Infinity
  const FLASH_LIFE = 0.45

  // Çarpışma patlaması: parlama + her yöne savrulan duman
  function burst(position, count = 45) {
    flash.position.copy(position)
    flash.position.y += 1.5
    flashAge = 0
    for (let i = 0; i < count; i++) {
      // Rastgele yön (yukarı ağırlıklı) × rastgele hız
      velocity.set(Math.random() - 0.5, Math.random() * 0.8, Math.random() - 0.5).normalize()
      velocity.multiplyScalar(6 + Math.random() * 10)
      smoke.emit({ position: flash.position, velocity, life: SMOKE_LIFE, startSize: 1.2, endSize: 7, opacity: 0.38 })
    }
  }

  function update(dt, power, carVelocity, right) {
    // Parlama: büyü ve sön
    if (flashAge < FLASH_LIFE) {
      flashAge += dt
      const t = Math.min(1, flashAge / FLASH_LIFE)
      flash.visible = t < 1
      flash.scale.setScalar(1.5 + t * 7)
      flash.material.opacity = 1 - t
    }

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
  }

  return { update, burst }
}
