import * as THREE from 'three'
import QRCode from 'qrcode'
import { createCarModel } from './carModel.js'
import { createThrusters } from './thrusters.js'
import { applyLoadout } from './parts.js'
import { escapeHtml, toCssColor } from './html.js'

// Bahis ekranı (herkes hazır olunca, yarıştan önce 30 sn). Yarışçılarda ve ana ekranda aynı:
// ortada QR ("Kim kazanır? Bahis yap!" → ?room=ODA#/bahis), büyük geri sayım, yarışçıların arabaları yan yana
// 3D vitrinde (kendi garaj parçalarıyla) ve her biri farklı bir gösteri yapar. Kapanış anı sunucunun
// bettingEndsAt'i: herkesin ekranında aynı saniye. Bahis sayıları ve oranlar sonraki adımda (/bets) gelecek.

const SPACING = 8.5 // arabalar arası (araba ~4.1 geniş; dönen, yuvarlanan komşusuna çarpmasın)
const AHEAD = 34 // vitrin, başlangıç çizgisinin kaç birim önünde
const LIFT = 3.5 // yoldan yükseklik
const ROW_GAP = { z: 11, y: 3.5 } // dikey ekranda ikinci sıra: biraz geride ve yukarıda
const BASE_YAW = Math.PI - 0.45 // burun kameraya dönük, hafif çapraz (3/4 görünüş)

const clamp01 = (v) => Math.min(1, Math.max(0, v))
const ease = (t) => t * t * (3 - 2 * t) // yumuşak başla, yumuşak dur

// Gösteriler: t = saniye, p = döngünün neresi (0 → 1). o: { x, y, yaw, pitch, roll, thrust } (yerel, sıfırdan)
const SHOWS = [
  { period: 4.2, run: (t, p, o) => ((o.yaw = t * 1.5), (o.y = Math.sin(t * 2) * 0.25)) }, // kendi etrafında döner
  {
    period: 3.0, // havada süzülür, iticiler tam güç
    run: (t, p, o) => {
      o.y = 2.4 + Math.sin(t * 2.1) * 0.5
      o.pitch = Math.sin(t * 1.3) * 0.08
      o.thrust = 0.9
    },
  },
  {
    period: 3.4, // barrel roll: döngünün başında tam tur yuvarlanır, sonra bekler
    run: (t, p, o) => {
      const k = ease(clamp01((p - 0.1) / 0.45))
      o.roll = k * Math.PI * 2
      o.y = Math.sin(k * Math.PI) * 1.4
      o.thrust = k > 0 && k < 1 ? 0.35 : 0
    },
  },
  {
    period: 2.6, // drift: sağa sola savrulur, kayarken yatar
    run: (t, p, o) => {
      const s = Math.sin(t * 2.4)
      o.yaw = s * 0.6
      o.x = Math.sin(t * 2.4 - 0.9) * 1.4
      o.roll = -s * 0.12
    },
  },
  {
    period: 3.2, // zıplar ve öne takla atar (havadayken), kalkışta iticiler ateşlenir
    run: (t, p, o) => {
      const air = clamp01(p / 0.42)
      if (p < 0.42) {
        o.y = 24 * air * (1 - air) // tepe 6 birim
        o.pitch = -ease(air) * Math.PI * 2
      }
      o.thrust = p < 0.06 ? 1 : 0
    },
  },
]

// race.js her 'room' olayında sync(room) çağırır; bahis başlayınca router 'betting' ekranına geçer
export function createBetting({ scene, camera, cameraModes, car, smoke, net, router }) {
  const el = document.createElement('div')
  el.className = 'betting'
  el.hidden = true
  el.innerHTML = `
    <div class="betting-top">
      <h2>Kim kazanır? <b>Bahis yap!</b></h2>
      <div class="betting-row">
        <figure class="betting-qr"><img alt="Bahis sayfası için QR kod" width="180" height="180"><figcaption>Telefonla okut</figcaption></figure>
        <div class="betting-clock"><b>30</b><small>sn sonra bahisler kapanır</small></div>
      </div>
    </div>
    <div class="betting-cars"></div>`
  document.body.appendChild(el)
  const clockEl = el.querySelector('.betting-clock b')
  const clockText = el.querySelector('.betting-clock small')
  const labelsEl = el.querySelector('.betting-cars')

  const group = new THREE.Group() // vitrin: başlangıç çizgisinin önünde, pist yönünde
  const cars = new Map() // oyuncu id → { model, thrusters, slot, show, phase, label, odds }
  let room = null
  let active = false
  let time = 0
  let slots = [] // yerel konumlar (n arabaya göre, ekran oranına göre)
  let seatCount = 0 // bahis başındaki araba sayısı: biri koparsa koltuğu boş kalır, diğerleri yerinden oynamaz
  let portrait = null
  const out = { x: 0, y: 0, yaw: 0, pitch: 0, roll: 0, thrust: 0 }
  const still = new THREE.Vector3()
  const right = new THREE.Vector3()
  const v = new THREE.Vector3()
  const viewPos = new THREE.Vector3()
  const viewTarget = new THREE.Vector3()

  // QR: izleyicinin bahis sayfası (aynı oda)
  function renderQr(roomId) {
    const url = new URL(window.location.href)
    url.search = `?room=${encodeURIComponent(roomId)}`
    url.hash = '#/bahis'
    QRCode.toDataURL(url.toString(), { margin: 1, width: 360, color: { dark: '#0b0618', light: '#e6eaff' } })
      .then((data) => {
        const img = el.querySelector('.betting-qr img')
        img.src = data
        img.title = url.toString()
      })
      .catch(() => (el.querySelector('.betting-qr').hidden = true))
  }

  // n araba için yerel konumlar. Yatay ekranda tek sıra; dikeyde 3 + 2 (tek sırada arabalar çok küçülürdü)
  function layout(n) {
    portrait = camera.aspect < 0.8
    const rows = portrait && n > 3 ? [Math.ceil(n / 2), Math.floor(n / 2)] : [n]
    const result = []
    rows.forEach((count, row) => {
      for (let i = 0; i < count; i++) {
        // Yerel +x arabanın SOLU (lookAt kuralı): kameradan bakınca 0. koltuk solda olsun diye ters sıra
        const x = ((count - 1) / 2 - i) * SPACING
        result.push(new THREE.Vector3(x, LIFT + row * ROW_GAP.y, AHEAD + row * ROW_GAP.z))
      }
    })
    return result
  }

  function addCar(player, index) {
    const model = createCarModel(player.color)
    model.rotation.order = 'YXZ' // önce yön (yaw), sonra burun (pitch), sonra yuvarlanma (roll)
    const thrusters = createThrusters(model, scene, smoke)
    applyLoadout(model, player.loadout, { playerColor: player.color, thrusters }) // kendi garaj parçaları
    group.add(model)
    const label = document.createElement('div')
    label.className = 'betting-car'
    label.style.setProperty('--c', toCssColor(player.color))
    label.innerHTML = `
      <span class="betting-odds">bahis yok · oran —</span>
      <span class="betting-name">${player.bot ? '<i>BOT</i> ' : ''}${escapeHtml(player.name)}${player.id === net.id ? ' <small>(sen)</small>' : ''}</span>`
    labelsEl.appendChild(label)
    cars.set(player.id, {
      model,
      thrusters,
      slot: index,
      show: SHOWS[index % SHOWS.length], // her koltuğa farklı gösteri
      phase: index * 0.7 + Math.random() * 0.5, // aynı anda başlamasınlar
      label,
      odds: label.querySelector('.betting-odds'),
      name: label.querySelector('.betting-name'),
    })
  }

  function removeCar(id) {
    const c = cars.get(id)
    if (!c) return
    group.remove(c.model)
    c.label.remove()
    cars.delete(id)
  }

  function show() {
    active = true
    el.hidden = false
    time = 0
    // Vitrin başlangıç çizgisinin önünde: arabanın (henüz kilitli) çerçevesi pistin yönünü verir
    group.position.copy(car.frame.position)
    group.quaternion.copy(car.frame.quaternion)
    scene.add(group)
    const players = (room?.players ?? []).filter((p) => !p.left)
    players.forEach(addCar)
    seatCount = players.length
    slots = layout(seatCount)
    renderQr(room.id)
    cameraModes.setMode('betting')
  }

  function hide() {
    active = false
    el.hidden = true
    for (const id of [...cars.keys()]) removeCar(id)
    scene.remove(group)
  }

  router.register('betting', {
    enter: show,
    leave(next) {
      hide()
      if (next !== 'race') router.reloadTo('landing') // bahisten çıkan: sayfa temiz yüklensin, koltuk boşalsın
    },
  })

  // Her 'room' olayında (race.js): bahiste kopanın arabası kalkar, koltuğu boş kalır (diğerleri yerinde)
  function sync(next) {
    room = next
    if (!active) return
    const present = new Set(next.players.filter((p) => !p.left).map((p) => p.id))
    for (const id of [...cars.keys()]) if (!present.has(id)) removeCar(id)
  }

  // Sonraki adım (/bets): { [oyuncu id]: { count, odds } } → arabanın üstündeki yazı
  function setOdds(byPlayer) {
    for (const [id, c] of cars) {
      const o = byPlayer?.[id]
      c.odds.textContent = o?.count ? `${o.count} bahis · ${o.odds ? `${o.odds.toFixed(2)}x` : '—'}` : 'bahis yok · oran —'
    }
  }

  // Kamera: bütün arabalar ekrana sığsın, ama ekranın alt yarısında kalsınlar (üstte QR ve saat)
  function frameCamera() {
    if (portrait !== camera.aspect < 0.8) slots = layout(seatCount) // telefon döndü
    const widest = Math.max(...slots.map((s) => Math.abs(s.x))) * 2 + 10
    const fov = portrait ? 62 : 48
    const halfH = Math.tan(THREE.MathUtils.degToRad(fov / 2))
    const distance = THREE.MathUtils.clamp(widest / 2 / (halfH * camera.aspect), 24, 120)
    const centerZ = AHEAD + (portrait ? ROW_GAP.z / 2 : 0)
    viewPos.set(0, LIFT + 5, centerZ - distance)
    viewTarget.set(0, LIFT + 1 + distance * halfH * 0.42, centerZ) // hedef yukarıda → arabalar aşağıda görünür
    group.localToWorld(viewPos)
    group.localToWorld(viewTarget)
    cameraModes.setBettingView(viewPos, viewTarget, fov)
  }

  // Her kare (main.js). dt: gerçek zaman
  function update(dt) {
    if (!active) return
    time += dt
    frameCamera()

    // Geri sayım: sunucunun bettingEndsAt'ine göre (herkeste aynı)
    const left = Math.max(0, Math.ceil(((room?.bettingEndsAt ?? 0) - net.serverNow()) / 1000))
    clockEl.textContent = String(left)
    clockText.textContent = left > 0 ? 'sn sonra bahisler kapanır' : 'Bahisler kapandı · yarış başlıyor'
    el.classList.toggle('closing', left > 0 && left <= 5)

    group.updateMatrixWorld()
    right.set(-1, 0, 0).transformDirection(group.matrixWorld) // itici dumanı için "sağ" yön
    for (const c of cars.values()) {
      const base = slots[c.slot] ?? slots[slots.length - 1]
      const t = time + c.phase
      const p = (t % c.show.period) / c.show.period
      Object.assign(out, { x: 0, y: 0, yaw: 0, pitch: 0, roll: 0, thrust: 0 })
      c.show.run(t, p, out)
      c.model.position.set(base.x + out.x, base.y + out.y, base.z)
      c.model.rotation.set(out.pitch, BASE_YAW + out.yaw, out.roll)
      c.model.updateMatrixWorld()
      c.thrusters.update(dt, out.thrust, still, right)

      // Etiketler sabit noktalara bağlı (gösteriyle zıplamasın): üstte bahis, altta isim
      placeLabel(c.odds, v.set(base.x, base.y + 5.2, base.z))
      placeLabel(c.name, v.set(base.x, base.y - 1.6, base.z))
    }
  }

  function placeLabel(node, local) {
    local.applyMatrix4(group.matrixWorld).project(camera) // -1…1 ekran koordinatı
    const visible = local.z < 1
    node.style.visibility = visible ? 'visible' : 'hidden'
    if (visible) node.style.transform = `translate(${((local.x + 1) / 2) * window.innerWidth}px, ${((1 - local.y) / 2) * window.innerHeight}px) translate(-50%, -50%)`
  }

  // İzleyici sayfası (#/bahis, QR'ın açtığı adres). Bahis arayüzü sonraki adımda: şimdilik yer tutucu
  const spectator = document.createElement('div')
  spectator.className = 'bets-page'
  spectator.hidden = true
  spectator.innerHTML = `
    <h1>ROADSTAR</h1>
    <h2>Bahis · oda <b class="bets-room"></b></h2>
    <p>Kim kazanır? Bahis burada yapılacak (yakında).</p>
    <button class="race-start bets-home">Ana sayfa</button>`
  document.body.appendChild(spectator)
  spectator.querySelector('.bets-home').addEventListener('click', () => router.go('landing'))
  router.register('bets', {
    enter() {
      spectator.querySelector('.bets-room').textContent = new URLSearchParams(window.location.search).get('room') ?? 'monad'
      spectator.hidden = false
    },
    leave: () => (spectator.hidden = true),
  })

  return { sync, update, setOdds }
}
