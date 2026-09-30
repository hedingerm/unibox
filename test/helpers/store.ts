import { Store } from '@main/db/store'
import { messageKey, threadKey } from '@main/db/ids'
import type { AttachmentInput } from '@main/db/repos/messages'
import type { Account, EmailAddress, MessageBody } from '@shared/types'
import { SYSTEM_LABELS } from '@shared/types'

export function makeStore(): Store {
  return Store.openMemory()
}

export function addGoogleAccount(store: Store, email = 'max@example.com'): Account {
  const account = store.accounts.upsert({ kind: 'google', email, displayName: email })
  store.labels.ensureSystemLabels(account.id)
  return account
}

export function addResendAccount(store: Store, domain = 'beispielweb.ch'): Account {
  const account = store.accounts.upsert({
    kind: 'resend',
    email: domain,
    displayName: domain,
    resendDomainId: `dom_${domain}`,
    resendRegion: 'eu-west-1',
    receivingEnabled: true
  })
  store.labels.ensureSystemLabels(account.id)
  return account
}

export interface SeedMessage {
  remoteId: string
  threadRemoteId?: string
  subject?: string
  from?: EmailAddress
  to?: EmailAddress[]
  date?: number
  labels?: string[]
  body?: MessageBody
  messageIdHeader?: string
  inReplyTo?: string | null
  references?: string[]
  cc?: EmailAddress[]
  direction?: 'incoming' | 'outgoing'
  /** Machine-generated: an absence notice, a list blast, a bounce. */
  autoReply?: boolean
  attachments?: AttachmentInput[]
}

export function seedMessage(store: Store, account: Account, seed: SeedMessage): string {
  const id = messageKey(account.id, seed.remoteId)
  store.messages.upsert({
    id,
    accountId: account.id,
    threadId: threadKey(account.id, seed.threadRemoteId ?? seed.remoteId),
    remoteId: seed.remoteId,
    messageIdHeader: seed.messageIdHeader ?? `<${seed.remoteId}@example.test>`,
    inReplyTo: seed.inReplyTo ?? null,
    references: seed.references ?? [],
    subject: seed.subject ?? 'Betreff',
    from: seed.from ?? { name: 'Sandra Keller', email: 's.keller@keller-farben.ch' },
    to: seed.to ?? [{ name: null, email: account.email }],
    cc: seed.cc ?? [],
    direction: seed.direction ?? 'incoming',
    autoReply: seed.autoReply ?? false,
    attachments: seed.attachments ?? [],
    date: seed.date ?? Date.now(),
    labelRemoteIds: seed.labels ?? [SYSTEM_LABELS.inbox, SYSTEM_LABELS.unread],
    body: seed.body ?? { html: null, text: 'Hallo Welt' }
  })
  return id
}
