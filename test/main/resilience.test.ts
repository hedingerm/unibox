import { describe, expect, it } from 'vitest'
import { createTestApp } from '../helpers/app'

async function connectResend(harness: ReturnType<typeof createTestApp>): Promise<void> {
  harness.resend.addDomain('beispielweb.ch', true)
  harness.resend.mx.set('beispielweb.ch', [
    { exchange: 'inbound-smtp.eu-west-1.amazonaws.com', priority: 10 }
  ])
  await harness.app.api['resend:setKey']('re_test')
  await harness.app.api['resend:enableReceiving']('dom_beispielweb_ch')
}

describe('a failing sync says why', () => {
  it('records the cause on the Google account and clears it on the next success', async () => {
    const harness = createTestApp({ googleOAuth: true, autoCompleteOAuth: true })
    try {
      harness.gmail.addMessage({ id: 'm1', subject: 'Offerte' })
      const account = await harness.app.api['google:connect']()
      await harness.app.syncAll()

      harness.gmail.offline = true
      await harness.app.syncAll()

      const failed = harness.app.store.accounts.get(account.id)!
      expect(failed.status).toBe('error')
      expect(failed.lastError).toBeTruthy()
      expect(failed.lastError).toContain('fetch failed')

      const event = harness.events
        .filter((entry) => entry.name === 'account:status')
        .at(-1)?.payload as { status: string; lastError: string | null }
      expect(event.status).toBe('error')
      expect(event.lastError).toContain('fetch failed')

      // The error must never be terminal: the next cycle simply retries.
      harness.gmail.offline = false
      await harness.app.syncAll()
      const recovered = harness.app.store.accounts.get(account.id)!
      expect(recovered.status).toBe('ok')
      expect(recovered.lastError).toBeNull()
    } finally {
      harness.dispose()
    }
  })

  it('records the cause on a Resend domain instead of swallowing it', async () => {
    const harness = createTestApp()
    try {
      await connectResend(harness)
      await harness.app.syncAll()
      const account = harness.app.store.accounts.findByEmail('resend', 'beispielweb.ch')!

      harness.resend.offline = true
      await harness.app.syncAll()
      const failed = harness.app.store.accounts.get(account.id)!
      expect(failed.status).toBe('error')
      expect(failed.lastError).toContain('fetch failed')

      harness.resend.offline = false
      await harness.app.syncAll()
      const recovered = harness.app.store.accounts.get(account.id)!
      expect(recovered.status).toBe('ok')
      expect(recovered.lastError).toBeNull()
    } finally {
      harness.dispose()
    }
  })

  it('keeps importing mail that arrived while the account was failing', async () => {
    const harness = createTestApp({ googleOAuth: true, autoCompleteOAuth: true })
    try {
      harness.gmail.addMessage({ id: 'm1', subject: 'Vorher' })
      const account = await harness.app.api['google:connect']()
      await harness.app.syncAll()

      harness.gmail.offline = true
      await harness.app.syncAll()
      expect(harness.app.store.accounts.get(account.id)?.status).toBe('error')

      const added = harness.gmail.addMessage({ id: 'm2', subject: 'Waehrend der Stoerung' })
      harness.gmail.pushHistory({
        messagesAdded: [{ message: { id: added.id, threadId: added.threadId } }]
      })
      harness.gmail.offline = false
      await harness.app.syncAll()

      expect(harness.app.store.messages.getByRemoteId(account.id, 'm2')?.subject).toBe(
        'Waehrend der Stoerung'
      )
      expect(harness.app.store.accounts.get(account.id)?.lastError).toBeNull()
    } finally {
      harness.dispose()
    }
  })
})
