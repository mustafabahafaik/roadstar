// Haritalar: her biri bir AYAR OBJESİ. world.js bu objeye bakarak sahneyi kurar (gökyüzü, ışık, sis, arka plan),
// pisti boyar; obstacles.js engellerin görünüşünü, car.js yerçekimini buradan alır.
// Parkur (engellerin ve rampaların yeri) seed'den gelir, haritadan bağımsızdır: aynı seed her haritada aynı yerleşim.
// Harita sadece görünüşü ve yerçekimini değiştirir; çarpışma kutuları ve hız sınırları aynı kalır.
//
// Bu dosyada three.js YOK (renkler düz sayı): sunucu ve botlar da okur (harita adı doğrulama, yerçekimi)

export const MAPS = {
  'neon-ocean': {
    id: 'neon-ocean',
    name: 'Neon Okyanus',
    info: 'Gökyüzünde kıvrılan neon pist, altında okyanus',
    ready: true,
    gravity: 1, // yerçekimi çarpanı (car.js GRAVITY × bu)
    sky: { type: 'sky', turbidity: 10, rayleigh: 2, mieCoefficient: 0.005, mieDirectionalG: 0.8 },
    sun: { elevation: 20, azimuth: 135, color: 0xfff2e0, intensity: 1.8 }, // derece; hafif sıcak güneş
    hemisphere: { sky: 0xcfe8ff, ground: 0x0b3a55, intensity: 0.5 }, // üstten gök, alttan deniz rengi
    fog: { color: 0xc4d6e4, density: 0.0006 },
    exposure: 0.5, // tone mapping parlaklığı
    environmentIntensity: 0.25, // gökyüzünün yansıması (ham değerleri çok parlak)
    background: ['water'], // arka plan objeleri (world.js / space.js kurar)
    track: { edgeTop: 0x00f0ff, edgeBottom: 0x00f0ff, asphalt: 0xffffff, steel: 0x2c3039 },
    obstacles: 'neon', // engel görünüşü: neon bloklar + tırlar
  },

  saturn: {
    id: 'saturn',
    name: 'Satürn Yörüngesi',
    info: 'Halkaların arasında düşük yerçekimi',
    ready: true,
    gravity: 0.6, // normalin %60'ı: zıplamalar daha yüksek, havada daha uzun
    // Uzay: tek renk arka plan + ortam haritası için gradyan (üst mor, ufukta turuncu parıltı, alt siyah)
    sky: { type: 'space', background: 0x05030c, top: '#3a1670', horizon: '#ff8a3d', bottom: '#05030c' },
    sun: { elevation: 14, azimuth: 250, color: 0xffc89a, intensity: 2.4 }, // tek yönlü turuncu güneş
    hemisphere: { sky: 0x7a4dff, ground: 0x1a0b2e, intensity: 0.4 }, // mor dolgu ışığı
    fog: { color: 0x0b0618, density: 0.00018 }, // uzak pist mor karanlığa karışsın
    exposure: 0.62,
    environmentIntensity: 0.55,
    background: ['stars', 'nebula', 'saturn', 'asteroids'],
    // Güneşe ~97° açıda: yarısı aydınlık, bantlar görünür (güneşin arkasında kalsa gece tarafını görürdük)
    saturn: { distance: 5600, radius: 1050, direction: [0.49, 0.21, -0.85], tilt: 0.42, spin: 0.015 },
    stars: { count: 7000 },
    asteroids: { count: 420 },
    // Kayan yıldızlar ve meteorlar (meteors.js, SADECE GÖRSEL): aralıklar saniye [en az, en çok]
    meteors: { starEvery: [2, 6], meteorEvery: [15, 25], saturnPassChance: 0.3 },
    track: { edgeTop: 0xb36bff, edgeBottom: 0xff8a2a, asphalt: 0xb7a6ff, steel: 0x1c1430 },
    obstacles: 'asteroid', // kule ve tırlar asteroit olarak çizilir (çarpışma kutuları AYNI)
  },
}

export const DEFAULT_MAP = 'neon-ocean'
export const MAP_LIST = Object.values(MAPS)
// Object.hasOwn: "toString" gibi her objede olan adlar harita sayılmasın
export const isMapId = (id) => typeof id === 'string' && Object.hasOwn(MAPS, id)
export const getMap = (id) => (isMapId(id) ? MAPS[id] : MAPS[DEFAULT_MAP])
