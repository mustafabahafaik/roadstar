import { MONAD_TESTNET } from './chain.js'

// Sağ üst: ağ / cüzdan / canlı işlem akışı. Ortada: yarış sonu özeti. Stiller style.css'te (.tx-*)
const MAX_ROWS = 8 // listede en fazla kaç işlem görünsün

// Dışarıdan gelen yazıyı (RPC hata mesajı) HTML'e koymadan önce zararsızlaştır (XSS'e karşı)
const escapeHtml = (text) =>
  String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

const short = (hex) => (hex ? `${hex.slice(0, 6)}…${hex.slice(-4)}` : '—')
const formatTime = (seconds) => {
  const m = Math.floor(seconds / 60)
  const s = (seconds % 60).toFixed(1).padStart(4, '0')
  return `${m}:${s}`
}

export function createTxHud(getChain) {
  const panel = document.createElement('div')
  panel.className = 'tx-panel'
  panel.innerHTML = `
    <div class="tx-head">
      <span class="tx-dot"></span><b>MONAD TESTNET</b>
      <span class="tx-progress"></span>
    </div>
    <div class="tx-wallet">
      <button class="tx-copy" title="Adresi kopyala"></button>
      <span class="tx-balance"></span>
      <a class="tx-faucet" href="${MONAD_TESTNET.faucet}" target="_blank" rel="noopener">Faucet ↗</a>
    </div>
    <div class="tx-note"></div>
    <ol class="tx-list"></ol>`
  document.body.appendChild(panel)

  const summary = document.createElement('div')
  summary.className = 'tx-summary'
  document.body.appendChild(summary)

  const el = (sel) => panel.querySelector(sel)
  const copyButton = el('.tx-copy')
  let race = null // yarış bitince { time, collected, total, gold }

  copyButton.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(getChain().address)
      copyButton.dataset.copied = '1'
      setTimeout(() => delete copyButton.dataset.copied, 1200)
    } catch {
      // pano izni yoksa adres zaten ekranda yazıyor
    }
  })

  function rowHtml(tx) {
    const link = tx.hash
      ? `<a href="${MONAD_TESTNET.explorer}/tx/${tx.hash}" target="_blank" rel="noopener">${short(tx.hash)}</a>`
      : '<span>—</span>'
    const state =
      tx.status === 'confirmed'
        ? `${tx.ms} ms`
        : tx.status === 'pending'
          ? '…'
          : escapeHtml(tx.error || tx.status)
    return `<li class="tx-${tx.status}"><span class="tx-label">${escapeHtml(tx.label)}</span>${link}<span class="tx-state">${state}</span></li>`
  }

  function renderSummary(chain) {
    if (!race) return
    const s = chain.stats()
    summary.innerHTML = `
      <h2>YARIŞ BİTTİ</h2>
      <p class="tx-sub">Süre <b>${formatTime(race.time)}</b> · Toplanan <b>${race.collected}/${race.total}</b> · Altın <b>${race.gold}</b></p>
      <div class="tx-metric">
        <span>Ortalama onay süresi</span>
        <strong>${s.avgMs ?? '—'}<small> ms</small></strong>
        <em>${s.minMs !== null ? `en hızlı ${s.minMs} ms · en yavaş ${s.maxMs} ms` : 'henüz onaylanan işlem yok'}</em>
      </div>
      <div class="tx-grid">
        <div><b>${s.sent}</b>gönderilen işlem</div>
        <div><b>${s.confirmed}</b>onaylanan</div>
        <div class="${s.failed ? 'bad' : ''}"><b>${s.failed}</b>hatalı</div>
        <div><b>${s.pending}</b>bekleyen</div>
      </div>
      ${s.skipped ? `<p class="tx-sub">${s.skipped} işlem gönderilmedi (bakiye / kontrat yok)</p>` : ''}
      <button class="tx-again">Yeni yarış</button>`
    summary.querySelector('.tx-again').onclick = () => {
      const url = new URL(window.location.href)
      url.searchParams.delete('seed') // sabit tohum verildiyse kaldır: yeni yarış = yeni tohum
      window.location.href = url.toString()
    }
  }

  function render() {
    const chain = getChain()
    if (!chain) return
    const status = chain.lastError ? 'bad' : chain.enabled ? 'ok' : 'warn'
    el('.tx-dot').className = `tx-dot ${status}`
    copyButton.textContent = short(chain.address)
    el('.tx-balance').textContent = chain.balance === null ? '… MON' : `${chain.balance.toFixed(4)} MON`
    el('.tx-note').textContent = chain.lastError
      ? `RPC hatası: ${chain.lastError}`
      : !chain.enabled
        ? 'Kontrat adresi yok: işlemler gönderilmiyor'
        : chain.balance === 0
          ? 'Bakiye 0: adresi kopyala, faucet\'ten MON yükle'
          : ''
    el('.tx-list').innerHTML = chain.txs.slice(-MAX_ROWS).reverse().map(rowHtml).join('')
    renderSummary(chain)
  }

  // Aynı karede gelen birçok değişikliği tek çizime topla
  let scheduled = false
  function refresh() {
    if (scheduled) return
    scheduled = true
    requestAnimationFrame(() => {
      scheduled = false
      render()
    })
  }

  let lastProgress = -1
  function setProgress(ratio) {
    const percent = Math.floor(ratio * 100)
    if (percent === lastProgress) return
    lastProgress = percent
    el('.tx-progress').textContent = `Tur %${percent}`
  }

  function showSummary(raceInfo) {
    race = raceInfo
    summary.classList.add('show')
    refresh()
  }

  return { refresh, setProgress, showSummary }
}
