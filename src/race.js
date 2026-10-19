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

// Yarış akışı: lobi → geri sayım (+ zincirden seed) → yarış → bitiş kapısı (finished) ya da dnf.
// Parkur (engel, rampa, token) seed gelince üretilir: aynı seed → herkes için birebir aynı pist.

const START_TIMEOUT_MS = 15000 // zincir bu sürede seed vermezse zincirsiz yarışa geç
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

// scene, car, chain, gameState: main.js'ten. onCourse(seed, label, race) → items (main.js oluşturur).
// getScore: takla skoru (sonuç ekranı için). showMessage / holdMessage: ekran yazısı
export function createRace({ scene, car, chain, gameState, onCourse, getScore, showMessage, holdMessage }) {
  const race = { id: null, seed: null, onChain: false } // zincirdeki yarış numarası ve parkur seed'i
  let items = null
  let startedAt = 0 // yarışın başladığı an (performance.now, ms)
  let elapsedMs = 0 // geçen süre (bitince donar)
  let finishReason = null

  // --- Oyuncunun durumu: ağa gidecek tek nesne ---
  // Sadece düz sayılar/yazılar (THREE nesnesi yok) → JSON'a çevrilebilir. Dünya koordinatı + quaternion:
  // diğer oyuncular pist hesabı yapmadan arabayı doğrudan çizebilir. Her karede AYNI nesne güncellenir
  const playerState = {
    id: chain.address, // oyuncunun kimliği: burner cüzdan adresi
    x: 0,
    y: 0,
    z: 0,
    rotation: [0, 0, 0, 1], // quaternion [x, y, z, w]: takla dahil gerçek duruş
    speed: 0,
    progress: 0, // 0 → 1: pistin ne kadarı bitti (sıralama bununla yapılır)
    status: gameState.current,
    t: 0, // yarış başından beri ms: alıcı tarafta konumu zamana göre ara değerlemek (interpolation) için
  }

  // --- Bitiş kapısı ---
  const gate = createFinishGate()
  enableShadows(gate)
  scene.add(gate)

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

  // --- Lobi ---
  const lobby = document.createElement('div')
  lobby.className = 'race-lobby'
  lobby.innerHTML = `
    <h1>MONAD RACER</h1>
    <p class="race-sub">${RACE_LENGTH} m · bitiş kapısına en kısa sürede ulaş</p>
    <ul class="race-keys">
      <li><kbd>W</kbd><kbd>S</kbd> gaz / fren</li>
      <li><kbd>A</kbd><kbd>D</kbd> sağa-sola</li>
      <li><kbd>Space</kbd> zıpla (basılı: süzül)</li>
      <li><kbd>Shift</kbd> boost</li>
      <li>havada <kbd>W</kbd><kbd>S</kbd><kbd>Q</kbd><kbd>E</kbd> takla</li>
      <li><kbd>1</kbd><kbd>2</kbd><kbd>3</kbd> kalkan / mıknatıs / rush</li>
    </ul>
    <p class="race-sub">Parkur zincirden gelen seed ile üretilir: kalkansız düşersen DNF</p>
    <button class="race-start">YARIŞA BAŞLA <small>(Enter)</small></button>`
  document.body.appendChild(lobby)

  // --- Sonuç ekranı ---
  const results = document.createElement('div')
  results.className = 'tx-summary race-results'
  document.body.appendChild(results)

  // --- Yarışı başlat: lobi → geri sayım → (seed) → yarış ---
  async function begin() {
    if (!gameState.set(GAME_STATE.COUNTDOWN)) return
    lobby.remove()

    // Geri sayım sürerken startRace zincire gider (Monad'da ~0.5 sn: çoğu zaman geri sayım bitmeden döner)
    const startTx = chain.enabled ? chain.send('startRace', [], 'startRace') : null
    for (const n of ['3', '2', '1']) {
      holdMessage(n)
      await sleep(700)
    }
    if (startTx) {
      if (startTx.status === 'pending') holdMessage('ZİNCİR BEKLENİYOR…')
      try {
        const timeout = sleep(START_TIMEOUT_MS).then(() => Promise.reject(new Error('zaman aşımı')))
        const receipt = await Promise.race([startTx.confirmation, timeout])
        const { raceId, seed } = parseRaceStarted(receipt)
        Object.assign(race, { id: raceId, seed, onChain: true })
      } catch (err) {
        console.warn('startRace olmadı, zincirsiz yarış:', err.message)
      }
    }
    // Zincirsiz: ?seed=123 verilirse hep aynı parkur (deneme için), yoksa rastgele 32 bayt
    if (!race.onChain) race.seed = new URLSearchParams(window.location.search).get('seed') ?? hexlify(randomBytes(32))

    // Parkuru seed'den kur ve sahneye ekle (engeller + rampalar), sonra tokenlar (main.js → items)
    const course = buildCourse(race.seed)
    for (const group of [createObstacles(course.obstacles), createRamps(course.ramps)]) {
      enableShadows(group)
      scene.add(group)
    }
    items = onCourse(race.seed, race.onChain ? `Yarış #${race.id}` : 'Zincirsiz yarış', race)

    car.state.locked = false
    gameState.set(GAME_STATE.RACING)
    startedAt = performance.now()
    showMessage(race.onChain ? 'BAŞLA!' : 'BAŞLA! (zincirsiz)')
  }
  lobby.querySelector('.race-start').addEventListener('click', begin)
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Enter' && gameState.is(GAME_STATE.LOBBY)) begin()
  })

  // --- Bitiş: car.js endRace → main.js → buraya. reason: 'lap' (kapıdan geçti) | 'dnf' ---
  function finish(reason) {
    if (finishReason) return
    finishReason = reason
    elapsedMs = performance.now() - startedAt // süre burada donar
    gameState.set(reason === 'lap' ? GAME_STATE.FINISHED : GAME_STATE.DNF)
    if (reason === 'lap') {
      showMessage('BİTİŞ!')
      if (race.onChain) chain.send('finishRace', [race.id], `finishRace #${race.id}`)
    }
    renderResults()
    results.classList.add('show')
  }

  // Sıralama: önce bitirenler (süreye göre), sonra DNF (ilerlemeye göre).
  // Şimdilik sadece sen varsın; çok oyunculuda diğer oyuncuların playerState'leri buraya eklenecek
  function ranking() {
    const players = [{ name: 'Sen', status: gameState.current, timeMs: elapsedMs, progress: car.progress() }]
    return players.sort((a, b) => {
      if (a.status !== b.status) return a.status === GAME_STATE.FINISHED ? -1 : 1
      return a.status === GAME_STATE.FINISHED ? a.timeMs - b.timeMs : b.progress - a.progress
    })
  }

  function renderResults() {
    const finished = finishReason === 'lap'
    const s = chain.stats()
    const collected = items?.collected ?? []
    const rows = ranking()
      .map((p, i) => {
        const result = p.status === GAME_STATE.FINISHED ? formatRaceTime(p.timeMs) : `DNF · %${Math.floor(p.progress * 100)}`
        return `<li><span>${i + 1}.</span><b>${p.name}</b><span>${result}</span></li>`
      })
      .join('')
    results.innerHTML = `
      <h2>${finished ? 'BİTİRDİN' : 'DNF'}</h2>
      ${finished ? '' : '<p class="tx-sub">Kalkansız düştün: yarışı bitiremedin</p>'}
      <div class="tx-metric">
        <span>Yarış süresi</span>
        <strong>${finished ? formatRaceTime(elapsedMs) : '—'}</strong>
        <em>${RACE_LENGTH} m · ilerleme %${Math.floor(car.progress() * 100)}</em>
      </div>
      <ol class="race-ranking">${rows}</ol>
      <p class="tx-sub">Toplanan <b>${collected.length}/${TOKEN_COUNT}</b> · Altın <b>${collected.filter((c) => c.type === 4).length}</b> · Takla skoru <b>${getScore()}</b></p>
      <div class="tx-grid">
        <div><b>${s.sent}</b>gönderilen işlem</div>
        <div><b>${s.avgMs ?? '—'}${s.avgMs ? '<small> ms</small>' : ''}</b>ort. onay</div>
        <div class="${s.failed ? 'bad' : ''}"><b>${s.failed}</b>hatalı</div>
        <div><b>${s.pending}</b>bekleyen</div>
      </div>
      <button class="tx-again">Yeni yarış</button>`
    results.querySelector('.tx-again').onclick = () => {
      const url = new URL(window.location.href)
      url.searchParams.delete('seed') // sabit seed verildiyse kaldır: yeni yarış = yeni parkur
      window.location.href = url.toString()
    }
  }

  // Ağa gönderilecek hâli: sayıları yuvarla (daha küçük mesaj). Konum 2, dönüş 4 ondalık yeterli
  function toNetwork() {
    const r = (v, d) => Number(v.toFixed(d))
    return JSON.stringify({
      ...playerState,
      x: r(playerState.x, 2),
      y: r(playerState.y, 2),
      z: r(playerState.z, 2),
      rotation: playerState.rotation.map((v) => r(v, 4)),
      speed: r(playerState.speed, 1),
      progress: r(playerState.progress, 4),
    })
  }

  let resultsTimer = 0
  function update(realDt) {
    const racing = gameState.is(GAME_STATE.RACING) || gameState.is(GAME_STATE.FALLING)
    if (racing) elapsedMs = performance.now() - startedAt

    // HUD (sadece değişince DOM'a yaz)
    const percent = Math.floor(car.progress() * 100)
    const width = `${percent}%`
    if (fillEl.style.width !== width) {
      fillEl.style.width = width
      percentEl.textContent = `%${percent}`
    }
    timeEl.textContent = formatRaceTime(elapsedMs)

    // Oyuncu durumu (aynı nesne güncellenir, yeni nesne yok)
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

    // Sonuç ekranı açıkken bekleyen işlemler onaylandıkça yenile (yarım saniyede bir yeter)
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
