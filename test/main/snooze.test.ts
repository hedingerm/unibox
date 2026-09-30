import { describe, expect, it } from 'vitest'
import { SYSTEM_LABELS } from '@shared/types'
import { labelKey, threadKey } from '@main/db/ids'
import { MutationService } from '@main/mutations'
import { SnoozeService } from '@main/snooze'
import type { Store } from '@main/db/store'
import type { Account } from '@shared/types'
import { addGoogleAccount, addResendAccount, makeStore, seedMessage } from '../helpers/store'

const HOUR = 3600 * 1000

interface Harness {
  store: Store
  snooze: SnoozeService
  account: Account
  /** Moves the clock both services read. */
  setNow: (value: number) => void
}

function setup(start = 1_000_000): Harness {
  const store = makeStore()
  const account = addGoogleAccount(store, 'max@muster-it.ch')
  let now = start
  const mutations = new MutationService(store, {
    // No Gmail client: the queue still records the write-back, which is all
    // these tests care about.
    gmailClientFor: () => null,
    now: () => now
  })
  const snooze = new SnoozeService(store, mutations, { now: () => now })
  return { store, snooze, account, setNow: (value) => (now = value) }
}

function inInbox(store: Store, messageId: string, accountId: string): boolean {
  return store.messages.labelIdsOf(messageId).includes(labelKey(accountId, SYSTEM_LABELS.inbox))
}

describe('snoozing a conversation', () => {
  it('archives it now and puts it back when the time comes', () => {
    const { store, snooze, account, setNow } = setup()
    const messageId = seedMessage(store, account, { remoteId: 'm1' })
    const threadId = threadKey(account.id, 'm1')

    snooze.snooze([threadId], 1_000_000 + 2 * HOUR)
    expect(inInbox(store, messageId, account.id)).toBe(false)
    expect(store.snoozes.get(threadId)?.wakeAt).toBe(1_000_000 + 2 * HOUR)

    // Not yet: a snooze that fires early is worse than no snooze.
    setNow(1_000_000 + HOUR)
    expect(snooze.tick()).toEqual([])
    expect(inInbox(store, messageId, account.id)).toBe(false)

    setNow(1_000_000 + 3 * HOUR)
    expect(snooze.tick()).toEqual([threadId])
    expect(inInbox(store, messageId, account.id)).toBe(true)
    expect(store.snoozes.get(threadId)).toBeNull()
  })

  it('wakes everything that fell due while the app was closed', () => {
    const { store, snooze, account, setNow } = setup()
    seedMessage(store, account, { remoteId: 'm1' })
    seedMessage(store, account, { remoteId: 'm2' })
    const first = threadKey(account.id, 'm1')
    const second = threadKey(account.id, 'm2')

    snooze.snooze([first], 1_000_000 + HOUR)
    snooze.snooze([second], 1_000_000 + 2 * HOUR)

    // A week later — the wake is late, not lost.
    setNow(1_000_000 + 7 * 24 * HOUR)
    expect(snooze.tick().sort()).toEqual([first, second].sort())
    expect(store.snoozes.count()).toBe(0)
  })

  it('refuses a moment that has already passed', () => {
    const { store, snooze, account } = setup()
    seedMessage(store, account, { remoteId: 'm1' })
    expect(() => snooze.snooze([threadKey(account.id, 'm1')], 999_000)).toThrow()
    expect(store.snoozes.count()).toBe(0)
  })

  it('moves the wake time instead of stacking a second reminder', () => {
    const { store, snooze, account } = setup()
    seedMessage(store, account, { remoteId: 'm1' })
    const threadId = threadKey(account.id, 'm1')

    snooze.snooze([threadId], 1_000_000 + HOUR)
    snooze.snooze([threadId], 1_000_000 + 5 * HOUR)
    expect(store.snoozes.count()).toBe(1)
    expect(store.snoozes.get(threadId)?.wakeAt).toBe(1_000_000 + 5 * HOUR)
  })

  it('queues the archive and the un-archive as ordinary write-backs', () => {
    const { store, snooze, account, setNow } = setup()
    seedMessage(store, account, { remoteId: 'm1' })
    const threadId = threadKey(account.id, 'm1')

    snooze.snooze([threadId], 1_000_000 + HOUR)
    expect(store.queue.list().map((entry) => entry.op)).toEqual(['remove_labels'])

    setNow(1_000_000 + 2 * HOUR)
    snooze.tick()
    expect(store.queue.list().map((entry) => entry.op)).toEqual(['remove_labels', 'add_labels'])
  })

  it('keeps working for Resend, which has no remote labels at all', () => {
    const store = makeStore()
    const account = addResendAccount(store, 'beispielweb.ch')
    let now = 1_000_000
    const mutations = new MutationService(store, { gmailClientFor: () => null, now: () => now })
    const snooze = new SnoozeService(store, mutations, { now: () => now })
    const messageId = seedMessage(store, account, { remoteId: 'r1' })
    const threadId = threadKey(account.id, 'r1')

    snooze.snooze([threadId], 1_000_000 + HOUR)
    expect(inInbox(store, messageId, account.id)).toBe(false)
    // Nothing was queued: Resend keeps archive state purely local.
    expect(store.queue.list()).toHaveLength(0)

    now = 1_000_000 + 2 * HOUR
    snooze.tick()
    expect(inInbox(store, messageId, account.id)).toBe(true)
  })
})

describe('a snooze that ends early', () => {
  it('wakes as soon as the conversation gets new mail', () => {
    const { store, snooze, account, setNow } = setup()
    seedMessage(store, account, { remoteId: 'm1', threadRemoteId: 't1' })
    const threadId = threadKey(account.id, 't1')
    snooze.snooze([threadId], 1_000_000 + 7 * 24 * HOUR)

    // The reply lands hours later; the reminder has arrived by itself.
    setNow(1_000_000 + 4 * HOUR)
    seedMessage(store, account, { remoteId: 'm2', threadRemoteId: 't1' })
    expect(snooze.tick()).toEqual([threadId])
    expect(store.snoozes.count()).toBe(0)
  })

  it('is not woken by mail that was already in the thread', () => {
    const { store, snooze, account } = setup()
    seedMessage(store, account, { remoteId: 'm1', threadRemoteId: 't1' })
    seedMessage(store, account, { remoteId: 'm2', threadRemoteId: 't1' })
    snooze.snooze([threadKey(account.id, 't1')], 1_000_000 + 7 * 24 * HOUR)

    expect(snooze.tick()).toEqual([])
    expect(store.snoozes.count()).toBe(1)
  })

  it('is not woken by the user’s own reply', () => {
    const { store, snooze, account, setNow } = setup()
    seedMessage(store, account, { remoteId: 'm1', threadRemoteId: 't1' })
    snooze.snooze([threadKey(account.id, 't1')], 1_000_000 + 7 * 24 * HOUR)

    setNow(1_000_000 + 4 * HOUR)
    seedMessage(store, account, {
      remoteId: 'm2',
      threadRemoteId: 't1',
      direction: 'outgoing',
      labels: [SYSTEM_LABELS.sent]
    })
    expect(snooze.tick()).toEqual([])
  })

  it('drops the reminder when the conversation is thrown away', () => {
    const { store, snooze, account } = setup()
    const messageId = seedMessage(store, account, { remoteId: 'm1' })
    const threadId = threadKey(account.id, 'm1')
    snooze.snooze([threadId], 1_000_000 + 7 * 24 * HOUR)

    snooze.forgetByMessages([messageId])
    expect(store.snoozes.count()).toBe(0)
  })

  it('forgets a reminder whose conversation no longer exists', () => {
    const { store, snooze, account } = setup()
    const messageId = seedMessage(store, account, { remoteId: 'm1' })
    const threadId = threadKey(account.id, 'm1')
    snooze.snooze([threadId], 1_000_000 + 7 * 24 * HOUR)

    store.messages.remove(messageId)
    expect(snooze.tick()).toEqual([])
    expect(store.snoozes.count()).toBe(0)
  })
})

describe('the snooze view', () => {
  it('lists what is waiting, the one returning soonest first', () => {
    const { store, snooze, account } = setup()
    seedMessage(store, account, { remoteId: 'm1' })
    seedMessage(store, account, { remoteId: 'm2' })
    const first = threadKey(account.id, 'm1')
    const second = threadKey(account.id, 'm2')

    snooze.snooze([first], 1_000_000 + 5 * HOUR)
    snooze.snooze([second], 1_000_000 + HOUR)

    expect(store.messages.snoozedThreadIds()).toEqual([second, first])
    expect(snooze.count()).toBe(2)
  })

  it('tells every list when a conversation comes back', () => {
    const { store, snooze, account } = setup()
    seedMessage(store, account, { remoteId: 'm1' })
    const threadId = threadKey(account.id, 'm1')
    snooze.snooze([threadId], 1_000_000 + HOUR)

    expect(store.messages.threadSummary(threadId)?.snoozedUntil).toBe(1_000_000 + HOUR)
    snooze.unsnooze([threadId])
    expect(store.messages.threadSummary(threadId)?.snoozedUntil).toBeNull()
  })
})
