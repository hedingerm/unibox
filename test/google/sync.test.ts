import { describe, expect, it } from 'vitest'
import { SYSTEM_LABELS } from '@shared/types'
import { GmailClient } from '@main/google/client'
import { GmailSync } from '@main/google/sync'
import { labelKey, messageKey } from '@main/db/ids'
import { FakeGmail } from '../helpers/fake-gmail'
import { addGoogleAccount, makeStore } from '../helpers/store'

function setup(): {
  store: ReturnType<typeof makeStore>
  gmail: FakeGmail
  sync: GmailSync
  accountId: string
} {
  const store = makeStore()
  const account = addGoogleAccount(store, 'max@muster-it.ch')
  const gmail = new FakeGmail()
  const client = new GmailClient({
    fetch: gmail.fetch,
    baseUrl: 'https://gmail.test/gmail/v1',
    accessToken: async () => 'token',
    sleep: async () => undefined
  })
  const sync = new GmailSync(store, account.id, client, { pageSize: 2 })
  return { store, gmail, sync, accountId: account.id }
}

describe('initial sync', () => {
  it('imports the full history including bodies and reads it back offline', async () => {
    const { store, gmail, sync, accountId } = setup()
    for (let i = 1; i <= 5; i += 1) {
      gmail.addMessage({ id: `m${i}`, subject: `Betreff ${i}`, text: `Inhalt ${i}` })
    }
    await sync.initialSync()

    const ids = store.messages.listThreadIds({ labelRemoteId: SYSTEM_LABELS.inbox })
    expect(ids).toHaveLength(5)
    const message = store.messages.getByRemoteId(accountId, 'm3')!
    expect(message.subject).toBe('Betreff 3')
    expect(store.messages.body(message.id).text).toBe('Inhalt 3')
    expect(store.messages.body(message.id).html).toContain('Inhalt 3')
    expect(store.accounts.get(accountId)?.initialSyncDone).toBe(true)

    gmail.offline = true
    expect(store.search.query({ text: 'Inhalt' })).toHaveLength(5)
  })

  it('mirrors the label hierarchy under the account', async () => {
    const { store, gmail, sync, accountId } = setup()
    gmail.addUserLabel('Label_1', 'Kunden')
    gmail.addUserLabel('Label_2', 'Kunden/Aktiv')
    gmail.addMessage({ id: 'm1', labelIds: ['INBOX', 'Label_2'] })
    await sync.initialSync()

    const labels = store.labels.listWithCounts(accountId)
    const child = labels.find((l) => l.name === 'Kunden/Aktiv')!
    expect(child.parentId).toBe(labelKey(accountId, 'Label_1'))
    expect(child.total).toBe(1)
    expect(labels.every((l) => l.accountId === accountId)).toBe(true)
  })

  it('imports send-as aliases with their signatures', async () => {
    const { store, gmail, sync, accountId } = setup()
    gmail.sendAs = [
      { sendAsEmail: 'max@muster-it.ch', displayName: 'Max Muster', isPrimary: true, isDefault: true },
      { sendAsEmail: 'kontakt@muster-it.ch', displayName: 'Muster IT', signature: '<p>HD</p>' },
      { sendAsEmail: 'pending@muster-it.ch', verificationStatus: 'pending' }
    ]
    await sync.initialSync()
    const identities = store.identities.listForAccount(accountId)
    expect(identities.map((i) => i.email).sort()).toEqual([
      'kontakt@muster-it.ch',
      'max@muster-it.ch',
      'pending@muster-it.ch'
    ])
    expect(identities.find((i) => i.email === 'kontakt@muster-it.ch')?.signatureHtml).toBe('<p>HD</p>')
    expect(identities.find((i) => i.isDefault)?.email).toBe('max@muster-it.ch')
  })

  it('keeps an unverified alias but marks it unsendable', async () => {
    const { store, gmail, sync, accountId } = setup()
    gmail.sendAs = [
      { sendAsEmail: 'max@muster-it.ch', isPrimary: true, isDefault: true },
      {
        sendAsEmail: 'pending@muster-it.ch',
        signature: '<p>Bald</p>',
        verificationStatus: 'pending'
      }
    ]
    await sync.initialSync()

    const pending = store.identities.findByEmail(accountId, 'pending@muster-it.ch')!
    expect(pending.verified).toBe(false)
    expect(pending.signatureHtml).toBe('<p>Bald</p>')
    expect(sync.ownAddresses()).not.toContain('pending@muster-it.ch')

    gmail.sendAs = [
      { sendAsEmail: 'max@muster-it.ch', isPrimary: true, isDefault: true },
      { sendAsEmail: 'pending@muster-it.ch', signature: '<p>Bald</p>' }
    ]
    await sync.syncSendAs()
    expect(store.identities.get(pending.id)?.verified).toBe(true)
  })

  it('follows Gmail signature changes but keeps a locally edited one', async () => {
    const { store, gmail, sync, accountId } = setup()
    gmail.sendAs = [
      { sendAsEmail: 'max@muster-it.ch', isPrimary: true, isDefault: true, signature: '<p>Alt</p>' },
      { sendAsEmail: 'kontakt@muster-it.ch', signature: '<p>HD</p>' }
    ]
    await sync.initialSync()
    const edited = store.identities.findByEmail(accountId, 'kontakt@muster-it.ch')!
    store.identities.update(edited.id, { signatureHtml: '<p>Von Hand</p>' })

    // Gmail changes one signature and drops the other.
    gmail.sendAs = [
      { sendAsEmail: 'max@muster-it.ch', isPrimary: true, isDefault: true, signature: '<p>Neu</p>' },
      { sendAsEmail: 'kontakt@muster-it.ch' }
    ]
    await sync.syncSendAs()

    expect(store.identities.findByEmail(accountId, 'max@muster-it.ch')?.signatureHtml).toBe(
      '<p>Neu</p>'
    )
    expect(store.identities.get(edited.id)?.signatureHtml).toBe('<p>Von Hand</p>')

    // Once Gmail's own signature is gone, an untouched one is cleared too.
    gmail.sendAs = [{ sendAsEmail: 'max@muster-it.ch', isPrimary: true, isDefault: true }]
    await sync.syncSendAs()
    expect(store.identities.findByEmail(accountId, 'max@muster-it.ch')?.signatureHtml).toBe(
      null
    )
  })

  it('imports attachment metadata without downloading the payload', async () => {
    const { store, gmail, sync, accountId } = setup()
    gmail.addMessage({
      id: 'm1',
      attachments: [{ filename: 'offerte.pdf', mimeType: 'application/pdf', attachmentId: 'att-1', size: 1234 }]
    })
    await sync.initialSync()
    const message = store.messages.getByRemoteId(accountId, 'm1')!
    const [attachment] = store.messages.attachments(message.id)
    expect(attachment?.filename).toBe('offerte.pdf')
    expect(attachment?.downloaded).toBe(false)
    expect(message.hasAttachments).toBe(true)
  })

  it('retries after a rate limit instead of failing', async () => {
    const { store, gmail, sync } = setup()
    gmail.addMessage({ id: 'm1' })
    gmail.rateLimitFor = 2
    await sync.initialSync()
    expect(store.messages.listThreadIds({ labelRemoteId: SYSTEM_LABELS.inbox })).toHaveLength(1)
  })

  it('resumes without re-fetching messages that are already stored', async () => {
    const { gmail, sync } = setup()
    for (let i = 1; i <= 4; i += 1) gmail.addMessage({ id: `m${i}` })
    await sync.initialSync()
    const afterFirst = gmail.requestCount
    await sync.initialSync()
    expect(gmail.requestCount - afterFirst).toBeLessThan(afterFirst)
  })
})

describe('incremental sync', () => {
  it('re-reads the send-as list, which has no history entries', async () => {
    const { store, gmail, sync, accountId } = setup()
    gmail.sendAs = [{ sendAsEmail: 'max@muster-it.ch', isPrimary: true, isDefault: true }]
    gmail.addMessage({ id: 'm1' })
    await sync.initialSync()

    gmail.sendAs = [
      { sendAsEmail: 'max@muster-it.ch', isPrimary: true, isDefault: true },
      { sendAsEmail: 'neu@muster-it.ch', displayName: 'Neu', signature: '<p>Neu</p>' }
    ]
    await sync.sync()

    expect(store.identities.findByEmail(accountId, 'neu@muster-it.ch')?.signatureHtml).toBe(
      '<p>Neu</p>'
    )
  })

  it('picks up new messages without a restart', async () => {
    const { store, gmail, sync, accountId } = setup()
    gmail.addMessage({ id: 'm1' })
    await sync.initialSync()

    const added = gmail.addMessage({ id: 'm2', subject: 'Neu eingetroffen' })
    gmail.pushHistory({ messagesAdded: [{ message: { id: added.id, threadId: added.threadId } }] })

    const result = await sync.incrementalSync()
    expect(result.resynced).toBe(false)
    expect(store.messages.getByRemoteId(accountId, 'm2')?.subject).toBe('Neu eingetroffen')
    expect(store.accounts.get(accountId)?.historyId).toBe(gmail.historyId)
  })

  it('skips messages that vanished before they could be fetched without resyncing', async () => {
    const { store, gmail, sync, accountId } = setup()
    const kept = gmail.addMessage({ id: 'm1', labelIds: ['INBOX'] })
    await sync.initialSync()

    // A Gmail draft autosave: the old message id is gone before we ask for it.
    gmail.pushHistory({ messagesAdded: [{ message: { id: 'gone', threadId: 'gone' } }] })
    kept.labelIds = ['TRASH']
    gmail.pushHistory({
      labelsAdded: [{ message: { id: 'm1', threadId: 'm1', labelIds: ['TRASH'] }, labelIds: ['TRASH'] }]
    })

    const result = await sync.incrementalSync()
    expect(result.resynced).toBe(false)
    expect(store.messages.getByRemoteId(accountId, 'm1')?.labelIds).toEqual([
      labelKey(accountId, SYSTEM_LABELS.trash)
    ])
  })

  it('applies remote label changes', async () => {
    const { store, gmail, sync, accountId } = setup()
    const message = gmail.addMessage({ id: 'm1', labelIds: ['INBOX', 'UNREAD'] })
    await sync.initialSync()

    message.labelIds = ['INBOX']
    gmail.pushHistory({
      labelsRemoved: [{ message: { id: 'm1', threadId: 'm1', labelIds: ['INBOX'] }, labelIds: ['UNREAD'] }]
    })
    await sync.incrementalSync()

    const local = store.messages.getByRemoteId(accountId, 'm1')!
    expect(local.labelIds).not.toContain(labelKey(accountId, SYSTEM_LABELS.unread))
    expect(local.labelIds).toContain(labelKey(accountId, SYSTEM_LABELS.inbox))
  })

  it('removes messages deleted upstream', async () => {
    const { store, gmail, sync, accountId } = setup()
    gmail.addMessage({ id: 'm1' })
    await sync.initialSync()
    gmail.pushHistory({ messagesDeleted: [{ message: { id: 'm1', threadId: 'm1' } }] })
    await sync.incrementalSync()
    expect(store.messages.getByRemoteId(accountId, 'm1')).toBeNull()
  })

  it('falls back to a full resync when the history id expired', async () => {
    const { store, gmail, sync, accountId } = setup()
    gmail.addMessage({ id: 'm1' })
    await sync.initialSync()
    gmail.addMessage({ id: 'm2' })
    gmail.historyExpired = true

    const result = await sync.incrementalSync()
    expect(result.resynced).toBe(true)
    expect(store.messages.getByRemoteId(accountId, 'm2')).not.toBeNull()
    expect(store.accounts.get(accountId)?.initialSyncDone).toBe(true)
  })

  it('applies deletions and label changes the expired history would have carried', async () => {
    const { store, gmail, sync, accountId } = setup()
    gmail.addMessage({ id: 'm1', labelIds: ['INBOX'] })
    const trashed = gmail.addMessage({ id: 'm2', labelIds: ['INBOX', 'UNREAD'] })
    await sync.initialSync()

    gmail.messages.delete('m1')
    trashed.labelIds = ['TRASH']
    gmail.historyExpired = true
    await sync.incrementalSync()

    expect(store.messages.getByRemoteId(accountId, 'm1')).toBeNull()
    expect(store.messages.getByRemoteId(accountId, 'm2')?.labelIds).toEqual([
      labelKey(accountId, SYSTEM_LABELS.trash)
    ])
  })

  it('reconciles a mailbox imported before reconciling existed once', async () => {
    const { store, gmail, sync, accountId } = setup()
    gmail.addMessage({ id: 'm1', labelIds: ['INBOX'] })
    gmail.addMessage({ id: 'm2', labelIds: ['INBOX'] })
    await sync.initialSync()

    // Stale state from the old resync: m1 is long gone at Gmail.
    gmail.messages.delete('m1')
    await sync.sync()
    expect(store.messages.getByRemoteId(accountId, 'm1')).toBeNull()
    expect(store.messages.getByRemoteId(accountId, 'm2')).not.toBeNull()

    // Once is enough: from here on the history keeps it in line.
    gmail.messages.delete('m2')
    await sync.sync()
    expect(store.messages.getByRemoteId(accountId, 'm2')).not.toBeNull()
  })
})

describe('attachment download', () => {
  it('fetches on first open and serves the cache afterwards', async () => {
    const { store, gmail, sync, accountId } = setup()
    gmail.addMessage({
      id: 'm1',
      attachments: [{ filename: 'offerte.pdf', mimeType: 'application/pdf', attachmentId: 'att-1', size: 9 }]
    })
    gmail.attachments.set('att-1', 'PDF-INHALT')
    await sync.initialSync()

    const message = store.messages.getByRemoteId(accountId, 'm1')!
    const [attachment] = store.messages.attachments(message.id)
    const writes: string[] = []
    const write = async (data: Buffer, filename: string): Promise<string> => {
      writes.push(`${filename}:${data.toString('utf8')}`)
      return `/cache/${filename}`
    }

    const first = await sync.downloadAttachment(attachment!.id, write)
    expect(first).toBe('/cache/offerte.pdf')
    expect(writes).toEqual(['offerte.pdf:PDF-INHALT'])
    expect(store.messages.attachment(attachment!.id)?.downloaded).toBe(true)

    const before = gmail.requestCount
    const second = await sync.downloadAttachment(attachment!.id, write)
    expect(second).toBe('/cache/offerte.pdf')
    expect(gmail.requestCount).toBe(before)
    expect(writes).toHaveLength(1)
  })
})

describe('message keys', () => {
  it('namespaces remote ids per account so two accounts never collide', () => {
    expect(messageKey('a', 'm1')).not.toBe(messageKey('b', 'm1'))
  })
})
