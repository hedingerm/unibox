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

describe('unified inbox over IPC', () => {
  it('merges Gmail and Resend mail into one chronological list with account badges', async () => {
    const harness = createTestApp()
    try {
      await connectResend(harness)
      harness.resend.addReceived({
        id: 'r1',
        subject: 'Website-Relaunch',
        created_at: '2026-08-18T10:05:00.000Z'
      })

      const account = harness.app.store.accounts.upsert({
        kind: 'google',
        email: 'max@muster-it.ch',
        displayName: 'max@muster-it.ch'
      })
      harness.app.store.labels.ensureSystemLabels(account.id)
      harness.app.store.messages.upsert({
        id: `${account.id}:g1`,
        accountId: account.id,
        threadId: `${account.id}:t:g1`,
        remoteId: 'g1',
        subject: 'Security alert',
        from: { name: 'GitHub', email: 'noreply@github.com' },
        to: [{ name: null, email: 'max@muster-it.ch' }],
        date: Date.parse('2026-08-18T10:12:00.000Z'),
        labelRemoteIds: [SYSTEM_LABELS.inbox, SYSTEM_LABELS.unread],
        body: { html: null, text: 'A vulnerability was found' }
      })
      await harness.app.syncAll()

      const threads = await harness.app.api['threads:list']({ accountId: null, labelId: null })
      expect(threads.map((thread) => thread.subject)).toEqual(['Security alert', 'Website-Relaunch'])

      const accounts = await harness.app.api['accounts:list']()
      const colors = new Set(accounts.map((item) => item.color))
      expect(colors.size).toBe(accounts.length)
      expect(accounts.map((item) => item.kind).sort()).toEqual(['google', 'resend'])
    } finally {
      harness.dispose()
    }
  })

  it('filters by account and by label', async () => {
    const harness = createTestApp()
    try {
      await connectResend(harness)
      harness.resend.addReceived({ id: 'r1', subject: 'Nur Resend' })
      await harness.app.syncAll()

      const resendAccount = harness.app.store.accounts.findByEmail('resend', 'beispielweb.ch')!
      const scoped = await harness.app.api['threads:list']({
        accountId: resendAccount.id,
        labelId: null
      })
      expect(scoped).toHaveLength(1)

      const sentLabel = harness.app.store.labels.get(resendAccount.id, SYSTEM_LABELS.sent)!
      expect(
        await harness.app.api['threads:list']({ accountId: resendAccount.id, labelId: sentLabel.id })
      ).toHaveLength(0)
    } finally {
      harness.dispose()
    }
  })
})

describe('search over IPC', () => {
  it('searches the whole local store and filters by account', async () => {
    const harness = createTestApp()
    try {
      await connectResend(harness)
      harness.resend.addReceived({ id: 'r1', subject: 'Kostenvoranschlag Relaunch' })
      await harness.app.syncAll()

      const hits = await harness.app.api['search:query']({ text: 'Kostenvoranschlag' })
      expect(hits).toHaveLength(1)
      expect(hits[0]?.matchedMessageId).toBeTruthy()

      expect(
        await harness.app.api['search:query']({ text: 'Kostenvoranschlag', accountId: 'unbekannt' })
      ).toHaveLength(0)
    } finally {
      harness.dispose()
    }
  })
})

describe('notifications', () => {
  it('notifies for new incoming mail and respects the per-account switch', async () => {
    const harness = createTestApp()
    try {
      await connectResend(harness)
      await harness.app.syncAll()
      harness.resend.addReceived({ id: 'r1', subject: 'Erste Anfrage' })
      await harness.app.syncAll()
      expect(harness.notifications.map((n) => n.body)).toEqual(['Erste Anfrage'])

      const account = harness.app.store.accounts.findByEmail('resend', 'beispielweb.ch')!
      await harness.app.api['accounts:update'](account.id, { notificationsEnabled: false })
      harness.resend.addReceived({ id: 'r2', subject: 'Zweite Anfrage' })
      await harness.app.syncAll()
      expect(harness.notifications).toHaveLength(1)

      await harness.app.api['accounts:update'](account.id, { notificationsEnabled: true })
      await harness.app.api['settings:set']({ notificationsEnabled: false })
      harness.resend.addReceived({ id: 'r3', subject: 'Dritte Anfrage' })
      await harness.app.syncAll()
      expect(harness.notifications).toHaveLength(1)
    } finally {
      harness.dispose()
    }
  })

  it('notifies for a reply into a conversation that is already in the inbox', async () => {
    const harness = createTestApp({ googleOAuth: true, autoCompleteOAuth: true })
    try {
      harness.gmail.addMessage({
        id: 'm1',
        threadId: 't1',
        subject: 'Offerte Website',
        labelIds: ['INBOX', 'UNREAD']
      })
      await harness.app.api['google:connect']()
      await harness.app.syncAll()
      // The connect itself is the backfill: history, not news.
      expect(harness.notifications).toHaveLength(0)

      const reply = harness.gmail.addMessage({
        id: 'm2',
        threadId: 't1',
        subject: 'Re: Offerte Website',
        labelIds: ['INBOX', 'UNREAD']
      })
      harness.gmail.pushHistory({
        messagesAdded: [{ message: { id: reply.id, threadId: reply.threadId } }]
      })
      await harness.app.syncAll()

      expect(harness.notifications.map((n) => n.body)).toEqual(['Re: Offerte Website'])
    } finally {
      harness.dispose()
    }
  })

  it('notifies once per new Gmail message and stays silent on mere label changes', async () => {
    const harness = createTestApp({ googleOAuth: true, autoCompleteOAuth: true })
    try {
      const existing = harness.gmail.addMessage({
        id: 'm1',
        threadId: 't1',
        subject: 'Alt',
        labelIds: ['INBOX', 'UNREAD']
      })
      await harness.app.api['google:connect']()
      await harness.app.syncAll()

      const fresh = harness.gmail.addMessage({
        id: 'm2',
        threadId: 't2',
        subject: 'Neuer Auftrag',
        labelIds: ['INBOX', 'UNREAD']
      })
      harness.gmail.pushHistory({
        messagesAdded: [{ message: { id: fresh.id, threadId: fresh.threadId } }]
      })
      // Reading a message elsewhere touches the same mailbox but is not mail.
      existing.labelIds = ['INBOX']
      harness.gmail.pushHistory({
        labelsRemoved: [
          { message: { id: 'm1', threadId: 't1', labelIds: ['INBOX'] }, labelIds: ['UNREAD'] }
        ]
      })
      await harness.app.syncAll()

      expect(harness.notifications.map((n) => n.body)).toEqual(['Neuer Auftrag'])
      expect(harness.notifications[0]?.threadId).toBe(
        harness.app.store.messages.getByRemoteId(
          harness.app.store.accounts.findByEmail('google', 'max@muster-it.ch')!.id,
          'm2'
        )?.threadId
      )
    } finally {
      harness.dispose()
    }
  })

  it('does not notify for outgoing mail', async () => {
    const harness = createTestApp()
    try {
      await connectResend(harness)
      await harness.app.syncAll()
      harness.resend.addSent({ id: 's1', subject: 'Antwort' })
      await harness.app.syncAll()
      expect(harness.notifications).toHaveLength(0)
    } finally {
      harness.dispose()
    }
  })

  it('stays silent while a freshly connected domain backfills its history', async () => {
    const harness = createTestApp()
    try {
      // Resend keeps 30 days of mail; the first sync after connecting a domain
      // pulls all of it at once — that is history, not news.
      for (const id of ['r1', 'r2', 'r3']) {
        harness.resend.addReceived({ id, subject: `Alt ${id}` })
      }
      await connectResend(harness)
      await harness.app.syncAll()

      expect(harness.notifications).toHaveLength(0)
      const account = harness.app.store.accounts.findByEmail('resend', 'beispielweb.ch')!
      expect(account.initialSyncDone).toBe(true)
      expect(
        await harness.app.api['threads:list']({ accountId: account.id, labelId: null })
      ).toHaveLength(3)

      harness.resend.addReceived({ id: 'r4', subject: 'Neu' })
      await harness.app.syncAll()
      expect(harness.notifications.map((n) => n.body)).toEqual(['Neu'])
    } finally {
      harness.dispose()
    }
  })

  it('polls Resend on its own cycle without touching Gmail', async () => {
    const harness = createTestApp()
    try {
      await connectResend(harness)
      await harness.app.syncResendAccounts()

      harness.resend.addReceived({ id: 'r1', subject: 'Schnell da' })
      await harness.app.syncResendAccounts()

      expect(harness.notifications.map((n) => n.body)).toEqual(['Schnell da'])
      const account = harness.app.store.accounts.findByEmail('resend', 'beispielweb.ch')!
      expect(
        harness.events.filter(
          (event) =>
            event.name === 'data:changed' &&
            (event.payload as { accountIds: string[] }).accountIds.includes(account.id)
        )
      ).toHaveLength(1)
    } finally {
      harness.dispose()
    }
  })

  it('checks Gmail cheaply and syncs only a mailbox that moved', async () => {
    const harness = createTestApp({ googleOAuth: true, autoCompleteOAuth: true })
    try {
      harness.gmail.addMessage({ id: 'm1', threadId: 't1', subject: 'Alt', labelIds: ['INBOX'] })
      await harness.app.api['google:connect']()
      await harness.app.syncAll()

      const before = harness.gmail.requestCount
      await harness.app.checkGmail()
      // Nothing moved: the profile read is all it costs.
      expect(harness.gmail.requestCount - before).toBe(1)
      expect(harness.notifications).toHaveLength(0)

      const mail = harness.gmail.addMessage({
        id: 'm2',
        threadId: 't2',
        subject: 'Sofort da',
        labelIds: ['INBOX', 'UNREAD']
      })
      harness.gmail.pushHistory({
        messagesAdded: [{ message: { id: mail.id, threadId: mail.threadId } }]
      })
      await harness.app.checkGmail()

      expect(harness.notifications.map((n) => [n.body, n.actions])).toEqual([
        ['Sofort da', ['archive', 'read']]
      ])
    } finally {
      harness.dispose()
    }
  })

  it('archives or marks read the conversation a notification announced', async () => {
    const harness = createTestApp()
    try {
      await connectResend(harness)
      await harness.app.syncAll()
      harness.resend.addReceived({ id: 'r1', subject: 'Erste Anfrage' })
      harness.resend.addReceived({ id: 'r2', subject: 'Zweite Anfrage' })
      await harness.app.syncAll()
      const [first, second] = harness.notifications
      const hasLabel = (threadId: string, label: string): boolean =>
        harness.app.store.messages
          .messagesInThread(threadId)
          .some((m) => m.labelIds.some((id) => id.endsWith(label)))
      expect(hasLabel(first!.threadId, SYSTEM_LABELS.unread)).toBe(true)
      expect(hasLabel(second!.threadId, SYSTEM_LABELS.inbox)).toBe(true)

      harness.app.notificationAction(first!.threadId, 'read')
      expect(hasLabel(first!.threadId, SYSTEM_LABELS.unread)).toBe(false)

      harness.app.notificationAction(second!.threadId, 'archive')
      expect(hasLabel(second!.threadId, SYSTEM_LABELS.inbox)).toBe(false)
    } finally {
      harness.dispose()
    }
  })
})

describe('resend key handling', () => {
  it('stores the key in the secret vault and lists domains', async () => {
    const harness = createTestApp()
    try {
      harness.resend.addDomain('beispielweb.ch', true)
      harness.resend.addDomain('nordwind.ch')
      const domains = await harness.app.api['resend:setKey']('re_live_123')
      expect(domains.map((d) => d.name)).toEqual(['beispielweb.ch', 'nordwind.ch'])
      expect(await harness.app.api['resend:hasKey']()).toBe(true)
      expect(harness.secrets.get('resend:apiKey')).toBe('re_live_123')
    } finally {
      harness.dispose()
    }
  })

  it('discards an invalid key instead of keeping it', async () => {
    const harness = createTestApp()
    try {
      harness.resend.invalidKey = true
      await expect(harness.app.api['resend:setKey']('re_bad')).rejects.toBeTruthy()
      expect(await harness.app.api['resend:hasKey']()).toBe(false)
    } finally {
      harness.dispose()
    }
  })
})

describe('connecting Google accounts', () => {
  it('connects two accounts and keeps their tokens out of the database', async () => {
    const harness = createTestApp({ googleOAuth: true, autoCompleteOAuth: true })
    try {
      harness.gmail.emailAddress = 'max.muster@gmail.com'
      const first = await harness.app.api['google:connect']()
      harness.gmail.emailAddress = 'max@muster-it.ch'
      const second = await harness.app.api['google:connect']()

      expect(first.email).toBe('max.muster@gmail.com')
      expect(second.email).toBe('max@muster-it.ch')
      expect((await harness.app.api['accounts:list']()).map((a) => a.email).sort()).toEqual([
        'max.muster@gmail.com',
        'max@muster-it.ch'
      ])

      expect(harness.app.vault.getGoogleTokens(first.id)?.refreshToken).toBe('test-refresh')
      expect(harness.app.vault.getGoogleTokens(second.id)?.refreshToken).toBe('test-refresh')

      // Nothing token-shaped may live in the database itself.
      const dump = (
        harness.app.store.db
          .prepare(`SELECT key, value FROM settings`)
          .all() as Array<{ key: string; value: string }>
      )
        .map((row) => `${row.key}=${row.value}`)
        .join('\n')
      expect(dump).not.toContain('test-refresh')
      expect(harness.openedUrls[0]).toContain('code_challenge_method=S256')
    } finally {
      harness.dispose()
    }
  })

  it('reports a missing OAuth client instead of failing silently', async () => {
    const harness = createTestApp()
    try {
      await expect(harness.app.api['google:connect']()).rejects.toThrow(/OAuth/)
    } finally {
      harness.dispose()
    }
  })
})

describe('label write-back from the UI path', () => {
  it('applies the label locally and queues it for Gmail', async () => {
    const harness = createTestApp({ googleOAuth: true, autoCompleteOAuth: true })
    try {
      harness.gmail.addUserLabel('Label_7', 'Kunden')
      harness.gmail.addMessage({ id: 'm1' })
      const account = await harness.app.api['google:connect']()
      await harness.app.syncAll()

      const message = harness.app.store.messages.getByRemoteId(account.id, 'm1')!
      const kunden = (await harness.app.api['labels:list'](account.id)).find(
        (label) => label.name === 'Kunden'
      )!

      await harness.app.api['messages:changeLabels']({
        messageIds: [message.id],
        addLabelIds: [kunden.id]
      })
      expect(harness.app.store.messages.labelIdsOf(message.id)).toContain(kunden.id)
      await harness.app.syncAll()
      expect(harness.gmail.modifications.at(-1)?.addLabelIds).toEqual(['Label_7'])
    } finally {
      harness.dispose()
    }
  })
})

describe('outbox over IPC', () => {
  it('holds a send in the undo window and cancels it', async () => {
    const harness = createTestApp()
    try {
      await connectResend(harness)
      const account = harness.app.store.accounts.findByEmail('resend', 'beispielweb.ch')!
      const item = await harness.app.api['compose:send']({
        accountId: account.id,
        identityName: 'Max Muster',
        identityEmail: 'kontakt@beispielweb.ch',
        to: [{ name: null, email: 's.keller@keller-farben.ch' }],
        cc: [],
        bcc: [],
        subject: 'Offerte',
        html: '<p>Guten Tag</p>',
        text: 'Guten Tag',
        attachments: [],
        replyToMessageId: null
      })
      expect(item.state).toBe('undoable')
      expect(await harness.app.api['outbox:list']()).toHaveLength(1)

      await harness.app.api['compose:cancel'](item.id)
      expect(await harness.app.api['outbox:list']()).toHaveLength(0)
      expect(harness.resend.sends).toHaveLength(0)
    } finally {
      harness.dispose()
    }
  })

  it('keeps a scheduled mail until its moment arrives', async () => {
    const harness = createTestApp()
    try {
      await connectResend(harness)
      const account = harness.app.store.accounts.findByEmail('resend', 'beispielweb.ch')!
      const item = await harness.app.api['compose:schedule'](
        {
          accountId: account.id,
          identityName: 'Max Muster',
          identityEmail: 'kontakt@beispielweb.ch',
          to: [{ name: null, email: 's.keller@keller-farben.ch' }],
          cc: [],
          bcc: [],
          subject: 'Später',
          html: '<p>Später</p>',
          text: 'Später',
          attachments: [],
          replyToMessageId: null
        },
        Date.now() + 3600_000
      )
      expect(item.state).toBe('scheduled')
      await harness.app.syncAll()
      expect(harness.resend.sends).toHaveLength(0)
      expect((await harness.app.api['outbox:list']())[0]?.state).toBe('scheduled')
    } finally {
      harness.dispose()
    }
  })
})

describe('first backfill feedback', () => {
  it('reports progress and refreshes the UI while the import is still running', async () => {
    const harness = createTestApp({ googleOAuth: true, autoCompleteOAuth: true })
    try {
      for (let i = 1; i <= 60; i += 1) harness.gmail.addMessage({ id: `m${i}` })
      await harness.app.api['google:connect']()
      harness.events.length = 0
      await harness.app.syncAll()

      const progress = harness.events.filter((event) => event.name === 'sync:progress')
      expect(progress.length).toBeGreaterThan(1)
      expect((progress[0]?.payload as { phase: string }).phase).toBe('initial')
      expect((progress[0]?.payload as { total: number }).total).toBe(60)

      // At least one refresh before the final one, so the list fills up live.
      const refreshes = harness.events.filter((event) => event.name === 'data:changed')
      expect(refreshes.length).toBeGreaterThan(1)
      const firstRefresh = harness.events.findIndex((event) => event.name === 'data:changed')
      const lastEvent = harness.events.length - 1
      expect(firstRefresh).toBeLessThan(lastEvent)

      expect(await harness.app.api['sync:status']()).not.toHaveLength(0)
    } finally {
      harness.dispose()
    }
  })
})
