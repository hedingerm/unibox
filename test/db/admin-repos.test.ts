import { describe, expect, it } from 'vitest'
import { ActivityRepo } from '@main/db/repos/activity'
import { addResendAccount, makeStore } from '../helpers/store'

describe('admin tables', () => {
  it('are created by the migration', () => {
    const store = makeStore()
    const tables = (
      store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
        name: string
      }>
    ).map((row) => row.name)
    expect(tables).toEqual(
      expect.arrayContaining([
        'mailboxes',
        'mailbox_aliases',
        'routing_rules',
        'deliveries',
        'activity_log',
        'message_tombstones'
      ])
    )
    store.close()
  })

  it('removes mailboxes and rules together with their domain', () => {
    const store = makeStore()
    const account = addResendAccount(store)
    store.mailboxes.create({
      accountId: account.id,
      address: 'info@beispielweb.ch',
      displayName: 'Info',
      aliases: ['hallo@beispielweb.ch'],
      identityId: null
    })
    store.rules.create({
      accountId: account.id,
      name: 'R',
      enabled: true,
      matchField: 'any',
      operator: 'contains',
      value: 'x',
      action: 'archive',
      actionArg: null,
      stopProcessing: true
    })
    store.accounts.remove(account.id)
    expect(store.mailboxes.count()).toBe(0)
    expect(store.mailboxes.findByAddress('hallo@beispielweb.ch')).toBeNull()
    expect(store.rules.list()).toHaveLength(0)
    store.close()
  })
})

describe('activity retention', () => {
  it('keeps only the newest entries', () => {
    const store = makeStore()
    const repo = new ActivityRepo(store.db, 10)
    for (let index = 0; index < 25; index += 1) {
      repo.record({ kind: 'mail_sent', summary: `M${index}` })
    }
    repo.prune()
    const page = repo.list({ limit: 100 })
    expect(page.entries).toHaveLength(10)
    expect(page.entries[0]?.summary).toBe('M24')
    expect(page.entries.at(-1)?.summary).toBe('M15')
    store.close()
  })

  it('folds only identical consecutive entries of one account', () => {
    const store = makeStore()
    store.activity.record({ kind: 'sync_error', accountId: 'a', summary: 'Offline', dedupe: true })
    store.activity.record({ kind: 'sync_error', accountId: 'b', summary: 'Offline', dedupe: true })
    store.activity.record({ kind: 'sync_error', accountId: 'a', summary: 'Offline', dedupe: true })
    store.activity.record({ kind: 'sync_error', accountId: 'a', summary: '401', dedupe: true })
    const entries = store.activity.list({ kind: 'sync_error' }).entries
    expect(entries.map((e) => [e.accountId, e.summary, e.count])).toEqual([
      ['a', '401', 1],
      ['b', 'Offline', 1],
      ['a', 'Offline', 2]
    ])
    store.close()
  })
})
