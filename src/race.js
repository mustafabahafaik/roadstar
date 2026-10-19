import * as THREE from 'three'
import { hexlify, randomBytes } from 'ethers'
import { trackCurve, TRACK_WIDTH, RACE_LENGTH } from './track.js'
import { buildCourse } from './course.js'
import { createObstacles } from './obstacles.js'
import { createRamps } from './ramps.js'
import { parseRaceStarted } from './chain.js'
import { GAME_STATE } from './gameState.js'
import { TOKEN_COUNT } from './items.js'
import { neon } from './neon.js'
import { COUNTDOWN_MS, SEND_RATE, rankPlayers } from '../shared/protocol.js'
import { createLobby } from './lobby.js'
import { createRemotePlayers } from './remotePlayers.js'
import { escapeHtml, toCssColor } from './html.js'

// Yarış akışı: lobi → geri sayım → yarış → bitiş kapısı (finished) ya da dnf.
// Çok oyunculu: seed'i ve başlangıç ANINI sunucu verir (herkes aynı parkurda, aynı anda başlar).
// Tek başına: seed yerelde üretilir. Engeller + rampalar seed'den; tokenlar zincirin kişisel seed'inden.

const START_TIMEOUT_MS = 15000 // zincir bu sürede token seed'i vermezse tokenlar parkur seed'inden
const STANDINGS_EVERY = 0.2 // canlı sıralama kaç saniyede bir yenilensin
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// 00:42.318 biçimi (dakika:saniye.milisaniye)
export function formatRaceTime(ms) {
  const minutes = Math.floor(ms / 60000)
  const seconds = Math.floor((ms % 60000) / 1000)
  const millis = Math.floor(ms % 1000)
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`
}

// --- Bitiş kapısı: u = 0'da (başlangıç ve bitiş aynı nokta), parlayan büyük bir kemer ---
function createFinishBanner() {
  const canvas = document.createElement('canvas')
  canvas.width = 512
  canvas.height = 64
  const ctx = canvas.getContext('2d')
  for (let x = 0; x < 512; x += 16) {
    for (let y = 0; y < 64; y += 16) {
      ctx.fillStyle = (x + y) % 32 === 0 ? '#ffffff' : '#111111' // dama deseni
      ctx.fillRect(x, y, 16, 16)
    }
  }
  ctx.fillStyle = 'rgba(10,6,24,0.85)'
  ctx.fillRect(150, 6, 212, 52)
  ctx.fillStyle = '#ff3bd6'
  ctx.font = '900 40px system-ui, sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText('BİTİŞ', 256, 34)
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

function createFinishGate() {
  const gate = new THREE.Group()
  const span = TRACK_WIDTH + 4 // kemerin iç genişliği
  const height = 13
  const metal = new THREE.MeshStandardMaterial({ color: 0x1b1530, metalness: 0.7, roughness: 0.35 })
  const banner = createFinishBanner()
  const bannerMaterial = new THREE.MeshStandardMaterial({ map: banner, emissiveMap: banner, emissive: 0xffffff, emissiveIntensity: 0.8 })
  const pink = neon(0xff3bd6, 3)
  const cyan = neon(0x00f0ff, 3)

  for (const side of [-1, 1]) {
    const pillar = new THREE.Mesh(new THREE.BoxGeometry(1.4, height + 1.4, 1.4), metal)
    pillar.position.set(side * (span / 2 + 0.7), (height - 1.4) / 2, 0)
    gate.add(pillar)
    const strip = new THREE.Mesh(new THREE.BoxGeometry(0.2, height, 0.2), cyan) // sütunun iç kenarında neon
    strip.position.set(side * (span / 2 + 0.05), height / 2, 0.75)
    gate.add(strip)
  }
  const beam = new THREE.Mesh(new THREE.BoxGeometry(span + 2.8, 2.4, 1.4), [metal, metal, metal, metal, bannerMaterial, bannerMaterial])
  beam.position.y = height
  gate.add(beam)
  const glow = new THREE.Mesh(new THREE.BoxGeometry(span, 0.2, 0.2), pink) // kirişin altında pembe çizgi
  glow.position.set(0, height - 1.3, 0.75)
  gate.add(glow)
  // Yolda dama desenli çizgi
  const line = new THREE.Mesh(new THREE.PlaneGeometry(TRACK_WIDTH, 2.2), new THREE.MeshBasicMaterial({ map: banner }))
  line.rotation.x = -Math.PI / 2
  line.position.y = 0.08 // yolun biraz üstünde: asfaltla titreşmesin (z-fighting)
  gate.add(line)

  // u = 0'a koy, pistin gidiş yönüne çevir
  gate.position.copy(trackCurve.getPointAt(0))
  gate.lookAt(gate.position.clone().add(trackCurve.getTangentAt(0)))
  return gate
}

// Gölge: her mesh hem gölge düşürsün hem alsın (neonlar hariç)
function enableShadows(group) {
  group.traverse((obj) => {
    if (!obj.isMesh || obj.material.userData?.bloom) return
    obj.castShadow = true
    obj.receiveShadow = true
  })
}

// scene, car, chain, gameState, net: main.js'ten. onCourse(seed, label, race) → items (main.js oluşturur).
// getScore: takla skoru (sonuç ekranı için). showMessage / holdMessage: ekran yazısı
export function createRace({ scene, car, chain, gameState, net, onCourse, getScore, showMessage, holdMessage }) {
  const race = { id: null, seed: null, onChain: false } // zincirdeki yarış numarası ve token seed'i
  let items = null
  let multiplayer = false
  let room = null // sunucunun son gönderdiği oda bilgisi (isimler, renkler, durumlar, bitiş süreleri)
  let finalStandings = null // sunucunun yarış sonu sıralaması ('results')
  let startAt = 0 // yarışın başlama anı (SUNUCU saatiyle, ms). Herkes için aynı sayı
  let elapsedMs = 0 // geçen süre (bitince donar)
  let finishReason = null
  let lastCount = null // geri sayımda en son gösterilen sayı
  let sendTimer = 0
  let standingsTimer = 0
  let resultsTimer = 0

  // --- Oyuncunun durumu: ağa giden tek nesne ---
  // Sadece düz sayılar/yazılar (THREE nesnesi yok) → JSON'a çevrilebilir. Dünya koordinatı + quaternion:
  // diğer oyuncular pist hesabı yapmadan arabayı doğrudan çizebilir. Her karede AYNI nesne güncellenir
  const playerState = {
    x: 0,
    y: 0,
    z: 0,
    rotation: [0, 0, 0, 1], // quaternion [x, y, z, w]: takla dahil gerçek duruş
    speed: 0,
    progress: 0, // 0 → 1: pistin ne kadarı bitti (sıralama bununla yapılır)
    status: gameState.current,
    t: 0, // yarış başından beri ms
  }

  // --- Bitiş kapısı ---
  const gate = createFinishGate()
  enableShadows(gate)
  scene.add(gate)

  // --- Rakip arabalar (remotePlayers.js): 100 ms geriden interpolasyon ---
  const remote = createRemotePlayers(scene, net)

  // --- HUD: üst ortada ilerleme çubuğu + süre ---
  const progressHud = document.createElement('div')
  progressHud.className = 'race-progress'
  progressHud.innerHTML = `
    <span class="race-time">00:00.000</span>
    <div class="race-bar"><div class="race-fill"></div><span class="race-flag">🏁</span></div>
    <span class="race-percent">%0</span>`
  document.body.appendChild(progressHud)
  const fillEl = progressHud.querySelector('.race-fill')
  const percentEl = progressHud.querySelector('.race-percent')
  const timeEl = progressHud.querySelector('.race-time')

  // --- HUD: sol üstte canlı sıralama (sadece çok oyunculu) ---
  const standingsHud = document.createElement('div')
  standingsHud.className = 'race-standings'
  standingsHud.hidden = true
  document.body.appendChild(standingsHud)

  // --- Sonuç ekranı ---
  const results = document.createElement('div')
  results.className = 'tx-summary race-results'
  document.body.appendChild(results)

  // --- Lobi (lobby.js) ---
  const lobby = createLobby({
    net,
    onSolo: () =>
      beginCountdown({
        // ?seed=123 verilirse hep aynı parkur (deneme için), yoksa rastgele 32 bayt
        seed: new URLSearchParams(window.location.search).get('seed') ?? hexlify(randomBytes(32)),
        startAt: net.serverNow() + COUNTDOWN_MS,
        multiplayer: false,
      }),
  })

  // --- Sunucu olayları ---
  net.on('room', (r) => {
    room = r
    lobby.render(r)
    remote.syncRoom(r.players, net.id) // yeni gelene araba ekle, gideni çıkar
  })
  net.on('start', ({ seed, startAt: at }) => beginCountdown({ seed, startAt: at, multiplayer: true }))
  net.on('snapshot', (snapshot) => remote.onSnapshot(snapshot))
  net.on('results', ({ standings }) => {
    finalStandings = standings
    if (finishReason) renderResults()
  })
  net.on('disconnect', () => {
    if (multiplayer && !finishReason) showMessage('SUNUCU BAĞLANTISI KOPTU')
  })

  // --- Geri sayım: parkuru kur, startAt anını bekle (update içinde) ---
  function beginCountdown({ seed, startAt: at, multiplayer: mp }) {
    if (!gameState.set(GAME_STATE.COUNTDOWN)) return
    lobby.remove()
    multiplayer = mp
    startAt = at
    standingsHud.hidden = !multiplayer

    // Parkuru seed'den kur ve sahneye ekle (engeller + rampalar)
    const course = buildCourse(seed)
    for (const group of [createObstacles(course.obstacles), createRamps(course.ramps)]) {
      enableShadows(group)
      scene.add(group)
    }
    setupTokens(seed) // beklemeden: yarış zinciri değil, sunucunun saatini bekler
  }

  // Tokenlar: zincir varsa startRace'in kişisel seed'i (kontrat türünü bu seed'le doğrular),
  // yoksa / gecikirse parkur seed'i. Zincir geç cevap verirse tokenlar yarış başladıktan sonra belirir
  async function setupTokens(courseSeed) {
    if (chain.enabled) {
      try {
        const startTx = chain.send('startRace', [], 'startRace')
        const timeout = sleep(START_TIMEOUT_MS).then(() => Promise.reject(new Error('zaman aşımı')))
        const receipt = await Promise.race([startTx.confirmation, timeout])
        const { raceId, seed } = parseRaceStarted(receipt)
        Object.assign(race, { id: raceId, seed, onChain: true })
      } catch (err) {
        console.warn('startRace olmadı, tokenlar zincirsiz:', err.message)
      }
    }
    if (!race.onChain) race.seed = courseSeed
    const label = race.onChain ? `Yarış #${race.id}` : multiplayer ? `Oda ${room?.id ?? ''}` : 'Zincirsiz yarış'
    items = onCourse(race.seed, label, race)
  }

  // --- Bitiş: car.js endRace → main.js → buraya. reason: 'lap' (kapıdan geçti) | 'dnf' ---
  function finish(reason) {
    if (finishReason) return
    finishReason = reason
    elapsedMs = net.serverNow() - startAt // süre burada donar
    gameState.set(reason === 'lap' ? GAME_STATE.FINISHED : GAME_STATE.DNF)
    refreshPlayerState()
    if (reason === 'lap') {
      showMessage('BİTİŞ!')
      if (race.onChain) chain.send('finishRace', [race.id], `finishRace #${race.id}`)
    }
    if (multiplayer) {
      if (reason === 'lap') net.finish(toNetwork()) // son durum + "bitirdim": süreyi sunucu ölçer
      else net.dnf()
    }
    renderResults()
    results.classList.add('show')
  }

  // Bizim durumumuz sunucunun diliyle: 'finished' | 'dnf' | 'racing'
  const selfStatus = () =>
    gameState.is(GAME_STATE.FINISHED) ? 'finished' : gameState.is(GAME_STATE.DNF) ? 'dnf' : 'racing'

  // Sıralama: çok oyunculuda odadaki herkes (rakiplerin ilerlemesi son gelen durumlardan,
  // bizimki doğrudan arabadan). Bitiş süresini sunucu ölçer; o gelene kadar kendi ölçümümüz
  function standings() {
    if (!multiplayer || !room) {
      return [{ id: 'me', name: 'Sen', color: 0xffffff, status: selfStatus(), progress: car.progress(), finishMs: elapsedMs, self: true }]
    }
    const source = finalStandings ?? room.players
    return rankPlayers(
      source.map((p) => {
        if (p.id === net.id) {
          const status = finalStandings ? p.status : selfStatus()
          return { ...p, status, progress: car.progress(), finishMs: p.finishMs ?? elapsedMs, self: true }
        }
        const progress = p.status === 'finished' ? 1 : Math.max(p.progress ?? 0, remote.progressOf(p.id))
        return { ...p, progress }
      }),
    )
  }

  const resultText = (p) =>
    p.status === 'finished'
      ? formatRaceTime(p.finishMs)
      : p.status === 'dnf'
        ? `DNF · %${Math.floor(p.progress * 100)}`
        : `%${Math.floor(p.progress * 100)}`

  function renderStandings() {
    const ping = net.rtt === null ? '' : `ping ${net.rtt} ms`
    const rows = standings()
      .map(
        (p, i) => `
        <li class="${p.self ? 'me' : ''}" style="--c:${toCssColor(p.color)}">
          <span>${i + 1}</span><b>${escapeHtml(p.name)}</b><span>${resultText(p)}</span>
        </li>`,
      )
      .join('')
    standingsHud.innerHTML = `<div class="race-standings-head"><b>SIRALAMA</b><span>${ping}</span></div><ol>${rows}</ol>`
  }

  function renderResults() {
    const finished = finishReason === 'lap'
    const s = chain.stats()
    const collected = items?.collected ?? []
    const list = standings()
    const me = list.find((p) => p.self)
    const place = list.indexOf(me) + 1
    const rows = list
      .map(
        (p, i) => `
        <li class="${p.self ? 'me' : ''}" style="--c:${toCssColor(p.color)}">
          <span>${i + 1}.</span><b>${escapeHtml(p.name)}${p.left ? ' <small>(koptu)</small>' : ''}</b><span>${resultText(p)}</span>
        </li>`,
      )
      .join('')
    const waiting = multiplayer && !finalStandings ? '<p class="tx-sub">Diğer oyuncular bekleniyor…</p>' : ''
    results.innerHTML = `
      <h2>${finished ? 'BİTİRDİN' : 'DNF'}</h2>
      ${finished ? '' : '<p class="tx-sub">Kalkansız düştün: yarışı bitiremedin</p>'}
      <div class="tx-metric">
        <span>${multiplayer ? `Sıralaman ${place}/${list.length} · ` : ''}Yarış süresi</span>
        <strong>${finished ? formatRaceTime(me.finishMs) : '—'}</strong>
        <em>${RACE_LENGTH} m · ilerleme %${Math.floor(car.progress() * 100)}</em>
      </div>
      <ol class="race-ranking">${rows}</ol>
      ${waiting}
      <p class="tx-sub">Toplanan <b>${collected.length}/${TOKEN_COUNT}</b> · Altın <b>${collected.filter((c) => c.type === 4).length}</b> · Takla skoru <b>${getScore()}</b></p>
      <div class="tx-grid">
        <div><b>${s.sent}</b>gönderilen işlem</div>
        <div><b>${s.avgMs ?? '—'}${s.avgMs ? '<small> ms</small>' : ''}</b>ort. onay</div>
        <div class="${s.failed ? 'bad' : ''}"><b>${s.failed}</b>hatalı</div>
        <div><b>${s.pending}</b>bekleyen</div>
      </div>
      <button class="tx-again">${multiplayer ? 'Lobiye dön' : 'Yeni yarış'}</button>`
    results.querySelector('.tx-again').onclick = () => {
      const url = new URL(window.location.href)
      url.searchParams.delete('seed') // sabit seed verildiyse kaldır: yeni yarış = yeni parkur (oda kalır)
      window.location.href = url.toString()
    }
  }

  // Ağa gönderilecek hâli: sayıları yuvarla (daha küçük mesaj). Konum 2, dönüş 4 ondalık yeterli
  function toNetwork() {
    const r = (v, d) => Number(v.toFixed(d))
    return {
      ...playerState,
      x: r(playerState.x, 2),
      y: r(playerState.y, 2),
      z: r(playerState.z, 2),
      rotation: playerState.rotation.map((v) => r(v, 4)),
      speed: r(playerState.speed, 1),
      progress: r(playerState.progress, 4),
    }
  }

  // Oyuncu durumu (aynı nesne güncellenir, yeni nesne yok)
  function refreshPlayerState() {
    const p = car.model.position
    const q = car.model.quaternion
    playerState.x = p.x
    playerState.y = p.y
    playerState.z = p.z
    playerState.rotation[0] = q.x
    playerState.rotation[1] = q.y
    playerState.rotation[2] = q.z
    playerState.rotation[3] = q.w
    playerState.speed = car.state.speed
    playerState.progress = car.progress()
    playerState.status = gameState.current
    playerState.t = Math.round(elapsedMs)
  }

  function update(realDt) {
    const now = net.serverNow()

    // Geri sayım: sunucunun verdiği ANA göre (herkesin ekranında aynı anda 3-2-1-BAŞLA)
    if (gameState.is(GAME_STATE.COUNTDOWN)) {
      const left = startAt - now
      if (left > 0) {
        const n = Math.ceil(left / 1000)
        if (n !== lastCount) holdMessage(String((lastCount = n)))
      } else {
        car.state.locked = false
        gameState.set(GAME_STATE.RACING)
        showMessage(multiplayer ? 'BAŞLA!' : 'BAŞLA! (tek başına)')
      }
    }

    const racing = gameState.is(GAME_STATE.RACING) || gameState.is(GAME_STATE.FALLING)
    if (racing) elapsedMs = now - startAt

    // HUD (sadece değişince DOM'a yaz)
    const percent = Math.floor(car.progress() * 100)
    const width = `${percent}%`
    if (fillEl.style.width !== width) {
      fillEl.style.width = width
      percentEl.textContent = `%${percent}`
    }
    timeEl.textContent = formatRaceTime(Math.max(0, elapsedMs))

    refreshPlayerState()

    if (multiplayer) {
      // Saniyede SEND_RATE (15) kez durumu sunucuya gönder
      if (racing && (sendTimer -= realDt) <= 0) {
        sendTimer = Math.max(0, sendTimer + 1 / SEND_RATE)
        net.sendState(toNetwork())
      }
      remote.update()
      if ((standingsTimer -= realDt) <= 0) {
        standingsTimer = STANDINGS_EVERY
        renderStandings()
      }
    }

    // Sonuç ekranı açıkken bekleyen işlemler / rakipler değiştikçe yenile (yarım saniyede bir yeter)
    if (finishReason) {
      resultsTimer -= realDt
      if (resultsTimer <= 0) {
        resultsTimer = 0.5
        renderResults()
      }
    }
  }

  return { race, update, finish, playerState, toNetwork, get items() { return items } }
}
