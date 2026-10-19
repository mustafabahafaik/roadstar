import { MONAD_TESTNET } from './chain.js'

// Sağ üst: ağ / cüzdan / canlı işlem akışı. Yarış sonu ekranı race.js'te. Stiller style.css'te (.tx-*)
const MAX_ROWS = 8 // listede en fazla kaç işlem görünsün

// Dışarıdan gelen yazıyı (RPC hata mesajı) HTML'e koymadan önce zararsızlaştır (XSS'e karşı)
const escapeHtml = (text) =>
  String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

const short = (hex) => (hex ? `${hex.slice(0, 6)}…${hex.slice(-4)}` : '—')

export function createTxHud(getChain) {
  const panel = document.createElement('div')
  panel.className = 'tx-panel'
  panel.innerHTML = `
    <div class="tx-head">
      <span class="tx-dot"></span><b>MONAD TESTNET</b>
    </div>
    <div class="tx-wallet">
      <button class="tx-copy" title="Adresi kopyala"></button>
      <span class="tx-balance"></span>
      <a class="tx-faucet" href="${MONAD_TESTNET.faucet}" target="_blank" rel="noopener">Faucet ↗</a>
    </div>
    <div class="tx-note"></div>
    <ol class="tx-list"></ol>`
  document.body.appendChild(panel)

  const el = (sel) => panel.querySelector(sel)
  const copyButton = el('.tx-copy')

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

  return { refresh }
}
