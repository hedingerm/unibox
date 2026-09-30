import { describe, expect, it } from 'vitest'
import { SYSTEM_LABELS } from '@shared/types'
import { GmailClient } from '@main/google/client'
import { GmailSync } from '@main/google/sync'
import { FakeGmail } from '../helpers/fake-gmail'
import { addGoogleAccount, makeStore, seedMessage } from '../helpers/store'

function setup() {
  const store = makeStore()
  const account = addGoogleAccount(store, 'max@muster-it.ch')
  const gmail = new FakeGmail()
  const client = new GmailClient({
    fetch: gmail.fetch,
    baseUrl: 'https://gmail.test/gmail/v1',
    accessToken: async () => 'token',
    sleep: async () => undefined,
    maxRetries: 0
  })
  return { store, gmail, account, sync: new GmailSync(store, account.id, client, { pageSize: 5 }) }
}

describe('drafts among a thread’s messages', () => {
  it('keeps a Gmail draft out of the mail it is a reply to', async () => {
    const { store, gmail, account, sync } = setup()
    gmail.addMessage({
      id: 'm1',
      threadId: 't1',
      from: 'info@jungunternehmerzentrum.ch',
      subject: 'Informationen zur Servicepartnerschaft'
    })
    gmail.addDraft({
      id: 'd1',
      threadId: 't1',
      from: 'max@muster-it.ch',
      subject: 'Re: Informationen zur Servicepartnerschaft',
      html: '<p></p>'
    })

    await sync.initialSync()

    expect(store.messages.getByRemoteId(account.id, 'd1')).toBeNull()
    const summary = store.messages.threadSummaries(
      store.messages.listThreadIds({ accountId: account.id, labelRemoteId: SYSTEM_LABELS.inbox })
    )[0]!
    expect(summary.lastDirection).toBe('incoming')
    expect(summary.messageCount).toBe(1)
  })

  it('drops a message that turned back into a draft at Gmail', async () => {
    const { store, gmail, account, sync } = setup()
    const message = gmail.addMessage({ id: 'm1', threadId: 't1' })
    await sync.initialSync()
    expect(store.messages.getByRemoteId(account.id, 'm1')).not.toBeNull()

    message.labelIds = [SYSTEM_LABELS.drafts]
    gmail.pushHistory({
      labelsAdded: [
        { message: { id: 'm1', threadId: 't1', labelIds: ['DRAFT'] }, labelIds: ['DRAFT'] }
      ]
    })
    await sync.incrementalSync()

    expect(store.messages.getByRemoteId(account.id, 'm1')).toBeNull()
  })

  it('marks the conversation a draft belongs to', () => {
    const { store, account } = setup()
    const messageId = seedMessage(store, account, {
      remoteId: 'm1',
      threadRemoteId: 't1',
      subject: 'Informationen zur Servicepartnerschaft'
    })
    store.drafts.save({
      id: null,
      accountId: account.id,
      kind: 'reply',
      identityId: null,
      identityName: 'Max Muster',
      identityEmail: 'max@muster-it.ch',
      to: 'info@jungunternehmerzentrum.ch',
      cc: '',
      bcc: '',
      subject: 'Re: Informationen zur Servicepartnerschaft',
      html: '<p>Besten Dank für die Unterlagen</p>',
      attachments: [],
      replyToMessageId: messageId
    })

    const summary = store.messages.threadSummary(store.messages.get(messageId)!.threadId)!
    expect(summary.draft?.snippet).toBe('Besten Dank für die Unterlagen')
  })

  it('leaves a conversation without a draft unmarked', () => {
    const { store, account } = setup()
    const messageId = seedMessage(store, account, { remoteId: 'm1', threadRemoteId: 't1' })

    const summary = store.messages.threadSummary(store.messages.get(messageId)!.threadId)!
    expect(summary.draft).toBeNull()
  })
})
