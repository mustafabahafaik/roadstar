// Token / skill HUD'u: sol altta panel + ortada kısa bildirim. Stiller style.css'te (.hud-*)
// HTML öğeleriyle yapılır (canvas'a çizmekten kolay); sadece değişen değerler DOM'a yazılır.

const toCss = (hex) => `#${hex.toString(16).padStart(6, '0')}`

export function createItemsHud(types, roomId, totalTokens) {
  const panel = document.createElement('div')
  panel.className = 'hud-panel'

  const slotTypes = types.filter((t) => t.key) // envanterde duranlar: Kalkan, Mıknatıs, Block Rush
  panel.innerHTML = `
    <div class="hud-room">Oda: <b>${roomId}</b></div>
    <div class="hud-fuel">
      <span>İTİCİ</span>
      <div class="hud-bar"><div class="hud-bar-fill"></div></div>
    </div>
    <div class="hud-slots">
      ${slotTypes
        .map(
          (t) => `
        <div class="hud-slot" data-type="${t.id}" style="--c:${toCss(t.color)}">
          <kbd>${t.key}</kbd>
          <span class="hud-slot-name">${t.name}</span>
          <span class="hud-slot-count">×0</span>
          <span class="hud-slot-state"></span>
          <div class="hud-slot-timer"></div>
        </div>`,
        )
        .join('')}
    </div>
    <div class="hud-stats">
      <span style="--c:${toCss(types[4].color)}">◆ Altın <b class="hud-gold">0</b></span>
      <span>Toplanan <b class="hud-collected">0</b>/${totalTokens}</span>
    </div>`
  document.body.appendChild(panel)

  const toastEl = document.createElement('div')
  toastEl.className = 'hud-toast'
  document.body.appendChild(toastEl)

  const fuelFill = panel.querySelector('.hud-bar-fill')
  const goldEl = panel.querySelector('.hud-gold')
  const collectedEl = panel.querySelector('.hud-collected')
  const slots = slotTypes.map((t) => {
    const el = panel.querySelector(`.hud-slot[data-type="${t.id}"]`)
    return {
      type: t,
      el,
      count: el.querySelector('.hud-slot-count'),
      state: el.querySelector('.hud-slot-state'),
      timer: el.querySelector('.hud-slot-timer'),
    }
  })

  // Önceki değerleri sakla: aynıysa DOM'a dokunma
  const last = new Map()
  function set(key, value, apply) {
    if (last.get(key) === value) return
    last.set(key, value)
    apply(value)
  }

  function update({ fuel, inventory, shield, timers, gold, collectedCount }) {
    set('fuel', Math.round(fuel * 100), (v) => {
      fuelFill.style.width = `${v}%`
      fuelFill.classList.toggle('low', v < 25)
    })
    set('gold', gold, (v) => (goldEl.textContent = v))
    set('collected', collectedCount, (v) => (collectedEl.textContent = v))

    for (const s of slots) {
      const id = s.type.id
      set(`count${id}`, inventory[id], (v) => {
        s.count.textContent = `×${v}`
        s.el.classList.toggle('empty', v === 0)
      })
      // Kalkan süresiz: açıkken "AÇIK". Diğerleri: kalan süre + akan çubuk
      const remaining = timers[id] ?? 0
      const active = s.type.duration ? remaining > 0 : shield
      const label = s.type.duration ? (active ? `${remaining.toFixed(1)} sn` : '') : active ? 'AÇIK' : ''
      set(`state${id}`, label, (v) => (s.state.textContent = v))
      set(`active${id}`, active, (v) => s.el.classList.toggle('active', v))
      const progress = s.type.duration ? Math.round((remaining / s.type.duration) * 100) : active ? 100 : 0
      set(`timer${id}`, progress, (v) => (s.timer.style.width = `${v}%`))
    }
  }

  // Ortada kısa bildirim ("+ Kalkan"); animasyonu her seferinde baştan başlat
  function toast(text, color) {
    toastEl.textContent = text
    toastEl.style.setProperty('--c', toCss(color))
    toastEl.classList.remove('show')
    void toastEl.offsetWidth
    toastEl.classList.add('show')
  }

  return { update, toast }
}
