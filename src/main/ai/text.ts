/** Mail as plain text: the model gets words, the renderer builds the markup. */
export function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    // A paragraph is a blank line and a <br> is a single one, the same way the
    // text goes back into markup. Without that split, every paragraph of a
    // draft comes back one line short and reads as a change against the
    // model's answer.
    .replace(/<li[^>]*>\s*<p[^>]*>/gi, '<li>')
    .replace(/<\/p>\s*<\/li>/gi, '</li>')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|h[1-6])>/gi, '\n\n')
    .replace(/<\/(div|li|tr)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * Where a mail stops being its author's words and starts quoting the one
 * before it. Every client marks the seam differently, and stripping the markup
 * has already flattened `<blockquote>` into ordinary lines — so the seam has to
 * be found in the text itself.
 */
const QUOTE_MARKERS = [
  /^>/,
  // The colon is what makes this a quote header: "Am liebsten schrieb ich dir
  // per WhatsApp" is a sentence, and cutting there would halve the mail.
  /^\s*Am\b.*\bschrieb\b.*:\s*$/i,
  /^\s*On\b.*\bwrote\b:?\s*$/i,
  /^\s*-{2,}\s*(Urspr[üu]ngliche Nachricht|Original Message|Weitergeleitete Nachricht|Forwarded message)\s*-{2,}/i,
  /^\s*(Von|From|Gesendet|Sent):\s+\S/,
  /^\s*_{10,}\s*$/
]

/**
 * The part of a mail its sender actually wrote. Reading the address form or the
 * language off a body that still carries the quoted original would measure the
 * other person: a "Sie" they used says nothing about how one writes back.
 */
export function ownWords(text: string): string {
  const lines = text.split('\n')
  const end = lines.findIndex((line) => QUOTE_MARKERS.some((marker) => marker.test(line)))
  return (end === -1 ? lines : lines.slice(0, end)).join('\n').trim()
}
