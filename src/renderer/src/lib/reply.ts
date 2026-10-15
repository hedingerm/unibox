import type { EmailAddress, Message } from '@shared/types'

export interface ReplyRecipients {
  to: EmailAddress[]
  cc: EmailAddress[]
}

/**
 * Who an answer goes to. A reply goes back to whoever wrote — or, for our own
 * mail, to whom we wrote. Reply-all puts everyone else on the mail into the
 * copy line, minus our own addresses and anyone already addressed.
 */
export function replyRecipients(
  message: Pick<Message, 'direction' | 'from' | 'to' | 'cc' | 'replyTo'>,
  all: boolean,
  own: readonly string[]
): ReplyRecipients {
  const to =
    message.direction === 'outgoing'
      ? message.to
      : message.replyTo.length > 0
        ? message.replyTo
        : [message.from]
  if (!all) return { to, cc: [] }
  const seen = new Set([...own, ...to.map((address) => address.email)].map(normalize))
  const others = message.direction === 'outgoing' ? message.cc : [...message.to, ...message.cc]
  const cc = others.filter((address) => {
    const key = normalize(address.email)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  return { to, cc }
}

function normalize(email: string): string {
  return email.trim().toLowerCase()
}
