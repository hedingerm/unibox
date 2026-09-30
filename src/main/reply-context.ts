import type { Store } from './db/store'

/** The headers and Gmail thread that keep a reply inside its conversation. */
export interface ReplyContext {
  inReplyTo: string | null
  references: string[]
  /** Gmail's thread id; `null` for Resend, which threads by headers alone. */
  threadRemoteId: string | null
}

const EMPTY: ReplyContext = { inReplyTo: null, references: [], threadRemoteId: null }

/**
 * Shared by sending and by mirroring a draft to Gmail: both have to land in the
 * conversation the mail answers, and a draft that threads differently from the
 * mail it becomes would jump threads on send.
 */
export function replyContext(store: Store, replyToMessageId: string | null): ReplyContext {
  if (!replyToMessageId) return EMPTY
  const parent = store.messages.get(replyToMessageId)
  if (!parent) return EMPTY
  const thread = store.messages.messagesInThread(parent.threadId)
  const references = [
    ...new Set([...parent.references, ...(parent.messageIdHeader ? [parent.messageIdHeader] : [])])
  ]
  const account = store.accounts.get(parent.accountId)
  const threadRemoteId =
    account?.kind === 'google' ? (thread[0]?.threadId.split(':t:')[1] ?? null) : null
  return { inReplyTo: parent.messageIdHeader, references, threadRemoteId }
}
