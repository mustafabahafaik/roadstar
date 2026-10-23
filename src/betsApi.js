import { SERVER_URL } from './net.js'

// Sunucunun bahis uçları (düz HTTP). İzleyici sayfası Socket.IO açmaz: 100 telefon için 2 sn'de bir küçük bir JSON yeter

const post = (path, body) =>
  fetch(`${SERVER_URL}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json())

// Oda adı sunucudaki kuralla aynı (küçük harf, a-z 0-9 -, en fazla 20)
export const cleanRoom = (text) =>
  String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '')
    .slice(0, 20) || 'monad'

// { status, racers: [{ id, name, color, address, index, bets, odds, progress, status }], totalBets, pool, winner, ... }
export const fetchBets = (room) => fetch(`${SERVER_URL}/bets/${encodeURIComponent(room)}`).then((r) => r.json())
export const requestFaucet = (address) => post('/faucet', { address })
export const reportBet = (room, hash, ms) => post(`/bets/${encodeURIComponent(room)}/confirm`, { hash, ms }).catch(() => {})

// 3.3x · 12x · — (henüz bahis yok)
export const formatOdds = (odds) => (odds ? `${odds >= 10 ? odds.toFixed(0) : odds.toFixed(1)}x` : '—')
