import { formatEther } from 'ethers'
import { SLOTS, SLOT, PARTS, partById, partsInSlot, DEFAULT_LOADOUT, applyLoadout, swatchCss } from './parts.js'
import { explorerTx } from './chain.js'

// Garaj: araba parçaları (GarageParts, ERC1155). Parçalar SADECE GÖRSEL (parts.js'teki not).
// Karta tıklamak önizlemedir (zincire bir şey gitmez); "Satın Al" → buy, "Tak" → equip işlemi.
// Kamera seçili slotun parçasına yaklaşır (cameraModes 'garage'), fareyle / parmakla çevrilir.
//
// car: bizim arabamız, boost: egzoz alevi. getEquipped / setEquipped: zincirde takılı loadout (main.js tutar)
const mon = (wei) => (wei === 0n ? 'Ücretsiz' : `${Number(formatEther(wei))} MON`)

export function createGarage({ router, cameraModes, chain, car, boost, getEquipped, setEquipped }) {
  let slot = SLOT.PAINT
  let preview = [...DEFAULT_LOADOUT] // ekranda denenen parçalar
  let owned = new Set(DEFAULT_LOADOUT) // varsayılanlar herkesin
  let pending = null // { action, part, tx } — süren işlem
  let status = ''

  const el = document.createElement('div')
  el.className = 'garage'
  el.hidden = true
  el.innerHTML = `
    <header class="garage-head">
      <button class="lobby-back garage-back">← Ana sayfa</button>
      <div>
        <h1>GARAJ</h1>
        <p>Parçalar sadece görsel: hız, boyut ve çarpışma değişmez</p>
      </div>
    </header>
    <aside class="garage-panel"></aside>
    <button class="landing-button landing-play garage-play">YARIŞA GİR</button>`
  document.body.appendChild(el)
  const panel = el.querySelector('.garage-panel')
  el.querySelector('.garage-back').addEventListener('click', () => router.go('landing'))
  el.querySelector('.garage-play').addEventListener('click', () => router.go('lobby'))

  // Önizlemeyi arabaya uygula (bizim araba: alev rengi de değişir)
  const showPreview = () => applyLoadout(car.model, preview, { thrusters: car.thrusters, boost })

  // Alev slotunda araba dururken de alev görünsün (sadece görüntü)
  function setFlamePreview(on) {
    car.thrusters.setPreview(on)
    boost.setFlamePreview(on)
  }

  function selectSlot(next) {
    slot = next
    cameraModes.focusSlot(slot)
    setFlamePreview(slot === SLOT.FLAME)
    render()
  }

  // Zincirden oku: takılı parçalar (loadoutOf) + sahip olunanlar (balanceOfBatch: tek çağrıda hepsinin bakiyesi)
  async function syncFromChain() {
    if (!chain.garageEnabled) return
    try {
      const [ids] = await chain.readGarage('loadoutOf', [chain.address])
      const paid = PARTS.filter((p) => p.price > 0n).map((p) => p.id)
      const [balances] = await chain.readGarage('balanceOfBatch', [paid.map(() => chain.address), paid])
      owned = new Set([...DEFAULT_LOADOUT, ...paid.filter((_, i) => balances[i] > 0n)])
      setEquipped(ids.map(Number))
      preview = [...getEquipped()]
      showPreview()
      status = ''
    } catch (err) {
      status = `Zincir okunamadı: ${err.shortMessage ?? err.message}`
    }
    render()
  }

  // Satın al (buy, fiyat kadar MON) ya da tak (equip). İşlem onaylanınca durumu biz güncelleriz
  // (RPC bazen yeni onaylanan işlemi geç gösterir: hemen tekrar okumak eski durumu getirebilir)
  async function act(action, part) {
    const tx =
      action === 'buy'
        ? chain.send('buy', [part.id], `buy ${part.name}`, { value: part.price })
        : chain.send('equip', [part.id], `equip ${part.name}`)
    pending = { action, part, tx }
    status = ''
    render()
    try {
      await tx.confirmation
      if (action === 'buy') {
        owned.add(part.id)
        status = `${part.name} artık senin. "Tak" ile arabana tak`
      } else {
        const next = [...getEquipped()]
        next[part.slot] = part.id
        setEquipped(next)
        status = `${part.name} takıldı: rakipler de böyle görecek`
      }
    } catch (err) {
      status = `İşlem olmadı: ${err.message}`
    }
    pending = { ...pending, done: true }
    render()
  }

  // Seçili slotun önizlenen parçası için düğme
  function actionHtml(part) {
    const equipped = getEquipped()[part.slot] === part.id
    if (!chain.garageEnabled) return '<button class="race-start" disabled>Kontrat yok · sadece önizleme</button>'
    if (pending && !pending.done) {
      const link = pending.tx.hash ? ` <a href="${explorerTx(pending.tx.hash)}" target="_blank" rel="noopener">işlem ↗</a>` : ''
      return `<button class="race-start" disabled>İŞLEM SÜRÜYOR…</button><small>${link}</small>`
    }
    if (equipped) return '<button class="race-start" disabled>TAKILI ✓</button>'
    if (owned.has(part.id)) return `<button class="race-start" data-action="equip">TAK</button>`
    return `<button class="race-start garage-buy" data-action="buy">SATIN AL · ${mon(part.price)}</button>`
  }

  function render() {
    if (el.hidden) return
    const equipped = getEquipped()
    const previewed = partById.get(preview[slot])
    const paintColor = partById.get(preview[SLOT.PAINT]).color
    const cards = partsInSlot(slot)
      .map((part) => {
        const state = equipped[slot] === part.id ? ['on', 'Takılı'] : owned.has(part.id) ? ['own', 'Sahipsin'] : ['buy', 'Satın Al']
        return `
        <button class="garage-card ${preview[slot] === part.id ? 'selected' : ''}" data-part="${part.id}">
          <span class="garage-swatch" style="background:${swatchCss(part, paintColor)}"></span>
          <b>${part.name}</b>
          <small>${mon(part.price)}</small>
          <em class="garage-chip ${state[0]}">${state[1]}</em>
        </button>`
      })
      .join('')
    const doneLink = pending?.done && pending.tx.hash ? ` <a href="${explorerTx(pending.tx.hash)}" target="_blank" rel="noopener">işlem ↗</a>` : ''
    panel.innerHTML = `
      <nav class="garage-slots">${SLOTS.map((name, i) => `<button class="${i === slot ? 'on' : ''}" data-slot="${i}">${name}</button>`).join('')}</nav>
      <div class="garage-cards">${cards}</div>
      <div class="garage-action">${actionHtml(previewed)}</div>
      <p class="garage-status">${status}${doneLink}</p>`
  }

  // Tek dinleyici (olay delegasyonu): panel her çizimde yenilendiği için düğmelere tek tek bağlanmıyoruz
  panel.addEventListener('click', (e) => {
    const button = e.target.closest('button')
    if (!button) return
    if (button.dataset.slot !== undefined) return selectSlot(Number(button.dataset.slot))
    if (button.dataset.part !== undefined) {
      preview[slot] = Number(button.dataset.part) // önizleme: araba anında değişir, zincire gitmez
      showPreview()
      return render()
    }
    if (button.dataset.action && !(pending && !pending.done)) act(button.dataset.action, partById.get(preview[slot]))
  })

  router.register('garage', {
    enter() {
      el.hidden = false
      preview = [...getEquipped()]
      cameraModes.setMode('garage')
      selectSlot(slot)
      syncFromChain()
    },
    leave(next) {
      el.hidden = true
      setFlamePreview(false)
      applyLoadout(car.model, getEquipped(), { thrusters: car.thrusters, boost }) // önizlemeyi geri al
      if (next !== 'landing') cameraModes.setMode('chase')
    },
  })
}
