// Grafik kalitesi ayarları. Bilgisayar ısınıyor ya da kapanıyorsa 'dusuk' kullan (varsayılan).
// Yüksek kaliteyi denemek için adresin sonuna ?kalite=yuksek ekle: http://localhost:5173/?kalite=yuksek
const PRESETS = {
  dusuk: {
    pixelRatio: 1, // ekran pikseli başına çizilen piksel (1.5 → 2.25 kat daha fazla iş)
    msaa: 2, // kenar yumuşatma örnek sayısı
    shadowMapSize: 1024, // gölge fotoğrafının çözünürlüğü
    waterResolution: 256, // su yansıması dokusunun çözünürlüğü
    maxFps: 60, // saniyede en fazla kaç kare çizilsin
  },
  yuksek: {
    pixelRatio: 1.5,
    msaa: 4,
    shadowMapSize: 2048,
    waterResolution: 512,
    maxFps: 60,
  },
}

const requested = new URLSearchParams(window.location.search).get('kalite')
export const quality = PRESETS[requested] ?? PRESETS.dusuk // ?? → soldaki yoksa sağdakini kullan
