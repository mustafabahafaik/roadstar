// Basit ekran yönlendirici (router): oyun aynı anda TEK bir ekrandadır, geçişler kurallıdır.
//
//   landing ⇄ garage ──▶ lobby ──▶ race ──▶ results ──▶ landing (ya da tekrar lobby)
//      └──────────────────▲  ◀── geri
//
// Her ekran { enter(params, önceki), leave(sonraki) } verir: router eskisini kapatır, yenisini açar.
// Adres çubuğundaki # kısmı (hash) ekranı söyler → tarayıcının geri tuşu çalışır, link doğrudan lobiye açabilir.
// Yarış ve sonucun adresi yok: sayfa yenilenince yarışın ortasına dönülemez (seed, süre, zincir işlemleri gider).
// <body data-screen="..."> da ekranın adı olur: CSS hangi HUD'un görüneceğine buna bakarak karar verir.

const ROUTES = { landing: '#/', garage: '#/garaj', lobby: '#/lobi' }
const TRANSITIONS = {
  landing: ['garage', 'lobby'],
  garage: ['landing', 'lobby'],
  lobby: ['landing', 'race'],
  race: ['results'],
  results: ['landing', 'lobby'],
}

// Adresteki hash → ekran adı (tanımadığımız ya da boş hash: giriş sayfası)
const screenFromHash = (hash) => Object.keys(ROUTES).find((name) => ROUTES[name] === hash) ?? 'landing'

export function createRouter() {
  const screens = {} // ad → { enter, leave }
  let current = null
  let currentHash = '' // şu anki ekranın adresi (yarış ve sonuç: girildikleri lobinin adresi)

  function register(name, screen) {
    screens[name] = screen
  }

  // Ekran değiştir. Kurala uymuyorsa (ör. yarıştan girişe) false döner, hiçbir şey olmaz
  function go(name, params = {}) {
    if (name === current) return true
    if (current && !TRANSITIONS[current].includes(name)) return false
    const previous = current
    screens[previous]?.leave?.(name)
    current = name
    document.body.dataset.screen = name
    // Adresi güncelle: pushState sayfayı yenilemez, sadece geçmişe bir kayıt ekler (geri tuşu için)
    const hash = ROUTES[name]
    if (hash) {
      if (window.location.hash !== hash) history.pushState(null, '', hash)
      currentHash = hash
    }
    screens[name]?.enter?.(params, previous)
    return true
  }

  // Geri / ileri tuşu: adresteki ekrana geç. Kurala uymuyorsa (yarıştayken geri) yok say ve adresi geri koy:
  // yeni bir geçmiş kaydı eklenir, böylece bir sonraki geri basışı da oyundan çıkarmaz, yine burada durur
  window.addEventListener('popstate', () => {
    if (!go(screenFromHash(window.location.hash))) history.pushState(null, '', currentHash)
  })

  // Sayfayı yenileyerek başka bir ekrandan başla (yarış sonrası: 3D dünyayı temizlemenin en sağlam yolu)
  function reloadTo(name) {
    history.replaceState(null, '', ROUTES[name] ?? ROUTES.landing)
    window.location.reload()
  }

  return {
    register,
    go,
    reloadTo,
    start: () => go(screenFromHash(window.location.hash)), // ilk ekran: adresteki
    get current() {
      return current
    },
  }
}
