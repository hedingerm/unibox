import { existsSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Account } from '@shared/types'
import type { TestApp } from '../helpers/app'
import { createTestApp } from '../helpers/app'
import { seedMessage } from '../helpers/store'

let harness: TestApp

async function connectResend(): Promise<Account> {
  harness.resend.addDomain('beispielweb.ch', true)
  harness.resend.mx.set('beispielweb.ch', [
    { exchange: 'inbound-smtp.eu-west-1.amazonaws.com', priority: 10 }
  ])
  await harness.app.api['resend:setKey']('re_test')
  await harness.app.api['resend:enableReceiving']('dom_beispielweb_ch')
  await harness.app.syncAll()
  return harness.app.store.accounts.findByEmail('resend', 'beispielweb.ch')!
}

beforeEach(() => {
  harness = createTestApp()
})

afterEach(() => {
  harness.dispose()
})

describe('delivery status', () => {
  it('keeps the last event of every sent mail and follows it as it changes', async () => {
    await connectResend()
    harness.resend.addSent({ id: 's1', subject: 'Offerte', last_event: 'delivered' })
    const bounced = harness.resend.addSent({ id: 's2', subject: 'Rechnung', last_event: 'sent' })
    // Sent from a domain without receiving: no account, but a delivery all the same.
    harness.resend.addSent({ id: 's3', from: 'info@nordwind.ch', subject: 'Hallo', last_event: 'opened' })
    await harness.app.syncAll()

    let list = await harness.app.api['delivery:list']()
    expect(list.map((d) => [d.remoteId, d.lastEvent])).toEqual(
      expect.arrayContaining([
        ['s1', 'delivered'],
        ['s2', 'sent'],
        ['s3', 'opened']
      ])
    )
    expect(list.find((d) => d.remoteId === 's1')?.messageId).not.toBeNull()
    expect(list.find((d) => d.remoteId === 's3')?.messageId).toBeNull()

    bounced.last_event = 'bounced'
    await harness.app.syncAll()
    list = await harness.app.api['delivery:list']({ status: 'bounced' })
    expect(list.map((d) => d.remoteId)).toEqual(['s2'])
    expect((await harness.app.api['delivery:list']({ domain: 'nordwind.ch' })).map((d) => d.remoteId)).toEqual(['s3'])

    const summary = await harness.app.api['delivery:summary']()
    expect(summary.total).toBe(3)
    expect(summary.byStatus).toMatchObject({ delivered: 1, bounced: 1, opened: 1 })
  })

  it('records delivery status with a key but no receiving domain at all', async () => {
    harness.resend.addDomain('nordwind.ch')
    harness.resend.addSent({ id: 'x1', from: 'info@nordwind.ch', last_event: 'complained' })
    await harness.app.api['resend:setKey']('re_test')
    await harness.app.syncAll()
    expect((await harness.app.api['delivery:list']()).map((d) => d.lastEvent)).toEqual(['complained'])
  })
})

describe('webhooks', () => {
  it('lists, creates and removes webhooks at Resend', async () => {
    await harness.app.api['resend:setKey']('re_test')
    const created = await harness.app.api['webhooks:create']({
      endpoint: 'https://hooks.example.ch/resend',
      events: ['email.bounced', 'email.bounced', 'email.delivered']
    })
    expect(created.signingSecret).toBe('whsec_wh_1')
    expect(created.events).toEqual(['email.bounced', 'email.delivered'])
    const listed = await harness.app.api['webhooks:list']()
    expect(listed).toHaveLength(1)
    expect(listed[0]).toMatchObject({ endpoint: 'https://hooks.example.ch/resend', status: 'enabled' })
    await harness.app.api['webhooks:remove'](created.id)
    expect(await harness.app.api['webhooks:list']()).toHaveLength(0)
  })

  it('refuses plain http and empty event lists', async () => {
    await harness.app.api['resend:setKey']('re_test')
    await expect(
      harness.app.api['webhooks:create']({ endpoint: 'http://x.ch/hook', events: ['email.sent'] })
    ).rejects.toThrow(/https/)
    await expect(
      harness.app.api['webhooks:create']({ endpoint: 'https://x.ch/hook', events: [] })
    ).rejects.toThrow(/Ereignis/)
  })
})

describe('domain authentication panel', () => {
  it('reports every record with its status, the inbound MX and DMARC', async () => {
    const domain = harness.resend.addDomain('beispielweb.ch', true)
    domain.created_at = '2026-01-10T08:00:00.000Z'
    domain.records = [
      { record: 'SPF', name: 'send', type: 'MX', value: 'feedback-smtp.eu-west-1.amazonses.com', priority: 10, status: 'verified' },
      { record: 'SPF', name: 'send', type: 'TXT', value: '"v=spf1 include:amazonses.com ~all"', status: 'failed' },
      { record: 'DKIM', name: 'resend._domainkey', type: 'TXT', value: 'p=MIGf', status: 'pending' }
    ]
    harness.resend.mx.set('beispielweb.ch', [
      { exchange: 'inbound-smtp.eu-west-1.amazonaws.com', priority: 10 },
      { exchange: 'mx.old-host.ch', priority: 20 }
    ])
    harness.resend.txt.set('_dmarc.beispielweb.ch', [['v=DMARC1; p=quar', 'antine; rua=mailto:d@beispielweb.ch']])
    await harness.app.api['resend:setKey']('re_test')

    const [details] = await harness.app.api['domains:list']()
    expect(details).toMatchObject({
      name: 'beispielweb.ch',
      sendingEnabled: true,
      receivingEnabled: true,
      verified: true,
      mxVerified: true,
      conflictingMx: ['mx.old-host.ch'],
      createdAt: Date.parse('2026-01-10T08:00:00.000Z')
    })
    const byKind = Object.fromEntries(details!.records.map((r) => [r.kind, r.status]))
    expect(byKind).toEqual({
      return_path: 'found',
      spf: 'missing',
      dkim: 'pending',
      mx_receiving: 'found',
      dmarc: 'found'
    })
    expect(details!.dmarc).toMatchObject({ status: 'found', policy: 'quarantine' })
  })

  it('suggests a DMARC record when none is published and re-verifies on request', async () => {
    harness.resend.addDomain('nordwind.ch')
    await harness.app.api['resend:setKey']('re_test')
    const details = await harness.app.api['domains:verify']('dom_nordwind_ch')
    expect(harness.resend.verified).toEqual(['dom_nordwind_ch'])
    expect(details.dmarc.status).toBe('missing')
    const dmarc = details.records.find((r) => r.kind === 'dmarc')!
    expect(dmarc).toMatchObject({ status: 'missing', value: 'v=DMARC1; p=none;', required: false })
    const mx = details.records.find((r) => r.kind === 'mx_receiving')!
    expect(mx).toMatchObject({ status: 'missing', required: false, value: 'inbound-smtp.eu-west-1.amazonaws.com' })
  })

  it('adds a new domain at Resend, lists its records and logs it', async () => {
    await harness.app.api['resend:setKey']('re_test')
    const details = await harness.app.api['domains:create']({ name: ' Neu-Kunde.CH ', region: 'us-east-1' })
    expect(details).toMatchObject({ name: 'neu-kunde.ch', region: 'us-east-1', verified: false, receivingEnabled: false })
    expect(details.records.map((r) => r.kind)).toEqual(
      expect.arrayContaining(['return_path', 'spf', 'dkim', 'mx_receiving', 'dmarc'])
    )
    expect(details.records.find((r) => r.kind === 'dkim')?.status).toBe('pending')
    expect((await harness.app.api['domains:list']()).map((d) => d.name)).toContain('neu-kunde.ch')
    const activity = await harness.app.api['activity:list']()
    expect(activity.entries.find((e) => e.kind === 'domain_created')?.summary).toContain('neu-kunde.ch')
  })

  it('refuses a malformed domain name before asking Resend', async () => {
    await harness.app.api['resend:setKey']('re_test')
    const before = harness.resend.requestCount
    await expect(
      harness.app.api['domains:create']({ name: 'kein domain', region: 'eu-west-1' })
    ).rejects.toThrow(/kein gültiger Domainname/)
    expect(harness.resend.requestCount).toBe(before)
  })
})

describe('activity log', () => {
  it('records sends, receiving changes and account removal', async () => {
    const account = await connectResend()
    await harness.app.api['compose:send']({
      accountId: account.id,
      identityName: 'Max',
      identityEmail: 'kontakt@beispielweb.ch',
      to: [{ name: null, email: 's.keller@keller-farben.ch' }],
      cc: [],
      bcc: [],
      subject: 'Offerte',
      html: '<p>Hallo</p>',
      text: 'Hallo',
      attachments: [],
      replyToMessageId: null,
      followUpDays: null
    })
    await harness.app.send.tick()
    await harness.app.api['resend:disableReceiving']('dom_beispielweb_ch')
    await harness.app.api['accounts:remove'](account.id)

    const page = await harness.app.api['activity:list']()
    const kinds = page.entries.map((entry) => entry.kind)
    expect(kinds).toEqual(
      expect.arrayContaining(['receiving_enabled', 'receiving_disabled', 'account_removed'])
    )
    // The undo window is still open, so nothing has been sent yet.
    expect(kinds).not.toContain('mail_sent')
  })

  it('logs a mail once it has really gone out', async () => {
    const account = await connectResend()
    harness.app.store.settings.set({ undoSendSeconds: 0 })
    await harness.app.api['compose:send']({
      accountId: account.id,
      identityName: 'Max',
      identityEmail: 'kontakt@beispielweb.ch',
      to: [{ name: null, email: 's.keller@keller-farben.ch' }],
      cc: [],
      bcc: [],
      subject: 'Offerte',
      html: '<p>Hallo</p>',
      text: 'Hallo',
      attachments: [],
      replyToMessageId: null,
      followUpDays: null
    })
    await harness.app.send.tick()
    const sent = await harness.app.api['activity:list']({ kind: 'mail_sent' })
    expect(sent.entries).toHaveLength(1)
    expect(sent.entries[0]?.summary).toBe('«Offerte» an s.keller@keller-farben.ch gesendet')
  })

  it('folds a repeating sync error into one entry', async () => {
    await connectResend()
    harness.resend.offline = true
    await harness.app.syncAll()
    await harness.app.syncAll()
    await harness.app.syncAll()
    const errors = await harness.app.api['activity:list']({ kind: 'sync_error' })
    expect(errors.entries).toHaveLength(1)
    expect(errors.entries[0]?.count).toBe(3)
  })

  it('pages through the log', async () => {
    for (let index = 0; index < 5; index += 1) {
      harness.app.store.activity.record({ kind: 'backup_created', summary: `B${index}` })
    }
    const first = await harness.app.api['activity:list']({ limit: 2 })
    expect(first.entries.map((e) => e.summary)).toEqual(['B4', 'B3'])
    const second = await harness.app.api['activity:list']({ limit: 2, beforeId: first.nextBeforeId })
    expect(second.entries.map((e) => e.summary)).toEqual(['B2', 'B1'])
    const last = await harness.app.api['activity:list']({ limit: 2, beforeId: second.nextBeforeId })
    expect(last.entries.map((e) => e.summary)).toEqual(['B0'])
    expect(last.nextBeforeId).toBeNull()
  })
})

describe('backups', () => {
  it('writes backups into the backup folder and lists them', async () => {
    const created = await harness.app.api['backups:create']()
    expect(existsSync(created.path)).toBe(true)
    expect(created.auto).toBe(false)
    const listed = await harness.app.api['backups:list']()
    expect(listed.map((file) => file.name)).toEqual([created.name])
    expect(listed[0]!.size).toBeGreaterThan(0)
    expect((await harness.app.api['activity:list']({ kind: 'backup_created' })).entries).toHaveLength(1)
  })

  it('writes the daily backup only when switched on and due', async () => {
    harness.app.runAutoBackup()
    expect(await harness.app.api['backups:list']()).toHaveLength(0)
    await harness.app.api['settings:set']({ autoBackup: true })
    harness.app.runAutoBackup()
    harness.app.runAutoBackup()
    const listed = await harness.app.api['backups:list']()
    expect(listed).toHaveLength(1)
    expect(listed[0]!.auto).toBe(true)
  })
})

describe('admin overview', () => {
  it('sums up accounts, domains, rules, traffic and sync state', async () => {
    const account = await connectResend()
    harness.resend.addDomain('nordwind.ch')
    harness.resend.addSent({ id: 'b1', last_event: 'bounced', created_at: new Date().toISOString() })
    await harness.app.syncAll()
    seedMessage(harness.app.store, account, { remoteId: 'in1' })
    seedMessage(harness.app.store, account, { remoteId: 'old', date: Date.now() - 30 * 86_400_000 })
    await harness.app.api['mailboxes:create']({ accountId: account.id, address: 'info@beispielweb.ch' })
    await harness.app.api['rules:create']({
      accountId: null,
      name: 'R',
      matchField: 'any',
      operator: 'contains',
      value: 'x',
      action: 'archive'
    })
    await harness.app.api['domains:list']()
    await harness.app.api['backups:create']()

    const overview = await harness.app.api['admin:overview']()
    expect(overview.accounts).toEqual({ total: 1, byKind: { google: 0, resend: 1 } })
    expect(overview.domains).toEqual({ total: 2, verified: 2, receiving: 1 })
    expect(overview.mailboxes).toBe(1)
    expect(overview.activeRules).toBe(1)
    expect(overview.last7Days).toEqual({ received: 1, sent: 1, bounced: 1 })
    expect(overview.lastBackupAt).not.toBeNull()
    expect(overview.dbSizeBytes).toBeGreaterThan(0)
    expect(overview.sync[0]).toMatchObject({ email: 'beispielweb.ch', status: 'ok' })
    expect(overview.recentErrors).toBe(0)
  })
})
