import { setAutoForward } from './input.js'

// Dokunmatik kontroller (telefon / tablet). Düğmeler klavyedeki tuşa basılmış gibi sahte keydown / keyup
// olayı gönderir: araba, boost, skill ve takla kodu HİÇ değişmeden dokunmatikte de çalışır.
// Telefonda gaz kendiliğinden basılı (parmaklar yön düğmelerinde); takla düğmeleri sadece havadayken görünür.
//
// Çoklu dokunuş: Pointer Events + setPointerCapture → aynı anda ◀ ve İTİCİ'ye basılabilir; parmak düğmeden
// kaysa da bırakılana kadar basılı sayılır. pointercancel (gelen bildirim vb.) de tuşu bırakır: tuş takılı kalmaz

const BUTTONS = [
  { code: 'KeyA', label: '◀', zone: 'left', size: 'big' },
  { code: 'KeyD', label: '▶', zone: 'left', size: 'big' },
  { code: 'KeyS', label: 'FREN', zone: 'right', size: 'small' },
  { code: 'ShiftLeft', label: 'BOOST', zone: 'right', size: 'mid' },
  { code: 'Space', label: 'İTİCİ', zone: 'right', size: 'big', hint: 'zıpla · basılı: süzül' },
  // Havada: takla ve yuvarlanma (tricks.js)
  { code: 'TouchTrickBack', label: '↺', zone: 'air', title: 'geriye takla' },
  { code: 'TouchTrickForward', label: '↻', zone: 'air', title: 'öne takla' },
  { code: 'KeyQ', label: '⟲', zone: 'air', title: 'sola yuvarlan' },
  { code: 'KeyE', label: '⟳', zone: 'air', title: 'sağa yuvarlan' },
]

const key = (type, code) => window.dispatchEvent(new KeyboardEvent(type, { code, key: code }))

export function createTouchControls({ car, router }) {
  const coarse = window.matchMedia('(pointer: coarse)')
  const syncTouch = () => document.body.classList.toggle('touch', coarse.matches)
  coarse.addEventListener('change', syncTouch)
  syncTouch()

  const el = document.createElement('div')
  el.className = 'touch-controls'
  el.innerHTML = ['left', 'air', 'right']
    .map((zone) => `<div class="touch-zone touch-${zone}"></div>`)
    .join('')
  document.body.appendChild(el)

  for (const b of BUTTONS) {
    const button = document.createElement('button')
    button.className = `touch-button touch-${b.size ?? 'small'}`
    button.innerHTML = b.hint ? `${b.label}<small>${b.hint}</small>` : b.label
    if (b.title) button.title = b.title
    el.querySelector(`.touch-${b.zone}`).appendChild(button)

    const pointers = new Set() // bu düğmeye basan parmaklar (iki parmakla basılıp biri kalkarsa bırakma)
    const down = (e) => {
      e.preventDefault()
      button.setPointerCapture(e.pointerId)
      if (pointers.size === 0) key('keydown', b.code)
      pointers.add(e.pointerId)
      button.classList.add('on')
    }
    const up = (e) => {
      if (!pointers.delete(e.pointerId)) return
      if (pointers.size === 0) {
        key('keyup', b.code)
        button.classList.remove('on')
      }
    }
    button.addEventListener('pointerdown', down)
    button.addEventListener('pointerup', up)
    button.addEventListener('pointercancel', up)
    button.addEventListener('lostpointercapture', up)
    button.addEventListener('contextmenu', (e) => e.preventDefault()) // uzun basınca menü açılmasın
  }

  // Skill kutucukları (HUD'da Kalkan / Mıknatıs / Block Rush): dokununca 1-2-3 tuşu
  document.addEventListener('pointerdown', (e) => {
    const slot = document.body.classList.contains('touch') && e.target.closest?.('.hud-slot')
    const digit = slot?.querySelector('kbd')?.textContent
    if (!digit) return
    key('keydown', `Digit${digit}`)
    key('keyup', `Digit${digit}`)
  })

  // Her kare: yarıştayken gaz kendiliğinden basılı; havadayken takla düğmeleri görünsün
  function update() {
    const racing = document.body.classList.contains('touch') && router.current === 'race'
    setAutoForward(racing && !car.state.locked && !car.state.finished)
    const airborne = racing && !car.state.onGround && !car.state.falling && !car.state.crashed
    if (airborne !== el.classList.contains('airborne')) el.classList.toggle('airborne', airborne)
  }

  return { update }
}
