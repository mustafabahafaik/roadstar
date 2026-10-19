// Dışarıdan gelen yazıyı (oyuncu takma adı, RPC hata mesajı) HTML'e koymadan önce zararsızlaştır.
// Yoksa biri adını "<img src=x onerror=...>" yapıp herkesin tarayıcısında kod çalıştırabilir (XSS)
export const escapeHtml = (text) =>
  String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

// 0x00f0ff → '#00f0ff'
export const toCssColor = (hex) => `#${hex.toString(16).padStart(6, '0')}`
