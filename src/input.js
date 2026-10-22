// Şu an basılı tutulan tuşlar. e.code klavye düzeninden bağımsızdır (Türkçe Q klavyede de 'KeyA')
const pressed = new Set()

// Lobide takma ad yazarken tuşlar oyunu sürmesin (W, boşluk, C, Shift...)
export const isTyping = (e) => e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement

window.addEventListener('keydown', (e) => {
  if (isTyping(e)) return
  pressed.add(e.code)
  if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault() // sayfa kaymasın
})
window.addEventListener('keyup', (e) => pressed.delete(e.code))
window.addEventListener('blur', () => pressed.clear()) // pencere değişince tuşlar takılı kalmasın

// Dokunmatik (touch.js): telefonda parmak yön düğmelerinde olduğu için yarışta gaz kendiliğinden basılı
let autoForward = false
export const setAutoForward = (on) => (autoForward = on)

export const input = {
  get forward() { return autoForward || pressed.has('KeyW') || pressed.has('ArrowUp') },
  get brake() { return pressed.has('KeyS') || pressed.has('ArrowDown') },
  get left() { return pressed.has('KeyA') || pressed.has('ArrowLeft') },
  get right() { return pressed.has('KeyD') || pressed.has('ArrowRight') },
  get jump() { return pressed.has('Space') },
  // Havada takla (tricks.js): Q / E kendi uzun ekseni etrafında yuvarlanma (barrel roll)
  get rollLeft() { return pressed.has('KeyQ') },
  get rollRight() { return pressed.has('KeyE') },
  // Dokunmatik takla düğmeleri: W gaz olarak sürekli basılı olduğu için havada "yeniden basma" olmuyor →
  // takla için ayrı (sahte) tuş kodları
  get trickForward() { return pressed.has('TouchTrickForward') },
  get trickBack() { return pressed.has('TouchTrickBack') },
}
