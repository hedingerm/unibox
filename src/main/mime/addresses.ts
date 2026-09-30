import type { EmailAddress } from '@shared/types'

function decodeEncodedWords(input: string): string {
  return input.replace(
    /=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g,
    (_match, charset: string, encoding: string, text: string) => {
      try {
        const normalized = charset.toLowerCase() === 'utf-8' ? 'utf8' : 'latin1'
        if (encoding.toUpperCase() === 'B') {
          return Buffer.from(text, 'base64').toString(normalized as BufferEncoding)
        }
        const bytes = text
          .replace(/_/g, ' ')
          .replace(/=([0-9A-Fa-f]{2})/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)))
        return Buffer.from(bytes, 'binary').toString(normalized as BufferEncoding)
      } catch {
        return text
      }
    }
  )
}

/** Splits an address header on commas that are not inside quotes or angle brackets. */
function splitAddressList(header: string): string[] {
  const parts: string[] = []
  let current = ''
  let inQuotes = false
  let depth = 0
  for (const char of header) {
    if (char === '"') inQuotes = !inQuotes
    if (!inQuotes && char === '<') depth += 1
    if (!inQuotes && char === '>') depth = Math.max(0, depth - 1)
    if (char === ',' && !inQuotes && depth === 0) {
      parts.push(current)
      current = ''
      continue
    }
    current += char
  }
  if (current.trim()) parts.push(current)
  return parts.map((p) => p.trim()).filter(Boolean)
}

export function parseAddress(input: string): EmailAddress | null {
  const value = decodeEncodedWords(input.trim())
  if (!value) return null
  const angle = value.match(/^(.*?)<([^>]+)>\s*$/)
  if (angle) {
    const rawName = (angle[1] ?? '').trim().replace(/^"(.*)"$/, '$1').trim()
    return { name: rawName || null, email: (angle[2] ?? '').trim() }
  }
  if (!value.includes('@')) return null
  return { name: null, email: value }
}

export function parseAddressList(header: string | null | undefined): EmailAddress[] {
  if (!header) return []
  return splitAddressList(header)
    .map(parseAddress)
    .filter((a): a is EmailAddress => a !== null)
}

function needsQuoting(name: string): boolean {
  return /[",;:<>@[\]\\]/.test(name)
}

function encodeWord(text: string): string {
  if (/^[\x20-\x7e]*$/.test(text)) return text
  return `=?UTF-8?B?${Buffer.from(text, 'utf8').toString('base64')}?=`
}

export function formatAddress(address: EmailAddress): string {
  if (!address.name) return address.email
  const encoded = encodeWord(address.name)
  const name =
    needsQuoting(encoded) && !encoded.startsWith('=?')
      ? `"${encoded.replace(/"/g, '\\"')}"`
      : encoded
  return `${name} <${address.email}>`
}

export function formatAddressList(addresses: EmailAddress[]): string {
  return addresses.map(formatAddress).join(', ')
}

export function sameAddress(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase()
}

export { decodeEncodedWords }
