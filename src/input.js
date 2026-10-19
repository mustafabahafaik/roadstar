// Şu an basılı tutulan tuşlar. e.code klavye düzeninden bağımsızdır (Türkçe Q klavyede de 'KeyA')
const pressed = new Set()

window.addEventListener('keydown', (e) => {
  pressed.add(e.code)
  if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault() // sayfa kaymasın
})
window.addEventListener('keyup', (e) => pressed.delete(e.code))
window.addEventListener('blur', () => pressed.clear()) // pencere değişince tuşlar takılı kalmasın

export const input = {
  get forward() { return pressed.has('KeyW') || pressed.has('ArrowUp') },
  get brake() { return pressed.has('KeyS') || pressed.has('ArrowDown') },
  get left() { return pressed.has('KeyA') || pressed.has('ArrowLeft') },
  get right() { return pressed.has('KeyD') || pressed.has('ArrowRight') },
  get jump() { return pressed.has('Space') },
  // Havada takla (tricks.js): Q / E kendi uzun ekseni etrafında yuvarlanma (barrel roll)
  get rollLeft() { return pressed.has('KeyQ') },
  get rollRight() { return pressed.has('KeyE') },
}
