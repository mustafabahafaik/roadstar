import * as THREE from 'three'
import { trackCurve, TRACK_WIDTH } from './track.js'
import { TRUCK_SIZE } from './truck.js'

// Satürn Yörüngesi haritasının arka planı: yıldızlar, bulutsular, Satürn ve asteroitler.
// Harici doku dosyası yok: her şey canvas'a çizilerek ya da geometriyle üretilir.
//
// InstancedMesh: aynı geometri + aynı malzeme, TEK çizim komutuyla (draw call) N kez çizilir; her kopyanın
// sadece kendi matrisi (konum / dönüş / boyut) ve istersek rengi vardır. 420 ayrı Mesh = 420 çizim komutu;
// InstancedMesh = 1. Ekran kartı için en pahalı şey komut sayısıdır, üçgen sayısı değil.

const UP = new THREE.Vector3(0, 1, 0)

// Tohumlu rastgele (mulberry32): herkes aynı yıldızları ve asteroitleri görsün (Math.random her oyuncuda farklı olurdu)
function seededRandom(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// --- Yıldızlar: binlerce nokta, TEK Points nesnesi (tek çizim komutu) ---
function createStars(count, rand) {
  const positions = new Float32Array(count * 3)
  const colors = new Float32Array(count * 3)
  const tints = [new THREE.Color(0xffffff), new THREE.Color(0xa8c8ff), new THREE.Color(0xffd2a1), new THREE.Color(0xd7b8ff)]
  const v = new THREE.Vector3()
  for (let i = 0; i < count; i++) {
    // Küre kabuğunda düzgün dağılım: rastgele yön (cos θ eşit dağılır) × 7000–9000 yarıçap
    const y = rand() * 2 - 1
    const angle = rand() * Math.PI * 2
    const r = Math.sqrt(1 - y * y)
    v.set(r * Math.cos(angle), y, r * Math.sin(angle)).multiplyScalar(7000 + rand() * 2000)
    v.toArray(positions, i * 3)
    const color = tints[Math.floor(rand() * tints.length)].clone().multiplyScalar(0.5 + rand() * 0.9)
    color.toArray(colors, i * 3)
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  // sizeAttenuation: false → boyut piksel cinsinden (uzaktaki yıldız da görünsün); fog: false → sis yutmasın
  const material = new THREE.PointsMaterial({ size: 2, sizeAttenuation: false, vertexColors: true, fog: false, depthWrite: false })
  return new THREE.Points(geometry, material)
}

// Yumuşak, kenarlara doğru sönen leke (bulutsu ve ortam haritası için canvas dokusu)
function blobTexture(rand) {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 256
  const ctx = canvas.getContext('2d')
  for (let i = 0; i < 14; i++) {
    const x = 70 + rand() * 116
    const y = 70 + rand() * 116
    const r = 40 + rand() * 80
    const g = ctx.createRadialGradient(x, y, 0, x, y, r)
    g.addColorStop(0, 'rgba(255,255,255,0.35)')
    g.addColorStop(1, 'rgba(255,255,255,0)')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, 256, 256)
  }
  return new THREE.CanvasTexture(canvas)
}

// --- Bulutsular: uzakta, toplanarak parlayan (additive) birkaç renkli leke. Sprite: hep kameraya döner ---
function createNebulae(rand) {
  const group = new THREE.Group()
  const colors = [0x7a3cff, 0xff6a3d, 0x2ad1ff, 0xd13cff, 0xff9a3d]
  for (let i = 0; i < 6; i++) {
    const material = new THREE.SpriteMaterial({
      map: blobTexture(rand),
      color: colors[i % colors.length],
      transparent: true,
      opacity: 0.32,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false,
    })
    const sprite = new THREE.Sprite(material)
    const angle = (i / 6) * Math.PI * 2 + rand()
    sprite.position.set(Math.cos(angle) * 6500, (rand() - 0.3) * 3000, Math.sin(angle) * 6500)
    sprite.scale.setScalar(3500 + rand() * 3000)
    group.add(sprite)
  }
  return group
}

// --- Satürn yüzeyi: enlem bantları (her satır bir renk), canvas ile prosedürel ---
function saturnTexture(rand) {
  const canvas = document.createElement('canvas')
  canvas.width = 1024
  canvas.height = 512
  const ctx = canvas.getContext('2d')
  const palette = ['#f3e2bd', '#e2c58d', '#c99b5f', '#b07f4a', '#ead3a0', '#d8b47c']
  const phases = palette.map(() => rand() * 10)
  for (let y = 0; y < 512; y++) {
    const lat = y / 512
    // Birkaç farklı frekansta sinüs: bantlar düzenli ama tekdüze olmasın
    const n = Math.sin(lat * 38 + phases[0]) * 0.5 + Math.sin(lat * 91 + phases[1]) * 0.3 + Math.sin(lat * 7 + phases[2]) * 0.2
    const i = Math.floor(((n + 1) / 2) * (palette.length - 1))
    ctx.fillStyle = palette[Math.max(0, Math.min(palette.length - 1, i))]
    ctx.fillRect(0, y, 1024, 1)
  }
  // Kutuplara doğru koyulaşma + bantların arasında ince fırtına çizgileri
  const shade = ctx.createLinearGradient(0, 0, 0, 512)
  shade.addColorStop(0, 'rgba(40,25,10,0.55)')
  shade.addColorStop(0.2, 'rgba(40,25,10,0)')
  shade.addColorStop(0.8, 'rgba(40,25,10,0)')
  shade.addColorStop(1, 'rgba(40,25,10,0.55)')
  ctx.fillStyle = shade
  ctx.fillRect(0, 0, 1024, 512)
  for (let i = 0; i < 260; i++) {
    ctx.fillStyle = `rgba(255,240,210,${rand() * 0.12})`
    ctx.fillRect(rand() * 1024, rand() * 512, 40 + rand() * 200, 1)
  }
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

// --- Halka dokusu: yarıçap boyunca bantlar ve boşluklar (Cassini boşluğu), saydamlık gradyanı ---
function ringTexture(rand) {
  const canvas = document.createElement('canvas')
  canvas.width = 512
  canvas.height = 4
  const ctx = canvas.getContext('2d')
  for (let x = 0; x < 512; x++) {
    const t = x / 512 // 0 iç kenar → 1 dış kenar
    let alpha = 0.25 + 0.55 * Math.sin(t * Math.PI) + (rand() - 0.5) * 0.25
    if (t > 0.58 && t < 0.63) alpha *= 0.08 // Cassini boşluğu
    if (t < 0.05 || t > 0.97) alpha *= t < 0.05 ? t / 0.05 : (1 - t) / 0.03 // kenarlar yumuşak
    const tone = 200 + Math.floor(rand() * 40)
    ctx.fillStyle = `rgba(${tone},${tone - 30},${tone - 70},${Math.max(0, Math.min(1, alpha))})`
    ctx.fillRect(x, 0, 1, 4)
  }
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

// --- Satürn: güneşle aydınlanan bantlı küre + yarı saydam halka. Yavaşça döner ---
function createSaturn(cfg, rand) {
  const group = new THREE.Group()
  const planet = new THREE.Mesh(
    new THREE.SphereGeometry(cfg.radius, 96, 48),
    new THREE.MeshStandardMaterial({ map: saturnTexture(rand), roughness: 1, metalness: 0, fog: false }),
  )
  group.add(planet)

  // RingGeometry'nin varsayılan UV'si düzlemsel; doku yarıçap boyunca uzansın diye u = (r − iç) / (dış − iç)
  const inner = cfg.radius * 1.25
  const outer = cfg.radius * 2.3
  const ringGeometry = new THREE.RingGeometry(inner, outer, 180, 1)
  const pos = ringGeometry.attributes.position
  const uv = ringGeometry.attributes.uv
  for (let i = 0; i < pos.count; i++) {
    const r = Math.hypot(pos.getX(i), pos.getY(i))
    uv.setXY(i, (r - inner) / (outer - inner), 0.5)
  }
  const ring = new THREE.Mesh(
    ringGeometry,
    new THREE.MeshBasicMaterial({
      map: ringTexture(rand),
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false, // saydam: arkasındaki yıldızları kesmesin
      fog: false,
      color: 0xd9c4a0,
    }),
  )
  ring.rotation.x = -Math.PI / 2 // halka ekvator düzleminde
  group.add(ring)

  const dir = new THREE.Vector3(...cfg.direction).normalize()
  group.position.copy(dir).multiplyScalar(cfg.distance)
  group.rotation.z = cfg.tilt // eksen eğikliği: halka yan görünsün
  return {
    object: group,
    update(dt) {
      planet.rotation.y += cfg.spin * dt // bantlar yavaşça kayar
    },
  }
}

// Pürüzlü kaya: ikosahedronun köşelerini rastgele itip çek (aynı köşe hep aynı miktar: dikiş yeri açılmasın)
function createRockGeometry(rand) {
  const geometry = new THREE.IcosahedronGeometry(1, 1)
  const pos = geometry.attributes.position
  const offsets = new Map()
  const v = new THREE.Vector3()
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i)
    const key = `${v.x.toFixed(3)},${v.y.toFixed(3)},${v.z.toFixed(3)}`
    if (!offsets.has(key)) offsets.set(key, 0.72 + rand() * 0.5)
    v.multiplyScalar(offsets.get(key))
    pos.setXYZ(i, v.x, v.y, v.z)
  }
  geometry.computeVertexNormals()
  return geometry
}

// --- Yol kenarında süzülen asteroitler: TEK InstancedMesh, her kare yavaşça döner ve süzülür ---
function createAsteroidBelt(count, rand) {
  const material = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, metalness: 0.05, flatShading: true })
  const mesh = new THREE.InstancedMesh(createRockGeometry(rand), material, count)
  mesh.frustumCulled = false // kopyalar pist boyunca dağınık: tek kayanın kutusuna göre gizlenmesin
  const tints = [0x6b5a7e, 0x5a4a44, 0x7d6a5a, 0x4a4560]
  const rocks = []
  const side = new THREE.Vector3()
  const color = new THREE.Color()
  for (let i = 0; i < count; i++) {
    const u = rand()
    const point = trackCurve.getPointAt(u)
    side.crossVectors(trackCurve.getTangentAt(u), UP).normalize()
    const lateral = (rand() < 0.5 ? -1 : 1) * (TRACK_WIDTH / 2 + 8 + rand() * 70) // yolun dışında kalsın
    rocks.push({
      base: point.addScaledVector(side, lateral).add(new THREE.Vector3(0, (rand() - 0.5) * 50, 0)),
      scale: 0.8 + rand() ** 2 * 6, // çoğu küçük, birkaçı büyük
      rotation: new THREE.Euler(rand() * 6, rand() * 6, rand() * 6),
      spin: new THREE.Vector3(rand() - 0.5, rand() - 0.5, rand() - 0.5).multiplyScalar(0.6),
      phase: rand() * Math.PI * 2,
    })
    mesh.setColorAt(i, color.set(tints[i % tints.length])) // kopya başına renk
  }
  const matrix = new THREE.Matrix4()
  const position = new THREE.Vector3()
  const quaternion = new THREE.Quaternion()
  const scale = new THREE.Vector3()
  let time = 0
  function update(dt) {
    time += dt
    rocks.forEach((rock, i) => {
      rock.rotation.x += rock.spin.x * dt
      rock.rotation.y += rock.spin.y * dt
      rock.rotation.z += rock.spin.z * dt
      position.copy(rock.base)
      position.y += Math.sin(time * 0.35 + rock.phase) * 1.5 // süzülme
      quaternion.setFromEuler(rock.rotation)
      mesh.setMatrixAt(i, matrix.compose(position, quaternion, scale.setScalar(rock.scale)))
    })
    mesh.instanceMatrix.needsUpdate = true // matrisleri GPU'ya yeniden gönder
  }
  update(0)
  return { object: mesh, update }
}

// --- Engel asteroitleri: kule ve tırların yerine, aynı yerde (çarpışma kutusu course.js'te, DEĞİŞMEZ) ---
// Kule kutusu: taban 8 geniş, ~7.4 yüksek → ~3.6 yarıçaplı kaya. Tır kutusu: 6 × 9 × 22 → uzun kaya
export function createAsteroidObstacles(obstacles) {
  const rocks = obstacles.filter((o) => o.type === 'tower' || o.type === 'truck')
  const rand = seededRandom(7)
  const material = new THREE.MeshStandardMaterial({
    color: 0x7a5a48,
    roughness: 0.9,
    metalness: 0.1,
    flatShading: true,
    emissive: 0x3a1405, // çatlaklardan sızan turuncu ısı hissi
  })
  const mesh = new THREE.InstancedMesh(createRockGeometry(rand), material, Math.max(1, rocks.length))
  mesh.count = rocks.length
  mesh.frustumCulled = false
  mesh.castShadow = mesh.receiveShadow = true
  const matrix = new THREE.Matrix4()
  const position = new THREE.Vector3()
  const quaternion = new THREE.Quaternion()
  const scale = new THREE.Vector3()
  const side = new THREE.Vector3()
  const look = new THREE.Matrix4()
  rocks.forEach((o, i) => {
    const tangent = trackCurve.getTangentAt(o.u)
    side.crossVectors(tangent, UP).normalize()
    position.copy(trackCurve.getPointAt(o.u)).addScaledVector(side, o.offset * (TRACK_WIDTH / 2))
    if (o.type === 'tower') {
      position.y += 3.6
      scale.set(3.8, 3.7, 3.8)
      quaternion.setFromEuler(new THREE.Euler(rand() * 6, rand() * 6, rand() * 6))
    } else {
      position.y += TRUCK_SIZE.height / 2
      scale.set(TRUCK_SIZE.width / 2, TRUCK_SIZE.height / 2, TRUCK_SIZE.length / 2)
      quaternion.setFromRotationMatrix(look.lookAt(new THREE.Vector3(), tangent, UP)) // uzun ekseni pist boyunca
    }
    mesh.setMatrixAt(i, matrix.compose(position, quaternion, scale))
  })
  return mesh
}

// Ortam haritası: dikey gradyanlı küre (üst mor, ufukta turuncu, alt siyah) → PMREM.
// Arabanın boyası ve metalleri uzayın renklerini yansıtsın (okyanusun mavi göğünü değil)
function createSpaceEnvironment(pmrem, sky) {
  const canvas = document.createElement('canvas')
  canvas.width = 4
  canvas.height = 256
  const ctx = canvas.getContext('2d')
  const g = ctx.createLinearGradient(0, 0, 0, 256)
  g.addColorStop(0, sky.top)
  g.addColorStop(0.47, sky.horizon)
  g.addColorStop(0.55, sky.bottom)
  g.addColorStop(1, sky.bottom)
  ctx.fillStyle = g
  ctx.fillRect(0, 0, 4, 256)
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  const envScene = new THREE.Scene()
  envScene.add(new THREE.Mesh(new THREE.SphereGeometry(100, 32, 16), new THREE.MeshBasicMaterial({ map: texture, side: THREE.BackSide })))
  const env = pmrem.fromScene(envScene).texture
  texture.dispose()
  return env
}

// Uzay haritasını sahneye kur. Dönen nesne: { environment, bloomHidden, update(dt), dispose() } (world.js kullanır)
export function createSpace(scene, pmrem, map) {
  const rand = seededRandom(42)
  const parts = []
  const has = (name) => map.background.includes(name)
  if (has('stars')) parts.push({ object: createStars(map.stars.count, rand) })
  if (has('nebula')) parts.push({ object: createNebulae(rand) })
  if (has('saturn')) parts.push(createSaturn(map.saturn, rand))
  if (has('asteroids')) parts.push(createAsteroidBelt(map.asteroids.count, rand))
  for (const p of parts) scene.add(p.object)
  scene.background = new THREE.Color(map.sky.background)

  return {
    environment: createSpaceEnvironment(pmrem, map.sky),
    bloomHidden: [], // yıldız ve bulutsular (Points / Sprite) bloom geçişinde zaten gizlenir
    update(dt) {
      for (const p of parts) p.update?.(dt)
    },
    dispose() {
      scene.background = null
      for (const p of parts) {
        scene.remove(p.object)
        p.object.traverse((o) => {
          o.geometry?.dispose()
          o.material?.map?.dispose()
          o.material?.dispose()
        })
      }
      this.environment.dispose()
    },
  }
}
