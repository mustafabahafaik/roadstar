import * as THREE from 'three'

// --- Yardımcı: tablo değerleri arasını yumuşakça doldur (Hermite interpolasyonu) ---
// keys: [[z, değer], ...] — z sırasına göre. Her noktada eğim komşu noktalardan hesaplanır
export function smoothTable(keys) {
  const n = keys.length
  const slope = (i) => {
    const a = keys[Math.max(0, i - 1)]
    const b = keys[Math.min(n - 1, i + 1)]
    return (b[1] - a[1]) / (b[0] - a[0])
  }
  return (z) => {
    if (z <= keys[0][0]) return keys[0][1]
    if (z >= keys[n - 1][0]) return keys[n - 1][1]
    let i = 0
    while (z > keys[i + 1][0]) i++
    const [z1, v1] = keys[i]
    const [z2, v2] = keys[i + 1]
    const h = z2 - z1
    const t = (z - z1) / h
    const t2 = t * t
    const t3 = t2 * t
    return (
      (2 * t3 - 3 * t2 + 1) * v1 +
      (t3 - 2 * t2 + t) * h * slope(i) +
      (-2 * t3 + 3 * t2) * v2 +
      (t3 - t2) * h * slope(i + 1)
    )
  }
}

// --- Loft: arka arkaya dizilmiş kesitlerden (halka) yüzey örer ---
// section(z) → { top, bottom, halfWidth, powerTop, powerBottom, tumble }
// classify(x, y, z) (isteğe bağlı) → her üçgenin hangi malzemeyi kullanacağı (0, 1, 2...).
//   Örneğin tırda: cam bölgesindeki üçgenler 1 (cam), alttakiler 2 (siyah tampon), gerisi 0 (boya)
// ringAngles(z, s) (isteğe bağlı) → halka noktalarının açıları (her kesitte aynı sayıda, artan sırada).
//   Verilmezse açılar eşit aralıklıdır. Malzeme sınırlarına tam denk gelen açılar vermek
//   sınırın üçgen kenarından geçmesini, yani tırtıksız düz çizgi olmasını sağlar
//   power  → kesitin köşeliliği (2 = elips, büyüdükçe yuvarlatılmış dikdörtgen)
//   tumble → üst kısmın ne kadar daraldığı (arabaların yanları yukarı doğru içe yatar)
export function loft(zStart, zEnd, slices, ringSize, section, classify = null, ringAngles = null) {
  const positions = []
  const indices = []

  const ringPoint = (z, angle, s) => {
    const c = Math.cos(angle)
    const sn = Math.sin(angle)
    const power = sn >= 0 ? s.powerTop : s.powerBottom
    // Süper elips: |x|^p + |y|^p = 1 eğrisi üzerinde nokta
    const sx = Math.sign(c) * Math.abs(c) ** (2 / power)
    const sy = Math.sign(sn) * Math.abs(sn) ** (2 / power)
    const cy = (s.top + s.bottom) / 2
    const hy = (s.top - s.bottom) / 2
    const narrow = 1 - s.tumble * Math.max(0, sy)
    return [sx * s.halfWidth * narrow, cy + sy * hy, z]
  }

  const anglesAt = (z, s) => ringAngles?.(z, s) ?? Array.from({ length: ringSize }, (_, j) => (j / ringSize) * Math.PI * 2)

  for (let i = 0; i <= slices; i++) {
    const z = zStart + ((zEnd - zStart) * i) / slices
    const s = section(z)
    for (const angle of anglesAt(z, s)) positions.push(...ringPoint(z, angle, s))
  }
  for (let i = 0; i < slices; i++) {
    for (let j = 0; j < ringSize; j++) {
      const a = i * ringSize + j
      const b = i * ringSize + ((j + 1) % ringSize)
      const c = a + ringSize
      const d = b + ringSize
      indices.push(a, b, c, b, d, c) // bu sıra yüzeyin dışarı bakmasını sağlar
    }
  }

  // Uç kapakları (ayrı köşelerle, kenarları keskin kalsın)
  const addCap = (z, facingFront) => {
    const s = section(z)
    const center = positions.length / 3
    positions.push(0, (s.top + s.bottom) / 2, z)
    for (const angle of anglesAt(z, s)) positions.push(...ringPoint(z, angle, s))
    for (let j = 0; j < ringSize; j++) {
      const p = center + 1 + j
      const q = center + 1 + ((j + 1) % ringSize)
      if (facingFront) indices.push(center, p, q)
      else indices.push(center, q, p)
    }
  }
  addCap(zEnd, true)
  addCap(zStart, false)

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setIndex(classify ? groupByMaterial(positions, indices, classify, geometry) : indices)
  geometry.computeVertexNormals()
  return geometry
}

// Üçgenleri merkez noktalarına göre malzeme gruplarına ayırır.
// Mesh'e malzeme dizisi verildiğinde ([boya, cam, ...]) her grup kendi malzemesiyle çizilir
function groupByMaterial(positions, indices, classify, geometry) {
  const buckets = []
  for (let t = 0; t < indices.length; t += 3) {
    let cx = 0
    let cy = 0
    let cz = 0
    for (let k = 0; k < 3; k++) {
      const v = indices[t + k] * 3
      cx += positions[v] / 3
      cy += positions[v + 1] / 3
      cz += positions[v + 2] / 3
    }
    const m = classify(cx, cy, cz)
    ;(buckets[m] ??= []).push(indices[t], indices[t + 1], indices[t + 2])
  }
  const sorted = []
  buckets.forEach((bucket, materialIndex) => {
    if (!bucket) return
    geometry.addGroup(sorted.length, bucket.length, materialIndex) // addGroup(başlangıç, adet, malzeme no)
    for (const index of bucket) sorted.push(index)
  })
  return sorted
}

