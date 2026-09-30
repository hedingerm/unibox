import { describe, expect, it } from 'vitest'
import { threadKey } from '@main/db/ids'
import { addGoogleAccount, makeStore, seedMessage } from '../helpers/store'

const STRANGER = { name: null, email: 'news@fremde-firma.ch' }

describe('remote image trust', () => {
  it('asks for a sender the user never wrote to', () => {
    const store = makeStore()
    const account = addGoogleAccount(store)
    seedMessage(store, account, { remoteId: 'm1', from: STRANGER })
    expect(store.remoteImages.allowsSender(STRANGER.email)).toBe(false)
    expect(
      store.messages.threadDetail(threadKey(account.id, 'm1'))?.messages[0]?.remoteImages
    ).toBe('ask')
    store.close()
  })

  it('allows a sender the user has written to', () => {
    const store = makeStore()
    const account = addGoogleAccount(store)
    seedMessage(store, account, {
      remoteId: 'sent',
      direction: 'outgoing',
      from: { name: null, email: account.email },
      to: [STRANGER]
    })
    seedMessage(store, account, { remoteId: 'm1', from: STRANGER })
    expect(store.remoteImages.allowsSender(STRANGER.email)).toBe(true)
    store.close()
  })

  it('extends trust to the domain, but never to a free mail host', () => {
    const store = makeStore()
    const account = addGoogleAccount(store)
    seedMessage(store, account, {
      remoteId: 'sent',
      direction: 'outgoing',
      from: { name: null, email: account.email },
      to: [
        { name: null, email: 'kontakt@fremde-firma.ch' },
        { name: null, email: 'privat@gmail.com' }
      ]
    })
    expect(store.remoteImages.allowsSender('rechnung@fremde-firma.ch')).toBe(true)
    expect(store.remoteImages.allowsSender('jemand-anders@gmail.com')).toBe(false)
    expect(store.remoteImages.allowsSender('privat@gmail.com')).toBe(true)
    store.close()
  })

  it('allows every sender of a thread the user has answered in', () => {
    const store = makeStore()
    const account = addGoogleAccount(store)
    seedMessage(store, account, { remoteId: 'm1', threadRemoteId: 't', from: STRANGER })
    seedMessage(store, account, {
      remoteId: 'm2',
      threadRemoteId: 't',
      direction: 'outgoing',
      from: { name: null, email: account.email },
      to: [{ name: null, email: 'jemand@dritte-firma.ch' }]
    })
    const detail = store.messages.threadDetail(threadKey(account.id, 't'))
    expect(detail?.messages.map((message) => message.remoteImages)).toEqual(['allow', 'allow'])
    store.close()
  })

  it('remembers an explicit allow for a sender and gives it back', () => {
    const store = makeStore()
    const account = addGoogleAccount(store)
    seedMessage(store, account, { remoteId: 'm1', from: STRANGER })

    store.remoteImages.trust('sender', 'News@Fremde-Firma.CH')
    expect(store.remoteImages.allowsSender(STRANGER.email)).toBe(true)
    expect(store.remoteImages.list()).toEqual([
      { kind: 'sender', value: STRANGER.email, createdAt: expect.any(Number) }
    ])

    store.remoteImages.revoke('sender', STRANGER.email)
    expect(store.remoteImages.allowsSender(STRANGER.email)).toBe(false)
    store.close()
  })

  it('takes a whole domain, with or without the leading at sign', () => {
    const store = makeStore()
    addGoogleAccount(store)
    store.remoteImages.trust('domain', '@Fremde-Firma.ch')
    expect(store.remoteImages.list()[0]?.value).toBe('fremde-firma.ch')
    expect(store.remoteImages.allowsSender('irgendwer@fremde-firma.ch')).toBe(true)
    store.close()
  })

  it('trusts the user their own mail', () => {
    const store = makeStore()
    const account = addGoogleAccount(store, 'max@muster-it.ch')
    expect(store.remoteImages.allowsSender('max@muster-it.ch')).toBe(true)
    expect(store.remoteImages.allowsSender('buchhaltung@muster-it.ch')).toBe(true)
    expect(account.email).toBe('max@muster-it.ch')
    store.close()
  })
})
