import * as THREE from 'three'
import { trackCurve, trackLength } from './track.js'
import { SEND_RATE } from '../shared/protocol.js'

// Bir rakibin hareketi: gelen durumlardan ekranda nerede çizileceğini hesaplar (mesh yok → Node'da test edilir).
//
// 1) Interpolasyon: rakibi biraz GERİDEN (delay) oynatırız. O anın hem öncesindeki hem sonrasındaki durum
//    elimizdedir, aralarını yumuşakça doldururuz. Zaman çizgisi: gönderenin ORTAK saatle yazdığı sentAt
//    (ağın getirdiği an değil) → ağ dalgalansa da araba gerçekte olduğu hızla akar.
// 2) Uyarlanan gecikme: sabit sayı yerine, son 2 sn'de "elimizdeki en yeni bilgi kaç ms eskiydi?" ölçümü.
//    İyi ağda kısa (rakip daha güncel), dalgalı ağda uzun (donma yok).
// 3) Dead reckoning (tahmini konum): paket yine de gecikirse son hız ve pist üzerindeki konumla en fazla
//    300 ms ileri tahmin. Gerçek veri gelince aradaki fark birkaç karede sönerek kapanır (ışınlama yok).

const SEND_INTERVAL = 1000 / SEND_RATE // 50 ms
const MIN_DELAY = SEND_INTERVAL + 20 // en iyi ağda bile: bir paket aralığı + pay
const MAX_DELAY = 350 // bundan kötü ağda gecikmeyi büyütmek yerine tahmine bırak
const START_DELAY = SEND_INTERVAL * 2 + 40 // ölçüm birikene kadar
const DELAY_MARGIN = 15 // ms: ölçülen değerin üstüne pay
const WINDOW = 2000 // ms: ölçümlerin bakıldığı son süre
const LAG_PERCENTILE = 0.9 // en kötü %10'u tahmin kapatsın: tek bir sıçrama gecikmeyi 2 sn büyütmesin
const MAX_PREDICT = 300 // ms: bundan ötesini tahmin etme (yanlış tahmin büyür), son tahminde bekle
const SMOOTH_TIME = 0.1 // sn: düzeltme farkı bu sürede ~%63 söner (6 kare)
const SNAP_DISTANCE = 40 // bundan büyük fark: yeniden doğma, kaydırma değil ışınla
const MAX_BUFFER = 40 // ~2 sn

const UP = new THREE.Vector3(0, 1, 0)
const ORIGIN = new THREE.Vector3()
const IDENTITY = new THREE.Quaternion()
const wrap = (u) => ((u % 1) + 1) % 1

// Pist yönü dönüşü (car.js'teki model.lookAt ile aynı): +z gidiş yönüne bakar
const basis = new THREE.Matrix4()
const tangent = new THREE.Vector3()
function trackQuaternion(u, out) {
  trackCurve.getTangentAt(u, tangent)
  return out.setFromRotationMatrix(basis.lookAt(tangent, ORIGIN, UP))
}

export function createRemoteMotion() {
  const buffer = [] // { sentAt, arrival, position, quaternion, speed, progress, u?, offset?, height? }
  let before = null // buffer'dan en son atılan örnek: tahminde yan / dikey hızı bulmak için
  let delay = START_DELAY
  const lags = [] // { at, lag }: yeni paket geldiği anda elimizdeki en yeni bilgi kaç ms eskiydi
  const arrivals = [] // varış anları (son 2 sn): saniyedeki paket sayısı ve en büyük boşluk

  const position = new THREE.Vector3() // çizilecek konum (hedef + sönen düzeltme farkı)
  const quaternion = new THREE.Quaternion()
  let hasPose = false
  let predicting = false // şu an tahmin modunda mı (F3 paneli)
  let predictedMs = 0
  let base = null // tahminin dayandığı örnek
  let baseBefore = null
  const error = new THREE.Vector3() // sönen düzeltme farkı
  const errorQ = new THREE.Quaternion()

  // Geçici nesneler (her karede yenisi oluşmasın)
  const target = new THREE.Vector3()
  const targetQ = new THREE.Quaternion()
  const old = new THREE.Vector3()
  const oldQ = new THREE.Quaternion()
  const side = new THREE.Vector3()
  const velocity = new THREE.Vector3()
  const qFrom = new THREE.Quaternion()
  const qTo = new THREE.Quaternion()
  const tmpQ = new THREE.Quaternion()

  // Yeni durum geldi. now: alıcının ortak saati (net.serverNow())
  function push(s, now) {
    const last = buffer[buffer.length - 1]
    if (last && s.sentAt <= last.sentAt) return // tekrar ya da sırası bozuk: zaman geriye akmaz
    if (last) lags.push({ at: now, lag: now - last.sentAt }) // tam yenisi gelmeden önceki en bayat an
    arrivals.push(now)
    buffer.push({
      sentAt: s.sentAt,
      position: new THREE.Vector3(s.x, s.y, s.z),
      quaternion: new THREE.Quaternion(...s.rotation),
      speed: s.speed,
      progress: s.progress,
      u: s.u,
      offset: s.off,
      height: s.h,
    })
    if (buffer.length > MAX_BUFFER) before = buffer.shift()
    while (lags.length && lags[0].at < now - WINDOW) lags.shift()
    while (arrivals.length && arrivals[0] < now - WINDOW) arrivals.shift()
  }

  // Gecikme hedefi: son 2 sn'deki "en bayat an"ların %90'ı + pay. Örnek yokken başlangıç değeri
  function targetDelay() {
    if (lags.length < 5) return START_DELAY
    const sorted = lags.map((l) => l.lag).sort((a, b) => a - b)
    const p = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * LAG_PERCENTILE))]
    return THREE.MathUtils.clamp(p + DELAY_MARGIN, MIN_DELAY, MAX_DELAY)
  }

  // Dead reckoning: örnek a'dan ms kadar sonrası. Pist bilgisi varsa pist eğrisi boyunca (virajı döner),
  // yoksa (eski sürüm) son iki örneğin hızıyla düz çizgide
  function predict(a, prev, ms, outPos, outQ) {
    const s = ms / 1000
    const span = prev ? (a.sentAt - prev.sentAt) / 1000 : 0
    const usable = prev && span > 0 && prev.position.distanceTo(a.position) < SNAP_DISTANCE
    if (a.u !== undefined) {
      const u = wrap(a.u + (a.speed * s) / trackLength)
      // Yan ve dikey hız: son iki örnekten (sınırlı: bozuk veri arabayı uçurmasın)
      const vOffset = usable && prev.offset !== undefined ? THREE.MathUtils.clamp((a.offset - prev.offset) / span, -20, 20) : 0
      const vHeight = usable && prev.height !== undefined ? THREE.MathUtils.clamp((a.height - prev.height) / span, -60, 40) : 0
      trackCurve.getTangentAt(u, tangent)
      side.crossVectors(tangent, UP).normalize()
      outPos
        .copy(trackCurve.getPointAt(u))
        .addScaledVector(side, a.offset + vOffset * s)
        .addScaledVector(UP, a.height + vHeight * s)
      // Duruş: son duruş, pistin a'dan bu yana döndüğü kadar döndürülür (takla / yatış korunur)
      trackQuaternion(a.u, qFrom)
      trackQuaternion(u, qTo)
      outQ.copy(qTo).multiply(qFrom.invert()).multiply(a.quaternion)
    } else {
      outPos.copy(a.position)
      if (usable) outPos.addScaledVector(velocity.subVectors(a.position, prev.position), s / span)
      outQ.copy(a.quaternion)
    }
  }

  // Her kare. now: ortak saat (ms), dt: gerçek geçen süre (sn). Çizilecek pozu position / quaternion'a yazar
  function update(now, dt) {
    if (!buffer.length) return false

    // Gecikme hedefe yumuşakça yaklaşsın: artarken çabuk (donma başlamasın), azalırken yavaş.
    // Değişim hızı sınırlı: gecikme gerçek zamandan hızlı artarsa renderTime GERİ akar (rakip geri gider).
    // Sınırlarla rakip en fazla %25 yavaş / %10 hızlı oynar, fark edilmez
    const goal = targetDelay()
    const step = (goal - delay) * (1 - Math.exp(-(goal > delay ? 4 : 0.5) * dt))
    delay += THREE.MathUtils.clamp(step, -0.1 * dt * 1000, 0.25 * dt * 1000)
    const renderTime = now - delay

    // Bir önceki karede tahmindeysek: eski dayanakla bu kare nerede olurdu? (geçişte farkı bulmak için)
    const wasPredicting = predicting && base
    if (wasPredicting) predict(base, baseBefore, Math.min(renderTime - base.sentAt, MAX_PREDICT), old, oldQ)

    // renderTime'ı geride bırakan eski durumları at (en az biri kalsın)
    while (buffer.length >= 2 && buffer[1].sentAt <= renderTime) before = buffer.shift()
    const a = buffer[0]
    const b = buffer[1]

    predicting = false
    predictedMs = 0
    if (renderTime < a.sentAt) {
      // Elimizdeki en eski durum bile ileride (rakip yeni göründü): onu göster
      target.copy(a.position)
      targetQ.copy(a.quaternion)
    } else if (b) {
      if (a.position.distanceTo(b.position) < SNAP_DISTANCE) {
        const alpha = (renderTime - a.sentAt) / (b.sentAt - a.sentAt) // 0 → a, 1 → b
        target.lerpVectors(a.position, b.position, alpha)
        targetQ.slerpQuaternions(a.quaternion, b.quaternion, alpha)
      } else {
        target.copy(a.position) // arada yeniden doğdu: kaydırma, b'nin anı gelince ışınlanır
        targetQ.copy(a.quaternion)
      }
    } else {
      // İleride durum yok (paket gecikti): dondurma, son hız ve pist üzerindeki konumla tahmin et
      predicting = true
      predictedMs = Math.min(renderTime - a.sentAt, MAX_PREDICT)
      predict(a, before, predictedMs, target, targetQ)
    }

    // Tahminden çıktık ya da tahminin dayanağı değişti (yeni paket): eski hesapla yeni hesap arasındaki
    // farkı düzeltme farkına ekle → araba bir karede zıplamaz, birkaç karede doğru yere kayar
    if (hasPose && wasPredicting && (!predicting || base !== a)) {
      error.add(old.sub(target))
      errorQ.multiply(oldQ.multiply(tmpQ.copy(targetQ).invert()))
      if (error.length() > SNAP_DISTANCE) {
        error.set(0, 0, 0) // çok uzaksa (yeniden doğdu, uzun kopukluk): ışınla
        errorQ.identity()
      }
    }
    base = predicting ? a : null
    baseBefore = predicting ? before : null

    const keep = Math.exp(-dt / SMOOTH_TIME)
    error.multiplyScalar(keep)
    errorQ.slerp(IDENTITY, 1 - keep)
    position.copy(target).add(error)
    quaternion.copy(errorQ).multiply(targetQ)
    hasPose = true
    return true
  }

  // F3 paneli: saniyedeki paket, son 2 sn'deki en büyük boşluk (şu anki bekleyiş dahil), buffer, gecikme
  function stats(now) {
    let maxGap = arrivals.length ? now - arrivals[arrivals.length - 1] : 0
    for (let i = 1; i < arrivals.length; i++) maxGap = Math.max(maxGap, arrivals[i] - arrivals[i - 1])
    return {
      hz: arrivals.filter((t) => t > now - 1000).length,
      maxGap,
      buffer: buffer.length,
      delay,
      predicting,
      predictedMs,
      correction: error.length(),
    }
  }

  return {
    push,
    update,
    stats,
    position,
    quaternion,
    get latest() {
      return buffer[buffer.length - 1] // canlı sıralama ve motor sesi: çizdiğimiz değil, son gelen
    },
  }
}
