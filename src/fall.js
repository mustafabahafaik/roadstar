import * as THREE from 'three'
import { trackCurve, TRACK_WIDTH } from './track.js'
import { FALL_EDGE, CAR_HALF_WIDTH } from './car.js'
import { WHEEL_POSITIONS } from './carModel.js'
import { GAME_STATE } from './gameState.js'
import { DEBUG } from './settings.js'

// --- Ayarlar ---
const SLOW_MOTION = 0.25 // düşerken zaman ölçeği (1 = normal, 0.25 = dört kat yavaş)
const SLOWMO_EASE = 5 // zaman ölçeğinin yumuşak geçiş hızı (gerçek zamanda)
// Düşmek yarışı bitirmez: araba pistin gerisinde yeniden doğar, ceza kaybedilen ZAMAN.
// Kalkansız: 2 sn ağır çekim + 40 birim geride, yavaş doğma → toplam ~3 sn kayıp.
// Kalkanla: kalkan gider, kısa sahne, araba düştüğü yerde hızını koruyarak pistin ortasına konur
export const FALL_DURATION = 2 // kalkansız düşüş sahnesi kaç GERÇEK saniye sürsün (HUD'daki "+2 sn")
const SAVE_DURATION = 0.5 // kalkan kurtarınca sahne bu kadar kısa
const SPIN_SPEED = { flip: 1.8, roll: 0.8 } // düşerken dönüş hızı (rad/sn, oyun zamanı)
const PUFF_INTERVAL = 0.22 // kesik kesik duman: kaç oyun saniyesinde bir püskürsün
const PUFFS_PER_BURST = 6
const WARN_START = TRACK_WIDTH / 2 - CAR_HALF_WIDTH - 0.5 // gövde kenara 0.5 birim kala uyarı başlar

const UP = new THREE.Vector3(0, 1, 0)
const AXIS_X = new THREE.Vector3(1, 0, 0)
const AXIS_Z = new THREE.Vector3(0, 0, 1)

// Pist boyunca, merkezden "offset" kadar yanda kapalı bir çizgi (hata ayıklama için)
function createEdgeLine(offset, color) {
  const points = []
  for (let i = 0; i < 600; i++) {
    const u = i / 600
    const tangent = trackCurve.getTangentAt(u)
    const side = new THREE.Vector3().crossVectors(tangent, UP).normalize()
    points.push(trackCurve.getPointAt(u).addScaledVector(side, offset).addScaledVector(UP, 0.2))
  }
  return new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(points), new THREE.LineBasicMaterial({ color }))
}

// DEBUG: düşme sınırı (kırmızı çizgiler) + arabanın merkezi (kırmızı direk).
// Düşme kontrolü arabanın MERKEZİNE bakar: direk çizgiyi geçince araba düşer
function createDebugView(scene, car) {
  scene.add(createEdgeLine(-FALL_EDGE, 0xff0000))
  scene.add(createEdgeLine(FALL_EDGE, 0xff0000))
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 7, 6), new THREE.MeshBasicMaterial({ color: 0xff0000 }))
  scene.add(pole)
  return {
    update() {
      pole.position.copy(car.model.position)
      pole.position.y += 3.5
    },
  }
}

// Kenar uyarısı: araba kenara yaklaşınca o taraftaki kenarda, arabanın hizasında kırmızı şerit yanıp söner.
// Bütün pist kenarını değil, sadece arabanın yanındaki parçayı yakar (uzaktaki kenarlar boşuna yanmasın)
function createEdgeWarning(scene, car) {
  const material = new THREE.MeshBasicMaterial({
    color: new THREE.Color(0xff2a2a).multiplyScalar(3),
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  })
  material.userData.bloom = true // postfx.js: parlasın
  const strip = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.3, 22), material)
  strip.visible = false
  scene.add(strip)
  const side = new THREE.Vector3()

  return {
    update(clock) {
      const s = car.state
      // 0 → 1: gövdenin kenarı pist kenarına yaklaştıkça artar, düşme sınırında 1 olur
      const closeness = THREE.MathUtils.clamp((Math.abs(s.offset) - WARN_START) / (FALL_EDGE - WARN_START), 0, 1)
      strip.visible = closeness > 0 && !s.falling && !s.finished
      if (!strip.visible) return
      const tangent = trackCurve.getTangentAt(s.u)
      side.crossVectors(tangent, UP).normalize()
      strip.position
        .copy(trackCurve.getPointAt(s.u))
        .addScaledVector(side, Math.sign(s.offset) * (TRACK_WIDTH / 2)) // yaklaşılan taraf
        .addScaledVector(UP, 0.45)
      strip.lookAt(strip.position.clone().add(tangent)) // şerit pist boyunca uzansın
      const on = Math.sin(clock * 22) > 0 // saniyede ~3.5 kez yanıp sön
      material.opacity = on ? 0.35 + 0.65 * closeness : 0.08
    },
  }
}

// getItems: envanterdeki kalkanı harcamak için (items geri sayımdan sonra oluşur)
// onMessage: ekrana yazı (main.js → showMessage). onFallStart({ saved, penalty }): race.js HUD'da "+2 sn" yakar
export function createFall({ car, smoke, scene, gameState, cameraModes, getItems, onMessage, onFallStart }) {
  const vignette = document.createElement('div')
  vignette.className = 'fall-vignette' // kenarları karartan katman (style.css)
  document.body.appendChild(vignette)

  const debug = DEBUG ? createDebugView(scene, car) : null
  const warning = createEdgeWarning(scene, car)

  let active = false // düşüş sahnesi sürüyor mu
  let realTimer = 0 // kalan GERÇEK süre
  let timeScale = 1
  let puffTimer = 0
  let saved = false // bu düşüşü kalkan mı kurtardı
  let clock = 0 // gerçek zaman sayacı (yanıp sönme için)
  const stats = { falls: 0, saves: 0 } // sonuç ekranı: kaç kez düştü, kaçını kalkan kurtardı
  const spinSign = { flip: 1, roll: 1 }
  const delta = new THREE.Quaternion()
  const position = new THREE.Vector3()
  const velocity = new THREE.Vector3()
  const down = new THREE.Vector3()

  // Kalkan var mı? Önce açık kalkan, yoksa envanterdeki. Varsa harcanır → ceza yok
  function useShield() {
    if (car.state.shield) {
      car.state.shield = false
      return true
    }
    return Boolean(getItems()?.consumeShield())
  }

  // car.js "altında yol yok" deyince çağrılır (main.js → car events.onFall)
  function start() {
    if (active || !gameState.set(GAME_STATE.FALLING)) return // sadece yarış sırasında
    active = true
    saved = useShield()
    realTimer = saved ? SAVE_DURATION : FALL_DURATION
    puffTimer = 0
    stats.falls++
    if (saved) stats.saves++
    spinSign.flip = Math.random() < 0.5 ? -1 : 1
    spinSign.roll = Math.random() < 0.5 ? -1 : 1
    cameraModes.setMode('fall', { side: Math.sign(car.state.offset) || 1 })
    vignette.classList.add('show')
    onMessage(saved ? 'KALKAN KURTARDI!' : `DÜŞTÜN! +${FALL_DURATION} sn`)
    onFallStart?.({ saved, penalty: saved ? 0 : FALL_DURATION })
  }

  // Düşüş sahnesi bitti: yarışa dön (DNF yok), yeniden doğ
  function end(respawn) {
    active = false
    vignette.classList.remove('show')
    cameraModes.setMode('chase')
    gameState.set(GAME_STATE.RACING)
    // Kalkan kurtardıysa düştüğü yerde, hızını koruyarak; yoksa 40 birim geride. 1.5 sn yanıp sönerek dokunulmaz
    if (respawn) car.respawnAfterFall({ saved })
  }

  // Kesik kesik duman: tekerlek iticilerinden kısa bir püskürme
  function puffBurst() {
    down.set(0, -1, 0).transformDirection(car.model.matrixWorld) // arabanın "aşağısı" (dönerken değişir)
    for (let i = 0; i < PUFFS_PER_BURST; i++) {
      const wheel = WHEEL_POSITIONS[Math.floor(Math.random() * WHEEL_POSITIONS.length)]
      car.model.localToWorld(position.set(wheel.x, wheel.y - 1, wheel.z))
      velocity.copy(down).multiplyScalar(10 + Math.random() * 6)
      velocity.x += (Math.random() - 0.5) * 3
      velocity.z += (Math.random() - 0.5) * 3
      smoke.emit({ position, velocity, life: 1.1, startSize: 0.6, endSize: 3.6, opacity: 0.45, drag: 2.5 })
    }
  }

  // realDt: gerçek zaman, gameDt: realDt × timeScale (oyun zamanı)
  function update(realDt, gameDt) {
    clock += realDt
    // Zaman ölçeği GERÇEK zamanla yumuşar (ağır çekim kendi geçişini yavaşlatmasın)
    timeScale += ((active ? SLOW_MOTION : 1) - timeScale) * (1 - Math.exp(-SLOWMO_EASE * realDt))

    if (active) {
      if (!car.state.falling && !car.state.crashed) {
        end(false) // başka bir yoldan (ör. çarpışma) zaten geri döndü
      } else {
        // Yerçekimiyle düşerken kendi etrafında yavaşça dön (yerel eksenlerde, oyun zamanıyla)
        delta.setFromAxisAngle(AXIS_X, SPIN_SPEED.flip * spinSign.flip * gameDt)
        car.state.trickQuat.multiply(delta)
        delta.setFromAxisAngle(AXIS_Z, SPIN_SPEED.roll * spinSign.roll * gameDt)
        car.state.trickQuat.multiply(delta)

        puffTimer -= gameDt
        if (puffTimer <= 0) {
          puffTimer = PUFF_INTERVAL
          puffBurst()
        }

        realTimer -= realDt
        if (realTimer <= 0) end(true)
      }
    }

    warning.update(clock)
    debug?.update()
  }

  return {
    start,
    update,
    stats,
    get timeScale() {
      return timeScale
    },
  }
}
