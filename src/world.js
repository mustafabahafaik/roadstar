import * as THREE from 'three'
import { Sky } from 'three/addons/objects/Sky.js'
import { Water } from 'three/addons/objects/Water.js'
import { quality } from './settings.js'
import { getMap, DEFAULT_MAP } from './maps.js'
import { recolorTrack } from './track.js'
import { createSpace } from './space.js'

// Dünya: bir harita objesini (maps.js) sahneye uygular. Işıklar bir kez kurulur, harita değişince sadece
// renkleri ve şiddetleri değişir; gökyüzü / su / uzay nesneleri ise kaldırılıp (dispose) yeniden kurulur.
// Çalışırken değiştirilebilir: giriş sayfasında Satürn kartına tıklayınca arka plan anında uzaya döner.

let waterNormals = null // su dokusu bir kez yüklensin (haritalar arasında gidip gelince tekrar indirilmesin)

// --- Okyanus: Sky (gökyüzü shader'ı) + Water (yansıyan su) ---
function createOcean(scene, pmrem, map, sun) {
  const sky = new Sky()
  sky.scale.setScalar(10000)
  const u = sky.material.uniforms // uniform = shader'a JavaScript'ten gönderilen ayar değeri
  u.turbidity.value = map.sky.turbidity // havadaki pus
  u.rayleigh.value = map.sky.rayleigh // mavi saçılma (gökyüzünün mavisi)
  u.mieCoefficient.value = map.sky.mieCoefficient // güneş etrafındaki hale
  u.mieDirectionalG.value = map.sky.mieDirectionalG
  u.sunPosition.value.copy(sun)

  // Ortam haritası: gökyüzünün "fotoğrafı" (PMREM pürüzlülüğe göre bulanıklaştırır) → parlak yüzeylere yansıma
  const envScene = new THREE.Scene()
  envScene.add(sky)
  const environment = pmrem.fromScene(envScene).texture
  scene.add(sky)

  waterNormals ??= new THREE.TextureLoader().load(
    '/textures/waternormals.jpg',
    (texture) => (texture.wrapS = texture.wrapT = THREE.RepeatWrapping), // 10000 birimlik düzleme döşensin
    undefined,
    () => console.warn('waternormals.jpg bulunamadı → public/textures/ içine koy'),
  )
  const water = new Water(new THREE.PlaneGeometry(10000, 10000), {
    textureWidth: quality.waterResolution,
    textureHeight: quality.waterResolution,
    waterNormals,
    sunDirection: sun.clone(),
    sunColor: 0xffffff,
    waterColor: 0x00557a,
    distortionScale: 3.7,
  })
  water.rotation.x = -Math.PI / 2
  scene.add(water)

  return {
    environment,
    bloomHidden: [sky, water], // bloom geçişinde gizle: güneşe bakınca ekran beyaza boğulmasın
    update(dt) {
      water.material.uniforms.time.value += dt // dalgalar
      u.time.value += dt * 1000 // bulutlar (ms)
    },
    dispose() {
      scene.remove(sky, water)
      sky.geometry.dispose()
      sky.material.dispose()
      water.geometry.dispose()
      water.material.dispose()
      environment.dispose()
    },
  }
}

// track: createTrack() (pist renkleri haritaya göre boyanır)
export function createWorld({ scene, renderer, track }) {
  const pmrem = new THREE.PMREMGenerator(renderer)
  const sun = new THREE.Vector3() // güneş yönü (birim vektör): Sky, Water ve gölge ışığı kullanır
  const bloomHidden = [] // postfx.js bu diziyi okur; haritaya göre içeriği değişir (aynı dizi)

  // Işıklar (bir kez): HemisphereLight üstten gök, alttan zemin rengi; DirectionalLight güneş + gölge
  const hemisphere = new THREE.HemisphereLight()
  const sunLight = new THREE.DirectionalLight()
  sunLight.castShadow = true
  sunLight.shadow.mapSize.set(quality.shadowMapSize, quality.shadowMapSize)
  sunLight.shadow.radius = 3
  sunLight.shadow.bias = -0.0004 // "gölge sivilcesi" (shadow acne) denen çizgili hatayı önler
  sunLight.shadow.normalBias = 0.04
  // Gölge kamerası arabanın etrafındaki 80×80'lik alanı kapsar; tüm pisti kapsasaydı gölgeler bulanık olurdu
  const shadowCam = sunLight.shadow.camera
  shadowCam.left = shadowCam.bottom = -40
  shadowCam.right = shadowCam.top = 40
  shadowCam.near = 1
  shadowCam.far = 400
  scene.add(hemisphere, sunLight, sunLight.target)

  let map = null
  let background = null // { environment, bloomHidden, update, dispose }

  function setMap(id) {
    const next = getMap(id)
    if (map?.id === next.id) return
    background?.dispose()
    map = next

    // Güneş: setFromSphericalCoords(yarıçap, tepeden açı, yatay açı) → yön vektörü
    sun.setFromSphericalCoords(1, THREE.MathUtils.degToRad(90 - map.sun.elevation), THREE.MathUtils.degToRad(map.sun.azimuth))
    sunLight.color.set(map.sun.color)
    sunLight.intensity = map.sun.intensity
    hemisphere.color.set(map.hemisphere.sky)
    hemisphere.groundColor.set(map.hemisphere.ground)
    hemisphere.intensity = map.hemisphere.intensity
    scene.fog = new THREE.FogExp2(map.fog.color, map.fog.density) // uzak nesneler havanın rengine karışır
    renderer.toneMappingExposure = map.exposure
    scene.environmentIntensity = map.environmentIntensity

    background = map.sky.type === 'space' ? createSpace(scene, pmrem, map) : createOcean(scene, pmrem, map, sun)
    scene.environment = background.environment
    bloomHidden.length = 0
    bloomHidden.push(...background.bloomHidden)
    recolorTrack(track, map.track)
  }

  setMap(DEFAULT_MAP)

  return {
    setMap,
    bloomHidden,
    get map() {
      return map
    },
    update: (dt) => background.update(dt),
    // Güneş ışığı ve gölge kamerası arabayı takip eder
    followSun(target) {
      sunLight.target.position.copy(target)
      sunLight.position.copy(target).addScaledVector(sun, 150)
    },
  }
}
