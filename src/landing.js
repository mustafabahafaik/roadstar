import { MONAD_TESTNET } from './chain.js'

// Giriş sayfası: arkada yavaşça dönen araba (kameranın 'showcase' modu), ROADSTAR başlığı, butonlar,
// harita seçimi ve zincir istatistikleri. Cüzdan (adres, bakiye, faucet) sağ üstteki zincir panelinde (txHud.js)

const MAP_KEY = 'monad-racer:map'
const LAST_RACE_KEY = 'monad-racer:last-race'

export const MAPS = [
  { id: 'neon-ocean', name: 'Neon Okyanus', info: 'Gökyüzünde kıvrılan neon pist, altında okyanus', ready: true },
  { id: 'saturn', name: 'Satürn Yörüngesi', info: 'Halkaların arasında düşük yerçekimi', ready: false },
]

// localStorage gizli pencerede / kapalıyken hata fırlatabilir: oyun yine de çalışsın
const load = (key) => {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}
const save = (key, value) => {
  try {
    localStorage.setItem(key, value)
  } catch {
    // kaydedilemedi: sadece bu oturum için geçerli
  }
}

// Son yarışın zincir metrikleri: sonuç ekranı (race.js) kaydeder, giriş sayfası gösterir
export const saveLastRace = (stats) => save(LAST_RACE_KEY, JSON.stringify(stats))
const loadLastRace = () => {
  try {
    return JSON.parse(load(LAST_RACE_KEY))
  } catch {
    return null
  }
}

export function createLanding({ router, chain, cameraModes }) {
  let selected = MAPS.find((m) => m.id === load(MAP_KEY) && m.ready)?.id ?? MAPS[0].id

  const el = document.createElement('div')
  el.className = 'landing'
  el.hidden = true
  el.innerHTML = `
    <div class="landing-hero">
      <p class="landing-kicker"><span class="landing-live"></span>MONAD TESTNET · CANLI</p>
      <h1>ROADSTAR</h1>
      <p class="landing-slogan">Monad üzerinde gerçek zamanlı roket yarışı</p>
      <div class="landing-actions">
        <button class="landing-button landing-play">YARIŞA GİR</button>
        <button class="landing-button landing-garage">GARAJ</button>
      </div>
      <p class="landing-touch" hidden>Yarış klavyeyle oynanır: lobiyi telefondan izleyebilir, bilgisayardan katılabilirsin.</p>
    </div>

    <section class="landing-maps">
      <h2>HARİTA</h2>
      <div class="landing-map-list">
        ${MAPS.map(
          (m) => `
          <button class="landing-map" data-map="${m.id}" ${m.ready ? '' : 'disabled'}>
            <span class="landing-map-art art-${m.id}"></span>
            <b>${m.name}</b>
            <small>${m.info}</small>
            ${m.ready ? '' : '<em>YAKINDA</em>'}
          </button>`,
        ).join('')}
      </div>
    </section>

    <footer class="landing-stats">
      <span><b class="landing-stat-tx">—</b> zincir işlemi gönderdin</span>
      <span><b class="landing-stat-avg">—</b> son yarış ort. onay</span>
      <span>Monad testnet · chain ${MONAD_TESTNET.chainId}</span>
    </footer>`
  document.body.appendChild(el)

  const $ = (sel) => el.querySelector(sel)
  $('.landing-play').addEventListener('click', () => router.go('lobby'))
  $('.landing-garage').addEventListener('click', () => router.go('garage'))
  // Dokunmatik ekran (telefon / tablet): klavye yok → nasıl katılacağını söyle (ekran türü değişirse güncellenir)
  const touch = window.matchMedia('(pointer: coarse)')
  const updateTouchNote = () => ($('.landing-touch').hidden = !touch.matches)
  touch.addEventListener('change', updateTouchNote)
  updateTouchNote()

  // Harita kartları: seçili olan vurgulanır, seçim hatırlanır (şimdilik sadece Neon Okyanus açık)
  const cards = [...el.querySelectorAll('.landing-map')]
  const renderMaps = () => cards.forEach((card) => card.classList.toggle('on', card.dataset.map === selected))
  for (const card of cards) {
    card.addEventListener('click', () => {
      selected = card.dataset.map
      save(MAP_KEY, selected)
      renderMaps()
    })
  }
  renderMaps()

  // İstatistikler: işlem sayısı ZİNCİRDEN (cüzdanın nonce'u = gönderdiği işlem sayısı), onay süresi son yarıştan
  function refreshStats() {
    chain
      .getTxCount()
      .then((count) => ($('.landing-stat-tx').textContent = count))
      .catch(() => ($('.landing-stat-tx').textContent = '—'))
    const last = loadLastRace()
    $('.landing-stat-avg').textContent = last?.avgMs ? `${last.avgMs} ms` : '—'
  }

  router.register('landing', {
    enter() {
      el.hidden = false
      cameraModes.setMode('showcase')
      refreshStats()
    },
    leave(next) {
      el.hidden = true
      if (next !== 'garage') cameraModes.setMode('chase') // garajda da araba vitrinde döner
    },
  })

  return {
    get map() {
      return selected
    },
  }
}
