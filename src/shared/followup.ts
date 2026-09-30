import type { EmailAddress } from './types'

/**
 * A sent mail that expects an answer. The rules live here rather than in the
 * main process because both sides need them: the composer decides whether to
 * arm the checkbox in the first place, and the send path guards against arming
 * it for an address that will never write back.
 */

/**
 * Above this many recipients a mail is an announcement, not a question — and
 * nobody wants a reminder because one of twelve people stayed quiet.
 */
export const FOLLOW_UP_MAX_RECIPIENTS = 5

/** Working days offered in the composer, and the default the settings start at. */
export const FOLLOW_UP_DAY_CHOICES = [1, 2, 3, 5, 7, 14] as const

export const DEFAULT_FOLLOW_UP_DAYS = 3

/**
 * Local parts that belong to a machine. A tag (`bounce-7f3a@`, `noreply+x@`) is
 * the same address with a marker on it, so the comparison looks at the stem.
 */
const AUTOMATED_LOCAL_PARTS = [
  'noreply',
  'no-reply',
  'no_reply',
  'donotreply',
  'do-not-reply',
  'do_not_reply',
  'autoreply',
  'auto-reply',
  'mailer-daemon',
  'mailerdaemon',
  'postmaster',
  'bounce',
  'bounces',
  'notification',
  'notifications',
  'alert',
  'alerts',
  'automated',
  'support-noreply'
]

export function isNoReplyAddress(email: string): boolean {
  const local = (email.split('@')[0] ?? '').toLowerCase()
  const stem = local.split('+')[0] ?? local
  return AUTOMATED_LOCAL_PARTS.some(
    (name) => stem === name || stem.startsWith(`${name}-`) || stem.startsWith(`${name}.`)
  )
}

/**
 * Whether a mail to these recipients is the kind that waits for an answer. A
 * newsletter address will not write back, and a mail to a whole distribution
 * list is not owed a personal reply.
 */
export function isFollowUpCandidate(recipients: EmailAddress[]): boolean {
  if (recipients.length === 0 || recipients.length > FOLLOW_UP_MAX_RECIPIENTS) return false
  return recipients.some((address) => !isNoReplyAddress(address.email))
}

/**
 * `days` working days after `from`, keeping the time of day. Calendar days
 * would make Friday + 3 land on Monday, which is one working day later than
 * the user meant. Steps through the calendar rather than doing arithmetic on
 * milliseconds so a DST change does not shift the hour.
 */
export function addWorkingDays(from: number, days: number): number {
  const date = new Date(from)
  let remaining = Math.max(0, Math.round(days))
  while (remaining > 0) {
    date.setDate(date.getDate() + 1)
    const weekday = date.getDay()
    if (weekday !== 0 && weekday !== 6) remaining -= 1
  }
  return date.getTime()
}

/**
 * Headers that mark a message as machine-generated. An out-of-office notice
 * carries `Auto-Submitted`, and a mailing-list blast into the conversation is
 * not the answer either — neither may count as the reply that was waited for.
 */
export function isAutoReplyHeaders(headers: Record<string, string | null | undefined>): boolean {
  const value = (name: string): string => (headers[name] ?? '').trim().toLowerCase()
  const submitted = value('auto-submitted')
  if (submitted !== '' && submitted !== 'no') return true
  const precedence = value('precedence')
  if (precedence === 'auto_reply' || precedence === 'bulk' || precedence === 'list') return true
  return value('x-autoreply') !== '' || value('x-autorespond') !== '' || value('list-id') !== ''
}

/** Reply prefixes in the languages this mailbox sees, stripped before matching. */
const REPLY_PREFIXES = /^(\s*(re|aw|antw|wg|fw|fwd)\s*:\s*)+/i

const AUTO_SUBJECT =
  /^(automatische antwort|automatische empfangsbestätigung|abwesenheit|abwesenheitsnotiz|out of office|out-of-office|automatic reply|auto[- ]?reply|autoreply|ooo\b)/i

/**
 * The same judgement from the subject alone. Needed because Resend and older
 * locally stored mail carry no header flag, and because some servers send an
 * absence notice without `Auto-Submitted` at all.
 */
export function isAutoReplySubject(subject: string): boolean {
  return AUTO_SUBJECT.test(subject.replace(REPLY_PREFIXES, '').trim())
}
