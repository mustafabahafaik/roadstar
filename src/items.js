import * as THREE from 'three'
import { trackCurve, trackDistance } from './track.js'
import { obstacleBoxes } from './car.js'
import { neon } from './neon.js'
import { itemHash, itemTypeFromHash, hashFraction } from './random.js'
import { createItemsHud } from './hud.js'

// --- Token türleri (0-4). id zincire gidecek listede de bu sayıyla tutulur ---
export const TOKEN_TYPES = [
  { id: 0, name: 'Thrust Cell', color: 0x29e7ff }, // anında: itici yakıtını doldurur
  { id: 1, name: 'Kalkan', color: 0x3dff8a, key: '1' }, // envanter: bir sonraki çarpışmayı affeder
  { id: 2, name: 'Mıknatıs', color: 0xff3b6b, key: '2', duration: 5 }, // envanter: 5 sn tokenları çeker
  { id: 3, name: 'Block Rush', color: 0x9b6bff, key: '3', duration: 3 }, // envanter: 3 sn hız patlaması
  { id: 4, name: 'Altın Token', color: 0xffc23a }, // nadir: yarış sonunda NFT olacak, şimdilik sayılır
]
const THRUST = 0
const SHIELD = 1
const MAGNET = 2
const RUSH = 3
const GOLD = 4

// --- Ayarlar ---
export const TOKEN_COUNT = 40 // pist boyunca kaç token (kontrattaki ITEMS_PER_ROOM ile aynı olmalı)
const LANE_OFFSET = 4.5 // sol / orta / sağ şerit merkezleri (−4.5, 0, 4.5)
const GROUND_HEIGHT = 1.6 // yoldaki tokenların yüksekliği
const AIR_CHANCE = 0.35 // tokenların ne kadarı havada olsun
const PICKUP_RADIUS = 4.5 // araba merkezine bu kadar yaklaşınca toplanır
const MAGNET_RADIUS = 35 // mıknatıs bu mesafedeki tokenları çeker
const MAGNET_PULL_SPEED = 110 // çekilen tokenın hızı (birim / saniye)
const RUSH_MULTIPLIER = 1.6 // Block Rush sırasında en yüksek hız ve ivme çarpanı

const up = new THREE.Vector3(0, 1, 0)

// --- 1) Yerleşim: seed + index → konum ve tür (aynı tohum → hep aynı yerleşim) ---
// Tür, kontrattaki itemAt ile aynı formülden gelir (random.js); konum aynı hash'in başka bitlerinden
export function planTokens(seed) {
  const plan = []
  for (let index = 0; index < TOKEN_COUNT; index++) {
    const hash = itemHash(seed, index)
    const r = (slot) => hashFraction(hash, slot) // her özellik hash'in ayrı bir parçasından

    // Pist TOKEN_COUNT dilime bölünür; her token kendi diliminin içinde rastgele bir yerde
    const u = (index + 0.15 + 0.7 * r(0)) / TOKEN_COUNT
    const offset = (Math.floor(r(1) * 3) - 1) * LANE_OFFSET // −1, 0, 1 → sol, orta, sağ
    let height = r(2) < AIR_CHANCE ? 5 + r(3) * 3 : GROUND_HEIGHT
    const type = itemTypeFromHash(hash) // zincirdeki Race.itemAt(seed, index) ile aynı

    // Bir engelin üstüne/içine denk geliyorsa engelin tepesinin üstüne kaldır (uçana ödül)
    for (const b of obstacleBoxes) {
      const halfDepth = b.halfDepth ?? b.bottomHalf
      const halfWidth = b.halfWidth ?? b.bottomHalf
      const nearAlong = Math.abs(trackDistance(u, b.u)) < halfDepth + 4
      const nearSide = Math.abs(offset - b.center) < halfWidth + 1.5
      if (nearAlong && nearSide) height = Math.max(height, b.top + 2.5)
    }
    plan.push({ index, type, u, offset, height })
  }
  return plan
}

// --- 2) Modeller: her tür kendi şekli ve renginde; geometri/malzeme türler arasında paylaşılır ---
function createTokenParts() {
  return TOKEN_TYPES.map((t) => {
    const core = neon(t.color, 2.2)
    const halo = neon(t.color, 3)
    const white = neon(0xffffff, 3)
    const parts = []
    if (t.id === THRUST) {
      // Pil gibi kapsül + iki uçta beyaz bant
      parts.push([new THREE.CapsuleGeometry(0.42, 1.0, 6, 16), core, 0])
      parts.push([new THREE.CylinderGeometry(0.46, 0.46, 0.12, 20), white, 0.42])
      parts.push([new THREE.CylinderGeometry(0.46, 0.46, 0.12, 20), white, -0.42])
    } else if (t.id === SHIELD) {
      // Altıgen kalkan plakası
      const g = new THREE.CylinderGeometry(1.0, 1.0, 0.22, 6)
      g.rotateX(Math.PI / 2) // yüzü öne baksın
      parts.push([g, core, 0])
    } else if (t.id === MAGNET) {
      // U (at nalı) mıknatıs: yarım halka + beyaz kutuplar
      parts.push([new THREE.TorusGeometry(0.7, 0.24, 12, 24, Math.PI), core, 0])
      for (const x of [-0.7, 0.7]) {
        const tip = new THREE.CylinderGeometry(0.25, 0.25, 0.32, 16)
        tip.translate(x, -0.12, 0)
        parts.push([tip, white, 0])
      }
    } else if (t.id === RUSH) {
      // Blok: köşesi üstte duran küp + beyaz kenar çizgileri
      const g = new THREE.BoxGeometry(1.05, 1.05, 1.05)
      g.rotateX(Math.PI / 4)
      g.rotateZ(Math.PI / 4)
      parts.push([g, core, 0])
      parts.push([new THREE.EdgesGeometry(g), new THREE.LineBasicMaterial({ color: new THREE.Color(0xffffff).multiplyScalar(3) }), 0, 'lines'])
    } else {
      // Altın: uzun elmas (oktahedron), biraz daha büyük
      const g = new THREE.OctahedronGeometry(1.0)
      g.scale(1, 1.35, 1)
      parts.push([g, core, 0])
    }
    // Hepsinin etrafında dönen ince parlak halka
    parts.push([new THREE.TorusGeometry(t.id === GOLD ? 1.6 : 1.35, 0.05, 8, 48), halo, 0, 'halo'])
    return parts
  })
}

function buildToken(parts) {
  const group = new THREE.Group()
  const spinner = new THREE.Group() // kendi etrafında dönen kısım
  group.add(spinner)
  let halo = null
  for (const [geometry, material, y, kind] of parts) {
    const obj = kind === 'lines' ? new THREE.LineSegments(geometry, material) : new THREE.Mesh(geometry, material)
    obj.position.y = y
    if (kind === 'halo') {
      halo = obj
      group.add(obj) // halka ayrı döner
    } else {
      spinner.add(obj)
    }
  }
  return { group, spinner, halo }
}

// Kalkan kabarcığı ve mıknatıs halkası: arabaya bağlı görseller
function createCarEffects(carModel) {
  const bubble = new THREE.Mesh(
    new THREE.SphereGeometry(1, 32, 20),
    new THREE.MeshBasicMaterial({
      color: new THREE.Color(TOKEN_TYPES[SHIELD].color).multiplyScalar(0.5),
      transparent: true,
      opacity: 0.22,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  )
  bubble.material.userData.bloom = true
  bubble.scale.set(3.2, 2.2, 5.8) // arabayı saran elips
  bubble.position.y = 1.4
  bubble.visible = false
  carModel.add(bubble)

  const ring = new THREE.Mesh(new THREE.TorusGeometry(6, 0.08, 8, 64), neon(TOKEN_TYPES[MAGNET].color, 2.5))
  ring.rotation.x = Math.PI / 2 // yere paralel
  ring.position.y = 0.4
  ring.visible = false
  carModel.add(ring)

  return { bubble, ring }
}

// --- 3) Toplama, envanter ve skill'ler ---
// events: { onCollect(index, type), onSkill(type) } → main.js bunları zincire işlem olarak gönderir.
// Oyundaki etki önce uygulanır, olay sonra bildirilir (iyimser arayüz: zinciri beklemeyiz)
// seed: tokenların tohumu (zincirden ya da zincirsizde rastgele), label: HUD'da görünen yarış adı
export function createItems(scene, car, seed, label, events = {}) {
  const hud = createItemsHud(TOKEN_TYPES, label, TOKEN_COUNT)
  const parts = createTokenParts()
  const effects = createCarEffects(car.model)

  // Zincire gidecek liste: toplanan her token için { index, type }
  const collected = []
  const inventory = { [SHIELD]: 0, [MAGNET]: 0, [RUSH]: 0 }
  const timers = { [MAGNET]: 0, [RUSH]: 0 } // aktif skill'lerin kalan süresi (saniye)
  let time = 0

  // Tokenları oluştur ve pistteki yerlerine koy
  const tokens = planTokens(seed).map((p) => {
    const center = trackCurve.getPointAt(p.u)
    const tangent = trackCurve.getTangentAt(p.u)
    const side = new THREE.Vector3().crossVectors(tangent, up).normalize()
    const base = center.addScaledVector(side, p.offset).addScaledVector(up, p.height)
    const model = buildToken(parts[p.type])
    model.group.position.copy(base)
    scene.add(model.group)
    return { ...p, base, ...model, collected: false, phase: p.index * 1.7 }
  })

  function collect(token) {
    token.collected = true
    token.group.visible = false
    collected.push({ index: token.index, type: token.type })
    if (token.type === THRUST) car.state.fuel = 1 // anında etki
    else if (token.type in inventory) inventory[token.type]++
    hud.toast(`+ ${TOKEN_TYPES[token.type].name}`, TOKEN_TYPES[token.type].color)
    events.onCollect?.(token.index, token.type)
  }

  function useSkill(type) {
    if (inventory[type] <= 0) return hud.toast(`${TOKEN_TYPES[type].name} yok`, 0x8a8fa3)
    if (type === SHIELD) {
      if (car.state.shield) return // zaten açık: boşa harcama
      car.state.shield = true
    } else {
      if (timers[type] > 0) return // zaten aktif
      timers[type] = TOKEN_TYPES[type].duration
    }
    inventory[type]--
    hud.toast(`${TOKEN_TYPES[type].name} aktif!`, TOKEN_TYPES[type].color)
    events.onSkill?.(type)
  }

  // 1, 2, 3 tuşları (üst sıra ya da sayı tuş takımı). e.repeat: basılı tutunca tekrar tetiklenmesin
  const keyToType = { Digit1: SHIELD, Digit2: MAGNET, Digit3: RUSH, Numpad1: SHIELD, Numpad2: MAGNET, Numpad3: RUSH }
  window.addEventListener('keydown', (e) => {
    if (e.repeat || !(e.code in keyToType)) return
    useSkill(keyToType[e.code])
  })

  const carCenter = new THREE.Vector3()
  const toCar = new THREE.Vector3()

  function update(dt) {
    time += dt

    // Skill süreleri
    for (const type in timers) timers[type] = Math.max(0, timers[type] - dt)
    car.state.boost = timers[RUSH] > 0 ? RUSH_MULTIPLIER : 1

    // Arabanın gövde merkezi (dünya koordinatı)
    carCenter.copy(car.model.position).addScaledVector(up, 1.3)
    const canCollect = !car.state.crashed && !car.state.falling
    const magnetOn = timers[MAGNET] > 0

    for (const t of tokens) {
      if (t.collected) continue

      // Mıknatıs: yakındaki tokenları arabaya doğru çek
      if (magnetOn) {
        toCar.subVectors(carCenter, t.base)
        const distance = toCar.length()
        if (distance < MAGNET_RADIUS) t.base.addScaledVector(toCar.normalize(), Math.min(distance, MAGNET_PULL_SPEED * dt))
      }

      // Dön, aşağı yukarı süzül, halka ters yönde dönsün
      t.spinner.rotation.y += dt * 2.2
      t.halo.rotation.x = Math.PI / 2 + Math.sin(time * 1.3 + t.phase) * 0.5
      t.halo.rotation.z += dt * 1.5
      t.group.position.copy(t.base)
      t.group.position.y += Math.sin(time * 2.4 + t.phase) * 0.3

      // Toplama: basit mesafe kontrolü
      if (canCollect && t.group.position.distanceTo(carCenter) < PICKUP_RADIUS) collect(t)
    }

    // Arabadaki görseller
    effects.bubble.visible = car.state.shield
    effects.bubble.material.opacity = 0.18 + Math.sin(time * 5) * 0.05
    effects.ring.visible = magnetOn
    effects.ring.rotation.z += dt * 3
    effects.ring.scale.setScalar(1 + Math.sin(time * 8) * 0.04)

    hud.update({
      fuel: car.state.fuel,
      inventory,
      shield: car.state.shield,
      timers,
      gold: collected.filter((c) => c.type === GOLD).length,
      collectedCount: collected.length,
    })
  }

  return { update, collected, inventory }
}
