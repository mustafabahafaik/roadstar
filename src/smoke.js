import * as THREE from 'three'

// Duman parçacık sistemi: tek bir havuz, tek bir çizim çağrısı (THREE.Points).
// - Havuz (pool): parçacıklar baştan oluşturulur ve yeniden kullanılır. Her pufta yeni nesne
//   yaratıp atmak, tarayıcının çöp toplayıcısını (garbage collection) çalıştırır → oyunda takılma.
// - Points: 900 parçacığın hepsi tek seferde çizilir (900 ayrı Sprite = 900 çizim komutu).
// - Parçacıklar dünyada kalır: arabaya bağlı değiller, doğdukları yerden kendi hızlarıyla uçarlar.

const MAX_PARTICLES = 900

// Yumuşak kenarlı "puf": canvas'a üst üste birkaç radyal gradyan (yuvarlak bulut parçası) çiz.
// Harici resim dosyası gerekmez
function createPuffTexture() {
  const size = 128
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d')
  const blob = (x, y, r, alpha) => {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r)
    g.addColorStop(0, `rgba(255,255,255,${alpha})`)
    g.addColorStop(0.5, `rgba(255,255,255,${alpha * 0.45})`)
    g.addColorStop(1, 'rgba(255,255,255,0)')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, size, size)
  }
  blob(64, 64, 62, 0.9) // ana gövde
  // Etrafına küçük topaklar: kenarı tam daire değil, bulut gibi düzensiz olsun
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + 0.4
    blob(64 + Math.cos(a) * 20, 64 + Math.sin(a) * 20, 30, 0.45)
  }
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

// Her parçacığın boyutu, saydamlığı ve dönüş açısı GPU'da ayrı ayrı uygulanır
const vertexShader = /* glsl */ `
  attribute float size;
  attribute float alpha;
  attribute float angle;
  uniform float viewportHeight;
  varying float vAlpha;
  varying float vAngle;
  void main() {
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    // Dünya birimindeki çapı ekran pikseline çevir: uzaktaki puf küçük görünür (perspektif)
    gl_PointSize = size * projectionMatrix[1][1] * viewportHeight * 0.5 / -mvPosition.z;
    gl_Position = projectionMatrix * mvPosition;
    vAlpha = alpha;
    vAngle = angle;
  }`

const fragmentShader = /* glsl */ `
  uniform sampler2D map;
  uniform vec3 color;
  varying float vAlpha;
  varying float vAngle;
  void main() {
    // Dokuyu parçacığın açısına göre döndür: her puf farklı duruyor gibi görünsün
    vec2 uv = gl_PointCoord - 0.5;
    float c = cos(vAngle), s = sin(vAngle);
    uv = vec2(c * uv.x - s * uv.y, s * uv.x + c * uv.y) + 0.5;
    vec4 tex = texture2D(map, uv);
    float a = tex.a * vAlpha;
    if (a < 0.003) discard; // tamamen saydam pikselleri hiç çizme
    gl_FragColor = vec4(color * tex.rgb, a);
  }`

// renderer: ekran yüksekliğini okumak için (puf boyutunu piksele çevirirken)
export function createSmoke(scene, renderer, color = 0xdde3ec) {
  const positions = new Float32Array(MAX_PARTICLES * 3)
  const sizes = new Float32Array(MAX_PARTICLES)
  const alphas = new Float32Array(MAX_PARTICLES)
  const angles = new Float32Array(MAX_PARTICLES)

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage))
  geometry.setAttribute('size', new THREE.BufferAttribute(sizes, 1).setUsage(THREE.DynamicDrawUsage))
  geometry.setAttribute('alpha', new THREE.BufferAttribute(alphas, 1).setUsage(THREE.DynamicDrawUsage))
  geometry.setAttribute('angle', new THREE.BufferAttribute(angles, 1).setUsage(THREE.DynamicDrawUsage))
  geometry.setDrawRange(0, 0)

  const material = new THREE.ShaderMaterial({
    uniforms: {
      map: { value: createPuffTexture() },
      color: { value: new THREE.Color(color) },
      viewportHeight: { value: 800 },
    },
    vertexShader,
    fragmentShader,
    transparent: true,
    depthWrite: false, // saydam pufler birbirini "kesmesin"
  })

  const points = new THREE.Points(geometry, material)
  points.frustumCulled = false // parçacıklar her yere dağılıyor: görüş alanı dışı sayılıp atlanmasın
  scene.add(points)

  // Havuz: her parçacığın durumu. alive = false olanlar boşta
  const pool = Array.from({ length: MAX_PARTICLES }, () => ({
    alive: false,
    position: new THREE.Vector3(),
    velocity: new THREE.Vector3(), // kendi hızı (hava direnciyle yavaşlar)
    carry: new THREE.Vector3(), // arabadan miras alınan hız (daha yavaş söner)
    age: 0,
    life: 1,
    startSize: 1,
    endSize: 4,
    opacity: 0.4,
    drag: 2,
    carryDrag: 0.35,
    rise: 1,
    angle: 0,
    spin: 0,
  }))
  let next = 0 // halka: sıradaki slot (havuz doluysa en eski parçacık yeniden kullanılır)

  // Yeni puf. Sadece verilen alanlar değişir, geri kalanı varsayılan
  function emit({
    position,
    velocity,
    carry,
    life = 1.2,
    startSize = 1,
    endSize = 5,
    opacity = 0.35,
    drag = 2.2,
    carryDrag = 0.35,
    rise = 1.5,
  }) {
    const p = pool[next]
    next = (next + 1) % MAX_PARTICLES
    p.alive = true
    p.age = 0
    p.position.copy(position)
    if (velocity) p.velocity.copy(velocity)
    else p.velocity.set(0, 0, 0)
    if (carry) p.carry.copy(carry)
    else p.carry.set(0, 0, 0)
    Object.assign(p, { life, startSize, endSize, opacity, drag, carryDrag, rise })
    p.angle = Math.random() * Math.PI * 2
    p.spin = (Math.random() - 0.5) * 1.5
  }

  const drawingSize = new THREE.Vector2()

  function update(dt) {
    material.uniforms.viewportHeight.value = renderer.getDrawingBufferSize(drawingSize).y

    // Canlı parçacıkları ilerlet ve tampona sırayla yaz (sıkıştırma: ölüler araya girmez,
    // setDrawRange ile sadece canlı olanlar çizilir)
    let count = 0
    for (const p of pool) {
      if (!p.alive) continue
      p.age += dt
      const t = p.age / p.life // 0 → 1
      if (t >= 1) {
        p.alive = false
        continue
      }
      p.velocity.multiplyScalar(Math.max(0, 1 - p.drag * dt)) // yavaşla (hava direnci)
      p.carry.multiplyScalar(Math.max(0, 1 - p.carryDrag * dt))
      p.velocity.y += p.rise * dt // sıcak duman hafifçe yükselir
      p.position.addScaledVector(p.velocity, dt).addScaledVector(p.carry, dt)
      p.angle += p.spin * dt

      positions[count * 3] = p.position.x
      positions[count * 3 + 1] = p.position.y
      positions[count * 3 + 2] = p.position.z
      sizes[count] = THREE.MathUtils.lerp(p.startSize, p.endSize, t) // büyü
      alphas[count] = p.opacity * (1 - t) * Math.min(1, t * 10) // hızlı belir, yavaşça sön
      angles[count] = p.angle
      count++
    }

    geometry.setDrawRange(0, count)
    for (const name of ['position', 'size', 'alpha', 'angle']) geometry.attributes[name].needsUpdate = true
  }

  return { emit, update, points }
}
