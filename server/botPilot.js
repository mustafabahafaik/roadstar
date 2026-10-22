// Bir botun beyni: sunucuya insan oyuncuyla AYNI protokolle bağlanır (aynı hile kontrolü, aynı zincir doğrulaması).
// Ücretli odada kendi cüzdanıyla gerçekten joinRoom yapar; kazanırsa ödülünü settle + withdraw ile çeker.
// Sürüş: pist eğrisini takip eder, tempo %85-%100 arasında değişir, ara sıra hata yapar, bazen takla atar.
import { io } from 'socket.io-client'
import * as THREE from 'three'
import { Wallet, Contract, NonceManager, getAddress, formatEther } from 'ethers'
import { trackCurve, trackLength, TRACK_WIDTH } from '../src/track.js'
import { buildCourse } from '../src/course.js'
import { rampSurfaceIn } from '../src/ramps.js'
import { SEND_RATE, POOL_GAS_LIMITS, ownershipMessage } from '../shared/protocol.js'
import { SLOTS, partsInSlot } from '../src/parts.js'
import { getMap } from '../src/maps.js'

// --- Sürüş ayarları ---
const TOP_SPEED = 66 // insanın azami hızı 70 (boost'la 140): iyi süren insan botu geçebilsin
const PACE_RANGE = [0.85, 1.0] // tempo: azami hızın yüzde kaçı
const PACE_CHANGE = [2, 5] // tempo kaç saniyede bir yeniden seçilsin
const ACCELERATION = 30 // car.js ile aynı
const STRAFE_SPEED = 12 // yana kayma hızı (car.js 14)
const JUMP_VELOCITY = 22 // car.js ile aynı
const GRAVITY = 22 // havada roketle süzülür (car.js HOVER_GRAVITY): ~2 sn uçuş, tırı bile aşar
const LANE = TRACK_WIDTH / 4 // şerit merkezi: ±4
const LOOK_AHEAD = 70 // kaç birim ilerideki engele tepki versin
const MISTAKE_RATE = 0.06 // saniyede hata olasılığı (yarış başına ~3)
const FUN_JUMP_RATE = 0.03 // saniyede "boş yolda gösteriş zıplaması" olasılığı
const TRICK_CHANCE = 0.4 // uzun bir uçuşta takla atma olasılığı
const START_REACTION = [0, 0.4] // "BAŞLA"ya tepki süresi (sn)
const WALL_CLEARANCE = 1.2 // duvarın üstünden en az bu kadar yüksek geç
const FORM_RANGE = [0.92, 1.0] // botun o yarışki formu: azami hızı bununla çarpılır (her yarış farklı sıralama)

const POOL_ABI = [
  'function joinRoom(uint256 roomId) payable',
  'function settle(uint256 roomId, address[] ranking, bytes signature)',
  'function withdraw()',
  'function refund(uint256 roomId)',
  'function claimable(address account) view returns (uint256)',
  'function getRoom(uint256 roomId) view returns (uint256 entryFee, uint8 maxPlayers, uint64 createdAt, uint64 startedAt, bool settled, address[] players)',
]

const rand = (min, max) => min + Math.random() * (max - min)
// Botun garaj parçaları: her slottan rastgele biri (sadece görsel; demo'da garajın vitrini gibi dursunlar)
const randomLoadout = () =>
  SLOTS.map((_, slot) => {
    const options = partsInSlot(slot)
    return options[Math.floor(Math.random() * options.length)].id
  })
const clamp = (v, min, max) => Math.min(Math.max(v, min), max)
const UP = new THREE.Vector3(0, 1, 0)
const AXIS_X = new THREE.Vector3(1, 0, 0)
const AXIS_Z = new THREE.Vector3(0, 0, 1)

// Bir yarışlık sürücü: seed'den parkuru kurar (oyunla birebir aynı), her adımda yeni durumu hesaplar.
// gravityScale: haritanın yerçekimi (Satürn 0.6): zıplama zamanlaması ve uçuş süresi buna göre
export function createDriver(seed, topSpeed, gravityScale = 1) {
  const gravity = GRAVITY * gravityScale
  topSpeed *= rand(...FORM_RANGE) // bugün formda mı?
  const course = buildCourse(seed)
  // Kopyala: buildCourse ortak bir nesneyi günceller, başka odadaki bot onu değiştirebilir
  const ramps = course.ramps
  const obstacles = course.obstacles.map((o) => ({ along: o.u * trackLength, type: o.type, center: o.offset * (TRACK_WIDTH / 2), height: o.height ?? 0 }))

  const s = {
    distance: 0,
    speed: 0,
    offset: rand(-2, 2),
    lateral: 0, // yanal hız (yatış için)
    height: 0,
    vy: 0,
    airborne: false,
    lastGround: { height: 0, slope: 0 },
    pace: rand(...PACE_RANGE),
    paceTimer: rand(...PACE_CHANGE),
    mistake: null, // { type: 'slow' | 'drift', time, side }
    flip: null, // { axis, dir, time, duration }
    tricks: 0,
    mistakes: 0,
  }
  const body = new THREE.Object3D()
  const side = new THREE.Vector3()
  const look = new THREE.Vector3()

  // Duvarın üstünden geçmek için şu an gereken dikey hız. Duvara varış süresi t = mesafe / hız;
  // yukarı atış: h + v·t − ½·g·t² ≥ duvar + pay  →  v ≥ (duvar + pay − h + ½·g·t²) / t
  function neededVy(wall, distance) {
    const t = distance / Math.max(s.speed, 1)
    return (wall.height + WALL_CLEARANCE - s.height + 0.5 * gravity * t * t) / t
  }

  function takeOff(vy) {
    s.airborne = true
    s.vy = vy
    const airtime = (2 * vy) / gravity
    if (airtime > 1.2 && Math.random() < TRICK_CHANCE) {
      // Takla: öne (X ekseni) ya da yana (Z ekseni) tam tur, inişten önce bitsin
      s.flip = { axis: Math.random() < 0.6 ? AXIS_X : AXIS_Z, dir: Math.random() < 0.5 ? -1 : 1, time: 0, duration: airtime * 0.75 }
    }
  }

  function step(dt) {
    // 1) Tempo: birkaç saniyede bir %85-%100 arası yeni hedef
    s.paceTimer -= dt
    if (s.paceTimer <= 0) {
      s.pace = rand(...PACE_RANGE)
      s.paceTimer = rand(...PACE_CHANGE)
    }
    let target = topSpeed * s.pace
    let laneTarget = Math.sin(s.distance / 90) * 2 // engel yokken hafif dalgalı sürüş

    // 2) Engeller: önümüzdeki (ya da hemen yanımızdaki) ilk engel
    const ahead = obstacles.find((o) => o.along - s.distance > -14 && o.along - s.distance < LOOK_AHEAD)
    if (ahead) {
      const gap = ahead.along - s.distance
      if (ahead.type === 'wall') {
        // Duvar tüm yolu kaplar: tepe noktası duvarın üstüne denk gelecek şekilde zıpla (geç kaldıysa daha sert)
        if (!s.airborne && gap > 0 && gap < s.speed * (JUMP_VELOCITY / gravity) + 2) takeOff(Math.max(JUMP_VELOCITY, neededVy(ahead, gap)))
      } else {
        laneTarget = -Math.sign(ahead.center) * LANE // kule / tır bir şeritte: karşı şeride geç
      }
    }

    // 3) Hata (sadece önü boşken: engelin içine kaymasın)
    if (!ahead && !s.mistake && !s.airborne && Math.random() < MISTAKE_RATE * dt) {
      s.mistake = Math.random() < 0.5 ? { type: 'slow', time: rand(1, 2) } : { type: 'drift', time: rand(1.2, 2), side: Math.random() < 0.5 ? -1 : 1 }
      s.mistakes++
    }
    if (s.mistake) {
      if (s.mistake.type === 'slow') target *= 0.45 // gazdan ayak çekti
      else laneTarget = s.mistake.side * 7 // kenara kaydı (düşme sınırı 9)
      s.mistake.time -= dt
      if (s.mistake.time <= 0) s.mistake = null
    }
    // Gösteriş zıplaması: inişi bir duvara denk gelmesin (düşük yerçekiminde uçuş 3 sn'yi geçer)
    const nextWall = obstacles.find((o) => o.type === 'wall' && o.along > s.distance - 2)
    const flight = ((2 * JUMP_VELOCITY) / gravity) * s.speed + 30
    const wallInFlight = nextWall && nextWall.along - s.distance < flight
    if (!ahead && !wallInFlight && !s.airborne && Math.random() < FUN_JUMP_RATE * dt) takeOff(JUMP_VELOCITY)

    // 4) Hız: hızlanırken araba gibi (ivmeyle), yavaşlarken yumuşak
    if (s.speed < target) s.speed = Math.min(target, s.speed + ACCELERATION * dt)
    else s.speed += (target - s.speed) * (1 - Math.exp(-2 * dt))

    // 5) Yana kayma (en fazla STRAFE_SPEED)
    const move = clamp(laneTarget - s.offset, -STRAFE_SPEED * dt, STRAFE_SPEED * dt)
    s.offset += move
    s.lateral = move / dt

    // 6) İlerle
    s.distance = Math.min(s.distance + s.speed * dt, trackLength)
    const u = (s.distance / trackLength) % 1

    // 7) Dikey: rampa yüzeyi, rampanın ucundan fırlama, zıplama ve iniş
    const ground = rampSurfaceIn(ramps, u, s.offset)
    if (s.airborne) {
      s.vy -= gravity * dt
      // Havadayken duvar yaklaşıyor ve bu hızla altından geçecektik (önceki uçuşun inişi duvara denk geldi):
      // insanın Space'e basılı tutması gibi roketle yüksel: dikey hızı tam yetecek kadar artır
      const toWall = nextWall ? nextWall.along - s.distance : Infinity
      if (toWall > 0 && toWall < 45) s.vy = Math.max(s.vy, neededVy(nextWall, toWall))
      s.height += s.vy * dt
      if (s.flip) s.flip.time += dt
      if (s.vy < 0 && s.height <= ground.height) {
        s.airborne = false
        s.height = ground.height
        s.vy = 0
        if (s.flip && s.flip.time >= s.flip.duration) s.tricks++
        s.flip = null
      }
    } else if (s.lastGround.height > 0.5 && ground.height < s.lastGround.height) {
      takeOff(s.lastGround.slope * s.speed) // rampanın dudağını geçti: eğimle orantılı fırla
      s.height = s.lastGround.height
    } else {
      s.height = ground.height
    }
    s.lastGround = ground

    // 8) Dünyadaki konum + duruş (oyundaki car.js ile aynı yöntem)
    const tangent = trackCurve.getTangentAt(u)
    side.crossVectors(tangent, UP).normalize()
    body.position.copy(trackCurve.getPointAt(u)).addScaledVector(side, s.offset).addScaledVector(UP, s.height)
    body.lookAt(look.copy(body.position).add(tangent))
    body.rotateZ(clamp(-s.lateral * 0.03, -0.35, 0.35)) // yana kayarken yatış
    if (s.flip) body.rotateOnAxis(s.flip.axis, s.flip.dir * Math.PI * 2 * Math.min(1, s.flip.time / s.flip.duration))

    const q = body.quaternion
    return {
      x: body.position.x,
      y: body.position.y,
      z: body.position.z,
      rotation: [q.x, q.y, q.z, q.w],
      speed: s.speed,
      progress: s.distance / trackLength,
      status: 'racing',
      u, // pist üzerindeki konum: alıcı paket gecikince bununla tahmin yürütür (src/remoteMotion.js)
      off: s.offset,
      h: s.height,
    }
  }

  return { step, stats: s, finished: () => s.distance >= trackLength }
}

// serverUrl, room: hangi sunucu / oda. key + provider + poolAddress: ücretli odada ödeme için (yoksa ücretsiz)
// botToken: sunucunun "bu bir bot" anahtarı (bots.js verir). onDone({ paidRoomId }): bot ayrılınca
export function createBotPilot({ serverUrl, room, name, key, provider, poolAddress, botToken, topSpeed = TOP_SPEED, log = console.log, onDone }) {
  const wallet = key ? new Wallet(key, provider) : null
  // NonceManager: nonce'u RPC'ye her işlemde sormak yerine kendisi sayar (RPC geç güncellenirse
  // aynı numara iki kez kullanılıp işlem reddedilir; oyundaki chain.js de bu yüzden kendisi sayar)
  const signer = wallet ? new NonceManager(wallet) : null
  const pool = signer && poolAddress ? new Contract(poolAddress, POOL_ABI, signer) : null
  const socket = io(serverUrl, { reconnection: false })
  let offset = 0 // sunucu saati − bizim saatimiz
  let paying = false
  let paidRoomId = null // ödeme yaptığı zincir odası (yarış olmadan ayrılırsa iade için)
  let raced = false
  let leaving = false
  let timer = null
  const serverNow = () => Date.now() + offset

  function leave(reason) {
    if (leaving) return
    leaving = true
    clearInterval(timer)
    socket.disconnect()
    log(`${name} ayrıldı: ${reason}`)
    onDone?.({ name, paidRoomId: raced ? null : paidRoomId })
  }

  // Oyundaki gibi ping/pong saat eşitlemesi (src/net.js)
  async function syncClock() {
    let best = null
    for (let i = 0; i < 3; i++) {
      const t0 = Date.now()
      const ts = await socket.emitWithAck('clock')
      const t1 = Date.now()
      if (!best || t1 - t0 < best.rtt) best = { rtt: t1 - t0, offset: ts - (t0 + t1) / 2 }
    }
    offset = best.offset
  }

  // Ücretli oda: bakiye kontrolü → (zincir odası numarası) → joinRoom → sunucuya "ödedim" → hazır
  async function pay(chain) {
    if (paying) return
    if (!pool) return leave('cüzdan yok, ücretli odaya giremez')
    paying = true
    try {
      const fee = BigInt(chain.entryFee)
      const feeData = await provider.getFeeData()
      const need = fee + POOL_GAS_LIMITS.joinRoom * (feeData.maxFeePerGas ?? feeData.gasPrice)
      const balance = await provider.getBalance(wallet.address)
      if (balance < need) throw new Error(`bakiye yetersiz: ${formatEther(balance)} MON (gereken ~${formatEther(need)})`)

      const claim = await socket.emitWithAck('claimChainRoom', {})
      if (!claim.ok) throw new Error(claim.error)
      const [, , , , , players] = await pool.getRoom(claim.roomId)
      if (!players.map((p) => getAddress(p)).includes(wallet.address)) {
        await (await pool.joinRoom(claim.roomId, { value: fee, gasLimit: POOL_GAS_LIMITS.joinRoom })).wait()
      }
      paidRoomId = claim.roomId
      const res = await socket.emitWithAck('chainJoined', { roomId: claim.roomId })
      if (!res.ok) throw new Error(res.error)
      log(`${name}: ${formatEther(fee)} MON yatırdı (zincir odası #${claim.roomId})`)
      socket.emit('ready', true)
    } catch (err) {
      signer.reset() // gönderilemeyen işlem sayacı boşa artırdıysa zincirden yeniden öğren
      leave(`ödeme olmadı (${err.shortMessage ?? err.message})`)
    }
    paying = false
  }

  function onRoom(r) {
    if (leaving || raced || r.status !== 'lobby') return
    const me = r.players.find((p) => p.id === socket.id)
    if (!me) return
    // Odada (bağlı) insan kalmadıysa çık: botlar kendi kendine yarışmasın. Ama zincir odası dolduysa
    // (kontrat "başladı" saydı, iade 1 gün sonra) kal ve yarış: kopan insan DNF olur, para dağıtılabilir
    const humans = r.players.some((p) => !p.bot && !p.left)
    const full = r.chain && r.players.length === r.chain.maxPlayers && r.players.every((p) => p.paid)
    if (!humans && !full) return leave('odada insan kalmadı')
    if (paidRoomId && !r.chain) return leave('zincir odasının süresi doldu (iade alınacak)')
    if (r.chain && !me.paid) return pay(r.chain)
    if (!me.ready && (!r.chain || me.paid)) socket.emit('ready', true)
  }

  function onStart({ seed, startAt, map }) {
    const driver = createDriver(seed, topSpeed, getMap(map).gravity)
    const reactAt = startAt + rand(...START_REACTION) * 1000
    let last = 0
    clearInterval(timer)
    timer = setInterval(() => {
      const now = serverNow()
      if (now < reactAt) return
      const dt = last ? Math.min((now - last) / 1000, 0.2) : 1 / SEND_RATE // gerçek geçen süre: zamanlayıcı gecikse de hız aşılmaz
      last = now
      const state = driver.step(dt)
      socket.emit('state', { ...state, t: now - startAt, sentAt: Math.round(now) }) // sentAt: ortak saatle gönderildiği an
      if (driver.finished()) {
        clearInterval(timer)
        socket.emit('finish')
        const st = driver.stats
        log(`${name} bitirdi: ${((now - startAt) / 1000).toFixed(1)} sn · ${st.tricks} takla · ${st.mistakes} hata`)
      }
    }, 1000 / SEND_RATE)
  }

  // Kazandıysa (1. ya da 2.): oda sonuçlanmadıysa settle, sonra withdraw. Para botta dönsün, havuzda birikmesin
  async function claimPrize(settlement) {
    if (!settlement || !pool) return
    const place = settlement.ranking.indexOf(wallet.address)
    if (place !== 0 && place !== 1) return
    try {
      const [, , , , settled] = await pool.getRoom(settlement.roomId)
      if (!settled) {
        try {
          await (await pool.settle(settlement.roomId, settlement.ranking, settlement.signature, { gasLimit: POOL_GAS_LIMITS.settle })).wait()
        } catch (err) {
          signer.reset()
          const [, , , , nowSettled] = await pool.getRoom(settlement.roomId)
          if (!nowSettled) throw err // başka biri aynı anda settle etmiş olabilir: o zaman sorun yok
        }
      }
      const amount = await pool.claimable(wallet.address)
      if (amount > 0n) {
        await (await pool.withdraw({ gasLimit: POOL_GAS_LIMITS.withdraw })).wait()
        log(`${name}: ödülünü çekti +${formatEther(amount)} MON`)
      }
    } catch (err) {
      log(`${name}: ödül çekilemedi (${err.shortMessage ?? err.message})`)
    }
  }

  socket.on('connect', async () => {
    try {
      await syncClock()
      const proof = wallet ? await wallet.signMessage(ownershipMessage(socket.id)) : undefined
      const res = await socket.emitWithAck('join', { name, room, address: wallet?.address, proof, botToken, loadout: randomLoadout() })
      if (!res.ok) return leave(`katılamadı (${res.error})`)
      onRoom(res.room)
    } catch (err) {
      leave(`bağlanamadı (${err.message})`)
    }
  })
  socket.on('connect_error', () => leave('sunucuya bağlanamadı'))
  socket.on('room', onRoom)
  socket.on('start', (data) => {
    raced = true // yarış başladı: artık ayrılırsa iade değil, DNF
    onStart(data)
  })
  socket.on('results', async ({ settlement }) => {
    clearInterval(timer)
    await claimPrize(settlement)
    leave('yarış bitti')
  })
  socket.on('disconnect', () => leave('bağlantı koptu'))

  return { leave, address: wallet?.address }
}
