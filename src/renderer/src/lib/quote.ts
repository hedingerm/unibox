/**
 * Where the quoted history of a reply begins. Each client marks it its own way
 * — Gmail with a class, Apple Mail and Thunderbird with a cite blockquote,
 * Outlook with an id on the header block — and this app's own composer with
 * the marker the editor keeps (see `QUOTE_MARKER` in lib/compose).
 */
const QUOTE_START = [
  '.gmail_quote',
  '.gmail_extra',
  'blockquote[type="cite"]',
  '.moz-cite-prefix',
  '#divRplyFwdMsg',
  '#appendonsend',
  '.OutlookMessageHeader',
  '.yahoo_quoted',
  '[data-unibox-quote]'
].join(',')

export interface QuoteSplit {
  /** What the sender wrote this time. */
  body: string
  /** Everything from the quote marker on, or null when there is none. */
  quote: string | null
}

const FORWARD_HEADER = /^-+\s*(forwarded message|weitergeleitete nachricht)/i

/** Whether a fragment shows anything: text, or an image standing in for text. */
function hasContent(root: ParentNode): boolean {
  return (root.textContent ?? '').trim() !== '' || root.querySelector('img') !== null
}

/**
 * Splits a mail's HTML at the start of its quoted history. It runs on the
 * *unsanitised* source because the sanitiser strips the ids and attributes
 * Outlook and Apple Mail mark their quotes with; both halves are sanitised
 * separately afterwards. Everything after the marker in document order goes
 * with it — Outlook puts the quoted mail next to its header block rather
 * than inside it.
 *
 * A mail that is nothing but quote (a bare forward) is left whole: hiding all
 * of it behind a toggle would show an empty message.
 */
export function splitQuotedHtml(html: string): QuoteSplit {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const marker = doc.body.querySelector(QUOTE_START)
  const last = doc.body.lastChild
  if (!marker || !last) return { body: html, quote: null }
  // Outlook draws a rule above its header block; it belongs to the quote.
  const previous = marker.previousElementSibling
  const start = previous?.tagName === 'HR' ? previous : marker
  const range = doc.createRange()
  range.setStartBefore(start)
  range.setEndAfter(last)
  const quote = doc.createElement('div')
  quote.append(range.extractContents())
  if (!hasContent(doc.body) || !hasContent(quote)) return { body: html, quote: null }
  // A forward wears the same marker, but the forwarded mail is the point of it.
  if (FORWARD_HEADER.test((quote.textContent ?? '').trim())) return { body: html, quote: null }
  return { body: doc.body.innerHTML, quote: quote.innerHTML }
}

/** "Am 18.08.2026 um 10:12 schrieb …:" / "On … wrote:" above a quote. */
const ATTRIBUTION = /^(am|on|le|il)\b.*(schrieb|wrote|a écrit|ha scritto).*:\s*$/i

/**
 * The same for a text-only mail: the trailing run of `>` lines, together with
 * the attribution line (and blank lines) directly above it.
 */
export function splitQuotedText(text: string): QuoteSplit {
  const lines = text.split(/\r?\n/)
  let start = lines.length
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!.trim()
    if (line === '' || line.startsWith('>')) start = index
    else break
  }
  if (!lines.slice(start).some((line) => line.trim().startsWith('>'))) {
    return { body: text, quote: null }
  }
  // Blank lines between the attribution and the `>` run are already inside it.
  if (start > 0 && ATTRIBUTION.test(lines[start - 1]!.trim())) start -= 1
  const quote = lines.slice(start).join('\n')
  while (start > 0 && lines[start - 1]!.trim() === '') start -= 1
  const body = lines.slice(0, start).join('\n')
  if (body.trim() === '') return { body: text, quote: null }
  return { body, quote: quote.replace(/^\s*\n/, '') }
}
