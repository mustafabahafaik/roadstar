import * as THREE from 'three'
import { createRockGeometry } from './space.js'

// Kayan yıldızlar ve meteorlar (Satürn Yörüngesi). SADECE GÖRSEL: oyun mantığına, çarpışmaya, sıralamaya etkisi yok.
//
// Neden Math.random (seed'li değil)? Parkur seed'li çünkü herkes AYNI engellere çarpmalı; bir oyuncuda duvar
// olan yer ötekinde boş olsaydı yarış adil olmazdı. Kayan yıldız ise kimseye çarpmaz, sonucu değiştirmez:
// iki oyuncunun gökyüzünde farklı anlarda farklı yıldız kayması hiçbir şeyi bozmaz. Aynı olmaları için
// seed'i ve zamanı eşitlemek gerekirdi; karşılığında hiçbir şey kazanmayacağımız bir iş.
//
// Nesne havuzu (pool): 8 kayan yıldız + 2 meteor açılışta bir kez kurulur. "Ateşle" deyince havuzdaki boş
// bir nesne yeniden kullanılır; yarış boyunca yeni geometri / malzeme yaratılmaz → çöp toplayıcı takılmaz.

const STAR_POOL = 8
const METEOR_POOL = 2
const TRAIL_SEGMENTS = 12 // iz kaç kesitten oluşsun (çok olursa daha yumuşak incelir)

const STAR_HEAD = new THREE.Color(0xe8f6ff).multiplyScalar(4) // baş: beyaz-mavi, HDR (bloom parlatsın)
const STAR_TAIL = new THREE.Color(0x5a9cff).multiplyScalar(2.5)
const FIRE_HEAD = new THREE.Color(0xfff0a0).multiplyScalar(5) // meteor ateşi: sarı-beyaz → turuncu → kırmızı
const FIRE_MID = new THREE.Color(0xff7a1a).multiplyScalar(3)
const FIRE_TAIL = new THREE.Color(0xff2a10).multiplyScalar(1.5)

const rand = (min, max) => min + Math.random() * (max - min)
const UP = new THREE.Vector3(0, 1, 0)

// Şerit (ribbon): N+1 kesit, her kesitte iki köşe (sol / sağ). Köşeler her kare yeniden yazılır.
// Toplamalı (additive) karışım: siyah renk "hiçbir şey ekleme" demek → kuyruğu siyaha boyamak onu saydam yapar
function createRibbon() {
  const count = (TRAIL_SEGMENTS + 1) * 2
  const geometry = new THREE.BufferGeometry()
  const positions = new THREE.BufferAttribute(new Float32Array(count * 3), 3).setUsage(THREE.DynamicDrawUsage)
  const colors = new THREE.BufferAttribute(new Float32Array(count * 3), 3).setUsage(THREE.DynamicDrawUsage)
  geometry.setAttribute('position', positions)
  geometry.setAttribute('color', colors)
  const index = []
  for (let i = 0; i < TRAIL_SEGMENTS; i++) {
    const a = i * 2
    index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2)
  }
  geometry.setIndex(index)
  const material = new THREE.MeshBasicMaterial({
    vertexColors: true, // her köşenin kendi rengi: baş parlak, kuyruk siyah
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
    fog: false, // çok uzaktalar: sis yutmasın
  })
  material.userData.bloom = true // postfx.js: parlasın (Sprite olsaydı bloom geçişinde gizlenirdi)
  const mesh = new THREE.Mesh(geometry, material)
  mesh.frustumCulled = false // köşeler her kare değişiyor: sınır küresi eski kalır, yanlışlıkla gizlenmesin
  mesh.visible = false
  return mesh
}

const toCamera = new THREE.Vector3()
const side = new THREE.Vector3()
const point = new THREE.Vector3()
const color = new THREE.Color()

// Şeridi çiz: baş konumu, gidiş yönü (birim), uzunluk, baştaki genişlik, parlaklık (0–1), renk fonksiyonu.
// Kameraya dönük: her kesitin "yan" yönü = gidiş × kameraya yön → şerit yüzünü hep kameraya çevirir
function shapeRibbon(mesh, head, dir, length, width, brightness, colorAt, cameraPosition) {
  const positions = mesh.geometry.attributes.position
  const colors = mesh.geometry.attributes.color
  toCamera.subVectors(cameraPosition, head).normalize()
  side.crossVectors(dir, toCamera).normalize()
  for (let i = 0; i <= TRAIL_SEGMENTS; i++) {
    const t = i / TRAIL_SEGMENTS // 0 = baş, 1 = kuyruk ucu
    point.copy(head).addScaledVector(dir, -length * t)
    const half = width * 0.5 * (1 - t) // giderek incelen iz
    positions.setXYZ(i * 2, point.x + side.x * half, point.y + side.y * half, point.z + side.z * half)
    positions.setXYZ(i * 2 + 1, point.x - side.x * half, point.y - side.y * half, point.z - side.z * half)
    colorAt(t, color).multiplyScalar(brightness * (1 - t) ** 1.6) // kuyruğa doğru söner → siyah = saydam
    colors.setXYZ(i * 2, color.r, color.g, color.b)
    colors.setXYZ(i * 2 + 1, color.r, color.g, color.b)
  }
  positions.needsUpdate = true
  colors.needsUpdate = true
}

const starColor = (t, out) => out.lerpColors(STAR_HEAD, STAR_TAIL, t)
const fireColor = (t, out) => (t < 0.35 ? out.lerpColors(FIRE_HEAD, FIRE_MID, t / 0.35) : out.lerpColors(FIRE_MID, FIRE_TAIL, (t - 0.35) / 0.65))

// Açılıp sönme: ilk anda hızlı belir, ömrün son kısmında yavaşça sön (0 → 1 → 0)
const fadeAt = (age, life, fadeIn, fadeOut) => Math.min(1, age / fadeIn, (life - age) / (life * fadeOut))

// scene, camera: sahne ve kamera. smoke: ortak duman havuzu (meteorun duman izi).
// getFocus: oyuncunun arabası (meteor yanından geçsin). getMap: şu anki harita (meteors ayarı yoksa kapalı)
// shake(güç, süre): kamera sarsıntısı (cameraModes.js)
export function createMeteors({ scene, camera, smoke, getFocus, getMap, shake }) {
  // --- Kayan yıldız havuzu ---
  const stars = Array.from({ length: STAR_POOL }, () => {
    const mesh = createRibbon()
    scene.add(mesh)
    return { mesh, active: false, age: 0, life: 1, head: new THREE.Vector3(), dir: new THREE.Vector3(), speed: 0, maxLength: 0, width: 0 }
  })

  // --- Meteor havuzu: parlayan kaya + ateş izi (şerit) + duman (ortak duman havuzu) ---
  const rockGeometry = createRockGeometry(Math.random)
  const meteors = Array.from({ length: METEOR_POOL }, () => {
    const material = new THREE.MeshStandardMaterial({
      color: 0x2a1810,
      emissive: 0xff5a1a, // kızgın kaya
      emissiveIntensity: 1.8,
      roughness: 0.85,
      flatShading: true,
    })
    material.userData.bloom = true
    const rock = new THREE.Mesh(rockGeometry, material)
    rock.visible = false
    const fire = createRibbon()
    scene.add(rock, fire)
    return {
      rock,
      fire,
      active: false,
      age: 0,
      life: 1,
      position: new THREE.Vector3(),
      velocity: new THREE.Vector3(),
      dir: new THREE.Vector3(),
      spin: new THREE.Vector3(),
      size: 1,
      near: false, // oyuncunun yanından mı geçiyor (sarsıntı)
      shaken: false,
      smokeTimer: 0,
    }
  })

  let starTimer = 1
  let meteorTimer = 8 // ilk meteor biraz erken gelsin (harita açılınca hemen bir şey görülsün)

  // Kayan yıldız: oyuncudan 5000–7000 birim uzakta (pistin çok ötesinde), gökyüzünde rastgele bir yön
  function fireStar(cameraPosition) {
    const s = stars.find((x) => !x.active)
    if (!s) return
    radial.set(rand(-1, 1), rand(-0.15, 0.9), rand(-1, 1)).normalize() // çoğu ufkun üstünde
    s.head.copy(cameraPosition).addScaledVector(radial, rand(5000, 7000))
    // Gidiş yönü: radyal yöne dik (gökyüzünde "yana" kaysın, bize doğru ya da uzağa değil), biraz aşağı eğimli
    s.dir.randomDirection().projectOnPlane(radial).addScaledVector(UP, -0.35).normalize()
    s.speed = rand(2500, 4500)
    s.maxLength = rand(600, 1200)
    s.width = rand(10, 18)
    s.life = rand(0.5, 1)
    s.age = 0
    s.active = true
    s.mesh.visible = true
  }

  const forward = new THREE.Vector3()
  const right = new THREE.Vector3()
  const start = new THREE.Vector3()
  const end = new THREE.Vector3()
  const radial = new THREE.Vector3()
  const toSaturn = new THREE.Vector3()
  const middle = new THREE.Vector3()
  const across = new THREE.Vector3()

  // Meteor: çoğunlukla pistin yanından, oyuncunun önünden yana doğru; bazen Satürn'ün halkalarının önünden
  function fireMeteor(map) {
    const m = meteors.find((x) => !x.active)
    if (!m) return
    camera.getWorldDirection(forward).setY(0).normalize()
    right.crossVectors(forward, UP).normalize()
    const sideSign = Math.random() < 0.5 ? -1 : 1
    let duration
    if (map.saturn && Math.random() < map.meteors.saturnPassChance) {
      // Satürn geçişi: kamera ile Satürn arasındaki çizginin ortalarında, gezegenin önünden yana kayar
      toSaturn.fromArray(map.saturn.direction).normalize().multiplyScalar(map.saturn.distance).sub(camera.position)
      middle.copy(camera.position).addScaledVector(toSaturn, rand(0.4, 0.55))
      across.crossVectors(toSaturn, UP).normalize()
      start.copy(middle).addScaledVector(across, -1400 * sideSign).addScaledVector(UP, rand(250, 450))
      end.copy(middle).addScaledVector(across, 1400 * sideSign).addScaledVector(UP, rand(-500, -300))
      m.size = rand(30, 45)
      m.near = false
      duration = rand(5, 6.5)
    } else {
      // Yakın geçiş: arabanın 200–450 birim önünde, bir yandan öbür yana, yukarıdan aşağı doğru
      const focus = getFocus()
      start.copy(focus).addScaledVector(forward, rand(220, 450)).addScaledVector(right, 750 * sideSign).addScaledVector(UP, rand(220, 380))
      end.copy(focus).addScaledVector(forward, rand(150, 380)).addScaledVector(right, -750 * sideSign).addScaledVector(UP, rand(-160, -60))
      m.size = rand(6, 10)
      m.near = true
      duration = rand(3.5, 5)
    }
    m.position.copy(start)
    m.velocity.subVectors(end, start).divideScalar(duration)
    m.dir.copy(m.velocity).normalize()
    m.spin.set(rand(-2, 2), rand(-2, 2), rand(-2, 2))
    m.rock.scale.setScalar(m.size)
    m.life = duration
    m.age = 0
    m.shaken = false
    m.smokeTimer = 0
    m.active = true
    m.rock.visible = m.fire.visible = true
  }

  function hideAll() {
    for (const s of stars) s.active = s.mesh.visible = false
    for (const m of meteors) m.active = m.rock.visible = m.fire.visible = false
  }

  const smokeVelocity = new THREE.Vector3()
  const smokePosition = new THREE.Vector3()

  // dt: OYUN zamanı (gerçek zaman × timeScale): düşüşteki ağır çekimde kayan yıldızlar ve meteorlar da yavaşlar
  function update(dt) {
    const map = getMap()
    if (!map?.meteors) return hideAll() // bu haritada gökyüzü olayları yok (okyanus)
    const cameraPosition = camera.position

    // Zamanlayıcılar: rastgele aralıklarla yeni kayan yıldız / meteor
    starTimer -= dt
    if (starTimer <= 0) {
      fireStar(cameraPosition)
      starTimer = rand(...map.meteors.starEvery)
    }
    meteorTimer -= dt
    if (meteorTimer <= 0) {
      fireMeteor(map)
      meteorTimer = rand(...map.meteors.meteorEvery)
    }

    // Kayan yıldızlar: hızla kayar, izi uzar, 0.5–1 sn'de söner
    for (const s of stars) {
      if (!s.active) continue
      s.age += dt
      if (s.age >= s.life) {
        s.active = s.mesh.visible = false
        continue
      }
      s.head.addScaledVector(s.dir, s.speed * dt)
      const length = Math.min(s.maxLength, s.speed * s.age) // iz baştan kısa başlar, kaydıkça uzar
      shapeRibbon(s.mesh, s.head, s.dir, length, s.width, fadeAt(s.age, s.life, 0.06, 0.5), starColor, cameraPosition)
    }

    // Meteorlar: kaya döner ve ilerler, arkasında ateş şeridi + duman pufları
    for (const m of meteors) {
      if (!m.active) continue
      m.age += dt
      if (m.age >= m.life) {
        m.active = m.rock.visible = m.fire.visible = false
        continue
      }
      m.position.addScaledVector(m.velocity, dt)
      m.rock.position.copy(m.position)
      m.rock.rotation.x += m.spin.x * dt
      m.rock.rotation.y += m.spin.y * dt
      m.rock.rotation.z += m.spin.z * dt
      const glow = fadeAt(m.age, m.life, 0.4, 0.2)
      m.rock.material.emissiveIntensity = 1.8 * glow
      shapeRibbon(m.fire, m.position, m.dir, m.size * 22, m.size * 2.4, glow, fireColor, cameraPosition)

      // Duman izi: kısa aralıklarla, kayanın biraz gerisinde, yavaşça yayılan pufu ortak havuzdan
      m.smokeTimer -= dt
      while (m.smokeTimer <= 0) {
        m.smokeTimer += 0.035
        smokePosition.copy(m.position).addScaledVector(m.dir, -m.size * rand(1, 3))
        smokeVelocity.randomDirection().multiplyScalar(m.size * 0.6)
        smoke.emit({
          position: smokePosition,
          velocity: smokeVelocity,
          life: 2.6,
          startSize: m.size * 1.6,
          endSize: m.size * 6,
          opacity: 0.28 * glow,
          drag: 0.8,
          rise: 0,
        })
      }

      // Yakın geçen meteor en yakın noktasına gelince kamera kısa ve hafif sarsılsın (bir kez)
      if (m.near && !m.shaken && m.position.distanceTo(cameraPosition) < 450) {
        m.shaken = true
        shake(0.012, 0.45)
      }
    }
  }

  return { update }
}
