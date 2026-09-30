import type { Identity } from '@shared/types'
import type { Store } from './db/store'

export class IdentityService {
  constructor(private readonly store: Store) {}

  list(): Identity[] {
    return this.store.identities.list()
  }

  listForAccount(accountId: string): Identity[] {
    return this.store.identities.listForAccount(accountId)
  }

  create(input: Omit<Identity, 'id' | 'source' | 'verified' | 'signatureHtml'>): Identity {
    const account = this.store.accounts.get(input.accountId)
    if (!account) throw new Error('Unbekanntes Konto')
    if (account.kind === 'google') {
      throw new Error('Gmail-Identitäten werden aus dem Konto übernommen und lassen sich nicht anlegen.')
    }
    const domain = input.email.split('@')[1]?.toLowerCase()
    if (domain !== account.email.toLowerCase()) {
      throw new Error(`Die Adresse muss zur Domain ${account.email} gehören.`)
    }
    return this.store.identities.create({ ...input, source: 'user' })
  }

  update(id: string, patch: Partial<Omit<Identity, 'id' | 'signatureHtml'>>): Identity {
    const existing = this.store.identities.get(id)
    if (!existing) throw new Error('Unbekannte Identität')
    if (existing.source === 'gmail_sendas') {
      // Gmail owns name and address; only local preferences may change.
      const allowed: Partial<Omit<Identity, 'id' | 'signatureHtml'>> = {}
      if (patch.isDefault !== undefined) allowed.isDefault = patch.isDefault
      if (patch.signatureId !== undefined) allowed.signatureId = patch.signatureId
      return this.store.identities.update(id, allowed)
    }
    return this.store.identities.update(id, patch)
  }

  remove(id: string): void {
    const existing = this.store.identities.get(id)
    if (!existing) return
    if (existing.source === 'gmail_sendas') {
      throw new Error('Gmail-Identitäten lassen sich hier nicht entfernen.')
    }
    this.store.identities.remove(id)
  }

  /** Only a verified address can be sent from, so only one may be picked. */
  private sendable(accountId: string): Identity[] {
    return this.store.identities.listForAccount(accountId).filter((i) => i.verified)
  }

  defaultFor(accountId: string): Identity | null {
    const identities = this.sendable(accountId)
    return identities.find((i) => i.isDefault) ?? identities[0] ?? null
  }

  /**
   * Picks the sender for a reply: the address the original message was actually
   * delivered to, so a mail to an alias is answered from that alias.
   */
  forReply(messageId: string): Identity | null {
    const message = this.store.messages.get(messageId)
    if (!message) return null
    const account = this.store.accounts.get(message.accountId)
    if (!account) return null
    const identities = this.sendable(account.id)

    const candidates =
      message.direction === 'outgoing'
        ? [message.from.email]
        : [...message.to, ...message.cc, ...message.bcc].map((a) => a.email)

    const byEmail = new Map(identities.map((i) => [i.email.toLowerCase(), i]))
    for (const candidate of candidates) {
      const match = byEmail.get(candidate.toLowerCase())
      if (match) return match
    }

    if (account.kind === 'resend') {
      // A mail to a mailbox (or one of its aliases) is answered as the
      // identity the mailbox is linked to, when it has one.
      for (const candidate of candidates) {
        const mailbox = this.store.mailboxes.findByAddress(candidate)
        if (!mailbox?.identityId || mailbox.accountId !== account.id) continue
        const linked = identities.find((identity) => identity.id === mailbox.identityId)
        if (linked) return linked
      }
      // Any address of the domain is a valid sender, even without a saved identity.
      const own = candidates.find(
        (address) => address.split('@')[1]?.toLowerCase() === account.email.toLowerCase()
      )
      if (own) {
        const fallback = this.defaultFor(account.id)
        return {
          id: `custom:${own.toLowerCase()}`,
          accountId: account.id,
          name: fallback?.name ?? account.displayName,
          email: own,
          signatureId: fallback?.signatureId ?? null,
          signatureHtml: fallback?.signatureHtml ?? null,
          isDefault: false,
          source: 'user',
          verified: true
        }
      }
    }

    if (account.kind === 'google') {
      const primary = byEmail.get(account.email.toLowerCase())
      if (primary) return primary
    }
    return this.defaultFor(account.id)
  }
}
