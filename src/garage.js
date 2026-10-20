// Garaj: şimdilik boş sayfa (bir sonraki adımda araba rengi, roket izi vb. buraya gelecek).
// Arkada araba vitrinde dönmeye devam eder (kamera giriş sayfasındaki 'showcase' modunda kalır)
export function createGarage({ router, cameraModes }) {
  const el = document.createElement('div')
  el.className = 'garage'
  el.hidden = true
  el.innerHTML = `
    <h1>GARAJ</h1>
    <p>Yakında: araba boyası, roket izi, kazandığın parçalar.</p>
    <div class="landing-actions">
      <button class="landing-button garage-back">← GERİ</button>
      <button class="landing-button garage-play">YARIŞA GİR</button>
    </div>`
  document.body.appendChild(el)
  el.querySelector('.garage-back').addEventListener('click', () => router.go('landing'))
  el.querySelector('.garage-play').addEventListener('click', () => router.go('lobby'))

  router.register('garage', {
    enter() {
      el.hidden = false
      cameraModes.setMode('showcase')
    },
    leave(next) {
      el.hidden = true
      if (next !== 'landing') cameraModes.setMode('chase')
    },
  })
}
