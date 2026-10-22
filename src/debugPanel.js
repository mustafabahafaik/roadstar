import { DEBUG } from './settings.js'

// F3 hata ayıklama paneli: kamera ve araba durumu. Kamera donma hatası tekrar olursa ekran görüntüsü alınsın diye.
// Telefonda F3 yok: adrese ?debug ekleyince panel açık başlar (?debug düşme sınırı çizgilerini de gösterir)
const REFRESH = 0.1 // saniyede 10 kez yaz: her karede DOM'a yazmak boşuna iş
const FAR = 60 // cameraModes.js'teki emniyet kemeri sınırı: üstündeyse ⚠

export function createDebugPanel({ car, camera, cameraModes, gameState, router, isOrbitEnabled }) {
  const el = document.createElement('pre')
  el.className = 'debug-panel'
  el.hidden = !DEBUG
  document.body.appendChild(el)

  window.addEventListener('keydown', (e) => {
    if (e.code !== 'F3') return
    e.preventDefault() // tarayıcının kendi F3'ü ("sayfada bul") açılmasın
    el.hidden = !el.hidden
  })

  let timer = 0
  let lastRespawns = 0
  let sinceRespawn = Infinity // son yeniden doğmadan beri geçen süre (sn)
  const flag = (on) => (on ? 'EVET' : '-')
  const vec = (v) => v.toArray().map((n) => n.toFixed(1).padStart(7)).join('')

  // dt: gerçek zaman. Kapalıyken de respawn sayacını izler (açınca "son ... sn önce" doğru çıksın)
  function update(dt) {
    const { stats } = cameraModes
    if (stats.respawns !== lastRespawns) {
      lastRespawns = stats.respawns
      sinceRespawn = 0
    } else sinceRespawn += dt
    if (el.hidden || (timer -= dt) > 0) return
    timer = REFRESH

    const s = car.state
    // Uzaklığı burada ölç: serbest kamerada (C) cameraModes hiç çalışmaz, onun değeri eskir
    const distance = camera.position.distanceTo(car.model.position)
    // car.state.respawned kamera aynı karede indirir (hep "-" görünürdü): sayı ve süre daha işe yarar
    const respawn = stats.respawns ? `${stats.respawns} kez, son ${sinceRespawn.toFixed(1)} sn önce` : 'yok'
    el.textContent = [
      'KAMERA · F3',
      `ekran      ${router.current} / ${gameState.current}`,
      `mod        ${cameraModes.mode}   blend ${cameraModes.blend.toFixed(2)}`,
      `serbest    ${isOrbitEnabled() ? 'AÇIK ⚠ (C tuşu)' : 'kapalı'}`,
      `uzaklık    ${distance.toFixed(1)}${distance > FAR || !Number.isFinite(distance) ? ' ⚠' : ''}`,
      `crashed    ${flag(s.crashed).padEnd(5)} falling  ${flag(s.falling)}`,
      `onGround   ${flag(s.onGround).padEnd(5)} locked   ${flag(s.locked)}`,
      `respawned  ${respawn}`,
      `kurtarma   ${stats.rescues}${stats.rescues ? ' ⚠ (konsola bak)' : ''}`,
      `kamera  ${vec(camera.position)}`,
      `araba   ${vec(car.model.position)}`,
    ].join('\n')
  }

  return { update }
}
