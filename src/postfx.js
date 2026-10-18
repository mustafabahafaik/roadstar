import * as THREE from 'three'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js'
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js'
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js'

// Seçici bloom: sadece malzemesinde userData.bloom = true olan nesneler parlar.
// 1) Bloom geçişi: parlamayacak her şeyi geçici olarak siyaha boya, gökyüzü/suyu gizle → sadece neonlar kalır,
//    bunlara bloom uygula (yarım çözünürlükte, ekran kartını yormasın).
// 2) Son geçiş: sahneyi normal çiz, üstüne 1. adımdaki parlamayı ekle, tone mapping uygula.
export function createPostFX(renderer, scene, camera, hiddenInBloom, msaaSamples = 4) {
  const size = renderer.getSize(new THREE.Vector2())
  const pixelRatio = renderer.getPixelRatio()

  // --- 1. Bloom geçişi ---
  const bloomComposer = new EffectComposer(renderer)
  bloomComposer.renderToScreen = false // ekrana değil, bir dokuya çiz
  bloomComposer.setPixelRatio(pixelRatio * 0.5)
  bloomComposer.addPass(new RenderPass(scene, camera))
  const bloomPass = new UnrealBloomPass(size.clone(), 0.6, 0.4, 0) // güç, yayılma, eşik (eşik 0: zaten sadece neonlar var)
  bloomComposer.addPass(bloomPass)

  // --- 2. Son geçiş ---
  // MSAA: kenarlardaki tırtıkları yumuşatır. Composer kendi dokusuna çizdiği için
  // renderer'daki antialias: true burada işe yaramıyor, örnekleme sayısını dokuya vermemiz gerekiyor.
  const target = new THREE.WebGLRenderTarget(size.x * pixelRatio, size.y * pixelRatio, {
    type: THREE.HalfFloatType,
    samples: msaaSamples,
  })
  const finalComposer = new EffectComposer(renderer, target)
  finalComposer.addPass(new RenderPass(scene, camera))

  // Karıştırma shader'ı: normal görüntü + bloom dokusu
  const mixPass = new ShaderPass(
    new THREE.ShaderMaterial({
      uniforms: {
        baseTexture: { value: null },
        bloomTexture: { value: bloomComposer.renderTarget2.texture },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D baseTexture;
        uniform sampler2D bloomTexture;
        varying vec2 vUv;
        void main() {
          gl_FragColor = texture2D(baseTexture, vUv) + vec4(texture2D(bloomTexture, vUv).rgb, 0.0);
        }`,
    }),
    'baseTexture', // ShaderPass önceki geçişin sonucunu bu uniform'a koyar
  )
  mixPass.needsSwap = true
  finalComposer.addPass(mixPass)
  finalComposer.addPass(new OutputPass()) // tone mapping + sRGB dönüşümü en sonda

  // Bloom geçişinde parlamayan nesnelerin geçici malzemesi
  const black = new THREE.MeshBasicMaterial({ color: 0x000000, side: THREE.DoubleSide, fog: false })
  const saved = new Map()

  function darken(obj) {
    if (obj.isMesh && !obj.material.userData?.bloom) { // ?. → malzeme dizisi olabilir
      saved.set(obj, obj.material)
      obj.material = black // önündeki neonları yine örtsün diye silmiyoruz, siyaha boyuyoruz
    } else if (obj.isSprite) {
      saved.set(obj, null)
      obj.visible = false // duman parlamasın
    }
  }

  function restore() {
    for (const [obj, material] of saved) {
      if (material) obj.material = material
      else obj.visible = true
    }
    saved.clear()
  }

  function render() {
    // 1) Sadece neonları çiz ve parlat
    for (const o of hiddenInBloom) o.visible = false
    scene.traverseVisible(darken)
    bloomComposer.render()
    restore()
    for (const o of hiddenInBloom) o.visible = true

    // 2) Normal sahne + parlama. Gölge haritasını sadece bu geçişte güncelle (bloom geçişinde gereksiz)
    renderer.shadowMap.needsUpdate = true
    finalComposer.render()
  }

  function setSize(width, height) {
    bloomComposer.setSize(width, height)
    finalComposer.setSize(width, height)
  }

  return { render, setSize, bloomPass }
}
