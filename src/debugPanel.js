import { DEBUG } from './settings.js'

// F3 hata ayıklama paneli: kamera, araba ve ağ durumu. Bir hata tekrar olursa ekran görüntüsü alınsın diye.
// Telefonda F3 yok: adrese ?debug ekleyince panel açık başlar (?debug düşme sınırı çizgilerini de gösterir)
const REFRESH = 0.1 // saniyede 10 kez yaz: her karede DOM'a yazmak boşuna iş
const FAR = 60 // cameraModes.js'teki emniyet kemeri sınırı: üstündeyse ⚠

// getNetStats: rakip başına ağ ölçümleri (remotePlayers.js), getPing: sunucuya gidiş-dönüş (ms)
export function createDebugPanel({ car, camera, cameraModes, gameState, router, isOrbitEnabled, getNetStats, getPing }) {
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
      ...netLines(),
    ].join('\n')
  }

  // Ağ: rakip başına saniyedeki paket, son 2 sn'deki en büyük boşluk, buffer uzunluğu, oynatma gecikmesi
  // ve şu an tahmin (dead reckoning) modunda mı. 20 paket/sn normal; boşluk 50 ms civarı iyi
  function netLines() {
    const players = getNetStats()
    if (!players.length) return []
    const ping = getPing()
    const lines = ['', `AĞ · ping ${ping === null ? '-' : `${ping} ms`}`, 'rakip         pk/sn boşluk buf gecikme']
    for (const p of players) {
      const name = p.name.length > 12 ? `${p.name.slice(0, 11)}…` : p.name.padEnd(12)
      const mode = p.predicting ? `  TAHMİN +${p.predictedMs.toFixed(0)}ms` : p.correction > 0.05 ? `  düzeltme ${p.correction.toFixed(1)}` : ''
      lines.push(`${name} ${String(p.hz).padStart(5)} ${p.maxGap.toFixed(0).padStart(6)} ${String(p.buffer).padStart(3)} ${p.delay.toFixed(0).padStart(7)}${mode}`)
    }
    return lines
  }

  return { update }
}
