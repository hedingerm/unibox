import { describe, expect, it } from 'vitest'
import { SYSTEM_LABELS } from '@shared/types'
import { createTestApp } from '../helpers/app'

async function connectResend(harness: ReturnType<typeof createTestApp>): Promise<string> {
  harness.resend.addDomain('beispielweb.ch', true)
  harness.resend.mx.set('beispielweb.ch', [
    { exchange: 'inbound-smtp.eu-west-1.amazonaws.com', priority: 10 }
  ])
  await harness.app.api['resend:setKey']('re_test')
  await harness.app.api['resend:enableReceiving']('dom_beispielweb_ch')
  const account = harness.app.store.accounts.findByEmail('resend', 'beispielweb.ch')!
  harness.app.store.messages.upsert({
    id: `${account.id}:r1`,
    accountId: account.id,
    threadId: `${account.id}:t:r1`,
    remoteId: 'r1',
    subject: 'Anfrage Relaunch',
    from: { name: 'Sandra Keller', email: 's.keller@keller-farben.ch' },
    to: [{ name: null, email: 'kontakt@beispielweb.ch' }],
    date: Date.now(),
    labelRemoteIds: [SYSTEM_LABELS.inbox],
    body: { html: null, text: 'Hallo' }
  })
  return account.id
}

function labelIdsOf(harness: ReturnType<typeof createTestApp>, messageId: string): string[] {
  return harness.app.store.messages.get(messageId)!.labelIds
}

describe('restoring from trash', () => {
  it('syncs an untrash back to Gmail', async () => {
    const harness = createTestApp({ googleOAuth: true, autoCompleteOAuth: true })
    try {
      harness.gmail.addMessage({ id: 'm1', subject: 'Offerte' })
      const account = await harness.app.api['google:connect']()
      await harness.app.syncAll()
      const messageId = harness.app.store.messages.getByRemoteId(account.id, 'm1')!.id
      const trash = harness.app.store.labels.get(account.id, SYSTEM_LABELS.trash)!
      const inbox = harness.app.store.labels.get(account.id, SYSTEM_LABELS.inbox)!

      await harness.app.api['messages:trash']([messageId])
      expect(labelIdsOf(harness, messageId)).toContain(trash.id)

      await harness.app.api['messages:untrash']([messageId])
      expect(labelIdsOf(harness, messageId)).not.toContain(trash.id)
      expect(labelIdsOf(harness, messageId)).toContain(inbox.id)

      await harness.app.mutations.flush()
      expect(harness.gmail.untrashed).toContain('m1')
    } finally {
      harness.dispose()
    }
  })

  it('takes a Gmail message back out of spam', async () => {
    const harness = createTestApp({ googleOAuth: true, autoCompleteOAuth: true })
    try {
      harness.gmail.addMessage({ id: 'm1', subject: 'Newsletter' })
      const account = await harness.app.api['google:connect']()
      await harness.app.syncAll()
      const messageId = harness.app.store.messages.getByRemoteId(account.id, 'm1')!.id
      const spam = harness.app.store.labels.get(account.id, SYSTEM_LABELS.spam)!

      await harness.app.api['messages:spam']([messageId])
      expect(labelIdsOf(harness, messageId)).toContain(spam.id)

      await harness.app.api['messages:unspam']([messageId])
      expect(labelIdsOf(harness, messageId)).not.toContain(spam.id)

      await harness.app.mutations.flush()
      const modification = harness.gmail.modifications.at(-1)!
      expect(modification.removeLabelIds).toContain(SYSTEM_LABELS.spam)
      expect(modification.addLabelIds).toContain(SYSTEM_LABELS.inbox)
    } finally {
      harness.dispose()
    }
  })

  it('keeps a Resend restore purely local', async () => {
    const harness = createTestApp()
    try {
      const accountId = await connectResend(harness)
      const messageId = `${accountId}:r1`
      const trash = harness.app.store.labels.get(accountId, SYSTEM_LABELS.trash)!
      const inbox = harness.app.store.labels.get(accountId, SYSTEM_LABELS.inbox)!

      await harness.app.api['messages:trash']([messageId])
      expect(labelIdsOf(harness, messageId)).toContain(trash.id)
      await harness.app.api['messages:untrash']([messageId])

      expect(labelIdsOf(harness, messageId)).toContain(inbox.id)
      expect(labelIdsOf(harness, messageId)).not.toContain(trash.id)
      // Resend has no write-back API for this, so nothing is owed to a server.
      expect(harness.app.store.queue.list()).toHaveLength(0)
    } finally {
      harness.dispose()
    }
  })

  it('shows a restored message in the inbox listing again', async () => {
    const harness = createTestApp()
    try {
      const accountId = await connectResend(harness)
      const messageId = `${accountId}:r1`

      await harness.app.api['messages:trash']([messageId])
      expect(await harness.app.api['threads:list']({ accountId, labelId: null })).toHaveLength(0)

      await harness.app.api['messages:untrash']([messageId])
      const threads = await harness.app.api['threads:list']({ accountId, labelId: null })
      expect(threads.map((thread) => thread.subject)).toEqual(['Anfrage Relaunch'])
    } finally {
      harness.dispose()
    }
  })
})

describe('deleting for good', () => {
  it('removes a Gmail message locally and upstream', async () => {
    const harness = createTestApp({ googleOAuth: true, autoCompleteOAuth: true })
    try {
      harness.gmail.addMessage({ id: 'm1', subject: 'Offerte' })
      const account = await harness.app.api['google:connect']()
      await harness.app.syncAll()
      const messageId = harness.app.store.messages.getByRemoteId(account.id, 'm1')!.id

      await harness.app.api['messages:trash']([messageId])
      await harness.app.api['messages:delete']([messageId])

      expect(harness.app.store.messages.get(messageId)).toBeNull()
      await harness.app.mutations.flush()
      expect(harness.gmail.deleted).toContain('m1')
    } finally {
      harness.dispose()
    }
  })

  it('removes a Resend message locally without calling any API', async () => {
    const harness = createTestApp()
    try {
      const accountId = await connectResend(harness)
      const messageId = `${accountId}:r1`

      await harness.app.api['messages:delete']([messageId])
      expect(harness.app.store.messages.get(messageId)).toBeNull()
      expect(harness.app.store.queue.list()).toHaveLength(0)
      // The local store is the only copy Resend mail ever had.
      expect(await harness.app.api['search:query']({ text: 'Relaunch' })).toHaveLength(0)
    } finally {
      harness.dispose()
    }
  })
})
