import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { migrations } from '@main/db/migrations'
import { IdentityService } from '@main/identities'
import { addGoogleAccount, addResendAccount, makeStore } from '../helpers/store'

describe('signature library', () => {
  it('signs several addresses with one entry, edited in one place', () => {
    const store = makeStore()
    const account = addResendAccount(store, 'beispielweb.ch')
    const footer = store.signatures.create({ name: 'Beispielweb', html: '<p>Beispielweb GmbH</p>' })
    const service = new IdentityService(store)

    for (const email of ['kontakt@beispielweb.ch', 'offerte@beispielweb.ch']) {
      service.create({
        accountId: account.id,
        name: 'Beispielweb',
        email,
        signatureId: footer.id,
        isDefault: false
      })
    }
    expect(store.signatures.get(footer.id)?.usedBy).toBe(2)

    store.signatures.update(footer.id, { html: '<p>Beispielweb GmbH, Zürich</p>' })
    expect(service.listForAccount(account.id).map((i) => i.signatureHtml)).toEqual([
      '<p>Beispielweb GmbH, Zürich</p>',
      '<p>Beispielweb GmbH, Zürich</p>'
    ])
    store.close()
  })

  it('leaves the addresses without one when an entry is deleted', () => {
    const store = makeStore()
    const account = addResendAccount(store, 'beispielweb.ch')
    const footer = store.signatures.create({ name: 'Beispielweb', html: '<p>Beispielweb GmbH</p>' })
    const identity = new IdentityService(store).create({
      accountId: account.id,
      name: 'Beispielweb',
      email: 'kontakt@beispielweb.ch',
      signatureId: footer.id,
      isDefault: true
    })

    store.signatures.remove(footer.id)
    const after = store.identities.get(identity.id)!
    expect(after.signatureId).toBeNull()
    expect(after.signatureHtml).toBeNull()
    store.close()
  })

  it('keeps one entry when two Gmail aliases carry the same text', () => {
    const store = makeStore()
    const account = addGoogleAccount(store, 'max@muster-it.ch')
    store.identities.replaceGmailIdentities(account.id, [
      {
        accountId: account.id,
        name: 'Max Muster',
        email: 'max@muster-it.ch',
        signatureHtml: '<p>Muster IT</p>',
        isDefault: true,
        verified: true
      },
      {
        accountId: account.id,
        name: 'Muster IT',
        email: 'kontakt@muster-it.ch',
        signatureHtml: '<p>Muster IT</p>',
        isDefault: false,
        verified: true
      }
    ])
    expect(store.signatures.list()).toHaveLength(1)
    expect(store.signatures.list()[0]!.usedBy).toBe(2)
    store.close()
  })

  it('moves one alias to its own entry when Gmail changes only that one', () => {
    const store = makeStore()
    const account = addGoogleAccount(store, 'max@muster-it.ch')
    const shared = [
      {
        accountId: account.id,
        name: 'Max Muster',
        email: 'max@muster-it.ch',
        signatureHtml: '<p>Muster IT</p>',
        isDefault: true,
        verified: true
      },
      {
        accountId: account.id,
        name: 'Muster IT',
        email: 'kontakt@muster-it.ch',
        signatureHtml: '<p>Muster IT</p>',
        isDefault: false,
        verified: true
      }
    ]
    store.identities.replaceGmailIdentities(account.id, shared)
    store.identities.replaceGmailIdentities(account.id, [
      { ...shared[0]!, signatureHtml: '<p>Max Muster, Inhaber</p>' },
      shared[1]!
    ])

    const byEmail = new Map(store.identities.list().map((i) => [i.email, i]))
    expect(byEmail.get('max@muster-it.ch')?.signatureHtml).toBe(
      '<p>Max Muster, Inhaber</p>'
    )
    expect(byEmail.get('kontakt@muster-it.ch')?.signatureHtml).toBe(
      '<p>Muster IT</p>'
    )
    expect(store.signatures.list()).toHaveLength(2)
    store.close()
  })

  it('keeps a locally edited signature across the next sync', () => {
    const store = makeStore()
    const account = addGoogleAccount(store, 'max@muster-it.ch')
    const imported = [
      {
        accountId: account.id,
        name: 'Max Muster',
        email: 'max@muster-it.ch',
        signatureHtml: '<p>Aus Gmail</p>',
        isDefault: true,
        verified: true
      }
    ]
    store.identities.replaceGmailIdentities(account.id, imported)
    const identity = store.identities.list()[0]!
    store.signatures.update(identity.signatureId!, { html: '<p>Hier bearbeitet</p>' })

    store.identities.replaceGmailIdentities(account.id, imported)
    expect(store.identities.get(identity.id)?.signatureHtml).toBe('<p>Hier bearbeitet</p>')
    store.close()
  })
})

describe('signature migration', () => {
  it('folds the per-address texts into one library, identical ones shared', () => {
    const db = new Database(':memory:')
    for (const migration of migrations.filter((entry) => entry.id < 10)) migration.up(db)
    db.prepare(
      `INSERT INTO accounts (id, kind, email, display_name, color, created_at)
       VALUES ('acc', 'resend', 'beispielweb.ch', 'Beispielweb', '#000', 0)`
    ).run()
    const insert = db.prepare(
      `INSERT INTO identities (id, account_id, name, email, signature_html, is_default, source)
       VALUES (?, 'acc', ?, ?, ?, 0, 'user')`
    )
    insert.run('i1', 'A', 'a@beispielweb.ch', '<p>Gleich</p>')
    insert.run('i2', 'B', 'b@beispielweb.ch', '<p>Gleich</p>')
    insert.run('i3', 'C', 'c@beispielweb.ch', '<p>Anders</p>')
    insert.run('i4', 'D', 'd@beispielweb.ch', null)

    migrations.find((entry) => entry.id === 10)!.up(db)

    const rows = db
      .prepare(
        `SELECT i.id, s.html FROM identities i
         LEFT JOIN signatures s ON s.id = i.signature_id ORDER BY i.id`
      )
      .all() as Array<{ id: string; html: string | null }>
    expect(rows).toEqual([
      { id: 'i1', html: '<p>Gleich</p>' },
      { id: 'i2', html: '<p>Gleich</p>' },
      { id: 'i3', html: '<p>Anders</p>' },
      { id: 'i4', html: null }
    ])
    expect(db.prepare('SELECT count(*) AS n FROM signatures').get()).toEqual({ n: 2 })
    // The address the text came from is the only name there is to give it.
    expect(
      db.prepare('SELECT name FROM signatures ORDER BY name').all()
    ).toEqual([{ name: 'a@beispielweb.ch' }, { name: 'c@beispielweb.ch' }])
    db.close()
  })
})
