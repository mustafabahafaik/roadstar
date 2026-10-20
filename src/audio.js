// Prosedürel sesler (Web Audio API): hiçbir ses dosyası yok, her şey osilatör ve beyaz gürültüden üretilir.
//
// Web Audio bir "düğüm grafiği"dir: ses kaynakları (OscillatorNode: dalga, AudioBufferSourceNode: kayıt)
// → işlemciler (BiquadFilterNode: filtre, GainNode: ses düzeyi, PannerNode: 3B konum) → hoparlör.
// Düğümler connect() ile bağlanır. Ses düzeyi, frekans gibi değerler zamanla değişebilen AudioParam'lardır
// (setTargetAtTime: hedefe yumuşakça yaklaş; exponentialRampToValueAtTime: üstel geçiş).
//
// Otomatik oynatma politikası: tarayıcılar sayfa açılır açılmaz ses çalınmasını engeller (reklamlı sitelerin
// birden bağırmaması için). AudioContext "suspended" (askıda) başlar; resume() ancak kullanıcının bir
// tıklama ya da tuş olayının İÇİNDE çağrılırsa işe yarar. Bu yüzden ses sistemini ilk tıklamada açıyoruz.

const SOUND_KEY = 'monad-racer:sound'
const MASTER_VOLUME = 0.55
const MAX_REMOTE_VOICES = 4 // rakip motoru (odada en çok 4 rakip)
const SIDE_PUFF_GAP = 0.11 // yan itici pufları arası en az süre (sn): duman sık çıkar, ses dağınık olmasın

const loadEnabled = () => {
  try {
    return localStorage.getItem(SOUND_KEY) !== 'off'
  } catch {
    return true
  }
}
const saveEnabled = (on) => {
  try {
    localStorage.setItem(SOUND_KEY, on ? 'on' : 'off')
  } catch {
    // kaydedilemedi: bu oturum için geçerli
  }
}

// Notalar (Hz)
const NOTE = { C5: 523.25, E5: 659.25, G5: 783.99, A5: 880, B5: 987.77, C6: 1046.5, D6: 1174.66, E6: 1318.5, G6: 1567.98, A6: 1760, E7: 2637 }
// Token türü (items.js: 0 Thrust, 1 Kalkan, 2 Mıknatıs, 3 Block Rush, 4 Altın) → kısa arpej
const COLLECT_NOTES = [
  [NOTE.A5, NOTE.E6], // Thrust Cell
  [NOTE.E5, NOTE.B5], // Kalkan
  [NOTE.G5, NOTE.D6], // Mıknatıs
  [NOTE.B5, NOTE.E6, NOTE.G6], // Block Rush
  [NOTE.E6, NOTE.A6, NOTE.E7], // Altın: daha yüksek, üç nota, parıltılı
]

export function createAudio() {
  let ctx = null // AudioContext: ilk tıklamada kurulur
  let bus = null // her sesin bağlandığı giriş (kompresör)
  let master = null
  let enabled = loadEnabled()
  let timeScale = 1 // ağır çekim (fall.js): sesler uzar ve pesleşir
  let noise = null // 2 sn beyaz gürültü tamponu: bir kez üretilir, bütün "fışş"lar bunu çalar
  let engine = null
  let thruster = null
  let lastSidePuff = -1
  const live = new Set() // çalan tek seferlik kaynaklar: ağır çekim başlarsa onlar da yavaşlasın
  const remoteVoices = new Map() // rakip id → motor sesi (PannerNode'lu)
  const listeners = []

  // ===================================================================
  // Kurulum: sadece kullanıcı etkileşimi içinde (tıklama / tuş)
  // ===================================================================
  function unlock() {
    if (!ctx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext
      if (!AudioCtx) return // ses desteklenmiyor: oyun sessiz devam eder
      ctx = new AudioCtx()
      // Ana hat: her şey → kompresör (birçok ses üst üste binince patlamasın) → ana ses → hoparlör
      bus = ctx.createDynamicsCompressor()
      bus.threshold.value = -16
      bus.ratio.value = 4
      master = ctx.createGain()
      master.gain.value = enabled ? MASTER_VOLUME : 0
      bus.connect(master).connect(ctx.destination)
      noise = createNoiseBuffer()
      engine = createEngineVoice(bus)
      thruster = createThrusterVoice()
    }
    if (ctx.state === 'suspended' && enabled && !document.hidden) ctx.resume()
  }

  // İlk tıklama / tuş ("Yarışa Gir" dahil): sesi aç. Bir kez yeterli, dinleyiciler kendini kaldırır
  const firstGesture = () => {
    unlock()
    window.removeEventListener('pointerdown', firstGesture)
    window.removeEventListener('keydown', firstGesture)
  }
  window.addEventListener('pointerdown', firstGesture)
  window.addEventListener('keydown', firstGesture)

  // Sekme gizlenince oyun döngüsü durur: motor uğultusu boşlukta çalmaya devam etmesin
  document.addEventListener('visibilitychange', () => {
    if (!ctx) return
    if (document.hidden) ctx.suspend()
    else if (enabled) ctx.resume()
  })

  function setEnabled(on) {
    enabled = on
    saveEnabled(on)
    unlock() // düğmeye basmak da bir tıklama: bağlamı açmak için uygun an
    if (master) master.gain.setTargetAtTime(on ? MASTER_VOLUME : 0, ctx.currentTime, 0.05)
    for (const listener of listeners) listener(on)
  }

  // Beyaz gürültü: her örnek −1 ile 1 arasında rastgele. Filtreyle şekillenince "fışş", "puf", "bum" olur
  function createNoiseBuffer() {
    const buffer = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate)
    const data = buffer.getChannelData(0)
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1
    return buffer
  }

  // AudioParam'ı yumuşakça hedefe götür (ani sıçrama "çıt" sesi yapar)
  const glide = (param, value, time = 0.05) => param.setTargetAtTime(value, ctx.currentTime, time)
  const rate = () => Math.max(0.25, timeScale)
  // Ağır çekim perdesi: detune sent cinsinden, 1200 sent = 1 oktav. timeScale 0.25 → −2400 (iki oktav pes)
  const slowDetune = () => 1200 * Math.log2(rate())

  // ===================================================================
  // Sürekli sesler: motor ve itici
  // ===================================================================

  // Motor: testere dişi (parlak, vızıltılı) + bir oktav aşağıda kare dalga (tok gövde) → alçak geçiren filtre
  function createEngineVoice(output) {
    const osc = ctx.createOscillator()
    osc.type = 'sawtooth'
    const sub = ctx.createOscillator()
    sub.type = 'square'
    const filter = ctx.createBiquadFilter()
    filter.type = 'lowpass' // tiz kısmı kes: uğultu boğuk ve alçak kalsın
    filter.Q.value = 6 // kesme frekansında hafif tepe: motor "hırlasın"
    const gain = ctx.createGain()
    gain.gain.value = 0
    osc.connect(filter)
    sub.connect(filter)
    filter.connect(gain).connect(output)
    osc.start()
    sub.start()
    return { osc, sub, filter, gain }
  }

  // ratio: hız / azami hız (0–1). boost: 0–1. Hızlandıkça perde ve filtre açılır, boost ikisini de iter
  function setEngine(voice, ratio, boost, active, volume = 1) {
    const frequency = 42 + 115 * ratio + 60 * boost
    glide(voice.osc.frequency, frequency)
    glide(voice.sub.frequency, frequency / 2)
    glide(voice.osc.detune, slowDetune())
    glide(voice.sub.detune, slowDetune())
    glide(voice.filter.frequency, 220 + 1500 * ratio + 1800 * boost)
    glide(voice.gain.gain, active ? (0.07 + 0.08 * ratio + 0.08 * boost) * volume : 0, 0.08)
  }

  // İtici: döngüdeki beyaz gürültü → bant geçiren filtre = "fışş". Gücü roket gücüne bağlı
  function createThrusterVoice() {
    const source = ctx.createBufferSource()
    source.buffer = noise
    source.loop = true
    const filter = ctx.createBiquadFilter()
    filter.type = 'bandpass'
    filter.frequency.value = 2200
    filter.Q.value = 0.8
    const gain = ctx.createGain()
    gain.gain.value = 0
    source.connect(filter).connect(gain).connect(bus)
    source.start()
    return { source, filter, gain }
  }

  // ===================================================================
  // Tek seferlik sesler: osilatör ya da gürültü + zarf
  // ===================================================================

  // Çalan kaynağı kaydet (ağır çekim anında da yavaşlasın); bitince kendini siler
  function track(source, kind) {
    const item = { source, kind }
    live.add(item)
    source.onended = () => live.delete(item)
  }

  // Zarf (envelope): ses düzeyinin zaman içindeki şekli. attack: hızla yüksel, decay: üstel olarak sön
  function envelope(gain, peak, attack, decay, start) {
    gain.gain.setValueAtTime(0.0001, start) // üstel geçiş 0'dan başlayamaz: neredeyse 0
    gain.gain.exponentialRampToValueAtTime(peak, start + attack)
    gain.gain.exponentialRampToValueAtTime(0.0001, start + attack + decay)
  }

  // Osilatör notası. Ağır çekimde süreler 1/timeScale kat uzar, perde detune ile düşer
  function tone({ type = 'triangle', freq, freqEnd, peak, attack = 0.005, decay, delay = 0 }) {
    if (!ctx || !enabled) return
    const stretch = 1 / rate()
    const t = ctx.currentTime + delay * stretch
    const length = (attack + decay) * stretch
    const osc = ctx.createOscillator()
    osc.type = type
    osc.frequency.setValueAtTime(freq, t)
    if (freqEnd) osc.frequency.exponentialRampToValueAtTime(freqEnd, t + length)
    osc.detune.value = slowDetune()
    const gain = ctx.createGain()
    envelope(gain, peak, attack * stretch, decay * stretch, t)
    osc.connect(gain).connect(bus)
    osc.start(t)
    osc.stop(t + length + 0.05)
    track(osc, 'osc')
  }

  // Filtrelenmiş gürültü patlaması. playbackRate ağır çekimde düşer: gürültü de "yavaşlar"
  function noiseBurst({ filterType = 'bandpass', freq, freqEnd, q = 1, peak, attack = 0.005, decay, delay = 0 }) {
    if (!ctx || !enabled) return
    const stretch = 1 / rate()
    const t = ctx.currentTime + delay * stretch
    const length = (attack + decay) * stretch
    const source = ctx.createBufferSource() // kaynak düğümü tek kullanımlıktır; tampon (noise) paylaşılır
    source.buffer = noise
    source.playbackRate.value = rate()
    const filter = ctx.createBiquadFilter()
    filter.type = filterType
    filter.Q.value = q
    filter.frequency.setValueAtTime(freq, t)
    if (freqEnd) filter.frequency.exponentialRampToValueAtTime(freqEnd, t + length)
    const gain = ctx.createGain()
    envelope(gain, peak, attack * stretch, decay * stretch, t)
    source.connect(filter).connect(gain).connect(bus)
    source.start(t, Math.random() * 1.5) // tamponun rastgele yerinden: her puf biraz farklı
    source.stop(t + length + 0.05)
    track(source, 'buffer')
  }

  // Token "çın": türüne göre kısa arpej; altın daha yüksek, uzun ve parıltılı (üstte bir oktav sinüs)
  function collect(type) {
    const gold = type === 4
    const notes = COLLECT_NOTES[type] ?? COLLECT_NOTES[0]
    notes.forEach((freq, i) => {
      tone({ type: 'triangle', freq, peak: gold ? 0.2 : 0.14, decay: gold ? 0.45 : 0.22, delay: i * 0.055 })
      if (gold) tone({ type: 'sine', freq: freq * 2, peak: 0.06, decay: 0.7, delay: i * 0.055 + 0.02 })
    })
  }

  // Boost: yükselen "vıınnn" (frekansı süpüren testere dişi) + açılan bir rüzgâr
  function boostStart() {
    tone({ type: 'sawtooth', freq: 150, freqEnd: 950, peak: 0.13, attack: 0.05, decay: 0.7 })
    noiseBurst({ freq: 500, freqEnd: 4500, q: 1.2, peak: 0.16, attack: 0.08, decay: 0.6 })
  }

  // Çarpışma ve düşüş: boğuk patlama = kapanan alçak geçiren filtreden gürültü + aşağı kayan bir "güm"
  function explosion() {
    noiseBurst({ filterType: 'lowpass', freq: 1000, freqEnd: 110, q: 0.7, peak: 0.6, attack: 0.01, decay: 0.95 })
    tone({ type: 'sine', freq: 95, freqEnd: 32, peak: 0.5, decay: 0.6 })
  }

  // Yan itici: çok kısa, tiz bir puf (duman sık çıkar; ses en fazla SIDE_PUFF_GAP'te bir)
  function sidePuff() {
    if (!ctx || ctx.currentTime - lastSidePuff < SIDE_PUFF_GAP) return
    lastSidePuff = ctx.currentTime
    noiseBurst({ freq: 2800, q: 1.6, peak: 0.1, attack: 0.004, decay: 0.08 })
  }

  // Geri sayım: 3-2-1 kısa bip, BAŞLA daha tiz ve uzun
  const countdown = () => tone({ type: 'square', freq: 660, peak: 0.08, decay: 0.14 })
  function go() {
    tone({ type: 'square', freq: 1320, peak: 0.09, decay: 0.38 })
    tone({ type: 'triangle', freq: 1980, peak: 0.05, decay: 0.38 })
  }

  // Bitiş fanfarı: Do-Mi-Sol-Do yükselişi, son nota akorla uzun
  function fanfare() {
    const notes = [NOTE.C5, NOTE.E5, NOTE.G5, NOTE.C6]
    notes.forEach((freq, i) => {
      const last = i === notes.length - 1
      tone({ type: 'square', freq, peak: 0.07, decay: last ? 0.8 : 0.12, delay: i * 0.11 })
      tone({ type: 'triangle', freq: freq * 2, peak: 0.05, decay: last ? 0.8 : 0.12, delay: i * 0.11 })
    })
    tone({ type: 'triangle', freq: NOTE.E6, peak: 0.05, decay: 0.8, delay: 0.33 })
    tone({ type: 'triangle', freq: NOTE.G5, peak: 0.05, decay: 0.8, delay: 0.33 })
  }

  // ===================================================================
  // Rakip motorları: PannerNode ile 3B konum (uzaklıkla kısılır, sağ-sol dengesi)
  // ===================================================================
  const setPosition = (node, p) => {
    if (node.positionX) {
      node.positionX.value = p.x
      node.positionY.value = p.y
      node.positionZ.value = p.z
    } else node.setPosition(p.x, p.y, p.z) // eski tarayıcı (Firefox'un dinleyicisi) yöntemi
  }

  function remoteVoice(id) {
    let voice = remoteVoices.get(id)
    if (voice || remoteVoices.size >= MAX_REMOTE_VOICES) return voice
    // inverse: ses düzeyi ≈ refDistance / uzaklık. 18 birimde tam, 180'de onda bir; 900'den sonra azalmaz
    const panner = ctx.createPanner()
    panner.panningModel = 'equalpower' // HRTF daha gerçekçi ama pahalı; sağ-sol yeterli
    panner.distanceModel = 'inverse'
    panner.refDistance = 18
    panner.maxDistance = 900
    panner.rolloffFactor = 1.4
    panner.connect(bus)
    voice = { ...createEngineVoice(panner), panner }
    remoteVoices.set(id, voice)
    return voice
  }

  function dropRemote(id, voice) {
    voice.gain.gain.setTargetAtTime(0, ctx.currentTime, 0.05)
    voice.osc.stop(ctx.currentTime + 0.3)
    voice.sub.stop(ctx.currentTime + 0.3)
    remoteVoices.delete(id)
  }

  // Dinleyici = kamera: konumu ve baktığı yön (rakip sağdaysa sağ kulakta duyulsun)
  const forward = { x: 0, y: 0, z: -1 }
  function setListener(camera) {
    const l = ctx.listener
    const e = camera.matrixWorld.elements // matrisin 3. sütunu kameranın arkası (−z ileri), 2. sütunu yukarısı
    forward.x = -e[8]
    forward.y = -e[9]
    forward.z = -e[10]
    if (l.positionX) {
      l.positionX.value = camera.position.x
      l.positionY.value = camera.position.y
      l.positionZ.value = camera.position.z
      l.forwardX.value = forward.x
      l.forwardY.value = forward.y
      l.forwardZ.value = forward.z
      l.upX.value = e[4]
      l.upY.value = e[5]
      l.upZ.value = e[6]
    } else {
      l.setPosition(camera.position.x, camera.position.y, camera.position.z)
      l.setOrientation(forward.x, forward.y, forward.z, e[4], e[5], e[6])
    }
  }

  // ===================================================================
  // Her kare (main.js): hız, boost, roket gücü, ağır çekim, kamera, rakipler
  // ===================================================================
  // active: yarış / sonuç ekranında mı (giriş, garaj ve lobide motor susar)
  // remotes: [{ id, position, speed }] — çizilen rakip arabalar
  function update({ speedRatio, boost, thrust, active, timeScale: ts, camera, remotes = [] }) {
    if (!ctx) return
    timeScale = ts

    setEngine(engine, speedRatio, boost, active)
    glide(thruster.gain.gain, active ? thrust * thrust * 0.16 : 0, 0.04) // süzülürken (güç 1) tam "fışş"
    glide(thruster.filter.frequency, 1600 + 1600 * thrust)
    thruster.source.playbackRate.value = rate()

    // Çalmakta olan tek seferlik sesler de ağır çekime uysun
    for (const { source, kind } of live) {
      if (kind === 'osc') source.detune.value = slowDetune()
      else source.playbackRate.value = rate()
    }

    camera.updateMatrixWorld()
    setListener(camera)
    const seen = new Set()
    for (const r of remotes) {
      const voice = remoteVoice(r.id)
      if (!voice) continue
      seen.add(r.id)
      setPosition(voice.panner, r.position)
      setEngine(voice, Math.min(1, r.speed / 70), Math.max(0, (r.speed - 70) / 70), active, 0.7)
    }
    for (const [id, voice] of remoteVoices) if (!seen.has(id)) dropRemote(id, voice)
  }

  return {
    unlock,
    setEnabled,
    update,
    collect,
    boostStart,
    explosion,
    sidePuff,
    countdown,
    go,
    fanfare,
    onChange: (fn) => listeners.push(fn),
    get enabled() {
      return enabled
    },
    get context() {
      return ctx // test ve hata ayıklama için (AudioContext; ilk tıklamadan önce null)
    },
  }
}

// Sağ üstte ses aç/kapa düğmesi. Tercih localStorage'da kalır (createAudio okur ve yazar)
export function createSoundToggle(audio) {
  const button = document.createElement('button')
  button.className = 'sound-toggle'
  const render = () => {
    button.textContent = audio.enabled ? '🔊' : '🔇'
    button.title = audio.enabled ? 'Sesi kapat' : 'Sesi aç'
    button.setAttribute('aria-label', button.title)
    button.classList.toggle('off', !audio.enabled)
  }
  button.addEventListener('click', () => audio.setEnabled(!audio.enabled))
  audio.onChange(render)
  render()
  document.body.appendChild(button)
}
