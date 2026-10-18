import * as THREE from 'three'

// Pistin geçeceği kontrol noktaları (x, y, z).
// y = yükseklik: hepsi suyun (y = 0) epey üstünde, inip çıkan bir rota
const points = [
  new THREE.Vector3(150, 40, 0),
  new THREE.Vector3(100, 60, 110),
  new THREE.Vector3(0, 75, 150),
  new THREE.Vector3(-110, 55, 100),
  new THREE.Vector3(-160, 35, 0),
  new THREE.Vector3(-90, 50, -120),
  new THREE.Vector3(0, 70, -90),
  new THREE.Vector3(90, 45, -140),
]

// CatmullRomCurve3: noktaların hepsinden yumuşakça geçen eğri.
// İkinci parametre true → son nokta ilk noktaya bağlanır, pist kapalı tur olur
export const trackCurve = new THREE.CatmullRomCurve3(points, true)

export function createTrack() {
  // TubeGeometry(eğri, uzunluk boyunca parça sayısı, kalınlık, kesit parça sayısı, kapalı mı)
  const geometry = new THREE.TubeGeometry(trackCurve, 400, 2, 12, true)

  // MeshBasicMaterial ışıktan etkilenmez → her açıdan aynı parlak renk, neon hissi
  const material = new THREE.MeshBasicMaterial({ color:  0x00f0ff,toneMapped: false })

  return new THREE.Mesh(geometry, material)
}
