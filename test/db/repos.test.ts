import { describe, expect, it } from 'vitest'
import { SYSTEM_LABELS } from '@shared/types'
import { labelKey } from '@main/db/ids'
import { migrate } from '@main/db/migrations'
import { DEFAULT_SETTINGS } from '@main/db/repos/settings'
import { addGoogleAccount, addResendAccount, makeStore, seedMessage } from '../helpers/store'

describe('migrations', () => {
  it('is idempotent', () => {
    const store = makeStore()
    expect(migrate(store.db)).toBe(0)
    const tables = (
      store.db
        .prepare(`SELECT name FROM sqlite_master WHERE type IN ('table','view')`)
        .all() as Array<{ name: string }>
    ).map((r) => r.name)
    for (const table of ['accounts', 'messages', 'bodies', 'messages_fts', 'outbox', 'mutation_queue']) {
      expect(tables).toContain(table)
    }
    store.close()
  })
})

describe('account repo', () => {
  it('assigns distinct badge colours and upserts by e-mail', () => {
    const store = makeStore()
    const a = addGoogleAccount(store, 'a@example.com')
    const b = addGoogleAccount(store, 'b@example.com')
    expect(a.color).not.toBe(b.color)
    const again = store.accounts.upsert({ kind: 'google', email: 'a@example.com', displayName: 'A' })
    expect(again.id).toBe(a.id)
    expect(store.accounts.list()).toHaveLength(2)
    store.close()
  })
})

describe('label repo', () => {
  it('mirrors Gmail hierarchy from slash-separated names', () => {
    const store = makeStore()
    const account = addGoogleAccount(store)
    store.labels.replaceAll(account.id, [
      { remoteId: 'INBOX', name: 'INBOX', type: 'system' },
      { remoteId: 'Label_1', name: 'Kunden', type: 'user' },
      { remoteId: 'Label_2', name: 'Kunden/Aktiv', type: 'user' }
    ])
    const labels = store.labels.list(account.id)
    const child = labels.find((l) => l.name === 'Kunden/Aktiv')
    expect(child?.parentId).toBe(labelKey(account.id, 'Label_1'))
    expect(labels.find((l) => l.name === 'Kunden')?.parentId).toBeNull()
    store.close()
  })

  it('keeps labels bound to their account', () => {
    const store = makeStore()
    const a = addGoogleAccount(store, 'a@example.com')
    const b = addGoogleAccount(store, 'b@example.com')
    store.labels.replaceAll(a.id, [{ remoteId: 'L1', name: 'Kunden', type: 'user' }])
    store.labels.replaceAll(b.id, [{ remoteId: 'L9', name: 'Kunden', type: 'user' }])
    const aLabel = store.labels.get(a.id, 'L1')!
    const bLabel = store.labels.get(b.id, 'L9')!
    expect(aLabel.id).not.toBe(bLabel.id)
    expect(store.labels.list(a.id).map((l) => l.id)).not.toContain(bLabel.id)
    store.close()
  })

  it('counts unread per label without counting trash', () => {
    const store = makeStore()
    const account = addGoogleAccount(store)
    seedMessage(store, account, { remoteId: 'm1' })
    seedMessage(store, account, { remoteId: 'm2', labels: [SYSTEM_LABELS.inbox] })
    seedMessage(store, account, {
      remoteId: 'm3',
      labels: [SYSTEM_LABELS.inbox, SYSTEM_LABELS.unread, SYSTEM_LABELS.trash]
    })
    const inbox = store.labels.listWithCounts(account.id).find((l) => l.remoteId === 'INBOX')!
    expect(inbox.total).toBe(3)
    expect(inbox.unread).toBe(1)
    store.close()
  })
})

describe('message repo', () => {
  it('stores bodies and reads them back offline', () => {
    const store = makeStore()
    const account = addGoogleAccount(store)
    const id = seedMessage(store, account, {
      remoteId: 'm1',
      body: { html: '<p>Angebot folgt</p>', text: null }
    })
    expect(store.messages.body(id).html).toContain('Angebot folgt')
    expect(store.messages.get(id)?.snippet).toContain('Angebot folgt')
    store.close()
  })

  it('lists merged inbox threads newest first across accounts', () => {
    const store = makeStore()
    const google = addGoogleAccount(store)
    const resend = addResendAccount(store)
    seedMessage(store, google, { remoteId: 'g1', date: 1000 })
    seedMessage(store, resend, { remoteId: 'r1', date: 3000 })
    seedMessage(store, google, { remoteId: 'g2', date: 2000 })
    const ids = store.messages.listThreadIds({ labelRemoteId: SYSTEM_LABELS.inbox })
    const summaries = store.messages.threadSummaries(ids)
    expect(summaries.map((s) => s.lastMessageAt)).toEqual([3000, 2000, 1000])
    expect(new Set(summaries.map((s) => s.accountId))).toEqual(new Set([google.id, resend.id]))
    store.close()
  })

  it('sorts a label by the thread\'s last message, not the last one in that label', () => {
    const store = makeStore()
    const account = addGoogleAccount(store)
    store.labels.replaceAll(account.id, [
      { remoteId: SYSTEM_LABELS.inbox, name: 'INBOX', type: 'system' },
      { remoteId: 'Label_1', name: '@Erledigt', type: 'user' }
    ])
    // Archived in July, answered today: the row shows today's date, so it has
    // to sit where today's date belongs.
    seedMessage(store, account, {
      remoteId: 'old',
      threadRemoteId: 'answered',
      date: 1000,
      labels: ['Label_1']
    })
    seedMessage(store, account, {
      remoteId: 'reply',
      threadRemoteId: 'answered',
      date: 5000,
      labels: [SYSTEM_LABELS.inbox]
    })
    seedMessage(store, account, { remoteId: 'other', date: 3000, labels: ['Label_1'] })

    const ids = store.messages.listThreadIds({ labelId: labelKey(account.id, 'Label_1') })
    const summaries = store.messages.threadSummaries(ids)
    expect(summaries.map((s) => s.lastMessageAt)).toEqual([5000, 3000])
    store.close()
  })

  it('excludes trashed and spam messages from the inbox but shows them in their folder', () => {
    const store = makeStore()
    const account = addGoogleAccount(store)
    seedMessage(store, account, { remoteId: 'ok' })
    seedMessage(store, account, {
      remoteId: 'gone',
      labels: [SYSTEM_LABELS.inbox, SYSTEM_LABELS.trash]
    })
    const inbox = store.messages.listThreadIds({ labelRemoteId: SYSTEM_LABELS.inbox })
    expect(inbox).toHaveLength(1)
    const trash = store.messages.listThreadIds({ labelRemoteId: SYSTEM_LABELS.trash })
    expect(trash).toHaveLength(1)
    store.close()
  })

  it('groups messages of a thread and reports unread state', () => {
    const store = makeStore()
    const account = addGoogleAccount(store)
    seedMessage(store, account, {
      remoteId: 'a',
      threadRemoteId: 't1',
      date: 10,
      labels: [SYSTEM_LABELS.inbox]
    })
    seedMessage(store, account, {
      remoteId: 'b',
      threadRemoteId: 't1',
      date: 20,
      labels: [SYSTEM_LABELS.inbox, SYSTEM_LABELS.unread]
    })
    const ids = store.messages.listThreadIds({ labelRemoteId: SYSTEM_LABELS.inbox })
    expect(ids).toHaveLength(1)
    const summary = store.messages.threadSummary(ids[0]!)!
    expect(summary.messageCount).toBe(2)
    expect(summary.unread).toBe(true)
    expect(store.messages.threadDetail(ids[0]!)?.messages).toHaveLength(2)
    store.close()
  })
})

describe('full text search', () => {
  it('finds messages across all accounts and filters by account and label', () => {
    const store = makeStore()
    const google = addGoogleAccount(store)
    const resend = addResendAccount(store)
    seedMessage(store, google, {
      remoteId: 'g1',
      subject: 'Offerte Onlineshop',
      body: { html: null, text: 'Wir brauchen einen Kostenvoranschlag' }
    })
    seedMessage(store, resend, {
      remoteId: 'r1',
      subject: 'Website-Relaunch',
      body: { html: '<p>Kostenvoranschlag für den Relaunch</p>', text: null }
    })

    expect(store.search.query({ text: 'Kostenvoranschlag' })).toHaveLength(2)
    expect(store.search.query({ text: 'Kostenvoranschlag', accountId: resend.id })).toHaveLength(1)
    expect(store.search.query({ text: 'Onlineshop' })[0]?.accountId).toBe(google.id)

    const inboxLabel = labelKey(google.id, SYSTEM_LABELS.inbox)
    expect(
      store.search.query({ text: 'Kostenvoranschlag', labelId: inboxLabel })
    ).toHaveLength(1)
    store.close()
  })

  it('treats FTS operators in user input as literal text', () => {
    const store = makeStore()
    const account = addGoogleAccount(store)
    seedMessage(store, account, { remoteId: 'm1', subject: 'Rechnung AND Mahnung' })
    expect(() => store.search.query({ text: 'Rechnung OR' })).not.toThrow()
    expect(store.search.query({ text: 'Rechnung' })).toHaveLength(1)
    store.close()
  })

  it('drops deleted messages from the index', () => {
    const store = makeStore()
    const account = addGoogleAccount(store)
    const id = seedMessage(store, account, { remoteId: 'm1', subject: 'Einzigartig' })
    store.messages.remove(id)
    expect(store.search.query({ text: 'Einzigartig' })).toHaveLength(0)
    store.close()
  })
})

describe('resend local states', () => {
  it('keeps archive, trash and read purely local', () => {
    const store = makeStore()
    const account = addResendAccount(store)
    const id = seedMessage(store, account, { remoteId: 'r1' })
    const inbox = labelKey(account.id, SYSTEM_LABELS.inbox)
    const unread = labelKey(account.id, SYSTEM_LABELS.unread)
    const trash = labelKey(account.id, SYSTEM_LABELS.trash)

    store.messages.removeLabels([id], [unread])
    expect(store.messages.labelIdsOf(id)).not.toContain(unread)

    store.messages.removeLabels([id], [inbox])
    expect(store.messages.listThreadIds({ labelRemoteId: SYSTEM_LABELS.inbox })).toHaveLength(0)

    store.messages.addLabels([id], [trash])
    expect(store.messages.listThreadIds({ labelRemoteId: SYSTEM_LABELS.trash })).toHaveLength(1)
    expect(store.queue.list()).toHaveLength(0)
    store.close()
  })
})

describe('settings repo', () => {
  it('polls at most every two minutes by default', () => {
    expect(DEFAULT_SETTINGS.pollIntervalSeconds).toBeLessThanOrEqual(120)
  })

  it('round-trips partial patches on top of defaults', () => {
    const store = makeStore()
    expect(store.settings.get().undoSendSeconds).toBe(10)
    store.settings.set({ undoSendSeconds: 30 })
    expect(store.settings.get().undoSendSeconds).toBe(30)
    expect(store.settings.get().notificationsEnabled).toBe(true)
    store.close()
  })
})
