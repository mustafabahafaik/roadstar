// Oyunun durum makinesi: oyun aynı anda yalnızca BİR durumdadır, geçişler kurallıdır.
//
//   lobby ──Başlat──▶ countdown ──3-2-1──▶ racing ──kenardan düştü──▶ falling ──yeniden doğdu──▶ racing
//                                            ├──bitiş kapısı──▶ finished
//                                            └──çıktı / süre doldu / bağlantı koptu──▶ dnf
//
// Dağınık bayraklar (isFalling, isFinished...) yerine tek bir durum: "aynı anda hem düşüyor hem
// bitmiş" gibi imkânsız karışımlar oluşamaz. Durum değişince dinleyicilere haber verilir.
export const GAME_STATE = {
  LOBBY: 'lobby', // yarış başlamadı: oyuncular hazırlanıyor (çok oyunculuda burada buluşulacak)
  COUNTDOWN: 'countdown',
  RACING: 'racing',
  FALLING: 'falling',
  FINISHED: 'finished', // bitiş kapısından geçti
  DNF: 'dnf', // Did Not Finish: yarıştan çıktı, süre doldu ya da bağlantı koptu (düşmek DNF değil)
}

// İzin verilen geçişler: buradaki listede olmayan bir geçiş denenirse yok sayılır
const TRANSITIONS = {
  lobby: ['countdown'],
  countdown: ['racing'],
  racing: ['falling', 'finished', 'dnf'],
  falling: ['racing', 'dnf'],
  finished: [],
  dnf: [],
}

export function createGameState(initial = GAME_STATE.LOBBY) {
  let current = initial
  const listeners = []

  return {
    get current() {
      return current
    },
    is(state) {
      return current === state
    },
    // Geçiş kurallara uyuyorsa yap ve dinleyicilere (yeni, eski) durumu bildir
    set(next) {
      if (next === current || !TRANSITIONS[current].includes(next)) return false
      const previous = current
      current = next
      for (const listener of listeners) listener(next, previous)
      return true
    },
    onChange(listener) {
      listeners.push(listener)
    },
  }
}
