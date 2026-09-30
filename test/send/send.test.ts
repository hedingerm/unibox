import { describe, expect, it } from 'vitest'
import type { OutboxDraft } from '@shared/types'
import { SYSTEM_LABELS } from '@shared/types'
import { GmailClient } from '@main/google/client'
import { GmailSync } from '@main/google/sync'
import { ResendClient } from '@main/resend/client'
import { SendService } from '@main/send'
import { FakeGmail } from '../helpers/fake-gmail'
import { FakeResend } from '../helpers/fake-resend'
import { addGoogleAccount, addResendAccount, makeStore, seedMessage } from '../helpers/store'
import type { Store } from '@main/db/store'

interface Harness {
  store: Store
  gmail: FakeGmail
  resend: FakeResend
  send: SendService
  googleId: string
  resendId: string
  gmailSync: GmailSync
  clock: { value: number }
}

function setup(): Harness {
  const store = makeStore()
  const google = addGoogleAccount(store, 'max@muster-it.ch')
  const resendAccount = addResendAccount(store, 'beispielweb.ch')
  const gmail = new FakeGmail()
  const resend = new FakeResend()
  const clock = { value: 1_000_000 }

  const gmailClient = new GmailClient({
    fetch: gmail.fetch,
    baseUrl: 'https://gmail.test/gmail/v1',
    accessToken: async () => 'token',
    sleep: async () => undefined
  })
  const resendClient = new ResendClient({
    apiKey: () => 're_test',
    fetch: resend.fetch,
    baseUrl: 'https://api.resend.test',
    sleep: async () => undefined
  })
  const gmailSync = new GmailSync(store, google.id, gmailClient)
  const send = new SendService(store, {
    gmailClientFor: (id) => (id === google.id ? gmailClient : null),
    resendClient: () => resendClient,
    now: () => clock.value,
    maxAttempts: 2
  })
  return { store, gmail, resend, send, googleId: google.id, resendId: resendAccount.id, gmailSync, clock }
}

function draft(overrides: Partial<OutboxDraft> & { accountId: string }): OutboxDraft {
  return {
    identityName: 'Max Muster',
    identityEmail: 'max@muster-it.ch',
    to: [{ name: null, email: 's.keller@keller-farben.ch' }],
    cc: [],
    bcc: [],
    subject: 'Offerte',
    html: '<p>Guten Tag</p>',
    text: 'Guten Tag',
    attachments: [],
    replyToMessageId: null,
    ...overrides
  }
}

function decodeRaw(raw: string): string {
  return Buffer.from(raw, 'base64url').toString('utf8')
}

describe('undo send', () => {
  it('holds the mail during the undo window and sends afterwards', async () => {
    const { send, gmail, googleId, clock, store } = setup()
    store.settings.set({ undoSendSeconds: 10 })

    const item = send.enqueue(draft({ accountId: googleId }))
    expect(item.state).toBe('undoable')
    expect(item.sendAt).toBe(clock.value + 10_000)

    await send.tick()
    expect(gmail.sent).toHaveLength(0)

    clock.value += 10_000
    await send.tick()
    expect(gmail.sent).toHaveLength(1)
    expect(store.outbox.get(item.id)?.state).toBe('sent')
  })

  it('cancels within the window and never touches the network', async () => {
    const { send, gmail, googleId, clock, store } = setup()
    const item = send.enqueue(draft({ accountId: googleId }), 30)
    expect(send.cancel(item.id)).toBe(true)

    clock.value += 60_000
    await send.tick()
    expect(gmail.sent).toHaveLength(0)
    expect(store.outbox.get(item.id)?.state).toBe('cancelled')
  })

  it('refuses to cancel once the mail is out', async () => {
    const { send, googleId, clock } = setup()
    const item = send.enqueue(draft({ accountId: googleId }), 0)
    clock.value += 1
    await send.tick()
    expect(send.cancel(item.id)).toBe(false)
  })

  it('honours the configured window length', () => {
    const { send, store, googleId, clock } = setup()
    store.settings.set({ undoSendSeconds: 45 })
    expect(send.enqueue(draft({ accountId: googleId })).sendAt).toBe(clock.value + 45_000)
  })
})

describe('schedule send', () => {
  it('waits for the scheduled moment', async () => {
    const { send, gmail, googleId, clock } = setup()
    const sendAt = clock.value + 3 * 3600_000
    const item = send.schedule(draft({ accountId: googleId }), sendAt)
    expect(item.state).toBe('scheduled')

    await send.tick()
    expect(gmail.sent).toHaveLength(0)

    clock.value = sendAt
    await send.tick()
    expect(gmail.sent).toHaveLength(1)
  })

  it('catches up on a moment that passed while the app was closed', async () => {
    const { send, gmail, googleId, clock } = setup()
    send.schedule(draft({ accountId: googleId }), clock.value - 3600_000)
    await send.tick()
    expect(gmail.sent).toHaveLength(1)
  })

  it('lists pending outbox items and drops them once sent', async () => {
    const { send, googleId, clock } = setup()
    send.schedule(draft({ accountId: googleId }), clock.value + 1000)
    expect(send.list()).toHaveLength(1)
    clock.value += 1000
    await send.tick()
    expect(send.list()).toHaveLength(0)
  })
})

describe('Gmail sending', () => {
  it('sends through the receiving account, in-thread, from the right alias', async () => {
    const { store, gmail, send, gmailSync, googleId, clock } = setup()
    gmail.sendAs = [
      { sendAsEmail: 'max@muster-it.ch', displayName: 'Max Muster', isDefault: true },
      { sendAsEmail: 'kontakt@muster-it.ch', displayName: 'Muster IT' }
    ]
    gmail.addMessage({
      id: 'm1',
      threadId: 'thread-9',
      to: 'kontakt@muster-it.ch',
      messageIdHeader: '<original@keller-farben.ch>'
    })
    await gmailSync.initialSync()
    const original = store.messages.getByRemoteId(googleId, 'm1')!

    send.enqueue(
      draft({
        accountId: googleId,
        identityEmail: 'kontakt@muster-it.ch',
        identityName: 'Muster IT',
        subject: 'Re: Betreff',
        replyToMessageId: original.id
      }),
      0
    )
    clock.value += 1
    await send.tick()

    expect(gmail.sent).toHaveLength(1)
    const raw = decodeRaw(gmail.sent[0]!.raw)
    expect(gmail.sent[0]!.threadId).toBe('thread-9')
    expect(raw).toContain('From: Muster IT <kontakt@muster-it.ch>')
    expect(raw).toContain('In-Reply-To: <original@keller-farben.ch>')
    expect(raw).toContain('References: <original@keller-farben.ch>')
  })

  it('sends attachments', async () => {
    const { gmail, send, googleId, clock } = setup()
    send.enqueue(
      draft({
        accountId: googleId,
        attachments: [
          {
            filename: 'offerte.pdf',
            mimeType: 'application/pdf',
            content: Buffer.from('PDF').toString('base64')
          }
        ]
      }),
      0
    )
    clock.value += 1
    await send.tick()
    const raw = decodeRaw(gmail.sent[0]!.raw)
    expect(raw).toContain('Content-Disposition: attachment; filename="offerte.pdf"')
    expect(raw).toContain(Buffer.from('PDF').toString('base64'))
  })
})

describe('Resend sending', () => {
  it('replies from the address the original mail was sent to', async () => {
    const { store, resend, send, resendId, clock } = setup()
    const original = seedMessage(store, store.accounts.get(resendId)!, {
      remoteId: 'r1',
      to: [{ name: null, email: 'offerte@beispielweb.ch' }],
      messageIdHeader: '<kunde@keller-farben.ch>'
    })

    send.enqueue(
      draft({
        accountId: resendId,
        identityEmail: 'offerte@beispielweb.ch',
        identityName: 'Max Muster',
        replyToMessageId: original
      }),
      0
    )
    clock.value += 1
    await send.tick()

    expect(resend.sends).toHaveLength(1)
    const payload = resend.sends[0]!.payload
    expect(payload.from).toBe('Max Muster <offerte@beispielweb.ch>')
    expect((payload.headers as Record<string, string>)['In-Reply-To']).toBe('<kunde@keller-farben.ch>')
    expect(resend.sends[0]!.idempotencyKey).toMatch(/^outbox\//)
  })

  it('stores the sent mail locally in the original thread', async () => {
    const { store, send, resendId, clock } = setup()
    const original = seedMessage(store, store.accounts.get(resendId)!, {
      remoteId: 'r1',
      date: clock.value - 60_000,
      to: [{ name: null, email: 'offerte@beispielweb.ch' }]
    })
    send.enqueue(draft({ accountId: resendId, identityEmail: 'offerte@beispielweb.ch', replyToMessageId: original }), 0)
    clock.value += 1
    await send.tick()

    const parent = store.messages.get(original)!
    const thread = store.messages.threadDetail(parent.threadId)!
    expect(thread.messages).toHaveLength(2)
    const reply = thread.messages[1]!
    expect(reply.direction).toBe('outgoing')
    expect(reply.labelIds.some((id) => id.endsWith(SYSTEM_LABELS.sent))).toBe(true)
  })

  it('sends attachments through Resend identities', async () => {
    const { resend, send, resendId, clock } = setup()
    send.enqueue(
      draft({
        accountId: resendId,
        identityEmail: 'kontakt@beispielweb.ch',
        attachments: [
          {
            filename: 'plan.pdf',
            mimeType: 'application/pdf',
            content: Buffer.from('PLAN').toString('base64')
          }
        ]
      }),
      0
    )
    clock.value += 1
    await send.tick()
    const attachments = resend.sends[0]!.payload.attachments as Array<Record<string, string>>
    expect(attachments[0]).toMatchObject({
      filename: 'plan.pdf',
      content: Buffer.from('PLAN').toString('base64'),
      content_type: 'application/pdf'
    })
  })
})

describe('failures', () => {
  it('retries a failed send and gives up after the attempt limit', async () => {
    const { store, resend, send, resendId, clock } = setup()
    resend.offline = true
    const item = send.enqueue(draft({ accountId: resendId, identityEmail: 'kontakt@beispielweb.ch' }), 0)

    clock.value += 1
    await send.tick()
    expect(store.outbox.get(item.id)?.state).toBe('scheduled')
    expect(store.outbox.get(item.id)?.attempts).toBe(1)

    clock.value += 10 * 60_000
    await send.tick()
    expect(store.outbox.get(item.id)?.state).toBe('failed')
    expect(store.outbox.get(item.id)?.lastError).toBeTruthy()
  })
})
