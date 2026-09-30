import { describe, expect, it } from 'vitest'
import { SYSTEM_LABELS } from '@shared/types'
import { ResendClient } from '@main/resend/client'
import { ResendSync } from '@main/resend/sync'
import { messageKey } from '@main/db/ids'
import { FakeResend } from '../helpers/fake-resend'
import { addResendAccount, makeStore } from '../helpers/store'
import type { Store } from '@main/db/store'

interface Harness {
  store: Store
  resend: FakeResend
  sync: ResendSync
  accountId: string
  saved: Array<{ filename: string; content: string }>
}

function setup(domain = 'beispielweb.ch'): Harness {
  const store = makeStore()
  const account = addResendAccount(store, domain)
  const resend = new FakeResend()
  const client = new ResendClient({
    apiKey: () => 're_test',
    fetch: resend.fetch,
    baseUrl: 'https://api.resend.test',
    sleep: async () => undefined
  })
  const saved: Array<{ filename: string; content: string }> = []
  const sync = new ResendSync(store, client, {
    saveAttachment: async (data, filename) => {
      saved.push({ filename, content: data.toString('utf8') })
      return `/cache/${filename}`
    },
    pageSize: 2
  })
  return { store, resend, sync, accountId: account.id, saved }
}

describe('polling import', () => {
  it('imports received and sent mail into the local store', async () => {
    const { store, resend, sync, accountId } = setup()
    resend.addReceived({ id: 'r1', subject: 'Website-Relaunch' })
    resend.addSent({ id: 's1', subject: 'Re: Website-Relaunch' })

    const result = await sync.poll()
    expect(result.imported).toHaveLength(2)

    const received = store.messages.getByRemoteId(accountId, 'r1')!
    expect(received.subject).toBe('Website-Relaunch')
    expect(received.direction).toBe('incoming')
    expect(store.messages.body(received.id).html).toContain('Guten Tag')

    const sent = store.messages.getByRemoteId(accountId, 's1')!
    expect(sent.direction).toBe('outgoing')
    expect(sent.labelIds.some((id) => id.endsWith(SYSTEM_LABELS.sent))).toBe(true)
  })

  it('is idempotent across polls', async () => {
    const { store, resend, sync } = setup()
    resend.addReceived({ id: 'r1' })
    await sync.poll()
    const second = await sync.poll()
    expect(second.imported).toHaveLength(0)
    expect(store.messages.listThreadIds({ labelRemoteId: SYSTEM_LABELS.inbox })).toHaveLength(1)
  })

  it('pages through a backlog larger than one page', async () => {
    const { store, resend, sync } = setup()
    for (let i = 1; i <= 5; i += 1) resend.addReceived({ id: `r${i}`, subject: `Anfrage ${i}` })
    const result = await sync.poll()
    expect(result.imported).toHaveLength(5)
    expect(store.messages.listThreadIds({ labelRemoteId: SYSTEM_LABELS.inbox })).toHaveLength(5)
  })

  it('routes mail to the domain it was addressed to', async () => {
    const { store, resend, sync } = setup('beispielweb.ch')
    const nordwind = addResendAccount(store, 'nordwind.ch')
    resend.addReceived({ id: 'r1', to: ['kontakt@beispielweb.ch'] })
    resend.addReceived({ id: 'r2', to: ['hallo@nordwind.ch'] })
    resend.addReceived({ id: 'r3', to: ['jemand@fremde-domain.ch'] })

    await sync.poll()
    expect(store.messages.get(messageKey(nordwind.id, 'r2'))).not.toBeNull()
    expect(store.messages.getByRemoteId(nordwind.id, 'r1')).toBeNull()
    expect(store.accounts.list().every((a) => a.kind === 'resend')).toBe(true)
  })

  it('keeps mail locally even though Resend drops it after 30 days', async () => {
    const { store, resend, sync, accountId } = setup()
    resend.addReceived({ id: 'r1', subject: 'Alt aber wichtig' })
    await sync.poll()

    // Simulate Resend's 30-day retention wiping the remote copy.
    resend.received = []
    await sync.poll()

    const message = store.messages.getByRemoteId(accountId, 'r1')!
    expect(message.subject).toBe('Alt aber wichtig')
    expect(store.search.query({ text: 'wichtig' })).toHaveLength(1)
  })
})

describe('attachments', () => {
  it('downloads and stores attachments immediately on import', async () => {
    const { store, resend, sync, saved, accountId } = setup()
    resend.addReceived({
      id: 'r1',
      attachments: [{ id: 'att_1', filename: 'plan.pdf', content_type: 'application/pdf', size: 12 }]
    })
    resend.addAttachment('r1', { id: 'att_1', filename: 'plan.pdf', content_type: 'application/pdf', size: 12 }, 'PLAN-INHALT')

    await sync.poll()
    expect(saved).toEqual([{ filename: 'plan.pdf', content: 'PLAN-INHALT' }])

    const message = store.messages.getByRemoteId(accountId, 'r1')!
    const [attachment] = store.messages.attachments(message.id)
    expect(attachment?.downloaded).toBe(true)
    expect(attachment?.filePath).toBe('/cache/plan.pdf')
    expect(message.hasAttachments).toBe(true)
  })
})

describe('threading', () => {
  it('links a reply to its parent via In-Reply-To', async () => {
    const { store, resend, sync, accountId } = setup()
    resend.addReceived({
      id: 'r1',
      headers: { 'Message-ID': '<first@keller-farben.ch>' },
      subject: 'Anfrage'
    })
    resend.addSent({
      id: 's1',
      headers: {
        'Message-ID': '<answer@beispielweb.ch>',
        'In-Reply-To': '<first@keller-farben.ch>'
      },
      subject: 'Re: Anfrage'
    })

    await sync.poll()
    const first = store.messages.getByRemoteId(accountId, 'r1')!
    const answer = store.messages.getByRemoteId(accountId, 's1')!
    expect(answer.threadId).toBe(first.threadId)
    expect(store.messages.threadSummary(first.threadId)?.messageCount).toBe(2)
  })

  it('links via References when In-Reply-To is missing', async () => {
    const { store, resend, sync, accountId } = setup()
    resend.addReceived({ id: 'r1', headers: { 'Message-ID': '<a@x.ch>' } })
    resend.addReceived({
      id: 'r2',
      headers: { 'Message-ID': '<c@x.ch>', References: '<a@x.ch> <b@x.ch>' }
    })
    await sync.poll()
    expect(store.messages.getByRemoteId(accountId, 'r2')!.threadId).toBe(
      store.messages.getByRemoteId(accountId, 'r1')!.threadId
    )
  })

  it('adopts messages that arrived before their parent', async () => {
    const { store, resend, sync, accountId } = setup()
    resend.addReceived({
      id: 'r2',
      headers: { 'Message-ID': '<child@x.ch>', 'In-Reply-To': '<parent@x.ch>' }
    })
    await sync.poll()
    resend.addReceived({ id: 'r1', headers: { 'Message-ID': '<parent@x.ch>' } })
    await sync.poll()

    const parent = store.messages.getByRemoteId(accountId, 'r1')!
    const child = store.messages.getByRemoteId(accountId, 'r2')!
    expect(child.threadId).toBe(parent.threadId)
    expect(store.messages.threadSummary(parent.threadId)?.messageCount).toBe(2)
  })

  it('keeps unrelated mail in separate conversations', async () => {
    const { store, resend, sync, accountId } = setup()
    resend.addReceived({ id: 'r1', headers: { 'Message-ID': '<a@x.ch>' } })
    resend.addReceived({ id: 'r2', headers: { 'Message-ID': '<b@x.ch>' } })
    await sync.poll()
    expect(store.messages.getByRemoteId(accountId, 'r1')!.threadId).not.toBe(
      store.messages.getByRemoteId(accountId, 'r2')!.threadId
    )
  })
})

describe('message bodies', () => {
  it('pulls the body from the detail endpoint, which the list omits', async () => {
    const { store, resend, sync, accountId } = setup()
    resend.addReceived({ id: 'r1', html: '<p>Offerte anbei</p>', text: 'Offerte anbei' })

    await sync.poll()
    const message = store.messages.getByRemoteId(accountId, 'r1')!
    expect(store.messages.body(message.id).html).toBe('<p>Offerte anbei</p>')
    expect(message.snippet).toContain('Offerte anbei')
  })

  it('backfills messages that were imported without a body', async () => {
    const { store, resend, sync, accountId } = setup()
    resend.addReceived({ id: 'r1', html: '<p>Nachtrag</p>', text: 'Nachtrag' })
    await sync.poll()

    const message = store.messages.getByRemoteId(accountId, 'r1')!
    store.messages.setBody(message.id, { html: null, text: null })
    expect(store.messages.listWithoutBody(accountId, 10)).toHaveLength(1)

    const result = await sync.poll()
    // Reported as a change so the open conversation is re-read in the UI.
    expect(result.updated).toEqual([message.id])
    expect(store.messages.body(message.id).html).toBe('<p>Nachtrag</p>')
    expect(store.messages.listWithoutBody(accountId, 10)).toHaveLength(0)
  })
})
