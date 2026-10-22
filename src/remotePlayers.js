import * as THREE from 'three'
import { createCarModel } from './carModel.js'
import { applyLoadout } from './parts.js'
import { createRemoteMotion } from './remoteMotion.js'

// Rakip arabalar: model + isim etiketi. Nerede çizileceğini remoteMotion.js hesaplar
// (ortak saatle interpolasyon, uyarlanan gecikme, paket gecikince dead reckoning)
const LABEL_HEIGHT = 4.6 // isim etiketi arabanın kaç birim üstünde

// İsim etiketi: canvas'a yazılmış bir Sprite (her zaman kameraya döner)
function createLabel(name, color) {
  const canvas = document.createElement('canvas')
  canvas.width = 256
  canvas.height = 64
  const ctx = canvas.getContext('2d')
  const css = `#${color.toString(16).padStart(6, '0')}`
  ctx.fillStyle = 'rgba(8, 10, 22, 0.75)'
  ctx.beginPath()
  ctx.roundRect(4, 8, 248, 48, 24)
  ctx.fill()
  ctx.strokeStyle = css
  ctx.lineWidth = 4
  ctx.stroke()
  ctx.fillStyle = '#ffffff'
  ctx.font = '700 28px system-ui, sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(name, 128, 33, 230) // canvas'a çizilen yazı HTML değildir: isimdeki < > zararsız
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  // toneMapped: false → pozlama (0.5) etiketi karartmasın; fog: false → uzaktan da okunsun
  const material = new THREE.SpriteMaterial({ map: texture, toneMapped: false, fog: false, depthTest: false })
  const sprite = new THREE.Sprite(material)
  sprite.scale.set(8, 2, 1)
  sprite.renderOrder = 10 // diğer her şeyin üstüne çizilsin
  return sprite
}

export function createRemotePlayers(scene, net) {
  const players = new Map() // id → { info, model, label, motion }

  function add(info) {
    const model = createCarModel(info.color)
    // Rakibin garaj parçaları (sadece görsel). Varsayılan boyadaysa oyuncu rengi: yarışta ayırt edilsin
    applyLoadout(model, info.loadout, { playerColor: info.color })
    model.traverse((obj) => {
      if (obj.isMesh) obj.castShadow = true
    })
    model.visible = false // ilk durum gelene kadar gizli
    const label = createLabel(info.name, info.color)
    label.visible = false
    scene.add(model, label)
    players.set(info.id, { info, model, label, motion: createRemoteMotion() })
  }

  function remove(id) {
    const p = players.get(id)
    if (!p) return
    scene.remove(p.model, p.label)
    p.label.material.map.dispose()
    p.label.material.dispose()
    players.delete(id)
  }

  // Oda listesi değişince (sunucu 'room'): yeni gelenlere araba ekle, gidenleri çıkar
  function syncRoom(roomPlayers, selfId) {
    const ids = new Set()
    for (const info of roomPlayers) {
      if (info.id === selfId || info.left) continue
      ids.add(info.id)
      if (!players.has(info.id)) add(info)
      players.get(info.id).info = info
    }
    for (const id of [...players.keys()]) if (!ids.has(id)) remove(id)
  }

  // Rakibin durumu (sunucu her birini beklemeden iletir). Varış anı da ortak saatle: ağ ölçümü için
  function onState(s) {
    players.get(s.id)?.motion.push(s, net.serverNow())
  }

  // Her kare. dt: gerçek geçen süre (sn)
  function update(dt) {
    const now = net.serverNow()
    for (const p of players.values()) {
      // DNF: düştü, pistten kaldır (durum 'room' olayıyla gelir). İlk durum gelene kadar da gizli
      const visible = p.motion.update(now, dt) && p.info.status !== 'dnf'
      p.model.visible = p.label.visible = visible
      if (!visible) continue
      p.model.position.copy(p.motion.position)
      p.model.quaternion.copy(p.motion.quaternion)
      p.label.position.copy(p.model.position).y += LABEL_HEIGHT
    }
  }

  // Canlı sıralama için: her rakibin en güncel ilerlemesi (çizdiğimiz değil, son gelen)
  const progressOf = (id) => players.get(id)?.motion.latest?.progress ?? 0

  // Sesi çıkacak rakipler: çizilen arabanın konumu ve son bilinen hızı (audio.js: uzaklığa göre kısılan motor)
  function voices() {
    const list = []
    for (const [id, p] of players) {
      if (p.model.visible) list.push({ id, position: p.model.position, speed: p.motion.latest?.speed ?? 0 })
    }
    return list
  }

  // F3 paneli: rakip başına ağ ölçümleri
  function stats() {
    const now = net.serverNow()
    return [...players.values()].map((p) => ({ name: p.info.name, ...p.motion.stats(now) }))
  }

  return { syncRoom, onState, update, progressOf, voices, stats }
}
