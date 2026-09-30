/** What a `mailto:` link asks the composer to open. */
export interface MailtoLink {
  to: string
  cc: string
  bcc: string
  subject: string
  body: string
}

function decode(value: string): string {
  // A `+` is a literal plus in a mailto address, not a space: decodeURIComponent
  // leaves it alone, which is exactly what an address like a+b@x.ch needs.
  try {
    return decodeURIComponent(value)
  } catch {
    // A half-written escape ("%zz") throws; the raw text is still better than
    // dropping the field and opening an empty composer.
    return value
  }
}

/**
 * Reads a `mailto:` url. Everything is optional — `mailto:` on its own is a
 * valid link and means "a new mail" — so a field that is missing comes back
 * empty rather than making the whole link unusable.
 */
export function parseMailto(url: string): MailtoLink | null {
  const match = /^mailto:([^?]*)(?:\?([\s\S]*))?$/i.exec(url.trim())
  if (!match) return null
  const link: MailtoLink = {
    to: decode(match[1] ?? ''),
    cc: '',
    bcc: '',
    subject: '',
    body: ''
  }
  for (const pair of (match[2] ?? '').split('&')) {
    if (!pair) continue
    const index = pair.indexOf('=')
    if (index === -1) continue
    const name = pair.slice(0, index).toLowerCase()
    const value = decode(pair.slice(index + 1).replace(/\+/g, ' '))
    if (name === 'to') link.to = link.to ? `${link.to}, ${value}` : value
    else if (name === 'cc') link.cc = value
    else if (name === 'bcc') link.bcc = value
    else if (name === 'subject') link.subject = value
    else if (name === 'body') link.body = value
  }
  return link
}
