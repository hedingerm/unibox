import { describe, expect, it } from 'vitest'
import { IdentityService } from '@main/identities'
import { addGoogleAccount, addResendAccount, makeStore, seedMessage } from '../helpers/store'

describe('identity management', () => {
  it('creates Resend identities with name, signature and default flag', () => {
    const store = makeStore()
    const account = addResendAccount(store, 'beispielweb.ch')
    const service = new IdentityService(store)

    const greeting = store.signatures.create({ name: 'Kurz', html: '<p>Freundliche Grüsse</p>' })
    const identity = service.create({
      accountId: account.id,
      name: 'Max Muster',
      email: 'kontakt@beispielweb.ch',
      signatureId: greeting.id,
      isDefault: true
    })
    expect(identity.isDefault).toBe(true)
    expect(identity.signatureHtml).toContain('Grüsse')

    const second = service.create({
      accountId: account.id,
      name: 'Beispielweb',
      email: 'hallo@beispielweb.ch',
      signatureId: null,
      isDefault: true
    })
    expect(service.listForAccount(account.id).filter((i) => i.isDefault)).toHaveLength(1)
    expect(service.defaultFor(account.id)?.id).toBe(second.id)
    store.close()
  })

  it('rejects addresses outside the domain', () => {
    const store = makeStore()
    const account = addResendAccount(store, 'beispielweb.ch')
    const service = new IdentityService(store)
    expect(() =>
      service.create({
        accountId: account.id,
        name: 'X',
        email: 'jemand@fremd.ch',
        signatureId: null,
        isDefault: false
      })
    ).toThrow(/beispielweb\.ch/)
    store.close()
  })

  it('treats Gmail identities as read-only apart from local preferences', () => {
    const store = makeStore()
    const account = addGoogleAccount(store, 'max@muster-it.ch')
    store.identities.create({
      accountId: account.id,
      name: 'Max Muster',
      email: 'max@muster-it.ch',
      source: 'gmail_sendas'
    })
    const service = new IdentityService(store)
    const identity = service.listForAccount(account.id)[0]!

    expect(() =>
      service.create({
        accountId: account.id,
        name: 'X',
        email: 'x@muster-it.ch',
        signatureId: null,
        isDefault: false
      })
    ).toThrow()
    expect(() => service.remove(identity.id)).toThrow()

    const own = store.signatures.create({ name: 'Eigene', html: '<p>S</p>' })
    const updated = service.update(identity.id, { name: 'Gefälscht', signatureId: own.id })
    expect(updated.name).toBe('Max Muster')
    expect(updated.signatureHtml).toBe('<p>S</p>')
    store.close()
  })
})

describe('unverified identities', () => {
  it('are never picked as the sender', () => {
    const store = makeStore()
    const account = addGoogleAccount(store, 'max@muster-it.ch')
    store.identities.create({
      accountId: account.id,
      name: 'Max Muster',
      email: 'max@muster-it.ch',
      isDefault: true,
      source: 'gmail_sendas'
    })
    const pending = store.identities.create({
      accountId: account.id,
      name: 'Bald',
      email: 'pending@muster-it.ch',
      signatureHtml: '<p>Bald</p>',
      source: 'gmail_sendas',
      verified: false
    })
    const id = seedMessage(store, account, {
      remoteId: 'm1',
      to: [{ name: null, email: 'pending@muster-it.ch' }]
    })

    const service = new IdentityService(store)
    expect(service.listForAccount(account.id)).toHaveLength(2)
    expect(service.defaultFor(account.id)?.email).toBe('max@muster-it.ch')
    expect(service.forReply(id)?.email).toBe('max@muster-it.ch')
    expect(store.identities.get(pending.id)?.signatureHtml).toBe('<p>Bald</p>')
    store.close()
  })
})

describe('reply identity', () => {
  it('answers from the Gmail alias the mail was addressed to', () => {
    const store = makeStore()
    const account = addGoogleAccount(store, 'max@muster-it.ch')
    store.identities.create({
      accountId: account.id,
      name: 'Max Muster',
      email: 'max@muster-it.ch',
      isDefault: true,
      source: 'gmail_sendas'
    })
    store.identities.create({
      accountId: account.id,
      name: 'Muster IT',
      email: 'kontakt@muster-it.ch',
      source: 'gmail_sendas'
    })
    const id = seedMessage(store, account, {
      remoteId: 'm1',
      to: [{ name: null, email: 'kontakt@muster-it.ch' }]
    })
    expect(new IdentityService(store).forReply(id)?.email).toBe('kontakt@muster-it.ch')
    store.close()
  })

  it('falls back to the account default when no alias matches', () => {
    const store = makeStore()
    const account = addGoogleAccount(store, 'max@muster-it.ch')
    store.identities.create({
      accountId: account.id,
      name: 'Max Muster',
      email: 'max@muster-it.ch',
      isDefault: true,
      source: 'gmail_sendas'
    })
    const id = seedMessage(store, account, {
      remoteId: 'm1',
      to: [{ name: null, email: 'liste@example.org' }]
    })
    expect(new IdentityService(store).forReply(id)?.email).toBe('max@muster-it.ch')
    store.close()
  })

  it('answers Resend mail from the exact address it was sent to', () => {
    const store = makeStore()
    const account = addResendAccount(store, 'beispielweb.ch')
    store.identities.create({
      accountId: account.id,
      name: 'Max Muster',
      email: 'kontakt@beispielweb.ch',
      isDefault: true
    })
    const id = seedMessage(store, account, {
      remoteId: 'r1',
      to: [{ name: null, email: 'offerte@beispielweb.ch' }]
    })
    const identity = new IdentityService(store).forReply(id)!
    expect(identity.email).toBe('offerte@beispielweb.ch')
    expect(identity.name).toBe('Max Muster')
    store.close()
  })
})
