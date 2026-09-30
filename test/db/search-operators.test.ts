import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { SYSTEM_LABELS } from '@shared/types'
import { labelKey } from '@main/db/ids'
import { migrate } from '@main/db/migrations'
import { addGoogleAccount, addResendAccount, makeStore, seedMessage } from '../helpers/store'

const DAY = 24 * 60 * 60 * 1000
const NOW = new Date(2026, 7, 20, 12, 0).getTime()

describe('search operators', () => {
  it('filters by sender without any free text', () => {
    const store = makeStore()
    const account = addGoogleAccount(store)
    seedMessage(store, account, {
      remoteId: 'm1',
      from: { name: 'Sandra Keller', email: 's.keller@keller-farben.ch' }
    })
    seedMessage(store, account, {
      remoteId: 'm2',
      from: { name: 'Peter Weber', email: 'p.weber@example.com' }
    })

    expect(store.search.query({ text: 'from:keller' }, NOW)).toHaveLength(1)
    expect(store.search.query({ text: 'from:Sandra' }, NOW)).toHaveLength(1)
    expect(store.search.query({ text: '-from:keller' }, NOW)).toHaveLength(1)
    expect(store.search.query({ text: 'from:niemand' }, NOW)).toHaveLength(0)
    store.close()
  })

  it('combines free text with operators', () => {
    const store = makeStore()
    const account = addGoogleAccount(store)
    seedMessage(store, account, {
      remoteId: 'm1',
      subject: 'Offerte Onlineshop',
      from: { name: null, email: 's.keller@keller-farben.ch' }
    })
    seedMessage(store, account, {
      remoteId: 'm2',
      subject: 'Offerte Website',
      from: { name: null, email: 'p.weber@example.com' }
    })

    expect(store.search.query({ text: 'Offerte' }, NOW)).toHaveLength(2)
    expect(store.search.query({ text: 'Offerte from:weber' }, NOW)).toHaveLength(1)
    store.close()
  })

  it('matches recipients through to: and cc:', () => {
    const store = makeStore()
    const account = addGoogleAccount(store)
    seedMessage(store, account, {
      remoteId: 'm1',
      to: [{ name: null, email: 'buchhaltung@beispielweb.ch' }]
    })
    seedMessage(store, account, {
      remoteId: 'm2',
      to: [{ name: null, email: 'info@example.com' }],
      cc: [{ name: null, email: 'buchhaltung@beispielweb.ch' }]
    })

    // `to:` also reads the Cc line, the way Gmail does.
    expect(store.search.query({ text: 'to:buchhaltung' }, NOW)).toHaveLength(2)
    expect(store.search.query({ text: 'cc:buchhaltung' }, NOW)).toHaveLength(1)
    store.close()
  })

  it('resolves from:me and to:me across accounts and identities', () => {
    const store = makeStore()
    const google = addGoogleAccount(store, 'max@example.com')
    store.identities.create({
      accountId: google.id,
      name: 'Max',
      email: 'hallo@beispielweb.ch',
      signatureHtml: null,
      isDefault: true
    })
    seedMessage(store, google, {
      remoteId: 'm1',
      from: { name: 'Max', email: 'hallo@beispielweb.ch' },
      to: [{ name: null, email: 'kunde@example.com' }]
    })
    seedMessage(store, google, {
      remoteId: 'm2',
      from: { name: null, email: 'kunde@example.com' },
      to: [{ name: null, email: 'max@example.com' }]
    })

    expect(store.search.query({ text: 'from:me' }, NOW)).toHaveLength(1)
    expect(store.search.query({ text: 'to:me' }, NOW)).toHaveLength(1)
    store.close()
  })

  it('reads state through is: and in:', () => {
    const store = makeStore()
    const account = addGoogleAccount(store)
    seedMessage(store, account, { remoteId: 'm1', labels: [SYSTEM_LABELS.inbox, SYSTEM_LABELS.unread] })
    seedMessage(store, account, { remoteId: 'm2', labels: [SYSTEM_LABELS.inbox] })
    seedMessage(store, account, {
      remoteId: 'm3',
      labels: [SYSTEM_LABELS.inbox, SYSTEM_LABELS.starred]
    })

    expect(store.search.query({ text: 'is:unread' }, NOW)).toHaveLength(1)
    expect(store.search.query({ text: 'is:read' }, NOW)).toHaveLength(2)
    expect(store.search.query({ text: '-is:unread' }, NOW)).toHaveLength(2)
    expect(store.search.query({ text: 'is:starred' }, NOW)).toHaveLength(1)
    expect(store.search.query({ text: 'in:inbox' }, NOW)).toHaveLength(3)
    expect(store.search.query({ text: 'in:sent' }, NOW)).toHaveLength(0)
    store.close()
  })

  it('works in the merged view where label ids differ per account', () => {
    const store = makeStore()
    const google = addGoogleAccount(store)
    const resend = addResendAccount(store)
    seedMessage(store, google, { remoteId: 'g1', labels: [SYSTEM_LABELS.inbox, SYSTEM_LABELS.unread] })
    seedMessage(store, resend, { remoteId: 'r1', labels: [SYSTEM_LABELS.inbox, SYSTEM_LABELS.unread] })

    expect(store.search.query({ text: 'is:unread' }, NOW)).toHaveLength(2)
    store.close()
  })

  it('scopes label: to each account and takes nested labels along', () => {
    const store = makeStore()
    const a = addGoogleAccount(store, 'a@example.com')
    const b = addGoogleAccount(store, 'b@example.com')
    store.labels.replaceAll(a.id, [
      { remoteId: 'INBOX', name: 'INBOX', type: 'system' },
      { remoteId: 'L1', name: 'Kunden', type: 'user' },
      { remoteId: 'L2', name: 'Kunden/Aktiv', type: 'user' }
    ])
    store.labels.replaceAll(b.id, [
      { remoteId: 'INBOX', name: 'INBOX', type: 'system' },
      { remoteId: 'L9', name: 'Kunden', type: 'user' }
    ])
    seedMessage(store, a, { remoteId: 'a1', labels: [SYSTEM_LABELS.inbox, 'L1'] })
    seedMessage(store, a, { remoteId: 'a2', labels: [SYSTEM_LABELS.inbox, 'L2'] })
    seedMessage(store, b, { remoteId: 'b1', labels: [SYSTEM_LABELS.inbox, 'L9'] })

    // Both accounts own a "Kunden", and the nested child counts as well.
    expect(store.search.query({ text: 'label:Kunden' }, NOW)).toHaveLength(3)
    expect(store.search.query({ text: 'label:kunden/aktiv' }, NOW)).toHaveLength(1)
    expect(store.search.query({ text: 'label:Kunden', accountId: b.id }, NOW)).toHaveLength(1)
    store.close()
  })

  it('addresses accounts by e-mail and Resend domains by name', () => {
    const store = makeStore()
    const google = addGoogleAccount(store, 'max@example.com')
    const resend = addResendAccount(store, 'beispielweb.ch')
    seedMessage(store, google, { remoteId: 'g1' })
    seedMessage(store, resend, { remoteId: 'r1' })

    expect(store.search.query({ text: 'account:beispielweb.ch' }, NOW)[0]?.accountId).toBe(resend.id)
    expect(store.search.query({ text: 'account:example.com' }, NOW)[0]?.accountId).toBe(google.id)
    store.close()
  })

  it('filters attachments and ignores inline images', () => {
    const store = makeStore()
    const account = addGoogleAccount(store)
    seedMessage(store, account, {
      remoteId: 'm1',
      attachments: [{ id: 'a1', filename: 'Offerte.pdf', mimeType: 'application/pdf', size: 100 }]
    })
    seedMessage(store, account, {
      remoteId: 'm2',
      attachments: [
        { id: 'a2', filename: 'signature.png', mimeType: 'image/png', size: 10, inline: true }
      ]
    })

    expect(store.search.query({ text: 'has:attachment' }, NOW)).toHaveLength(1)
    expect(store.search.query({ text: 'filename:pdf' }, NOW)).toHaveLength(1)
    expect(store.search.query({ text: 'filename:png' }, NOW)).toHaveLength(0)
    store.close()
  })

  it('cuts by date, ISO and Swiss notation alike', () => {
    const store = makeStore()
    const account = addGoogleAccount(store)
    seedMessage(store, account, { remoteId: 'old', date: NOW - 30 * DAY })
    seedMessage(store, account, { remoteId: 'new', date: NOW - 2 * DAY })

    expect(store.search.query({ text: 'newer_than:7d' }, NOW)).toHaveLength(1)
    expect(store.search.query({ text: 'older_than:7d' }, NOW)).toHaveLength(1)
    expect(store.search.query({ text: 'after:2026-08-01' }, NOW)).toHaveLength(1)
    expect(store.search.query({ text: 'after:1.8.2026' }, NOW)).toHaveLength(1)
    expect(store.search.query({ text: 'before:1.8.2026' }, NOW)).toHaveLength(1)
    store.close()
  })

  it('keeps trash and spam out unless the query opens them', () => {
    const store = makeStore()
    const account = addGoogleAccount(store)
    seedMessage(store, account, { remoteId: 'm1', subject: 'Rechnung', labels: [SYSTEM_LABELS.inbox] })
    seedMessage(store, account, { remoteId: 'm2', subject: 'Rechnung', labels: [SYSTEM_LABELS.trash] })
    seedMessage(store, account, { remoteId: 'm3', subject: 'Rechnung', labels: [SYSTEM_LABELS.spam] })

    expect(store.search.query({ text: 'Rechnung' }, NOW)).toHaveLength(1)
    expect(store.search.query({ text: 'Rechnung in:trash' }, NOW)).toHaveLength(1)
    expect(store.search.query({ text: 'Rechnung in:spam' }, NOW)).toHaveLength(1)
    store.close()
  })

  it('escapes LIKE wildcards in operator values', () => {
    const store = makeStore()
    const account = addGoogleAccount(store)
    seedMessage(store, account, { remoteId: 'm1', subject: '100% Rabatt' })
    seedMessage(store, account, { remoteId: 'm2', subject: 'Kein Rabatt' })

    expect(store.search.query({ text: 'subject:100%' }, NOW)).toHaveLength(1)
    expect(store.search.query({ text: 'subject:%' }, NOW)).toHaveLength(1)
    expect(store.search.query({ text: 'subject:_' }, NOW)).toHaveLength(0)
    store.close()
  })

  it('counts threads, not messages, against the limit', () => {
    const store = makeStore()
    const account = addGoogleAccount(store)
    for (const remoteId of ['t1a', 't1b', 't1c']) {
      seedMessage(store, account, {
        remoteId,
        threadRemoteId: 't1',
        from: { name: null, email: 'hans@example.com' },
        date: NOW - 1000
      })
    }
    seedMessage(store, account, {
      remoteId: 't2',
      from: { name: null, email: 'hans@example.com' },
      date: NOW
    })

    // Three of the four messages share a conversation: a limit of two must
    // still return two rows, not two messages collapsed into one.
    expect(store.search.query({ text: 'from:hans', limit: 2 }, NOW)).toHaveLength(2)
    const results = store.search.query({ text: 'from:hans' }, NOW)
    expect(results).toHaveLength(2)
    // The newest matching message of a conversation is the one worth opening.
    expect(results[0]?.matchedMessageId).toBe(`${account.id}:t2`)
    store.close()
  })

  it('finds quoted phrases as phrases', () => {
    const store = makeStore()
    const account = addGoogleAccount(store)
    seedMessage(store, account, { remoteId: 'm1', subject: 'Rechnung Januar 2026' })
    seedMessage(store, account, { remoteId: 'm2', subject: 'Januar Rechnung 2026' })

    expect(store.search.query({ text: '"Rechnung Januar"' }, NOW)).toHaveLength(1)
    expect(store.search.query({ text: 'Rechnung Januar' }, NOW)).toHaveLength(2)
    store.close()
  })

  it('still honours the sidebar scope handed in with the query', () => {
    const store = makeStore()
    const account = addGoogleAccount(store)
    seedMessage(store, account, { remoteId: 'm1', labels: [SYSTEM_LABELS.inbox, SYSTEM_LABELS.unread] })
    seedMessage(store, account, { remoteId: 'm2', labels: [SYSTEM_LABELS.sent, SYSTEM_LABELS.unread] })

    const sent = labelKey(account.id, SYSTEM_LABELS.sent)
    expect(store.search.query({ text: 'is:unread', labelId: sent }, NOW)).toHaveLength(1)
    store.close()
  })

  it('returns nothing for an empty or wildcard-only query', () => {
    const store = makeStore()
    const account = addGoogleAccount(store)
    seedMessage(store, account, { remoteId: 'm1' })

    expect(store.search.query({ text: '' }, NOW)).toHaveLength(0)
    expect(store.search.query({ text: '   ' }, NOW)).toHaveLength(0)
    expect(store.search.query({ text: 'from:' }, NOW)).toHaveLength(0)
    store.close()
  })
})

describe('message addresses', () => {
  it('indexes every header and keeps the rows in step with the message', () => {
    const store = makeStore()
    const account = addGoogleAccount(store)
    const id = seedMessage(store, account, {
      remoteId: 'm1',
      from: { name: 'Sandra Keller', email: 'S.Keller@Keller-Farben.ch' },
      to: [{ name: null, email: 'kontakt@beispielweb.ch' }],
      cc: [{ name: 'Buchhaltung', email: 'buchhaltung@beispielweb.ch' }]
    })

    const rows = store.db
      .prepare('SELECT kind, email FROM message_addresses WHERE message_id = ? ORDER BY kind, email')
      .all(id) as Array<{ kind: string; email: string }>
    expect(rows).toEqual([
      { kind: 'cc', email: 'buchhaltung@beispielweb.ch' },
      { kind: 'from', email: 's.keller@keller-farben.ch' },
      { kind: 'to', email: 'kontakt@beispielweb.ch' }
    ])

    // A corrected header replaces the rows instead of piling up next to them.
    seedMessage(store, account, {
      remoteId: 'm1',
      from: { name: 'Sandra Keller', email: 'sandra@keller-farben.ch' },
      to: [{ name: null, email: 'kontakt@beispielweb.ch' }]
    })
    expect(
      store.db
        .prepare("SELECT COUNT(*) AS n FROM message_addresses WHERE message_id = ? AND kind = 'from'")
        .get(id)
    ).toEqual({ n: 1 })

    store.messages.remove(id)
    expect(
      store.db.prepare('SELECT COUNT(*) AS n FROM message_addresses WHERE message_id = ?').get(id)
    ).toEqual({ n: 0 })
    store.close()
  })

  it('offers known addresses newest first for autocomplete', () => {
    const store = makeStore()
    const account = addGoogleAccount(store)
    seedMessage(store, account, {
      remoteId: 'm1',
      from: { name: 'Sandra Keller', email: 's.keller@keller-farben.ch' },
      date: NOW - 10 * DAY
    })
    seedMessage(store, account, {
      remoteId: 'm2',
      from: { name: 'Marco Bianchi', email: 'marco@example.com' },
      date: NOW
    })

    const all = store.messages.knownAddresses(['from'], '')
    expect(all.map((address) => address.email)).toEqual([
      'marco@example.com',
      's.keller@keller-farben.ch'
    ])
    expect(store.messages.knownAddresses(['from'], 'keller')).toHaveLength(1)
    // The prefix matches display names too, and its wildcards stay literal.
    expect(store.messages.knownAddresses(['from'], 'Marco')).toHaveLength(1)
    expect(store.messages.knownAddresses(['from'], '%')).toHaveLength(0)
    store.close()
  })

  it('ranks recipients by how often and how recently they were written to', () => {
    // Recency is measured against the clock, so the clock has to stand where
    // the seeded dates were written — otherwise the test expires with time.
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
    onTestFinished(() => {
      vi.useRealTimers()
    })
    const store = makeStore()
    const account = addGoogleAccount(store)
    const partner = { name: 'Marco Bianchi', email: 'marco@example.com' }
    const oldClient = { name: 'Sandra Keller', email: 's.keller@keller-farben.ch' }
    // Three mails to the old client, but none of them from this year.
    for (const [index, offset] of [400, 420, 440].entries()) {
      seedMessage(store, account, {
        remoteId: `old${index}`,
        threadRemoteId: `told${index}`,
        from: { name: null, email: account.email },
        to: [oldClient],
        direction: 'outgoing',
        date: NOW - offset * DAY
      })
    }
    seedMessage(store, account, {
      remoteId: 'new1',
      from: { name: null, email: account.email },
      to: [partner],
      direction: 'outgoing',
      date: NOW - DAY
    })

    const suggested = store.messages.knownAddresses(['from', 'to', 'cc'], '', 8, {
      forRecipients: true
    })
    expect(suggested.map((address) => address.email)).toEqual([
      'marco@example.com',
      's.keller@keller-farben.ch'
    ])
    store.close()
  })

  it('keeps own addresses and no-reply mailboxes out of recipient suggestions', () => {
    const store = makeStore()
    const account = addGoogleAccount(store)
    store.identities.create({
      accountId: account.id,
      name: 'Max',
      email: 'rechnung@example.com',
      isDefault: false,
      signatureHtml: null,
      source: 'user'
    })
    seedMessage(store, account, {
      remoteId: 'm1',
      from: { name: 'Shop', email: 'no-reply@shop.example' },
      to: [{ name: null, email: account.email }, { name: null, email: 'rechnung@example.com' }],
      cc: [{ name: 'Sandra Keller', email: 's.keller@keller-farben.ch' }],
      date: NOW
    })

    const suggested = store.messages.knownAddresses(['from', 'to', 'cc'], '', 8, {
      forRecipients: true
    })
    expect(suggested.map((address) => address.email)).toEqual(['s.keller@keller-farben.ch'])
    // The search box still completes both — there they are legitimate targets.
    expect(store.messages.knownAddresses(['from'], 'no-reply')).toHaveLength(1)
    store.close()
  })

  it('backfills the table for databases that predate it', () => {
    const store = makeStore()
    const account = addGoogleAccount(store)
    const id = seedMessage(store, account, {
      remoteId: 'm1',
      from: { name: 'Sandra', email: 'sandra@example.com' },
      to: [{ name: null, email: 'kontakt@beispielweb.ch' }]
    })

    // Simulate the pre-migration state and replay migration 3 over it.
    store.db.exec('DELETE FROM message_addresses')
    store.db.exec("DELETE FROM schema_migrations WHERE id = 3")
    store.db.exec('DROP TABLE message_addresses')
    migrate(store.db)

    const rows = store.db
      .prepare('SELECT kind, email FROM message_addresses WHERE message_id = ? ORDER BY kind')
      .all(id) as Array<{ kind: string; email: string }>
    expect(rows).toEqual([
      { kind: 'from', email: 'sandra@example.com' },
      { kind: 'to', email: 'kontakt@beispielweb.ch' }
    ])
    store.close()
  })
})
