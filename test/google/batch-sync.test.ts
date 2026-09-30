import { describe, expect, it } from 'vitest'
import { SYSTEM_LABELS } from '@shared/types'
import { GmailClient } from '@main/google/client'
import { GmailSync } from '@main/google/sync'
import type { Store } from '@main/db/store'
import { FakeGmail } from '../helpers/fake-gmail'
import { addGoogleAccount, makeStore } from '../helpers/store'

interface Harness {
  store: Store
  gmail: FakeGmail
  sync: GmailSync
  accountId: string
  /** Virtual milliseconds the client spent waiting on Gmail's quota. */
  elapsed: () => number
}

function setup(options: { pageSize?: number; batchSize?: number } = {}): Harness {
  const store = makeStore()
  const account = addGoogleAccount(store, 'max@muster-it.ch')
  const gmail = new FakeGmail()
  let clock = 0

  const client = new GmailClient({
    fetch: gmail.fetch,
    baseUrl: 'https://gmail.test/gmail/v1',
    accessToken: async () => 'token',
    sleep: async (ms) => {
      clock += ms
    },
    now: () => clock
  })
  const sync = new GmailSync(store, account.id, client, {
    pageSize: options.pageSize ?? 100,
    batchSize: options.batchSize
  })
  return { store, gmail, sync, accountId: account.id, elapsed: () => clock }
}

describe('initial sync over the batch endpoint', () => {
  it('bundles a page of messages into a single round trip', async () => {
    const { store, gmail, sync, accountId } = setup()
    for (let index = 1; index <= 60; index += 1) {
      gmail.addMessage({ id: `m${index}`, subject: `Betreff ${index}`, text: `Inhalt ${index}` })
    }

    await sync.initialSync()

    expect(gmail.batchRequests).toBe(1)
    expect(gmail.largestBatch).toBe(60)
    expect(store.messages.listThreadIds({ labelRemoteId: SYSTEM_LABELS.inbox, limit: 200 })).toHaveLength(60)
    const message = store.messages.getByRemoteId(accountId, 'm42')!
    expect(message.subject).toBe('Betreff 42')
    expect(store.messages.body(message.id).text).toBe('Inhalt 42')
  })

  it('never asks for more than 100 messages at a time', async () => {
    const { gmail, sync } = setup({ pageSize: 500 })
    for (let index = 1; index <= 250; index += 1) gmail.addMessage({ id: `m${index}` })

    await sync.initialSync()
    expect(gmail.largestBatch).toBeLessThanOrEqual(100)
    expect(gmail.batchRequests).toBe(3)
  })

  it('imports the rest of the page when one message fails for good', async () => {
    const { store, gmail, sync, accountId } = setup()
    for (const id of ['m1', 'm2', 'm3']) gmail.addMessage({ id })
    gmail.partFailures.set('m2', { status: 404, reason: 'notFound', message: 'Not Found' })

    await sync.initialSync()

    expect(store.messages.getByRemoteId(accountId, 'm1')).not.toBeNull()
    expect(store.messages.getByRemoteId(accountId, 'm2')).toBeNull()
    expect(store.messages.getByRemoteId(accountId, 'm3')).not.toBeNull()
    expect(store.accounts.get(accountId)?.initialSyncDone).toBe(true)
  })

  it('re-requests a throttled message instead of losing it', async () => {
    const { store, gmail, sync, accountId } = setup()
    for (const id of ['m1', 'm2']) gmail.addMessage({ id })
    gmail.rateLimitedOnce.add('m2')

    await sync.initialSync()

    expect(gmail.batchRequests).toBe(2) // one full round, one for the throttled id
    expect(store.messages.getByRemoteId(accountId, 'm2')).not.toBeNull()
  })

  it('throttles itself so a rate limit does not abort the import', async () => {
    const { store, gmail, sync, elapsed } = setup()
    for (let index = 1; index <= 100; index += 1) gmail.addMessage({ id: `m${index}` })
    gmail.rateLimitFor = 3 // the batch request itself is refused three times

    await sync.initialSync()

    expect(store.messages.listThreadIds({ labelRemoteId: SYSTEM_LABELS.inbox, limit: 200 })).toHaveLength(100)
    // It waited rather than giving up.
    expect(elapsed()).toBeGreaterThan(0)
  })
})

describe('a large mailbox arrives in minutes, not hours', () => {
  it('imports 6000 messages inside Gmail quota in under three minutes', async () => {
    const { store, gmail, sync, elapsed } = setup()
    for (let index = 1; index <= 6000; index += 1) gmail.addMessage({ id: `m${index}` })

    await sync.initialSync()

    expect(gmail.batchRequests).toBe(60)
    expect(store.messages.countByLabelRemoteId(SYSTEM_LABELS.inbox)).toBe(6000)
    // 6000 gets at 5 quota units each, against Gmail's 250 units per second.
    expect(elapsed()).toBeLessThan(180_000)
    expect(elapsed()).toBeGreaterThan(100_000)
  }, 60_000)
})

describe('a first sync survives a restart', () => {
  it('resumes where it stopped, without loss and without duplicates', async () => {
    const first = setup({ pageSize: 50 })
    for (let index = 1; index <= 200; index += 1) first.gmail.addMessage({ id: `m${index}` })

    // Abort mid-import: the third page throws, leaving the cursor behind.
    let pages = 0
    const failing = new FakeGmail()
    failing.messages = first.gmail.messages
    const store = first.store
    const account = store.accounts.get(first.accountId)!

    const client = new GmailClient({
      fetch: async (input, init) => {
        const url = new URL(typeof input === 'string' ? input : input.toString())
        if (url.pathname.endsWith('/users/me/messages') && (init?.method ?? 'GET') === 'GET') {
          pages += 1
          if (pages > 2) throw new TypeError('fetch failed')
        }
        return failing.fetch(input, init)
      },
      baseUrl: 'https://gmail.test/gmail/v1',
      accessToken: async () => 'token',
      sleep: async () => undefined
    })
    const aborting = new GmailSync(store, account.id, client, { pageSize: 50 })
    await expect(aborting.initialSync()).rejects.toThrow()

    const imported = store.messages.countByLabelRemoteId(SYSTEM_LABELS.inbox)
    expect(imported).toBeGreaterThan(0)
    expect(imported).toBeLessThan(200)
    expect(store.accounts.get(account.id)?.initialSyncDone).toBe(false)

    // Restart: the cursor picks up where the run stopped.
    const resumed = new GmailSync(
      store,
      account.id,
      new GmailClient({
        fetch: failing.fetch,
        baseUrl: 'https://gmail.test/gmail/v1',
        accessToken: async () => 'token',
        sleep: async () => undefined
      }),
      { pageSize: 50 }
    )
    await resumed.initialSync()

    expect(store.messages.countByLabelRemoteId(SYSTEM_LABELS.inbox)).toBe(200)
    const rows = store.db
      .prepare('SELECT COUNT(*) AS n, COUNT(DISTINCT remote_id) AS distinct_ids FROM messages')
      .get() as { n: number; distinct_ids: number }
    expect(rows.n).toBe(rows.distinct_ids)
    expect(store.accounts.get(account.id)?.initialSyncDone).toBe(true)
  })
})
