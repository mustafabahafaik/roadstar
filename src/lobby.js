import { formatEther, getAddress } from 'ethers'
import { RACE_LENGTH } from './track.js'
import { MIN_PLAYERS, MAX_PLAYERS, ownershipMessage } from '../shared/protocol.js'
import { SERVER_URL } from './net.js'
import { ENTRY_FEE, parseRoomCreated } from './chain.js'
import { escapeHtml, toCssColor } from './html.js'

const NAME_KEY = 'monad-racer-name' // takma ad bir sonraki açılışta hatırlansın

const loadName = () => {
  try {
    return localStorage.getItem(NAME_KEY) ?? ''
  } catch {
    return '' // gizli pencere / depolama kapalı: sorun değil
  }
}
const saveName = (name) => {
  try {
    localStorage.setItem(NAME_KEY, name)
  } catch {
    // kaydedilemezse bir dahaki sefere yeniden yazılır
  }
}

const mon = (wei) => `${Number(formatEther(wei))} MON`

// Açılış ekranı: sunucuya bağlan → takma ad + oda → oyuncu listesi + (ücretli oda: yatır) + "Hazırım".
// Yarışı sunucu başlatır ('start' olayını race.js dinler). onSolo: sunucusuz tek kişilik yarış
export function createLobby({ net, chain, onSolo }) {
  const params = new URLSearchParams(window.location.search)
  const el = document.createElement('div')
  el.className = 'race-lobby'
  el.innerHTML = `
    <h1>MONAD RACER</h1>
    <p class="race-sub">${RACE_LENGTH} m · ${MAX_PLAYERS} kişiye kadar · bitiş kapısına ilk sen ulaş</p>

    <form class="lobby-join">
      <input class="lobby-name" maxlength="16" placeholder="Takma ad" autocomplete="off" required>
      <input class="lobby-room-input" maxlength="20" placeholder="Oda adı" autocomplete="off">
      <button type="submit" class="race-start" disabled>ODAYA KATIL</button>
    </form>

    <div class="lobby-room" hidden>
      <h2>Oda <b class="lobby-room-name"></b> <small class="lobby-count"></small></h2>
      <ul class="lobby-players"></ul>

      <div class="lobby-pay" hidden>
        <label class="lobby-size">Oda boyutu
          <select>${[2, 3, 4, 5].map((n) => `<option value="${n}">${n} kişi</option>`).join('')}</select>
        </label>
        <button class="race-start lobby-pay-button"></button>
        <p class="race-sub lobby-pay-info"></p>
      </div>

      <button class="race-start lobby-ready">HAZIRIM</button>
      <p class="race-sub lobby-hint"></p>
    </div>

    <p class="lobby-status">Sunucuya bağlanılıyor…</p>
    <button class="lobby-solo">Tek başına yarış</button>

    <ul class="race-keys">
      <li><kbd>W</kbd><kbd>S</kbd> gaz / fren</li>
      <li><kbd>A</kbd><kbd>D</kbd> sağa-sola</li>
      <li><kbd>Space</kbd> zıpla (basılı: süzül)</li>
      <li><kbd>Shift</kbd> boost</li>
      <li>havada <kbd>W</kbd><kbd>S</kbd><kbd>Q</kbd><kbd>E</kbd> takla</li>
      <li><kbd>1</kbd><kbd>2</kbd><kbd>3</kbd> kalkan / mıknatıs / rush</li>
    </ul>`
  document.body.appendChild(el)

  const $ = (sel) => el.querySelector(sel)
  const form = $('.lobby-join')
  const joinButton = form.querySelector('button')
  // Not: form.name formun KENDİ adı (HTMLFormElement.name), input değil → input'ları sınıfla seçiyoruz
  const nameInput = $('.lobby-name')
  const roomInput = $('.lobby-room-input')
  const readyButton = $('.lobby-ready')
  const payBox = $('.lobby-pay')
  const payButton = $('.lobby-pay-button')
  const sizeSelect = $('.lobby-size select')
  const status = $('.lobby-status')
  nameInput.value = loadName()
  roomInput.value = params.get('room') ?? 'monad'
  let ready = false // sunucuya göre hazır mıyım
  let paying = false // ödeme işlemleri sürüyor
  let poolEnabled = false // hem oyunda hem sunucuda RacePool ayarlı mı
  let lastRoom = null

  const setStatus = (text, bad = false) => {
    status.textContent = text
    status.classList.toggle('bad', bad)
  }

  // Bağlan: başarılıysa "Odaya katıl" açılır; sunucu yoksa sadece tek başına oynanır
  net
    .connect()
    .then(() => {
      joinButton.disabled = false
      setStatus(`Sunucuya bağlı · ping ${net.rtt} ms`)
      nameInput.focus()
    })
    .catch(() => setStatus(`Sunucuya ulaşılamadı (${SERVER_URL}). Tek başına yarışabilirsin.`, true))

  form.addEventListener('submit', async (e) => {
    e.preventDefault() // form sayfayı yenilemesin
    const name = nameInput.value.trim()
    if (!name) return
    joinButton.disabled = true
    try {
      // "Bu adres benim" kanıtı: sunucunun verdiği bağlantı numarasını (socket.id) burner anahtarla imzala
      const proof = await chain.signMessage(ownershipMessage(net.id))
      const res = await net.join(name, roomInput.value, { address: chain.address, proof })
      if (!res.ok) throw new Error(res.error)
      saveName(name)
      poolEnabled = chain.poolEnabled && res.poolEnabled
      // Oda adresini çubuğa yaz: sayfayı yenileyince / bağlantıyı paylaşınca aynı oda dolu gelsin
      const url = new URL(window.location.href)
      url.searchParams.set('room', res.room.id)
      history.replaceState(null, '', url)
      form.hidden = true
      $('.lobby-room').hidden = false
      $('.lobby-solo').hidden = true
      render(res.room)
      setStatus(`Sunucuya bağlı · ping ${net.rtt} ms`)
    } catch (err) {
      joinButton.disabled = false
      setStatus(err.message, true)
    }
  })

  // Hazır durumu SUNUCUNUN söylediğidir (ör. oda ücretliye dönünce sıfırlar): buton render'da güncellenir
  readyButton.addEventListener('click', () => net.setReady(!ready))

  // --- Ücret yatır: (gerekirse createRoom) → joinRoom (+ ücret) → sunucu zincirden doğrular ---
  async function pay() {
    paying = true
    render(lastRoom)
    try {
      const claim = await net.claimChainRoom(Number(sizeSelect.value))
      if (!claim.ok) throw new Error(claim.error)
      let roomId = claim.roomId
      if (claim.create) {
        setStatus(`Zincirde ${claim.maxPlayers} kişilik oda kuruluyor…`)
        const tx = chain.send('createRoom', [ENTRY_FEE, claim.maxPlayers], `createRoom ${claim.maxPlayers} kişi`)
        roomId = parseRoomCreated(await tx.confirmation).toString()
      }
      // Ücreti zincirden oku (kurucunun seçtiği). Zaten ödediysem (sayfayı yeniledim) tekrar ödeme
      const [fee, , , , , players] = await chain.readPool('getRoom', [roomId])
      if (!players.map((p) => getAddress(p)).includes(chain.address)) {
        setStatus(`${mon(fee)} yatırılıyor…`)
        await chain.send('joinRoom', [roomId], `joinRoom #${roomId}`, { value: fee }).confirmation
      }
      setStatus('Sunucu ödemeyi zincirden doğruluyor…')
      const res = await net.chainJoined(roomId)
      if (!res.ok) throw new Error(res.error)
      setStatus(`Ücret yatırıldı ✓ (oda #${roomId}). Şimdi hazır olabilirsin`)
    } catch (err) {
      setStatus(`Ödeme olmadı: ${err.message}`, true)
    }
    paying = false
    render(lastRoom)
  }
  payButton.addEventListener('click', pay)

  $('.lobby-solo').addEventListener('click', onSolo)

  // Oda listesi (sunucunun her 'room' olayında). İsimler başkalarından gelir → escapeHtml şart
  function render(room) {
    if (!room) return
    lastRoom = room
    const me = room.players.find((p) => p.id === net.id)
    const paid = room.chain // ücretli oda mı (zincir odası bağlandı mı)
    const capacity = paid ? room.chain.maxPlayers : MAX_PLAYERS
    $('.lobby-room-name').textContent = room.id
    $('.lobby-count').textContent = `${room.players.length}/${capacity}${paid ? ` · ${mon(room.chain.entryFee)} giriş` : ''}`
    $('.lobby-players').innerHTML = room.players
      .map((p) => {
        const state = p.ready ? ['lobby-ok', 'HAZIR'] : paid && !p.paid ? ['lobby-wait', 'ödeme bekleniyor'] : ['lobby-wait', 'bekliyor']
        return `
        <li style="--c:${toCssColor(p.color)}">
          <span class="lobby-dot"></span>
          <b>${escapeHtml(p.name)}</b>${p.id === net.id ? ' <small>(sen)</small>' : ''}
          ${p.paid ? '<span class="lobby-paid">MON ✓</span>' : ''}
          <span class="${state[0]}">${state[1]}</span>
        </li>`
      })
      .join('')

    // Ödeme bölümü: havuz ayarlıysa ve henüz ödemediysem
    payBox.hidden = !poolEnabled || Boolean(me?.paid)
    $('.lobby-size').hidden = Boolean(paid) // boyutu sadece odayı kuran seçer
    payButton.disabled = paying || (room.creating && !paid)
    payButton.textContent = paying
      ? 'İŞLEM SÜRÜYOR…'
      : paid
        ? `${mon(room.chain.entryFee)} YATIR VE KATIL`
        : `${mon(ENTRY_FEE)} YATIR VE ODAYI KUR`
    $('.lobby-pay-info').textContent = paid
      ? `Zincir odası #${room.chain.roomId}: 1. %80 · 2. %15 · %5 hazine`
      : room.creating
        ? 'Biri zincirde odayı kuruyor…'
        : 'Ücretli yarış: para kontratta kilitli kalır, sonuçla dağıtılır'

    // Hazırım: ücretli odada önce ödeme
    const mustPay = paid && !me?.paid
    ready = Boolean(me?.ready)
    readyButton.disabled = mustPay
    readyButton.textContent = mustPay ? 'ÖNCE ÜCRETİ YATIR' : ready ? 'HAZIR ✓ (vazgeç)' : 'HAZIRIM'
    readyButton.classList.toggle('on', ready)
    $('.lobby-hint').textContent = paid
      ? room.autoStartAt
        ? 'Herkes ödedi: hazır olmayan varsa 15 sn içinde yine başlar'
        : `Herkes ödeyip hazır olunca başlar (${capacity} kişi)`
      : `Herkes hazır olunca (en az ${MIN_PLAYERS} kişi) ya da oda dolunca 3 sn sonra başlar`
  }

  return {
    render,
    remove: () => el.remove(),
  }
}
