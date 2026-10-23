// Betiklerin gizli ayarları: server/.env ve contracts/.env (ikisi de .gitignore'da). Komut satırında verilen
// ortam değişkeni (ör. FUNDER_KEY=0x... node scripts/fund.js ...) dosyadakini ezer.
// Anahtarlar ASLA ekrana yazılmaz: betikler sadece anahtardan türeyen ADRESİ gösterir.
import { existsSync, readFileSync } from 'node:fs'

const FILES = ['../server/.env', '../contracts/.env']

export function readEnv() {
  const values = {}
  for (const file of FILES) {
    const url = new URL(file, import.meta.url)
    if (!existsSync(url)) continue
    for (const line of readFileSync(url, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/) // # ile başlayan satırlar eşleşmez
      if (m && m[2] !== '' && !(m[1] in values)) values[m[1]] = m[2].replace(/^['"]|['"]$/g, '')
    }
  }
  for (const [k, v] of Object.entries(process.env)) if (v && /^[A-Z0-9_]+$/.test(k)) values[k] = v
  return values
}

export const isPrivateKey = (k) => /^0x[0-9a-fA-F]{64}$/.test(k ?? '')
