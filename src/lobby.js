import { RACE_LENGTH } from './track.js'
import { MIN_PLAYERS, MAX_PLAYERS } from '../shared/protocol.js'
import { SERVER_URL } from './net.js'
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

// Açılış ekranı: sunucuya bağlan → takma ad + oda → oyuncu listesi + "Hazırım".
// Yarışı sunucu başlatır ('start' olayını race.js dinler). onSolo: sunucusuz tek kişilik yarış
export function createLobby({ net, onSolo }) {
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
      <button class="race-start lobby-ready">HAZIRIM</button>
      <p class="race-sub">Herkes hazır olunca (en az ${MIN_PLAYERS} kişi) ya da oda dolunca 3 sn sonra başlar</p>
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
  const status = $('.lobby-status')
  nameInput.value = loadName()
  roomInput.value = params.get('room') ?? 'monad'
  let ready = false

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
      const res = await net.join(name, roomInput.value)
      if (!res.ok) throw new Error(res.error)
      saveName(name)
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

  readyButton.addEventListener('click', () => {
    ready = !ready
    net.setReady(ready)
    readyButton.textContent = ready ? 'HAZIR ✓ (vazgeç)' : 'HAZIRIM'
    readyButton.classList.toggle('on', ready)
  })

  $('.lobby-solo').addEventListener('click', onSolo)

  // Oda listesi (sunucunun her 'room' olayında). İsimler başkalarından gelir → escapeHtml şart
  function render(room) {
    $('.lobby-room-name').textContent = room.id
    $('.lobby-count').textContent = `${room.players.length}/${MAX_PLAYERS}`
    $('.lobby-players').innerHTML = room.players
      .map(
        (p) => `
        <li style="--c:${toCssColor(p.color)}">
          <span class="lobby-dot"></span>
          <b>${escapeHtml(p.name)}</b>${p.id === net.id ? ' <small>(sen)</small>' : ''}
          <span class="${p.ready ? 'lobby-ok' : 'lobby-wait'}">${p.ready ? 'HAZIR' : 'bekliyor'}</span>
        </li>`,
      )
      .join('')
  }

  return {
    render,
    remove: () => el.remove(),
  }
}
