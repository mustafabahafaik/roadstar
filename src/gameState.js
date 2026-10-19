// Oyunun durum makinesi: oyun aynı anda yalnızca BİR durumdadır, geçişler kurallıdır.
//
//   countdown ──BAŞLA──▶ racing ──kenardan düştü──▶ falling ──2 sn──▶ racing
//                          │                           └──kalkan yok──▶ finished
//                          └──tur bitti──▶ finished
//
// Dağınık bayraklar (isFalling, isFinished...) yerine tek bir durum: "aynı anda hem düşüyor hem
// bitmiş" gibi imkânsız karışımlar oluşamaz. Durum değişince dinleyicilere haber verilir.
export const GAME_STATE = {
  COUNTDOWN: 'countdown',
  RACING: 'racing',
  FALLING: 'falling',
  FINISHED: 'finished',
}

// İzin verilen geçişler: buradaki listede olmayan bir geçiş denenirse yok sayılır
const TRANSITIONS = {
  countdown: ['racing'],
  racing: ['falling', 'finished'],
  falling: ['racing', 'finished'],
  finished: [],
}

export function createGameState(initial = GAME_STATE.COUNTDOWN) {
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
