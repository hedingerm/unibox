import { SYSTEM_LABELS } from './types'

/**
 * Gmail-style search operators. The vocabulary stays English even though the UI
 * is German: `from:`/`is:unread` is the muscle memory every mail client trained,
 * and a German alias would only be a second thing to remember.
 */
export type SearchField =
  | 'from'
  | 'to'
  | 'cc'
  | 'subject'
  | 'has'
  | 'filename'
  | 'is'
  | 'in'
  | 'label'
  | 'account'
  | 'after'
  | 'before'
  | 'newer_than'
  | 'older_than'

export interface SearchFilter {
  field: SearchField
  value: string
  negated: boolean
}

export interface ParsedQuery {
  /** Free-text words, fed to FTS5 with a prefix wildcard on the last one. */
  terms: string[]
  /** Quoted runs, fed to FTS5 as phrases. */
  phrases: string[]
  filters: SearchFilter[]
}

const FIELDS = new Set<string>([
  'from',
  'to',
  'cc',
  'subject',
  'has',
  'filename',
  'is',
  'in',
  'label',
  'account',
  'after',
  'before',
  'newer_than',
  'older_than'
])

const IS_VALUES = new Set(['unread', 'read', 'starred'])
const HAS_VALUES = new Set(['attachment', 'attachments'])

/** `in:` speaks system folders; the values map onto Gmail's remote label ids. */
export const IN_VALUES: Record<string, string> = {
  inbox: SYSTEM_LABELS.inbox,
  sent: SYSTEM_LABELS.sent,
  draft: SYSTEM_LABELS.drafts,
  drafts: SYSTEM_LABELS.drafts,
  trash: SYSTEM_LABELS.trash,
  spam: SYSTEM_LABELS.spam,
  starred: SYSTEM_LABELS.starred
}

const RELATIVE = /^(\d+)([dwmy])$/i

/**
 * Resolves a date operand to epoch milliseconds at *local* midnight. Accepts ISO
 * `2026-01-31`, the Swiss `31.1.2026`, and relative `7d`/`2w`/`3m`/`1y`.
 * Returns `null` when the operand is not a date at all — the caller then treats
 * the whole token as free text instead of dropping it.
 */
export function resolveDate(value: string, now: number): number | null {
  const relative = RELATIVE.exec(value)
  if (relative) {
    const amount = Number(relative[1])
    const unit = relative[2]!.toLowerCase()
    const date = new Date(now)
    if (unit === 'd') date.setDate(date.getDate() - amount)
    if (unit === 'w') date.setDate(date.getDate() - amount * 7)
    if (unit === 'm') date.setMonth(date.getMonth() - amount)
    if (unit === 'y') date.setFullYear(date.getFullYear() - amount)
    return date.getTime()
  }
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(value)
  const swiss = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(value)
  const parts = iso
    ? { year: Number(iso[1]), month: Number(iso[2]), day: Number(iso[3]) }
    : swiss
      ? { year: Number(swiss[3]), month: Number(swiss[2]), day: Number(swiss[1]) }
      : null
  if (!parts) return null
  if (parts.month < 1 || parts.month > 12 || parts.day < 1 || parts.day > 31) return null
  // Local midnight, never Date.parse — that reads bare ISO dates as UTC and
  // shifts every boundary by an hour or two.
  return new Date(parts.year, parts.month - 1, parts.day).getTime()
}

function isValidValue(field: SearchField, value: string): boolean {
  if (value.length === 0) return false
  switch (field) {
    case 'is':
      return IS_VALUES.has(value.toLowerCase())
    case 'has':
      return HAS_VALUES.has(value.toLowerCase())
    case 'in':
      return value.toLowerCase() in IN_VALUES
    case 'after':
    case 'before':
    case 'newer_than':
    case 'older_than':
      // Validated against a fixed instant: only the *shape* matters here.
      return resolveDate(value, 0) !== null
    default:
      return true
  }
}

interface Token {
  text: string
  /** True when the token came out of quotes, so it must stay a phrase. */
  quoted: boolean
}

/**
 * Splits on whitespace but keeps quoted runs together, including the
 * `subject:"zwei worte"` form where the quotes start mid-token.
 */
function tokenize(input: string): Token[] {
  const tokens: Token[] = []
  let current = ''
  let quoted = false
  let inQuotes = false
  const flush = (): void => {
    if (current.length > 0 || quoted) tokens.push({ text: current, quoted })
    current = ''
    quoted = false
  }
  for (const char of input) {
    if (char === '"') {
      inQuotes = !inQuotes
      quoted = true
      continue
    }
    if (!inQuotes && /\s/.test(char)) {
      flush()
      continue
    }
    current += char
  }
  flush()
  return tokens
}

/**
 * Turns a raw search string into free text plus structured filters. Anything
 * that does not parse as a known operator stays free text on purpose: `Re:
 * Angebot`, `https://…` and German colons must keep finding mail.
 */
export function parseSearchQuery(input: string): ParsedQuery {
  const terms: string[] = []
  const phrases: string[] = []
  const filters: SearchFilter[] = []

  for (const token of tokenize(input)) {
    const asText = (): void => {
      if (token.text.length === 0) return
      if (token.quoted) phrases.push(token.text)
      else terms.push(token.text)
    }
    if (token.quoted && !token.text.includes(':')) {
      asText()
      continue
    }
    const negated = token.text.startsWith('-')
    const body = negated ? token.text.slice(1) : token.text
    const colon = body.indexOf(':')
    if (colon <= 0) {
      asText()
      continue
    }
    const field = body.slice(0, colon).toLowerCase()
    const value = body.slice(colon + 1)
    if (!FIELDS.has(field) || !isValidValue(field as SearchField, value)) {
      asText()
      continue
    }
    filters.push({ field: field as SearchField, value, negated })
  }

  return { terms, phrases, filters }
}

/** Whether a query says anything at all — an empty one must not hit the index. */
export function isEmptyQuery(parsed: ParsedQuery): boolean {
  return parsed.terms.length === 0 && parsed.phrases.length === 0 && parsed.filters.length === 0
}

/** Renders one filter back into the text the user would have typed. */
export function filterToText(filter: SearchFilter): string {
  const needsQuotes = /\s/.test(filter.value)
  const value = needsQuotes ? `"${filter.value}"` : filter.value
  return `${filter.negated ? '-' : ''}${filter.field}:${value}`
}
