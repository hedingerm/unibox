import type { EmailAddress, Template } from '@shared/types'
import { api } from './bridge'
import { parseRecipients } from './compose'

/** What summons a template in the body: `/kürzel` plus Enter. */
export const TEMPLATE_TRIGGER = '/'

/**
 * Reads a line of the draft as a template call. Only a line that is nothing
 * but a slash and a shortcut the library actually knows counts — a mail that
 * begins with a path or a date is text and stays text.
 */
export function templateForLine(line: string, templates: Template[]): Template | null {
  const trimmed = line.trim()
  if (!trimmed.startsWith(TEMPLATE_TRIGGER)) return null
  const shortcut = trimmed.slice(TEMPLATE_TRIGGER.length).trim().toLowerCase()
  if (shortcut === '') return null
  return templates.find((entry) => (entry.shortcut ?? '').toLowerCase() === shortcut) ?? null
}

/**
 * Who the draft is going to, as far as the composer can tell. The address
 * comes from the field; the name is looked up in the archive when none was
 * typed, which is the same source the assistant's dossier reads — an address
 * that was written to before knows its own name.
 */
export async function recipientOf(to: string): Promise<EmailAddress | null> {
  const first = parseRecipients(to)[0]
  if (!first) return null
  if (first.name?.trim()) return first
  try {
    const known = await api.invoke('search:addresses', {
      field: 'recipient',
      prefix: first.email,
      limit: 5
    })
    const match = known.find(
      (address) => address.email.toLowerCase() === first.email.toLowerCase() && address.name
    )
    return match ?? first
  } catch {
    // A failed lookup is not a failed insert: the name simply stays unknown
    // and its variable is asked for instead.
    return first
  }
}
