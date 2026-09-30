import { describe, expect, it } from 'vitest'
import { SYSTEM_LABELS } from '@shared/types'
import { GmailClient } from '@main/google/client'
import { GmailSync } from '@main/google/sync'
import { MutationService } from '@main/mutations'
import { labelKey } from '@main/db/ids'
import { messageSource, reconstructSource } from '@main/source'
import { FakeGmail } from '../helpers/fake-gmail'
import { addGoogleAccount, addResendAccount, makeStore, seedMessage } from '../helpers/store'
import { createTestApp } from '../helpers/app'

function gmailSetup(): {
  store: ReturnType<typeof makeStore>
  gmail: FakeGmail
  client: GmailClient
  mutations: MutationService
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
    sleep: async () => undefined,
    maxRetries: 0
  })
  const mutations = new MutationService(store, {
    gmailClientFor: (id) => (id === account.id ? client : null),
    now: () => 1_000
  })
  const sync = new GmailSync(store, account.id, client, { pageSize: 5 })
  return { store, gmail, client, mutations, sync, accountId: account.id }
}

describe('starring', () => {
  it('writes the STARRED label back to Gmail and shows on the thread summary', async () => {
    const { store, gmail, mutations, sync, accountId } = gmailSetup()
    gmail.addMessage({ id: 'm1' })
    await sync.initialSync()
    const message = store.messages.getByRemoteId(accountId, 'm1')!
    expect(store.messages.threadSummary(message.threadId)?.starred).toBe(false)

    mutations.setStarred([message.id], true)
    expect(store.messages.threadSummary(message.threadId)?.starred).toBe(true)
    await mutations.flush()
    expect(gmail.modifications.at(-1)).toEqual({
      id: 'm1',
      addLabelIds: ['STARRED'],
      removeLabelIds: []
    })

    mutations.setStarred([message.id], false)
    await mutations.flush()
    expect(gmail.modifications.at(-1)?.removeLabelIds).toEqual(['STARRED'])
    expect(store.messages.labelIdsOf(message.id)).not.toContain(
      labelKey(accountId, SYSTEM_LABELS.starred)
    )
  })

  it('picks up a star set in Gmail on the next sync', async () => {
    const { store, gmail, sync, accountId } = gmailSetup()
    gmail.addMessage({ id: 'm1', labelIds: ['INBOX', 'STARRED'] })
    await sync.initialSync()
    const message = store.messages.getByRemoteId(accountId, 'm1')!
    expect(store.messages.threadSummary(message.threadId)?.starred).toBe(true)
  })

  it('keeps a Resend star local, and is:starred still finds it', () => {
    const store = makeStore()
    const account = addResendAccount(store)
    const id = seedMessage(store, account, { remoteId: 'r1', subject: 'Offerte' })
    const mutations = new MutationService(store, { gmailClientFor: () => null })

    mutations.setStarred([id], true)
    expect(store.queue.list()).toHaveLength(0)
    expect(store.search.query({ text: 'is:starred' }).map((hit) => hit.subject)).toEqual([
      'Offerte'
    ])
  })

  it('stars the newest message, unstars all of them, and lists the starred view', async () => {
    const harness = createTestApp()
    try {
      const store = harness.app.store
      const account = addGoogleAccount(store, 'max@muster-it.ch')
      const first = seedMessage(store, account, {
        remoteId: 'a',
        threadRemoteId: 't',
        date: 1_000,
        labels: [SYSTEM_LABELS.inbox, SYSTEM_LABELS.starred]
      })
      const second = seedMessage(store, account, { remoteId: 'b', threadRemoteId: 't', date: 2_000 })
      seedMessage(store, account, { remoteId: 'c', subject: 'Andere' })
      const threadId = store.messages.get(first)!.threadId
      const starred = labelKey(account.id, SYSTEM_LABELS.starred)

      await harness.app.api['threads:star']([threadId], true)
      expect(store.messages.labelIdsOf(second)).toContain(starred)

      const view = await harness.app.api['threads:list']({
        accountId: null,
        labelId: null,
        view: 'starred'
      })
      expect(view.map((thread) => thread.threadId)).toEqual([threadId])

      await harness.app.api['threads:star']([threadId], false)
      expect(store.messages.labelIdsOf(first)).not.toContain(starred)
      expect(store.messages.labelIdsOf(second)).not.toContain(starred)
      expect(
        await harness.app.api['threads:list']({ accountId: null, labelId: null, view: 'starred' })
      ).toHaveLength(0)
    } finally {
      harness.dispose()
    }
  })
})

describe('message source', () => {
  it('fetches the raw message from Gmail on demand', async () => {
    const { store, gmail, client, sync, accountId } = gmailSetup()
    gmail.addMessage({ id: 'm1', subject: 'Rohfassung' })
    await sync.initialSync()
    const message = store.messages.getByRemoteId(accountId, 'm1')!

    const source = await messageSource(
      { store, gmailClientFor: () => client, resendClient: () => null },
      message.id
    )
    expect(source.origin).toBe('gmail')
    expect(source.raw).toContain('Subject: Rohfassung')
    expect(source.raw).toContain('X-Fake-Gmail: raw')
  })

  it('rebuilds the headers when the provider has no copy to give', async () => {
    const { store, gmail, client, sync, accountId } = gmailSetup()
    gmail.addMessage({ id: 'm1', subject: 'Offline' })
    await sync.initialSync()
    const message = store.messages.getByRemoteId(accountId, 'm1')!
    gmail.offline = true

    const source = await messageSource(
      { store, gmailClientFor: () => client, resendClient: () => null },
      message.id
    )
    expect(source.origin).toBe('reconstructed')
    expect(source.raw).toContain('Subject: Offline')
    expect(source.raw).toMatch(/^Message-ID: <m1@/)
  })

  it('writes stored bodies out as readable parts', () => {
    const store = makeStore()
    const account = addResendAccount(store)
    const id = seedMessage(store, account, {
      remoteId: 'r1',
      subject: 'Hallo',
      inReplyTo: '<x@y>',
      body: { html: '<p>Hi</p>', text: 'Hi' }
    })
    const raw = reconstructSource(store.messages.get(id)!, store.messages.body(id), [])
    expect(raw).toContain('In-Reply-To: <x@y>')
    expect(raw).toContain('Content-Type: text/html; charset="UTF-8"\r\n\r\n<p>Hi</p>')
  })
})
