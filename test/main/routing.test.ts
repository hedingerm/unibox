import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Account } from '@shared/types'
import { SYSTEM_LABELS } from '@shared/types'
import { labelKey, messageKey } from '@main/db/ids'
import type { TestApp } from '../helpers/app'
import { createTestApp } from '../helpers/app'

let harness: TestApp
let account: Account

async function connectResend(): Promise<Account> {
  harness.resend.addDomain('beispielweb.ch', true)
  harness.resend.mx.set('beispielweb.ch', [
    { exchange: 'inbound-smtp.eu-west-1.amazonaws.com', priority: 10 }
  ])
  await harness.app.api['resend:setKey']('re_test')
  await harness.app.api['resend:enableReceiving']('dom_beispielweb_ch')
  // The first poll is the backfill; everything after it counts as arrival.
  await harness.app.syncAll()
  return harness.app.store.accounts.findByEmail('resend', 'beispielweb.ch')!
}

function labelsOf(remoteId: string): string[] {
  return harness.app.store.messages.get(messageKey(account.id, remoteId))?.labelIds ?? []
}

beforeEach(async () => {
  harness = createTestApp()
  account = await connectResend()
})

afterEach(() => {
  harness.dispose()
})

describe('routing rules at sync', () => {
  it('applies the matching rule to newly received mail only', async () => {
    harness.resend.addReceived({ id: 'old', subject: 'Newsletter Juli', from: 'news@shop.ch' })
    await harness.app.syncAll()
    const rule = await harness.app.api['rules:create']({
      accountId: null,
      name: 'Newsletter weg',
      matchField: 'from',
      operator: 'ends_with',
      value: '@shop.ch',
      action: 'archive'
    })

    harness.resend.addReceived({ id: 'new', subject: 'Newsletter August', from: 'news@shop.ch' })
    harness.resend.addReceived({ id: 'other', subject: 'Anfrage' })
    await harness.app.syncAll()

    // Mail that was already there stays untouched — rules never act backwards.
    expect(labelsOf('old')).toContain(labelKey(account.id, SYSTEM_LABELS.inbox))
    expect(labelsOf('new')).not.toContain(labelKey(account.id, SYSTEM_LABELS.inbox))
    expect(labelsOf('other')).toContain(labelKey(account.id, SYSTEM_LABELS.inbox))
    const stored = (await harness.app.api['rules:list']()).find((r) => r.id === rule.id)!
    expect(stored.matchCount).toBe(1)
    expect(stored.lastMatchedAt).not.toBeNull()
    const log = await harness.app.api['activity:list']({ kind: 'rule_action' })
    expect(log.entries).toHaveLength(1)
    expect(log.entries[0]?.summary).toContain('Newsletter weg')
    expect(log.entries[0]?.meta.messageId).toBe(messageKey(account.id, 'new'))
  })

  it('does not run over the first backfill of a domain', async () => {
    await harness.app.api['rules:create']({
      accountId: null,
      name: 'Alles lesen',
      matchField: 'any',
      operator: 'contains',
      value: 'anfrage',
      action: 'mark_read'
    })
    harness.resend.addDomain('nordwind.ch', true)
    harness.resend.mx.set('nordwind.ch', [{ exchange: 'inbound-smtp.eu-west-1.amazonaws.com', priority: 10 }])
    harness.resend.addReceived({ id: 'hist', to: ['info@nordwind.ch'], subject: 'Anfrage alt' })
    await harness.app.api['resend:enableReceiving']('dom_nordwind_ch')
    await harness.app.syncAll()
    const nordwind = harness.app.store.accounts.findByEmail('resend', 'nordwind.ch')!
    expect(harness.app.store.messages.get(messageKey(nordwind.id, 'hist'))?.labelIds).toContain(
      labelKey(nordwind.id, SYSTEM_LABELS.unread)
    )
  })

  it('carries out every action kind', async () => {
    const label = await harness.app.api['labels:create'](account.id, 'Rechnungen')
    const cases = [
      { value: 'label-me', action: 'label' as const, actionArg: label.id },
      { value: 'read-me', action: 'mark_read' as const },
      { value: 'spam-me', action: 'spam' as const },
      { value: 'trash-me', action: 'trash' as const }
    ]
    for (const entry of cases) {
      await harness.app.api['rules:create']({
        accountId: account.id,
        name: entry.value,
        matchField: 'subject',
        operator: 'exact',
        value: entry.value,
        action: entry.action,
        actionArg: entry.actionArg ?? null
      })
    }
    for (const entry of cases) harness.resend.addReceived({ id: entry.value, subject: entry.value })
    await harness.app.syncAll()

    expect(labelsOf('label-me')).toContain(label.id)
    expect(labelsOf('read-me')).not.toContain(labelKey(account.id, SYSTEM_LABELS.unread))
    expect(labelsOf('spam-me')).toContain(labelKey(account.id, SYSTEM_LABELS.spam))
    expect(labelsOf('trash-me')).toContain(labelKey(account.id, SYSTEM_LABELS.trash))
  })

  it('finds a rule label by name on another domain, creating it there', async () => {
    const label = await harness.app.api['labels:create'](account.id, 'Kunden')
    await harness.app.api['rules:create']({
      accountId: null,
      name: 'Kunden',
      matchField: 'from',
      operator: 'contains',
      value: 'keller',
      action: 'label',
      actionArg: label.id
    })
    harness.resend.addDomain('nordwind.ch', true)
    harness.resend.mx.set('nordwind.ch', [{ exchange: 'inbound-smtp.eu-west-1.amazonaws.com', priority: 10 }])
    await harness.app.api['resend:enableReceiving']('dom_nordwind_ch')
    await harness.app.syncAll()
    const nordwind = harness.app.store.accounts.findByEmail('resend', 'nordwind.ch')!
    harness.resend.addReceived({ id: 'n1', to: ['info@nordwind.ch'] })
    await harness.app.syncAll()
    const nordwindLabel = harness.app.store.labels.list(nordwind.id).find((l) => l.name === 'Kunden')
    expect(nordwindLabel).toBeDefined()
    expect(harness.app.store.messages.get(messageKey(nordwind.id, 'n1'))?.labelIds).toContain(nordwindLabel!.id)
  })

  it('drops mail for good, even though Resend keeps listing it', async () => {
    await harness.app.api['rules:create']({
      accountId: null,
      name: 'Spam verwerfen',
      matchField: 'subject',
      operator: 'regex',
      value: 'viagra|casino',
      action: 'drop'
    })
    harness.resend.addReceived({ id: 'junk', subject: 'Online CASINO bonus' })
    await harness.app.syncAll()
    expect(harness.app.store.messages.get(messageKey(account.id, 'junk'))).toBeNull()
    await harness.app.syncAll()
    expect(harness.app.store.messages.get(messageKey(account.id, 'junk'))).toBeNull()
    // Nor does a dropped mail raise a notification on its way through.
    expect(harness.notifications.some((n) => n.body.includes('CASINO'))).toBe(false)
  })

  it('lets a non-stopping rule hand over to the next one', async () => {
    await harness.app.api['rules:create']({
      accountId: null,
      name: 'Lesen',
      matchField: 'from',
      operator: 'contains',
      value: 'keller',
      action: 'mark_read',
      stopProcessing: false
    })
    await harness.app.api['rules:create']({
      accountId: null,
      name: 'Archiv',
      matchField: 'from',
      operator: 'contains',
      value: 'keller',
      action: 'archive'
    })
    await harness.app.api['rules:create']({
      accountId: null,
      name: 'Nie erreicht',
      matchField: 'from',
      operator: 'contains',
      value: 'keller',
      action: 'trash'
    })
    harness.resend.addReceived({ id: 'k1' })
    await harness.app.syncAll()
    const labels = labelsOf('k1')
    expect(labels).not.toContain(labelKey(account.id, SYSTEM_LABELS.unread))
    expect(labels).not.toContain(labelKey(account.id, SYSTEM_LABELS.inbox))
    expect(labels).not.toContain(labelKey(account.id, SYSTEM_LABELS.trash))
  })

  it('reorders rules so a later one wins', async () => {
    const a = await harness.app.api['rules:create']({
      accountId: null,
      name: 'A',
      matchField: 'any',
      operator: 'contains',
      value: 'anfrage',
      action: 'trash'
    })
    const b = await harness.app.api['rules:create']({
      accountId: null,
      name: 'B',
      matchField: 'any',
      operator: 'contains',
      value: 'anfrage',
      action: 'spam'
    })
    const ordered = await harness.app.api['rules:reorder']([b.id, a.id])
    expect(ordered.map((rule) => rule.id)).toEqual([b.id, a.id])
    harness.resend.addReceived({ id: 'q1' })
    await harness.app.syncAll()
    expect(labelsOf('q1')).toContain(labelKey(account.id, SYSTEM_LABELS.spam))
    expect(labelsOf('q1')).not.toContain(labelKey(account.id, SYSTEM_LABELS.trash))
  })
})

describe('forwarding rules', () => {
  it('forwards through Resend from the address the mail came in on, marked against loops', async () => {
    await harness.app.api['rules:create']({
      accountId: null,
      name: 'Offerten an Marco',
      matchField: 'to',
      operator: 'exact',
      value: 'offerten@beispielweb.ch',
      action: 'forward',
      actionArg: 'Marco@Partner.ch'
    })
    harness.resend.addReceived({ id: 'o1', to: ['offerten@beispielweb.ch'], subject: 'Offerte Dach' })
    await harness.app.syncAll()

    expect(harness.resend.sends).toHaveLength(1)
    const send = harness.resend.sends[0]!
    expect(send.payload.to).toEqual(['marco@partner.ch'])
    expect(send.payload.from).toBe('offerten@beispielweb.ch')
    expect(send.payload.subject).toBe('Fwd: Offerte Dach')
    expect(send.payload.reply_to).toEqual(['s.keller@keller-farben.ch'])
    expect((send.payload.headers as Record<string, string>)['X-Unibox-Forwarded']).toBe('1')
    expect(send.idempotencyKey).toContain(messageKey(account.id, 'o1'))
  })

  it('never forwards a mail that was itself auto-forwarded', async () => {
    await harness.app.api['rules:create']({
      accountId: null,
      name: 'Alles weiter',
      matchField: 'any',
      operator: 'contains',
      value: 'dach',
      action: 'forward',
      actionArg: 'marco@partner.ch'
    })
    harness.resend.addReceived({
      id: 'loop',
      subject: 'Fwd: Offerte Dach',
      headers: { 'X-Unibox-Forwarded': '1' }
    })
    await harness.app.syncAll()
    expect(harness.resend.sends).toHaveLength(0)
    const log = await harness.app.api['activity:list']({ kind: 'rule_action' })
    expect(log.entries[0]?.meta.error).toMatch(/bereits automatisch weitergeleitet/)
  })

  it('refuses to forward into a domain whose catch-all lands here', async () => {
    await expect(
      harness.app.api['rules:create']({
        accountId: null,
        name: 'Schleife',
        matchField: 'any',
        operator: 'contains',
        value: 'x',
        action: 'forward',
        actionArg: 'info@beispielweb.ch'
      })
    ).rejects.toThrow(/Kreis/)
  })
})

describe('rule validation and dry run', () => {
  it('rejects a broken regex with a readable message', async () => {
    await expect(
      harness.app.api['rules:create']({
        accountId: null,
        name: 'Kaputt',
        matchField: 'subject',
        operator: 'regex',
        value: '(',
        action: 'archive'
      })
    ).rejects.toThrow(/Ungültiger regulärer Ausdruck/)
  })

  it('rejects a label action without an existing label', async () => {
    await expect(
      harness.app.api['rules:create']({
        accountId: null,
        name: 'Ohne Label',
        matchField: 'subject',
        operator: 'contains',
        value: 'x',
        action: 'label',
        actionArg: 'nope'
      })
    ).rejects.toThrow(/Label/)
  })

  it('tests a rule against recent mail without applying anything', async () => {
    harness.resend.addReceived({ id: 't1', subject: 'Rechnung 1' })
    harness.resend.addReceived({ id: 't2', subject: 'Anfrage' })
    harness.resend.addReceived({ id: 't3', subject: 'Rechnung 2' })
    await harness.app.syncAll()

    const result = await harness.app.api['rules:test'](
      { accountId: null, matchField: 'subject', operator: 'starts_with', value: 'rechnung' },
      10
    )
    expect(result.error).toBeNull()
    expect(result.scanned).toBe(3)
    expect(result.matches.map((match) => match.subject).sort()).toEqual(['Rechnung 1', 'Rechnung 2'])
    expect(labelsOf('t1')).toContain(labelKey(account.id, SYSTEM_LABELS.inbox))
    expect((await harness.app.api['activity:list']({ kind: 'rule_action' })).entries).toHaveLength(0)

    const invalid = await harness.app.api['rules:test'](
      { accountId: null, matchField: 'subject', operator: 'regex', value: '[' },
      10
    )
    expect(invalid.error).toMatch(/Ungültiger/)
    expect(invalid.matches).toHaveLength(0)
  })

  it('updates and removes rules', async () => {
    const rule = await harness.app.api['rules:create']({
      accountId: account.id,
      name: 'Alt',
      matchField: 'subject',
      operator: 'contains',
      value: 'a',
      action: 'archive'
    })
    const updated = await harness.app.api['rules:update'](rule.id, { name: 'Neu', enabled: false })
    expect(updated).toMatchObject({ name: 'Neu', enabled: false, accountId: account.id, value: 'a' })
    await harness.app.api['rules:remove'](rule.id)
    expect(await harness.app.api['rules:list']()).toHaveLength(0)
  })
})
