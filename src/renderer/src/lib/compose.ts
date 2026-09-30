import type { EmailAddress, MessageBody, OutboxAttachment } from '@shared/types'
import { t } from '../i18n'
import { formatFullDate } from './format'
import { escapeHtml, plainTextToHtml, sanitizeMessageHtml } from './sanitize'

export const SIGNATURE_MARKER = 'data-unibox-signature'
/** Marks the quoted original of a forward or reply: the signature stays above it. */
export const QUOTE_MARKER = 'data-unibox-quote'

const QUOTE_START = new RegExp(`<[a-z]+[^>]*\\s${QUOTE_MARKER}[^>]*>`, 'i')

/**
 * Locates a marked block by counting nested `<div>`s rather than by matching to
 * the next `</div>`: a signature pasted out of Gmail brings its own, and the
 * block is not always the last thing in the draft — the editor leaves a
 * paragraph behind it as soon as the caret has been there.
 */
function markedBlockRange(html: string, marker: string): { start: number; end: number } | null {
  const open = new RegExp(`<div[^>]*${marker}[^>]*>`, 'i').exec(html)
  if (!open) return null
  const scan = /<div\b[^>]*>|<\/div>/gi
  scan.lastIndex = open.index + open[0].length
  let depth = 1
  for (let token = scan.exec(html); token; token = scan.exec(html)) {
    depth += token[0].startsWith('</') ? -1 : 1
    if (depth === 0) return { start: open.index, end: token.index + token[0].length }
  }
  return { start: open.index, end: html.length }
}

export function stripSignature(html: string): string {
  const range = markedBlockRange(html, SIGNATURE_MARKER)
  return range ? `${html.slice(0, range.start)}${html.slice(range.end)}` : html
}

/** Takes the quoted original back out of a draft, leaving what was written. */
export function stripQuote(html: string): string {
  const range = markedBlockRange(html, QUOTE_MARKER)
  return range ? `${html.slice(0, range.start)}${html.slice(range.end)}` : html
}

/** Whether the draft currently carries a quoted original. */
export function hasQuote(html: string): boolean {
  return QUOTE_START.test(html)
}

/**
 * Keeps exactly one signature block in the draft — at the end, or directly
 * above the forwarded original, which is where a reader expects it. The body
 * never stays empty: the signature is a block of its own in the editor, and a
 * draft that consisted only of it would put the caret inside the signature.
 */
export function withSignature(html: string, signatureHtml: string | null): string {
  const stripped = stripSignature(html)
  if (!signatureHtml || !signatureHtml.trim()) return stripped
  const body = stripped.trim() === '' ? '<p></p>' : stripped
  const block = `<div ${SIGNATURE_MARKER}="true"><br>${signatureHtml}</div>`
  const quote = body.match(QUOTE_START)
  if (!quote || quote.index === undefined) return `${body}${block}`
  return `${body.slice(0, quote.index)}${block}${body.slice(quote.index)}`
}

/** What the forwarded header block reports about the original message. */
export interface ForwardSource {
  from: EmailAddress
  to: EmailAddress[]
  cc: EmailAddress[]
  subject: string
  date: number
  body: MessageBody
}

function addressLine(addresses: EmailAddress[]): string {
  return addresses
    .map((address) => (address.name?.trim() ? `${address.name} <${address.email}>` : address.email))
    .join(', ')
}

export function forwardSubject(subject: string): string {
  return /^(fwd|fw|wg):/i.test(subject.trim()) ? subject : `Fwd: ${subject}`
}

/**
 * The forwarded original: a header block naming sender, date and recipients,
 * followed by the sanitised body. `inlineImages` maps the original's Content-IDs
 * to data URIs — the send path turns those back into CID parts, so images the
 * sender embedded survive the trip.
 */
export function buildForwardHtml(
  source: ForwardSource,
  inlineImages: Record<string, string> = {}
): string {
  const html = quotedBody(source, inlineImages)
  const rows: Array<[string, string]> = [
    [t('compose.forwardFrom'), addressLine([source.from])],
    [t('compose.forwardDate'), formatFullDate(source.date)],
    [t('compose.forwardSubject'), source.subject],
    [t('compose.forwardTo'), addressLine(source.to)]
  ]
  if (source.cc.length > 0) rows.push([t('compose.forwardCc'), addressLine(source.cc)])
  const header = rows
    .map(([label, value]) => `<b>${escapeHtml(label)}</b> ${escapeHtml(value)}`)
    .join('<br>')
  return [
    '<p><br></p>',
    `<div ${QUOTE_MARKER}="true">`,
    `<p>${escapeHtml(t('compose.forwardHeader'))}</p>`,
    `<p>${header}</p>`,
    html,
    '</div>'
  ].join('')
}

/** The original as it is rendered for quoting or forwarding. */
function quotedBody(source: ForwardSource, inlineImages: Record<string, string>): string {
  const original = source.body.html ?? plainTextToHtml(source.body.text ?? '')
  // Quoting is a deliberate act on a mail the user already opened, so remote
  // images keep their source here — stripping them would hand the recipient a
  // gutted copy.
  // The quote goes back out with the mail, so its links keep the tab order the
  // recipient's client will give them.
  const { html } = sanitizeMessageHtml(original, {
    allowRemoteImages: true,
    inlineImages,
    tabbableLinks: true
  })
  return html
}

/**
 * The quoted original of a reply: one attribution line and the mail below it,
 * in the same marked block a forward uses — so signature placement, the
 * assistant's view of the draft and the editor's schema all keep working.
 */
export function buildReplyQuoteHtml(
  source: ForwardSource,
  inlineImages: Record<string, string> = {}
): string {
  const intro = t('compose.quoteHeader', {
    date: formatFullDate(source.date),
    sender: addressLine([source.from])
  })
  return [
    `<div ${QUOTE_MARKER}="true">`,
    `<p>${escapeHtml(intro)}</p>`,
    `<blockquote>${quotedBody(source, inlineImages)}</blockquote>`,
    '</div>'
  ].join('')
}

let inlineCounter = 0

/**
 * Turns pasted/inserted data-URI images into CID attachments so recipients see
 * them inline instead of receiving a multi-megabyte HTML blob.
 */
export function extractInlineImages(html: string): {
  html: string
  attachments: OutboxAttachment[]
} {
  const attachments: OutboxAttachment[] = []
  const rewritten = html.replace(
    /src="data:([\w/+.-]+);base64,([A-Za-z0-9+/=]+)"/g,
    (_match, mimeType: string, content: string) => {
      inlineCounter += 1
      const contentId = `unibox-inline-${inlineCounter}@unibox.local`
      const extension = mimeType.split('/')[1]?.split('+')[0] ?? 'bin'
      attachments.push({
        filename: `bild-${inlineCounter}.${extension}`,
        mimeType,
        content,
        contentId,
        inline: true
      })
      return `src="cid:${contentId}"`
    }
  )
  return { html: rewritten, attachments }
}

const ADDRESS_PATTERN = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/

export function parseRecipients(input: string): EmailAddress[] {
  return input
    .split(/[,;]/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const angle = part.match(/^(.*?)<([^>]+)>$/)
      if (angle) {
        return { name: (angle[1] ?? '').trim().replace(/^"|"$/g, '') || null, email: (angle[2] ?? '').trim() }
      }
      return { name: null, email: part }
    })
    .filter((address) => ADDRESS_PATTERN.test(address.email))
}

export function isValidRecipientList(input: string): boolean {
  const entries = input.split(/[,;]/).map((part) => part.trim()).filter(Boolean)
  return entries.length > 0 && parseRecipients(input).length === entries.length
}

/**
 * How an address reads in a recipient field. A display name holding a
 * separator or angle bracket is dropped rather than quoted: the list is parsed
 * by splitting, so a quoted comma would tear the entry in two.
 */
export function formatRecipient(address: EmailAddress): string {
  const name = address.name?.trim() ?? ''
  return name === '' || /[,;<>"]/.test(name) ? address.email : `${name} <${address.email}>`
}
