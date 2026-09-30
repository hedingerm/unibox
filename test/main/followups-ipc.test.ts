import { describe, expect, it } from 'vitest'
import { SYSTEM_LABELS } from '@shared/types'
import { createTestApp } from '../helpers/app'

async function connectResend(harness: ReturnType<typeof createTestApp>): Promise<void> {
  harness.resend.addDomain('beispielweb.ch', true)
  harness.resend.mx.set('beispielweb.ch', [
    { exchange: 'inbound-smtp.eu-west-1.amazonaws.com', priority: 10 }
  ])
  await harness.app.api['resend:setKey']('re_test')
  await harness.app.api['resend:enableReceiving']('dom_beispielweb_ch')
}

/** Sends one mail for real and returns the id Resend gave it. */
async function sendOffer(
  harness: ReturnType<typeof createTestApp>,
  followUpDays: number | null
): Promise<string> {
  // No undo window, so the mail leaves on the first tick instead of in ten
  // seconds — these tests are about what happens after it is gone.
  await harness.app.api['settings:set']({ undoSendSeconds: 0 })
  const account = harness.app.store.accounts.findByEmail('resend', 'beispielweb.ch')!
  await harness.app.api['compose:send']({
    accountId: account.id,
    identityName: 'Max Muster',
    identityEmail: 'kontakt@beispielweb.ch',
    to: [{ name: 'Sandra Keller', email: 's.keller@keller-farben.ch' }],
    cc: [],
    bcc: [],
    subject: 'Offerte Website',
    html: '<p>Guten Tag</p>',
    text: 'Guten Tag',
    attachments: [],
    replyToMessageId: null,
    followUpDays
  })
  await harness.app.send.tick()
  return `email_${harness.resend.sends.length}`
}

describe('waiting for an answer, end to end', () => {
  it('arms a reminder on a real send and lists it as its own mailbox', async () => {
    const harness = createTestApp()
    try {
      await connectResend(harness)
      await sendOffer(harness, 3)

      const waiting = await harness.app.api['followups:list']()
      expect(waiting).toHaveLength(1)
      expect(waiting[0]!.subject).toBe('Offerte Website')
      expect(waiting[0]!.followUp).not.toBeNull()

      // The same rows the sidebar counts and the mailbox draws.
      const counts = await harness.app.api['mailbox:counts']()
      expect(counts.followups).toBe(1)
      const mailbox = await harness.app.api['threads:list']({
        accountId: null,
        labelId: null,
        view: 'followups'
      })
      expect(mailbox.map((row) => row.threadId)).toEqual([waiting[0]!.threadId])
    } finally {
      harness.dispose()
    }
  })

  it('arms nothing when the composer said no answer is expected', async () => {
    const harness = createTestApp()
    try {
      await connectResend(harness)
      await sendOffer(harness, null)
      expect(await harness.app.api['followups:list']()).toHaveLength(0)
    } finally {
      harness.dispose()
    }
  })

  it('clears itself when the answer arrives', async () => {
    const harness = createTestApp()
    try {
      await connectResend(harness)
      const sentId = await sendOffer(harness, 3)
      expect(await harness.app.api['followups:list']()).toHaveLength(1)

      // Threaded onto the sent mail through the headers, the way a real reply is.
      harness.resend.addReceived({
        id: 'reply_1',
        subject: 'AW: Offerte Website',
        // Deliberately dated *before* the mail it answers: a sender with a
        // wrong clock must not be able to keep a reminder alive for ever.
        created_at: '2026-08-19T08:00:00.000Z',
        headers: {
          'Message-ID': '<reply-1@keller-farben.ch>',
          'In-Reply-To': `<${sentId}@resend.local>`
        }
      })
      await harness.app.syncResendAccounts()

      expect(await harness.app.api['followups:list']()).toHaveLength(0)
      const counts = await harness.app.api['mailbox:counts']()
      expect(counts.followups).toBe(0)
    } finally {
      harness.dispose()
    }
  })

  it('keeps waiting when the only thing back is an absence notice', async () => {
    const harness = createTestApp()
    try {
      await connectResend(harness)
      const sentId = await sendOffer(harness, 3)

      harness.resend.addReceived({
        id: 'ooo_1',
        subject: 'Offerte Website',
        created_at: '2026-08-19T08:00:00.000Z',
        headers: {
          'Message-ID': '<ooo-1@keller-farben.ch>',
          'In-Reply-To': `<${sentId}@resend.local>`,
          'Auto-Submitted': 'auto-replied'
        }
      })
      await harness.app.syncResendAccounts()

      expect(await harness.app.api['followups:list']()).toHaveLength(1)
    } finally {
      harness.dispose()
    }
  })

  it('ends the wait when the user says the matter is settled', async () => {
    const harness = createTestApp()
    try {
      await connectResend(harness)
      await sendOffer(harness, 3)
      const [waiting] = await harness.app.api['followups:list']()

      await harness.app.api['followups:clear'](waiting!.threadId)
      expect(await harness.app.api['followups:list']()).toHaveLength(0)
    } finally {
      harness.dispose()
    }
  })

  it('stops waiting on a conversation that was thrown away', async () => {
    const harness = createTestApp()
    try {
      await connectResend(harness)
      await sendOffer(harness, 3)
      const [waiting] = await harness.app.api['followups:list']()
      const messageIds = await harness.app.api['threads:messageIds']([waiting!.threadId])

      await harness.app.api['messages:trash'](messageIds)
      expect(await harness.app.api['followups:list']()).toHaveLength(0)
    } finally {
      harness.dispose()
    }
  })

  it('lets the user start a wait on a conversation by hand', async () => {
    const harness = createTestApp()
    try {
      await connectResend(harness)
      await sendOffer(harness, null)
      const account = harness.app.store.accounts.findByEmail('resend', 'beispielweb.ch')!
      const sentLabel = harness.app.store.labels
        .list(account.id)
        .find((label) => label.remoteId === SYSTEM_LABELS.sent)!
      const [thread] = await harness.app.api['threads:list']({
        accountId: account.id,
        labelId: sentLabel.id
      })
      expect(thread).toBeDefined()

      const dueAt = await harness.app.api['followups:defaultDueAt']()
      expect(dueAt).toBeGreaterThan(Date.now())

      await harness.app.api['followups:set'](thread!.threadId, dueAt)
      const waiting = await harness.app.api['followups:list']()
      expect(waiting).toHaveLength(1)
      expect(waiting[0]!.followUp?.dueAt).toBe(dueAt)
    } finally {
      harness.dispose()
    }
  })
})
