/**
 * Placeholders in a mail template. `{{empfaenger.vorname}}` is plain text in
 * the body, not markup: the editor stores it verbatim, an assistant run reads
 * it as text, and nothing in the schema has to learn a new node for it.
 *
 * Nothing here touches the DOM or the database — the same functions fill a
 * template in the composer and check a body before it is sent.
 */

/**
 * One placeholder. Angle brackets and line breaks are excluded so a run of
 * braces can never swallow a tag: a `{{` that is never closed inside the same
 * text node is simply not a placeholder.
 */
const PLACEHOLDER = /\{\{([^{}<>\n]{1,80})\}\}/g

/** The variables the composer can answer on its own. */
export const AUTO_VARIABLES = [
  'empfaenger.vorname',
  'empfaenger.name',
  'empfaenger.mail',
  'absender.name',
  'absender.mail',
  'betreff',
  'datum'
] as const

export type AutoVariable = (typeof AUTO_VARIABLES)[number]

/**
 * What the composer knows while a template is being inserted. Everything is
 * already resolved and formatted — the date in the app's wording, the
 * recipient's name as the archive knows it — so this module never has to ask
 * anybody anything.
 */
export interface TemplateContext {
  recipientName: string | null
  recipientEmail: string | null
  senderName: string | null
  senderEmail: string | null
  subject: string
  date: string
}

/**
 * The part of a display name that is used to address somebody. Taking the
 * first word is a guess that is right for `Sandra Meier` and wrong for a name
 * that starts with a title — which is why an unresolved variable is asked for
 * rather than filled with a guess nobody saw.
 */
export function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? ''
}

/** Every placeholder in the text, once each, in the order they appear. */
export function scanTemplate(source: string): string[] {
  const found = new Set<string>()
  for (const match of source.matchAll(PLACEHOLDER)) {
    const name = match[1]!.trim()
    if (name !== '') found.add(name)
  }
  return [...found]
}

/** Whether anything in the text is still waiting to be filled in. */
export function hasPlaceholders(source: string): boolean {
  return scanTemplate(source).length > 0
}

/**
 * The values the composer can supply without asking. A variable whose answer
 * is not known stays out of the map entirely: it then reaches the fill dialog
 * as an empty field instead of being replaced by an empty string nobody would
 * notice was missing.
 */
export function autoValues(context: TemplateContext): Record<string, string> {
  const values: Record<string, string> = { datum: context.date }
  if (context.recipientName?.trim()) {
    values['empfaenger.name'] = context.recipientName.trim()
    const first = firstName(context.recipientName)
    if (first !== '') values['empfaenger.vorname'] = first
  }
  if (context.recipientEmail?.trim()) values['empfaenger.mail'] = context.recipientEmail.trim()
  if (context.senderName?.trim()) values['absender.name'] = context.senderName.trim()
  if (context.senderEmail?.trim()) values['absender.mail'] = context.senderEmail.trim()
  if (context.subject.trim()) values['betreff'] = context.subject.trim()
  return values
}

/**
 * Which placeholders of a template are still open once the automatic values
 * are in. This is what the fill dialog asks for — in the template's own order,
 * so the fields read the way the mail does.
 */
export function openVariables(source: string, values: Record<string, string>): string[] {
  return scanTemplate(source).filter((name) => (values[name] ?? '') === '')
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function substitute(
  source: string,
  values: Record<string, string>,
  transform: (value: string) => string
): string {
  return source.replace(PLACEHOLDER, (whole, raw: string) => {
    const value = values[raw.trim()]
    // A placeholder without a value stays as it is. It is then still there
    // when the send guard looks, which is the point: an unfilled variable must
    // not turn into a silent gap in the mail.
    return value === undefined || value === '' ? whole : transform(value)
  })
}

/**
 * The template body with its placeholders filled in. Values are escaped here
 * rather than at the call sites — they come from a text field, and a name with
 * an `&` in it would otherwise land in the draft as broken markup.
 */
export function renderTemplate(html: string, values: Record<string, string>): string {
  return substitute(html, values, escapeHtml)
}

/** The same for the subject line, which is text and gets no escaping. */
export function renderSubject(subject: string, values: Record<string, string>): string {
  return substitute(subject, values, (value) => value)
}
