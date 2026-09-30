/**
 * Free mail hosts. Everybody is @gmail.com, so having written to one person
 * there says nothing about the next stranger from the same host: domain-wide
 * trust is only ever earned by a domain that belongs to somebody.
 */
export const SHARED_EMAIL_DOMAINS = new Set([
  'aol.com',
  'bluewin.ch',
  'gmail.com',
  'gmx.at',
  'gmx.ch',
  'gmx.de',
  'gmx.net',
  'googlemail.com',
  'hispeed.ch',
  'hotmail.ch',
  'hotmail.com',
  'hotmail.de',
  'icloud.com',
  'live.com',
  'mac.com',
  'me.com',
  'msn.com',
  'outlook.com',
  'outlook.de',
  'proton.me',
  'protonmail.com',
  'sunrise.ch',
  'web.de',
  'yahoo.com',
  'yahoo.de',
  'yandex.com'
])

/** The host part of an address, lowercased. Empty when there is none. */
export function emailDomain(email: string): string {
  const at = email.lastIndexOf('@')
  return at === -1 ? '' : email.slice(at + 1).trim().toLowerCase()
}

/** Whether trusting a whole domain says anything about who is behind it. */
export function isSharedDomain(domain: string): boolean {
  return SHARED_EMAIL_DOMAINS.has(domain.toLowerCase())
}
