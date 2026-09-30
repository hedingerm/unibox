import { describe, expect, it } from 'vitest'
import { SYSTEM_LABELS } from '@shared/types'
import type { Account, OutboxItem } from '@shared/types'
import { messageKey, threadKey } from '@main/db/ids'
import { FollowUpService } from '@main/followups'
import type { Store } from '@main/db/store'
import { addGoogleAccount, makeStore, seedMessage } from '../helpers/store'

const DAY = 24 * 3600 * 1000

/** Monday 17 August 2026, 09:00 local — a working day with room after it. */
const MONDAY = new Date(2026, 7, 17, 9, 0, 0, 0).getTime()

interface Harness {
  store: Store
  followUps: FollowUpService
  account: Account
  setNow: (value: number) => void
  now: () => number
}

function setup(start = MONDAY): Harness {
  const store = makeStore()
  const account = addGoogleAccount(store, 'max@muster-it.ch')
  let now = start
  const followUps = new FollowUpService(store, { now: () => now })
  return { store, followUps, account, setNow: (value) => (now = value), now: () => now }
}

/** A mail that has just gone out, as the outbox hands it to the send path. */
function sentItem(account: Account, patch: Partial<OutboxItem> = {}): OutboxItem {
  return {
    id: 'outbox-1',
    accountId: account.id,
    identityName: 'Max Muster',
    identityEmail: account.email,
    to: [{ name: 'Sandra Keller', email: 's.keller@keller-farben.ch' }],
    cc: [],
    bcc: [],
    subject: 'Offerte Website',
    html: '<p>Guten Tag</p>',
    text: 'Guten Tag',
    attachments: [],
    replyToMessageId: null,
    followUpDays: 3,
    state: 'sent',
    sendAt: MONDAY,
    attempts: 0,
    lastError: null,
    createdAt: MONDAY,
    sentMessageId: null,
    ...patch
  }
}

/** Puts the sent mail on disk the way both send paths eventually do. */
function seedSent(harness: Harness, remoteId: string, threadRemoteId = remoteId): string {
  return seedMessage(harness.store, harness.account, {
    remoteId,
    threadRemoteId,
    direction: 'outgoing',
    subject: 'Offerte Website',
    from: { name: 'Max Muster', email: harness.account.email },
    to: [{ name: null, email: 's.keller@keller-farben.ch' }],
    date: harness.now(),
    labels: [SYSTEM_LABELS.sent]
  })
}

describe('arming a follow-up when a mail goes out', () => {
  it('waits the requested working days', () => {
    const harness = setup()
    const messageId = seedSent(harness, 'm1')

    const followUp = harness.followUps.track(sentItem(harness.account), messageId)

    expect(followUp).not.toBeNull()
    expect(followUp!.threadId).toBe(threadKey(harness.account.id, 'm1'))
    // Monday + 3 working days is Thursday, same time of day.
    expect(new Date(followUp!.dueAt).getDay()).toBe(4)
    expect(followUp!.dueAt).toBe(MONDAY + 3 * DAY)
  })

  it('arms nothing when the composer unticked the box', () => {
    const harness = setup()
    const messageId = seedSent(harness, 'm1')
    expect(
      harness.followUps.track(sentItem(harness.account, { followUpDays: null }), messageId)
    ).toBeNull()
    expect(harness.store.followUps.listOpen()).toHaveLength(0)
  })

  it('arms nothing for an address that will never write back', () => {
    const harness = setup()
    const messageId = seedSent(harness, 'm1')
    const item = sentItem(harness.account, {
      to: [{ name: null, email: 'noreply@stripe.com' }]
    })
    expect(harness.followUps.track(item, messageId)).toBeNull()
  })

  it('arms nothing while the feature is switched off', () => {
    const harness = setup()
    harness.store.settings.set({ followUpEnabled: false })
    const messageId = seedSent(harness, 'm1')
    expect(harness.followUps.track(sentItem(harness.account), messageId)).toBeNull()
  })

  it('moves the existing wait instead of stacking a second one', () => {
    const harness = setup()
    const first = seedSent(harness, 'm1')
    harness.followUps.track(sentItem(harness.account), first)

    harness.setNow(MONDAY + 4 * DAY)
    const second = seedSent(harness, 'm2', 'm1')
    const followUp = harness.followUps.track(sentItem(harness.account), second)

    expect(harness.store.followUps.listOpen()).toHaveLength(1)
    expect(followUp!.messageId).toBe(second)
    expect(followUp!.nudgeCount).toBe(1)
    expect(followUp!.dueAt).toBeGreaterThan(MONDAY + 4 * DAY)
  })

  it('survives a send whose follow-on sync never landed the message', () => {
    const harness = setup()
    // Nothing seeded: the mail is out, but not on disk yet.
    const missing = messageKey(harness.account.id, 'm1')
    const followUp = harness.followUps.track(sentItem(harness.account), missing)
    expect(followUp!.threadId).toBe('')
    // With no conversation behind it the row stays out of every list…
    expect(harness.store.followUps.openThreadIds(null, 10, 0)).toEqual([])

    // …until the message arrives and the next review adopts it.
    seedSent(harness, 'm1')
    harness.followUps.reconcile()
    expect(harness.store.followUps.get(followUp!.id)?.threadId).toBe(
      threadKey(harness.account.id, 'm1')
    )
  })

  it('drops a row whose message never turned up at all', () => {
    const harness = setup()
    harness.followUps.track(sentItem(harness.account), messageKey(harness.account.id, 'gone'))
    harness.setNow(MONDAY + 8 * DAY)
    harness.followUps.reconcile()
    expect(harness.store.followUps.listOpen()).toHaveLength(0)
  })
})

describe('ending a wait by itself', () => {
  function armed(harness: Harness): string {
    const messageId = seedSent(harness, 'm1')
    return harness.followUps.track(sentItem(harness.account), messageId)!.id
  }

  it('resolves as soon as somebody answers', () => {
    const harness = setup()
    const id = armed(harness)

    harness.setNow(MONDAY + DAY)
    seedMessage(harness.store, harness.account, {
      remoteId: 'r1',
      threadRemoteId: 'm1',
      subject: 'AW: Offerte Website',
      date: harness.now()
    })

    expect(harness.followUps.reconcile().resolved).toBe(1)
    const followUp = harness.store.followUps.get(id)!
    expect(followUp.state).toBe('resolved')
    expect(followUp.resolvedReason).toBe('replied')
  })

  it('is not fooled by an out-of-office notice', () => {
    const harness = setup()
    const id = armed(harness)

    harness.setNow(MONDAY + DAY)
    // Gmail's own responder keeps the subject and marks itself in the headers.
    seedMessage(harness.store, harness.account, {
      remoteId: 'r1',
      threadRemoteId: 'm1',
      subject: 'Offerte Website',
      autoReply: true,
      date: harness.now()
    })

    expect(harness.followUps.reconcile().resolved).toBe(0)
    expect(harness.store.followUps.get(id)?.state).toBe('open')
  })

  it('is not fooled by an absence notice that only says so in its subject', () => {
    const harness = setup()
    const id = armed(harness)

    harness.setNow(MONDAY + DAY)
    seedMessage(harness.store, harness.account, {
      remoteId: 'r1',
      threadRemoteId: 'm1',
      subject: 'Automatische Antwort: Offerte Website',
      date: harness.now()
    })

    harness.followUps.reconcile()
    expect(harness.store.followUps.get(id)?.state).toBe('open')
  })

  it('is not fooled by a no-reply sender writing into the thread', () => {
    const harness = setup()
    const id = armed(harness)

    harness.setNow(MONDAY + DAY)
    seedMessage(harness.store, harness.account, {
      remoteId: 'r1',
      threadRemoteId: 'm1',
      from: { name: null, email: 'no-reply@keller-farben.ch' },
      date: harness.now()
    })

    harness.followUps.reconcile()
    expect(harness.store.followUps.get(id)?.state).toBe('open')
  })

  it('restarts the wait when we write again instead of ending it', () => {
    const harness = setup()
    const id = armed(harness)

    harness.setNow(MONDAY + 2 * DAY)
    seedSent(harness, 'm2', 'm1')

    expect(harness.followUps.reconcile()).toEqual({ resolved: 0, nudged: 1 })
    const followUp = harness.store.followUps.get(id)!
    expect(followUp.nudgeCount).toBe(1)
    expect(followUp.messageId).toBe(messageKey(harness.account.id, 'm2'))
    // Wednesday + 3 working days is the following Monday.
    expect(followUp.dueAt).toBe(MONDAY + 7 * DAY)

    // The same nudge must not be counted a second time on the next cycle.
    expect(harness.followUps.reconcile()).toEqual({ resolved: 0, nudged: 0 })
    expect(harness.store.followUps.get(id)?.nudgeCount).toBe(1)
  })

  it('stops waiting once the conversation is thrown away', () => {
    const harness = setup()
    const messageId = seedSent(harness, 'm1')
    const id = harness.followUps.track(sentItem(harness.account), messageId)!.id

    harness.followUps.forgetByMessages([messageId])
    expect(harness.store.followUps.get(id)?.resolvedReason).toBe('dropped')
  })
})

describe('announcing what has run out of time', () => {
  it('says nothing before the date and exactly once after it', () => {
    const harness = setup()
    const messageId = seedSent(harness, 'm1')
    harness.followUps.track(sentItem(harness.account), messageId)

    harness.setNow(MONDAY + DAY)
    expect(harness.followUps.takeDue()).toHaveLength(0)

    harness.setNow(MONDAY + 3 * DAY)
    const due = harness.followUps.takeDue()
    expect(due).toHaveLength(1)
    expect(due[0]!.subject).toBe('Offerte Website')
    expect(due[0]!.recipients).toContain('s.keller@keller-farben.ch')

    // A reminder that repeated every cycle would get notifications switched off.
    expect(harness.followUps.takeDue()).toHaveLength(0)
  })

  it('speaks up again once the wait was moved and ran out anew', () => {
    const harness = setup()
    const messageId = seedSent(harness, 'm1')
    harness.followUps.track(sentItem(harness.account), messageId)

    harness.setNow(MONDAY + 3 * DAY)
    expect(harness.followUps.takeDue()).toHaveLength(1)

    const threadId = threadKey(harness.account.id, 'm1')
    harness.followUps.postpone(threadId, MONDAY + 5 * DAY)
    harness.setNow(MONDAY + 6 * DAY)
    expect(harness.followUps.takeDue()).toHaveLength(1)
  })
})

describe('waiting on a conversation by hand', () => {
  it('hangs the wait off the last thing we wrote', () => {
    const harness = setup()
    seedMessage(harness.store, harness.account, { remoteId: 'in1', threadRemoteId: 't1' })
    const ours = seedSent(harness, 'out1', 't1')
    seedMessage(harness.store, harness.account, {
      remoteId: 'in2',
      threadRemoteId: 't1',
      date: harness.now() - 1
    })

    const followUp = harness.followUps.arm(threadKey(harness.account.id, 't1'), MONDAY + 5 * DAY)
    expect(followUp.messageId).toBe(ours)
  })

  it('moves an existing wait rather than adding one', () => {
    const harness = setup()
    seedSent(harness, 'm1')
    const threadId = threadKey(harness.account.id, 'm1')
    harness.followUps.arm(threadId, MONDAY + 2 * DAY)
    harness.followUps.arm(threadId, MONDAY + 5 * DAY)

    expect(harness.store.followUps.listOpen()).toHaveLength(1)
    expect(harness.store.followUps.openForThread(threadId)?.dueAt).toBe(MONDAY + 5 * DAY)
  })

  it('ends a wait when the user says the matter is settled', () => {
    const harness = setup()
    seedSent(harness, 'm1')
    const threadId = threadKey(harness.account.id, 'm1')
    harness.followUps.arm(threadId, MONDAY + 2 * DAY)
    harness.followUps.clear(threadId)

    expect(harness.store.followUps.openForThread(threadId)).toBeNull()
    expect(harness.store.followUps.countOpen()).toBe(0)
  })

  it('refuses a conversation that does not exist', () => {
    const harness = setup()
    expect(() => harness.followUps.arm('nope', MONDAY + DAY)).toThrow()
  })
})

describe('what the mailbox and the sidebar read', () => {
  it('lists the most urgent first and counts what is late', () => {
    const harness = setup()
    seedSent(harness, 'm1', 't1')
    seedSent(harness, 'm2', 't2')
    harness.followUps.arm(threadKey(harness.account.id, 't2'), MONDAY + 5 * DAY)
    harness.followUps.arm(threadKey(harness.account.id, 't1'), MONDAY - DAY)

    expect(harness.store.followUps.openThreadIds(null, 10, 0)).toEqual([
      threadKey(harness.account.id, 't1'),
      threadKey(harness.account.id, 't2')
    ])
    expect(harness.store.followUps.countOpen()).toBe(2)
    expect(harness.store.followUps.countOverdue(harness.now())).toBe(1)
  })

  it('puts the countdown on the row of the conversation itself', () => {
    const harness = setup()
    seedSent(harness, 'm1')
    const threadId = threadKey(harness.account.id, 'm1')
    harness.followUps.arm(threadId, MONDAY + 2 * DAY)

    const summary = harness.store.messages.threadSummary(threadId)!
    expect(summary.followUp?.dueAt).toBe(MONDAY + 2 * DAY)

    harness.followUps.clear(threadId)
    expect(harness.store.messages.threadSummary(threadId)?.followUp).toBeNull()
  })
})
