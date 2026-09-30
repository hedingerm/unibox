import type { AiMode } from '@shared/types'
import { QUOTE_MARKER, stripSignature } from './compose'
import { plainTextToHtml } from './sanitize'
import { htmlToPlainText } from './text'

/** What the user types in the body to summon the assistant. */
export const AI_TRIGGER = '@ai'

/**
 * Reads a line of the draft as a command. A line that opens with `@ai` and
 * carries an instruction is one; everything else is mail text and stays.
 */
export function aiInstruction(line: string): string | null {
  const match = new RegExp(`^${AI_TRIGGER}[\\s\\u00a0]+(\\S[\\s\\S]*)$`).exec(line.trim())
  return match ? match[1]!.trim() : null
}

/**
 * Splits a draft into the part the user is writing and the forwarded original
 * below it. The quote is somebody else's mail: the assistant neither reads it
 * as the draft nor gets to rewrite it.
 */
export function splitDraft(html: string): { body: string; quote: string } {
  const quote = new RegExp(`<[a-z]+[^>]*\\s${QUOTE_MARKER}[^>]*>`, 'i').exec(html)
  if (!quote || quote.index === undefined) return { body: html, quote: '' }
  return { body: html.slice(0, quote.index), quote: html.slice(quote.index) }
}

/** The draft as the model should see it: no signature, no quote, no markup. */
export function draftText(html: string): string {
  return htmlToPlainText(stripSignature(splitDraft(html).body))
}

/**
 * An empty body means there is nothing to work from, so the assistant writes;
 * anything else is a rework of what the user already put there.
 */
export function modeForDraft(html: string): AiMode {
  return draftText(html).trim() === '' ? 'draft' : 'rewrite'
}

/**
 * Turns the model's plain text into the paragraphs the editor stores. Asking
 * for text and building the markup here is what keeps stray markdown and
 * inline styles out of the draft.
 */
export function textToHtml(text: string): string {
  const trimmed = text.trim()
  return trimmed === '' ? '' : plainTextToHtml(trimmed)
}
