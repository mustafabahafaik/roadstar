import * as THREE from 'three'

// Neon malzeme: kendi ışığını yayan, ışıktan etkilenmeyen parlak renk.
// intensity → rengin parlaklık çarpanı (1'in üstü = HDR, ekranın gösterebileceğinden parlak)
// bloom     → true ise postfx.js bu malzemeye ışık hâlesi ekler (seçici bloom)
export function neon(hex, intensity = 2.5, bloom = true) {
  const color = new THREE.Color(hex).multiplyScalar(intensity)
  const material = new THREE.MeshBasicMaterial({ color })
  material.userData.bloom = bloom
  return material
}
