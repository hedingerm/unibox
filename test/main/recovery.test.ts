import { describe, expect, it } from 'vitest'
import type { OutboxDraft } from '@shared/types'
import { SYSTEM_LABELS } from '@shared/types'
import { createTestApp } from '../helpers/app'

async function connectResend(harness: ReturnType<typeof createTestApp>): Promise<string> {
  harness.resend.addDomain('beispielweb.ch', true)
  harness.resend.mx.set('beispielweb.ch', [
    { exchange: 'inbound-smtp.eu-west-1.amazonaws.com', priority: 10 }
  ])
  await harness.app.api['resend:setKey']('re_test')
  await harness.app.api['resend:enableReceiving']('dom_beispielweb_ch')
  return harness.app.store.accounts.findByEmail('resend', 'beispielweb.ch')!.id
}

function draft(accountId: string): OutboxDraft {
  return {
    accountId,
    identityName: 'Max Muster',
    identityEmail: 'kontakt@beispielweb.ch',
    to: [{ name: null, email: 's.keller@keller-farben.ch' }],
    cc: [],
    bcc: [],
    subject: 'Offerte Relaunch',
    html: '<p>Anbei die Offerte</p>',
    text: 'Anbei die Offerte',
    attachments: [],
    replyToMessageId: null
  }
}

describe('failed outgoing mail can be recovered', () => {
  it('stays listed, is sent on retry and disappears when discarded', async () => {
    const harness = createTestApp()
    try {
      const accountId = await connectResend(harness)
      const item = await harness.app.api['compose:send'](draft(accountId))
      // What a run of failed attempts leaves behind.
      harness.app.store.outbox.setState(item.id, 'failed', { lastError: 'Resend 422: invalid from' })

      const listed = await harness.app.api['outbox:list']()
      const failed = listed.find((entry) => entry.id === item.id)
      expect(failed?.state).toBe('failed')
      expect(failed?.lastError).toBe('Resend 422: invalid from')

      await harness.app.api['outbox:retry'](item.id)
      expect(harness.resend.sends).toHaveLength(1)
      expect(harness.app.store.outbox.get(item.id)?.state).toBe('sent')
      expect(await harness.app.api['outbox:list']()).toHaveLength(0)

      const second = await harness.app.api['compose:send'](draft(accountId))
      harness.app.store.outbox.setState(second.id, 'failed', { lastError: 'Netzwerkfehler' })
      await harness.app.api['outbox:discard'](second.id)
      expect(await harness.app.api['outbox:list']()).toHaveLength(0)
      expect(harness.app.store.outbox.get(second.id)?.state).toBe('cancelled')
      // Discarding must not send it after all.
      expect(harness.resend.sends).toHaveLength(1)
    } finally {
      harness.dispose()
    }
  })
})

describe('failed sync actions can be recovered', () => {
  it('lists them with their cause, replays them on retry and drops them on discard', async () => {
    const harness = createTestApp({ googleOAuth: true, autoCompleteOAuth: true })
    try {
      harness.gmail.addMessage({ id: 'm1', subject: 'Offerte Onlineshop' })
      const account = await harness.app.api['google:connect']()
      await harness.app.syncAll()
      const message = harness.app.store.messages.getByRemoteId(account.id, 'm1')!

      // Enqueued directly so the background flush cannot race the assertions.
      const queued = harness.app.store.queue.enqueue({
        accountId: account.id,
        messageId: message.id,
        op: 'remove_labels',
        payload: { addLabelIds: [], removeLabelIds: [SYSTEM_LABELS.inbox] }
      })
      // Gmail refused it for good.
      harness.app.store.queue.markFailed(queued.id, 'Gmail API 403: insufficientPermissions', 0, true)

      const listed = await harness.app.api['queue:list']()
      expect(listed).toHaveLength(1)
      expect(listed[0]!.state).toBe('failed')
      expect(listed[0]!.lastError).toContain('insufficientPermissions')
      expect(listed[0]!.subject).toBe('Offerte Onlineshop')
      expect(listed[0]!.accountEmail).toBe('max@muster-it.ch')

      const modificationsBefore = harness.gmail.modifications.length
      await harness.app.api['queue:retry'](listed[0]!.id)
      expect(harness.gmail.modifications.length).toBe(modificationsBefore + 1)
      expect(await harness.app.api['queue:list']()).toHaveLength(0)

      const second = harness.app.store.queue.enqueue({
        accountId: account.id,
        messageId: message.id,
        op: 'trash',
        payload: {}
      })
      harness.app.store.queue.markFailed(second.id, 'Gmail API 404', 0, true)
      await harness.app.api['queue:discard'](second.id)
      expect(harness.app.store.queue.get(second.id)).toBeNull()
      expect(await harness.app.api['queue:list']()).toHaveLength(0)
    } finally {
      harness.dispose()
    }
  })

  it('counts what is still owed to the servers', async () => {
    const harness = createTestApp()
    try {
      const accountId = await connectResend(harness)
      const account = harness.app.store.accounts.get(accountId)!
      harness.app.store.messages.upsert({
        id: `${account.id}:r1`,
        accountId: account.id,
        threadId: `${account.id}:t:r1`,
        remoteId: 'r1',
        subject: 'Anfrage',
        from: { name: null, email: 's.keller@keller-farben.ch' },
        date: Date.now(),
        labelRemoteIds: [SYSTEM_LABELS.inbox]
      })

      expect(await harness.app.api['queue:pending']()).toEqual({ mutations: 0, outbox: 0 })
      await harness.app.api['compose:send'](draft(accountId))
      const pending = await harness.app.api['queue:pending']()
      expect(pending.outbox).toBe(1)
      // Resend keeps archive/read state local, so nothing is owed to a server.
      expect(pending.mutations).toBe(0)
    } finally {
      harness.dispose()
    }
  })
})
