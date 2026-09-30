import { describe, expect, it } from 'vitest'
import { SYSTEM_LABELS } from '@shared/types'
import { GmailClient } from '@main/google/client'
import { GmailSync } from '@main/google/sync'
import { MutationService } from '@main/mutations'
import { labelKey } from '@main/db/ids'
import { FakeGmail } from '../helpers/fake-gmail'
import { addGoogleAccount, addResendAccount, makeStore, seedMessage } from '../helpers/store'
import type { Store } from '@main/db/store'

interface Harness {
  store: Store
  gmail: FakeGmail
  mutations: MutationService
  accountId: string
  sync: GmailSync
}

function setup(): Harness {
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
  return { store, gmail, mutations, accountId: account.id, sync }
}

describe('write-back to Gmail', () => {
  it('archives locally at once and syncs the label removal', async () => {
    const { store, gmail, mutations, sync, accountId } = setup()
    gmail.addMessage({ id: 'm1' })
    await sync.initialSync()
    const message = store.messages.getByRemoteId(accountId, 'm1')!

    mutations.archive([message.id])
    expect(store.messages.labelIdsOf(message.id)).not.toContain(labelKey(accountId, SYSTEM_LABELS.inbox))

    await mutations.flush()
    expect(gmail.modifications).toEqual([{ id: 'm1', addLabelIds: [], removeLabelIds: ['INBOX'] }])
    expect(store.queue.list()).toHaveLength(0)
  })

  it('marks read and unread', async () => {
    const { store, gmail, mutations, sync, accountId } = setup()
    gmail.addMessage({ id: 'm1' })
    await sync.initialSync()
    const message = store.messages.getByRemoteId(accountId, 'm1')!

    mutations.setRead([message.id], true)
    await mutations.flush()
    expect(gmail.modifications.at(-1)?.removeLabelIds).toEqual(['UNREAD'])

    mutations.setRead([message.id], false)
    await mutations.flush()
    expect(gmail.modifications.at(-1)?.addLabelIds).toEqual(['UNREAD'])
    expect(store.messages.labelIdsOf(message.id)).toContain(labelKey(accountId, SYSTEM_LABELS.unread))
  })

  it('trashes through the dedicated endpoint', async () => {
    const { store, gmail, mutations, sync, accountId } = setup()
    gmail.addMessage({ id: 'm1' })
    await sync.initialSync()
    const message = store.messages.getByRemoteId(accountId, 'm1')!

    mutations.trash([message.id])
    await mutations.flush()
    expect(gmail.trashed).toEqual(['m1'])
    expect(store.messages.labelIdsOf(message.id)).toContain(labelKey(accountId, SYSTEM_LABELS.trash))

    mutations.untrash([message.id])
    await mutations.flush()
    expect(gmail.untrashed).toEqual(['m1'])
  })

  it('applies user label changes with remote label ids', async () => {
    const { store, gmail, mutations, sync, accountId } = setup()
    gmail.addUserLabel('Label_7', 'Kunden')
    gmail.addMessage({ id: 'm1' })
    await sync.initialSync()
    const message = store.messages.getByRemoteId(accountId, 'm1')!
    const kunden = labelKey(accountId, 'Label_7')

    mutations.changeLabels([message.id], [kunden], [])
    expect(store.messages.labelIdsOf(message.id)).toContain(kunden)
    await mutations.flush()
    expect(gmail.modifications.at(-1)?.addLabelIds).toEqual(['Label_7'])
  })

  it('permanently deletes remotely and locally', async () => {
    const { store, gmail, mutations, sync, accountId } = setup()
    gmail.addMessage({ id: 'm1' })
    await sync.initialSync()
    const message = store.messages.getByRemoteId(accountId, 'm1')!

    mutations.deletePermanently([message.id])
    expect(store.messages.get(message.id)).toBeNull()
    await mutations.flush()
    expect(gmail.deleted).toEqual(['m1'])
  })
})

describe('spam', () => {
  it('syncs spam for Gmail messages', async () => {
    const { store, gmail, mutations, sync, accountId } = setup()
    gmail.addMessage({ id: 'm1' })
    await sync.initialSync()
    const message = store.messages.getByRemoteId(accountId, 'm1')!

    mutations.markSpam([message.id])
    await mutations.flush()
    expect(gmail.modifications.at(-1)).toEqual({
      id: 'm1',
      addLabelIds: ['SPAM'],
      removeLabelIds: ['INBOX']
    })
    expect(store.messages.labelIdsOf(message.id)).toContain(labelKey(accountId, SYSTEM_LABELS.spam))
  })

  it('keeps spam local for Resend messages', async () => {
    const { store, mutations } = setup()
    const resend = addResendAccount(store)
    const id = seedMessage(store, resend, { remoteId: 'r1' })

    mutations.markSpam([id])
    expect(store.messages.labelIdsOf(id)).toContain(labelKey(resend.id, SYSTEM_LABELS.spam))
    expect(store.queue.list()).toHaveLength(0)
  })
})

describe('offline queue', () => {
  it('keeps actions and replays them in order once back online', async () => {
    const { store, gmail, mutations, sync, accountId } = setup()
    gmail.addMessage({ id: 'm1' })
    gmail.addMessage({ id: 'm2' })
    await sync.initialSync()
    const first = store.messages.getByRemoteId(accountId, 'm1')!
    const second = store.messages.getByRemoteId(accountId, 'm2')!

    gmail.offline = true
    mutations.setRead([first.id], true)
    mutations.archive([first.id])
    mutations.archive([second.id])

    const offlineResult = await mutations.flush()
    expect(offlineResult.done).toBe(0)
    expect(offlineResult.retry).toBe(1)
    expect(store.queue.list()).toHaveLength(3)
    expect(gmail.modifications).toHaveLength(0)

    // Locally the user already sees the effect.
    expect(store.messages.labelIdsOf(first.id)).not.toContain(labelKey(accountId, SYSTEM_LABELS.inbox))

    gmail.offline = false
    const later = new MutationService(store, {
      gmailClientFor: () => new GmailClient({
        fetch: gmail.fetch,
        baseUrl: 'https://gmail.test/gmail/v1',
        accessToken: async () => 'token',
        sleep: async () => undefined
      }),
      now: () => 10 * 60_000
    })
    const result = await later.flush()
    expect(result.done).toBe(3)
    expect(gmail.modifications.map((m) => [m.id, m.removeLabelIds?.[0] ?? m.addLabelIds?.[0]])).toEqual([
      ['m1', 'UNREAD'],
      ['m1', 'INBOX'],
      ['m2', 'INBOX']
    ])
  })

  it('does not let one failing account block another', async () => {
    const store = makeStore()
    const a = addGoogleAccount(store, 'a@example.com')
    const b = addGoogleAccount(store, 'b@example.com')
    const idA = seedMessage(store, a, { remoteId: 'ma' })
    const idB = seedMessage(store, b, { remoteId: 'mb' })

    const goodGmail = new FakeGmail()
    goodGmail.addMessage({ id: 'mb' })
    const badGmail = new FakeGmail()
    badGmail.offline = true

    const clientFor = (accountId: string): GmailClient =>
      new GmailClient({
        fetch: accountId === a.id ? badGmail.fetch : goodGmail.fetch,
        baseUrl: 'https://gmail.test/gmail/v1',
        accessToken: async () => 'token',
        sleep: async () => undefined,
        maxRetries: 0
      })

    const mutations = new MutationService(store, { gmailClientFor: clientFor, now: () => 0 })
    mutations.archive([idA])
    mutations.archive([idB])
    const result = await mutations.flush()
    expect(result.done).toBe(1)
    expect(goodGmail.modifications).toHaveLength(1)
    expect(store.queue.list().map((m) => m.accountId)).toEqual([a.id])
    store.close()
  })

  it('gives up on permanent errors instead of retrying forever', async () => {
    const store = makeStore()
    const account = addGoogleAccount(store)
    const id = seedMessage(store, account, { remoteId: 'missing' })
    const gmail = new FakeGmail()
    const mutations = new MutationService(store, {
      gmailClientFor: () =>
        new GmailClient({
          fetch: gmail.fetch,
          baseUrl: 'https://gmail.test/gmail/v1',
          accessToken: async () => 'token',
          sleep: async () => undefined,
          maxRetries: 0
        }),
      now: () => 0
    })
    mutations.changeLabels([id], [labelKey(account.id, 'INBOX')], [])
    const result = await mutations.flush()
    expect(result.failed).toBe(1)
    expect(store.queue.list()[0]?.state).toBe('failed')
    store.close()
  })
})
