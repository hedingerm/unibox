import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Account } from '@shared/types'
import { SYSTEM_LABELS } from '@shared/types'
import { messageKey } from '@main/db/ids'
import type { TestApp } from '../helpers/app'
import { createTestApp } from '../helpers/app'
import { seedMessage } from '../helpers/store'

let harness: TestApp
let account: Account

beforeEach(() => {
  harness = createTestApp()
  account = harness.app.store.accounts.upsert({
    kind: 'resend',
    email: 'beispielweb.ch',
    displayName: 'beispielweb.ch',
    resendDomainId: 'dom_beispielweb_ch',
    resendRegion: 'eu-west-1',
    receivingEnabled: true
  })
  harness.app.store.labels.ensureSystemLabels(account.id)
  const store = harness.app.store
  seedMessage(store, account, { remoteId: 'm1', subject: 'An Info', to: [{ name: null, email: 'info@beispielweb.ch' }] })
  seedMessage(store, account, {
    remoteId: 'm2',
    subject: 'An Hallo (Alias)',
    to: [{ name: null, email: 'someone@else.ch' }],
    cc: [{ name: null, email: 'Hallo@beispielweb.ch' }]
  })
  seedMessage(store, account, { remoteId: 'm3', subject: 'An Offerten', to: [{ name: null, email: 'offerten@beispielweb.ch' }] })
  seedMessage(store, account, { remoteId: 'm4', subject: 'Irgendwas', to: [{ name: null, email: 'random@beispielweb.ch' }] })
  seedMessage(store, account, {
    remoteId: 'm5',
    subject: 'Gelesen an Info',
    to: [{ name: null, email: 'info@beispielweb.ch' }],
    labels: [SYSTEM_LABELS.inbox]
  })
})

afterEach(() => {
  harness.dispose()
})

describe('mailboxes', () => {
  it('lists the conversations addressed to a mailbox or its aliases', async () => {
    const info = await harness.app.api['mailboxes:create']({
      accountId: account.id,
      address: 'Info@Beispielweb.ch',
      displayName: 'Info',
      aliases: ['hallo@beispielweb.ch']
    })
    expect(info.address).toBe('info@beispielweb.ch')
    expect(info.aliases).toEqual(['hallo@beispielweb.ch'])
    expect(info.unread).toBe(2)

    const threads = await harness.app.api['threads:list']({
      accountId: null,
      labelId: null,
      view: 'mailbox',
      mailboxId: info.id
    })
    expect(threads.map((t) => t.subject).sort()).toEqual(['An Hallo (Alias)', 'An Info', 'Gelesen an Info'])
  })

  it('lists the catch-all mail no mailbox claims as unassigned', async () => {
    await harness.app.api['mailboxes:create']({ accountId: account.id, address: 'info@beispielweb.ch' })
    await harness.app.api['mailboxes:create']({ accountId: account.id, address: 'offerten@beispielweb.ch' })
    const threads = await harness.app.api['threads:list']({
      accountId: account.id,
      labelId: null,
      view: 'unassigned'
    })
    expect(threads.map((t) => t.subject).sort()).toEqual(['An Hallo (Alias)', 'Irgendwas'])
    const counts = await harness.app.api['mailbox:counts']()
    expect(counts.unassigned).toBe(2)
    expect(counts[`unassigned:${account.id}`]).toBe(2)
  })

  it('counts and lists unassigned mail per Resend domain', async () => {
    const store = harness.app.store
    const other = store.accounts.upsert({
      kind: 'resend',
      email: 'andere.ch',
      displayName: 'andere.ch',
      resendDomainId: 'dom_andere_ch',
      resendRegion: 'eu-west-1',
      receivingEnabled: true
    })
    store.labels.ensureSystemLabels(other.id)
    seedMessage(store, other, { remoteId: 'o1', subject: 'Fremd', to: [{ name: null, email: 'x@andere.ch' }] })
    await harness.app.api['mailboxes:create']({ accountId: account.id, address: 'info@beispielweb.ch' })

    const counts = await harness.app.api['mailbox:counts']()
    // beispielweb.ch: m2, m3, m4 reach no mailbox; andere.ch has none, so all of it.
    expect(counts[`unassigned:${account.id}`]).toBe(3)
    expect(counts[`unassigned:${other.id}`]).toBe(1)
    expect(counts.unassigned).toBe(4)

    const threads = await harness.app.api['threads:list']({
      accountId: other.id,
      labelId: null,
      view: 'unassigned'
    })
    expect(threads.map((t) => t.subject)).toEqual(['Fremd'])
  })

  it('reports unread counts per mailbox in the mailbox counts', async () => {
    const offerten = await harness.app.api['mailboxes:create']({
      accountId: account.id,
      address: 'offerten@beispielweb.ch'
    })
    const counts = await harness.app.api['mailbox:counts']()
    expect(counts[`mailbox:${offerten.id}`]).toBe(1)
    await harness.app.api['messages:mark']({ messageIds: [messageKey(account.id, 'm3')], read: true })
    expect((await harness.app.api['mailbox:counts']())[`mailbox:${offerten.id}`]).toBe(0)
  })

  it('refuses addresses off the domain or already taken', async () => {
    await expect(
      harness.app.api['mailboxes:create']({ accountId: account.id, address: 'info@anders.ch' })
    ).rejects.toThrow(/Domain beispielweb.ch/)
    await harness.app.api['mailboxes:create']({
      accountId: account.id,
      address: 'info@beispielweb.ch',
      aliases: ['hallo@beispielweb.ch']
    })
    await expect(
      harness.app.api['mailboxes:create']({ accountId: account.id, address: 'hallo@beispielweb.ch' })
    ).rejects.toThrow(/bereits/)
  })

  it('updates, reorders and removes mailboxes without touching mail', async () => {
    const a = await harness.app.api['mailboxes:create']({ accountId: account.id, address: 'info@beispielweb.ch' })
    const b = await harness.app.api['mailboxes:create']({ accountId: account.id, address: 'offerten@beispielweb.ch' })
    expect(a.displayName).toBe('info')
    const updated = await harness.app.api['mailboxes:update'](a.id, {
      displayName: 'Allgemein',
      aliases: ['hallo@beispielweb.ch', 'HALLO@beispielweb.ch', 'info@beispielweb.ch']
    })
    expect(updated.displayName).toBe('Allgemein')
    expect(updated.aliases).toEqual(['hallo@beispielweb.ch'])
    await harness.app.api['mailboxes:reorder']([b.id, a.id])
    expect((await harness.app.api['mailboxes:list'](account.id)).map((m) => m.id)).toEqual([b.id, a.id])
    await harness.app.api['mailboxes:remove'](a.id)
    expect(await harness.app.api['mailboxes:list']()).toHaveLength(1)
    expect(harness.app.store.messages.get(messageKey(account.id, 'm1'))).not.toBeNull()
  })

  it('answers mail to a linked mailbox from its identity', async () => {
    const identity = await harness.app.api['identities:create']({
      accountId: account.id,
      name: 'Beispielweb Support',
      email: 'support@beispielweb.ch',
      signatureId: null,
      isDefault: false
    })
    await harness.app.api['mailboxes:create']({
      accountId: account.id,
      address: 'info@beispielweb.ch',
      aliases: ['hallo@beispielweb.ch'],
      identityId: identity.id
    })
    const reply = await harness.app.api['identities:forReply'](messageKey(account.id, 'm2'))
    expect(reply?.id).toBe(identity.id)
    // Unlinked mail keeps the usual pick: the address it came in on.
    const other = await harness.app.api['identities:forReply'](messageKey(account.id, 'm4'))
    expect(other?.email).toBe('random@beispielweb.ch')
  })
})
