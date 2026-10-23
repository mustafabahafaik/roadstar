import { formatEther } from 'ethers'
import { BET_AMOUNT } from '../shared/protocol.js'
import { cleanRoom, fetchBets, requestFaucet, reportBet, formatOdds } from './betsApi.js'
import { escapeHtml, toCssColor } from './html.js'

// İzleyici sayfası (#/bahis?room=ODA, bahis ekranındaki QR): telefonda "kim kazanır?" bahsi. Testnet MON, gerçek para yok.
// Cüzdan: tarayıcıdaki burner (chain.js). Bakiye yetmezse sunucunun faucet'i bir kez 0.025 MON yollar.
// Sunucuya 2 sn'de bir /bets sorar (Socket.IO yok): oranlar, geri sayım, yarışta canlı sıralama, sonuç.

const POLL_MS = 2000
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const mon = (wei) => Number(formatEther(BigInt(wei))).toFixed(3).replace(/\.?0+$/, '')

export function createSpectator({ router, chain }) {
  const el = document.createElement('div')
  el.className = 'bets-page'
  el.hidden = true
  el.innerHTML = `
    <header>
      <h1>ROADSTAR</h1>
      <p>Kim kazanır? · oda <b class="sp-room"></b></p>
    </header>
    <p class="sp-wallet">Cüzdan hazırlanıyor…</p>
    <p class="sp-status"></p>
    <div class="sp-cards"></div>
    <p class="sp-bet" hidden></p>
    <p class="sp-result" hidden></p>
    <p class="sp-note">⚠️ Bu sekmeyi kapatma, cüzdanın burada.</p>
    <button class="sp-home">Ana sayfa</button>`
  document.body.appendChild(el)
  const $ = (sel) => el.querySelector(sel)
  const cards = $('.sp-cards')
  $('.sp-home').addEventListener('click', () => router.go('landing'))

  let room = 'monad'
  let data = null // son /bets cevabı
  let offset = 0 // sunucu saati − bizim saatimiz (geri sayım herkeste aynı olsun)
  let walletReady = false
  let myPick = null // kime yatırdım (adres)
  let bet = { state: 'none', ms: null, error: null } // none | sending | done | error
  let paidRefresh = 0 // sonuçtan sonra bakiyeyi birkaç kez yenile (ödeme partiyle gelir)
  let timers = []

  const setWallet = (text, bad = false) => {
    $('.sp-wallet').textContent = text
    $('.sp-wallet').classList.toggle('bad', bad)
  }
  const pickKey = () => `roadstar.bet.${data?.chainRoomId}`

  // Cüzdan: bakiye bir bahse (0.01 + gaz) yetmiyorsa faucet. Gelene kadar bakiyeyi yokla
  async function prepareWallet() {
    setWallet('Cüzdan hazırlanıyor…')
    await chain.whenReady().catch(() => {})
    if (!chain.betEnabled) return setWallet('Bahis kontratı ayarlı değil (VITE_BET_ADDRESS)', true)
    if (chain.canAfford('placeBet', BET_AMOUNT)) return walletOk()
    setWallet('Cüzdanına test MON\'u geliyor…')
    const res = await requestFaucet(chain.address).catch(() => ({ ok: false, error: 'sunucuya ulaşılamadı' }))
    if (!res.ok) return setWallet(`MON alınamadı: ${res.error}`, true)
    for (let i = 0; i < 40; i++) {
      await sleep(1500)
      await chain.refreshBalance().catch(() => {})
      if (chain.canAfford('placeBet', BET_AMOUNT)) return walletOk()
    }
    setWallet('MON gelmedi: sayfayı yenile', true)
  }
  function walletOk() {
    walletReady = true
    setWallet(`Cüzdanın hazır ✓ · ${chain.balance?.toFixed(3)} MON`)
    render()
  }

  async function poll() {
    try {
      const next = await fetchBets(room)
      offset = next.now - Date.now()
      const firstRound = next.chainRoomId && next.chainRoomId !== data?.chainRoomId
      data = next
      if (firstRound) await restorePick()
      if (data.status === 'settled' && paidRefresh < 4) {
        paidRefresh++
        chain.refreshBalance().then(() => walletReady && setWallet(`Cüzdanın hazır ✓ · ${chain.balance?.toFixed(3)} MON`), () => {})
      }
      render()
    } catch {
      $('.sp-status').textContent = 'Sunucuya ulaşılamıyor…'
    }
  }

  // Sayfa yenilendiyse: bu turda kime yatırmıştım? Önce tarayıcı, yoksa zincir (pickOf = kontrattaki sıra + 1)
  async function restorePick() {
    myPick = null
    bet = { state: 'none', ms: null, error: null }
    try {
      myPick = localStorage.getItem(pickKey())
    } catch {}
    if (!myPick && chain.betEnabled) {
      const [pick] = await chain.readBet('pickOf', [BigInt(data.chainRoomId), chain.address]).catch(() => [0n])
      myPick = data.racers.find((r) => r.index === Number(pick) - 1)?.address ?? null
    }
    if (myPick) bet.state = 'done'
  }

  async function placeBet(racer) {
    if (!walletReady || data?.status !== 'open' || myPick || bet.state === 'sending') return
    myPick = racer.address
    bet = { state: 'sending', ms: null, error: null }
    render()
    const tx = chain.send('placeBet', [BigInt(data.chainRoomId), racer.address], `bahis: ${racer.name}`, { value: BET_AMOUNT })
    try {
      await tx.confirmation
      bet = { state: 'done', ms: tx.ms, error: null }
      try {
        localStorage.setItem(pickKey(), racer.address)
      } catch {}
      reportBet(room, tx.hash, tx.ms) // ana ekrandaki "ortalama onay süresi" için
      chain.refreshBalance().catch(() => {})
    } catch {
      bet = { state: 'error', ms: null, error: tx.error ?? 'işlem olmadı' }
      myPick = null
    }
    render()
  }

  // --- Çizim ---
  function statusText() {
    const left = Math.max(0, Math.ceil((data.bettingEndsAt - (Date.now() + offset)) / 1000))
    switch (data.status) {
      case 'disabled':
        return 'Bu sunucuda bahis kapalı'
      case 'free':
        return 'Bu oda ücretsiz: bahis sadece ücretli odada açılır'
      case 'waiting':
        return 'Yarışçılar hazırlanıyor… Herkes hazır olunca 30 sn bahis açılır'
      case 'opening':
        return 'Bahisler açılıyor…'
      case 'open':
        return left > 0 ? `Bahisler ${left} sn sonra kapanır` : 'Bahisler kapanıyor…'
      case 'closed':
        return data.raceStatus === 'racing' ? 'Bahisler kapandı · yarış sürüyor' : 'Bahisler kapandı'
      default:
        return 'Yarış bitti'
    }
  }

  function render() {
    if (!data) return
    el.classList.toggle('open', data.status === 'open')
    $('.sp-status').textContent = statusText()
    const racing = data.status === 'closed' || data.status === 'settled'
    // Yarışta canlı sıralama: ilerlemeye göre (bitirenler önde)
    const list = racing ? [...data.racers].sort((a, b) => (b.status === 'finished') - (a.status === 'finished') || b.progress - a.progress) : data.racers
    const canBet = walletReady && data.status === 'open' && !myPick
    cards.innerHTML = list
      .map((r) => {
        const mine = myPick && r.address?.toLowerCase() === myPick.toLowerCase()
        const won = data.winner && r.address === data.winner
        const progress = Math.floor((r.status === 'finished' ? 1 : r.progress ?? 0) * 100)
        return `
        <button class="sp-card${mine ? ' mine' : ''}${won ? ' won' : ''}" style="--c:${toCssColor(r.color)}" data-address="${r.address ?? ''}" ${canBet && r.address ? '' : 'disabled'}>
          <span class="sp-name">${escapeHtml(r.name)}${mine ? ' <small>✓ senin bahsin</small>' : ''}</span>
          <span class="sp-odds">${formatOdds(r.odds)}</span>
          <span class="sp-count">${r.bets ?? 0} bahis</span>
          ${racing ? `<span class="sp-progress"><i style="width:${progress}%"></i></span><span class="sp-percent">${won ? '🏆' : r.status === 'finished' ? '🏁' : `%${progress}`}</span>` : ''}
        </button>`
      })
      .join('')

    const betLine = $('.sp-bet')
    betLine.hidden = bet.state === 'none'
    betLine.classList.toggle('bad', bet.state === 'error')
    betLine.textContent =
      bet.state === 'sending' ? 'Bahsin gönderiliyor…' : bet.state === 'error' ? `Bahis olmadı: ${bet.error}` : bet.ms !== null ? `Bahsin zincirde ✓ ${(bet.ms / 1000).toFixed(1)} sn` : 'Bahsin zincirde ✓'

    const result = $('.sp-result')
    result.hidden = data.status !== 'settled' || !myPick
    if (!result.hidden) {
      const won = data.refundAll || data.winner?.toLowerCase() === myPick.toLowerCase()
      result.classList.toggle('won', won)
      result.textContent = data.refundAll
        ? `Kimse bilemedi: ${mon(data.betAmount)} MON iade edildi`
        : won
          ? `Kazandın! +${mon(data.payoutPerWinner)} MON cüzdanına geldi`
          : 'Kaybettin. Bir dahaki yarışa!'
    }
  }
  cards.addEventListener('click', (e) => {
    const address = e.target.closest('.sp-card')?.dataset.address
    const racer = data?.racers.find((r) => r.address === address)
    if (racer) placeBet(racer)
  })

  router.register('bets', {
    enter() {
      room = cleanRoom(new URLSearchParams(window.location.search).get('room'))
      $('.sp-room').textContent = room
      el.hidden = false
      prepareWallet()
      poll()
      timers = [setInterval(poll, POLL_MS), setInterval(() => data && ($('.sp-status').textContent = statusText()), 250)]
    },
    leave() {
      el.hidden = true
      timers.forEach(clearInterval)
    },
  })
}
