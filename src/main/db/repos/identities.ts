import type { Identity } from '@shared/types'
import type { Db } from '../index'
import { newId } from '../ids'
import type { SignatureRepo } from './signatures'

interface IdentityRow {
  id: string
  account_id: string
  name: string
  email: string
  signature_id: string | null
  signature_html: string | null
  gmail_signature_html: string | null
  is_default: number
  source: 'gmail_sendas' | 'user'
  verified: number
}

function toIdentity(row: IdentityRow): Identity {
  return {
    id: row.id,
    accountId: row.account_id,
    name: row.name,
    email: row.email,
    signatureId: row.signature_id,
    signatureHtml: row.signature_html,
    isDefault: row.is_default === 1,
    source: row.source,
    verified: row.verified === 1
  }
}

/** An empty signature and no signature are the same thing when comparing. */
function normalizeSignature(value: string | null | undefined): string | null {
  return value && value.trim() ? value : null
}

export interface IdentityInput {
  accountId: string
  name: string
  email: string
  /** Points the identity at this library entry. */
  signatureId?: string | null
  /**
   * Convenience for callers that hold a text rather than an id: links the entry
   * holding it, creating one if the library has none. `signatureId` wins.
   */
  signatureHtml?: string | null
  isDefault?: boolean
  source?: 'gmail_sendas' | 'user'
  verified?: boolean
}

/** One entry of Gmail's sendAs list, as the sync hands it over. */
export interface GmailIdentityInput {
  accountId: string
  name: string
  email: string
  signatureHtml: string | null
  isDefault: boolean
  verified: boolean
}

export class IdentityRepo {
  constructor(
    private readonly db: Db,
    private readonly signatures: SignatureRepo
  ) {}

  // The composer wants the text, not the pointer, so every read resolves it.
  private static readonly SELECT = `
    SELECT i.*, s.html AS signature_html
      FROM identities i
      LEFT JOIN signatures s ON s.id = i.signature_id`

  list(): Identity[] {
    const rows = this.db
      .prepare(`${IdentityRepo.SELECT} ORDER BY i.account_id, i.is_default DESC, i.email`)
      .all() as IdentityRow[]
    return rows.map(toIdentity)
  }

  listForAccount(accountId: string): Identity[] {
    const rows = this.db
      .prepare(
        `${IdentityRepo.SELECT} WHERE i.account_id = ? ORDER BY i.is_default DESC, i.email`
      )
      .all(accountId) as IdentityRow[]
    return rows.map(toIdentity)
  }

  get(id: string): Identity | null {
    const row = this.db.prepare(`${IdentityRepo.SELECT} WHERE i.id = ?`).get(id) as
      | IdentityRow
      | undefined
    return row ? toIdentity(row) : null
  }

  findByEmail(accountId: string, email: string): Identity | null {
    const row = this.db
      .prepare(`${IdentityRepo.SELECT} WHERE i.account_id = ? AND lower(i.email) = lower(?)`)
      .get(accountId, email) as IdentityRow | undefined
    return row ? toIdentity(row) : null
  }

  /**
   * Points an identity at a library entry holding `html`. An entry nobody else
   * uses is this address's own and is rewritten in place — keeping its name and
   * leaving no orphan behind; a shared one is never touched, the identity moves
   * to another entry instead.
   */
  private linkSignature(current: string | null, html: string | null, name: string): string | null {
    const text = normalizeSignature(html)
    const sole = current !== null && (this.signatures.get(current)?.usedBy ?? 0) <= 1
    if (!text) {
      if (sole && current) this.signatures.remove(current)
      return null
    }
    if (sole && current) return this.signatures.update(current, { html: text }).id
    return this.signatures.findOrCreate(text, name).id
  }

  create(input: IdentityInput): Identity {
    const existing = this.findByEmail(input.accountId, input.email)
    if (existing) {
      // Re-creating an address only ever adds to it: a signature it already
      // carries is not cleared by a caller that simply has none to offer.
      const patch: Parameters<IdentityRepo['update']>[1] = {
        name: input.name,
        isDefault: input.isDefault ?? existing.isDefault
      }
      if (input.signatureId !== undefined) patch.signatureId = input.signatureId
      else if (normalizeSignature(input.signatureHtml)) patch.signatureHtml = input.signatureHtml
      return this.update(existing.id, patch)
    }
    const id = newId()
    const source = input.source ?? 'user'
    const signature = normalizeSignature(input.signatureHtml)
    const signatureId =
      input.signatureId !== undefined
        ? input.signatureId
        : signature
          ? this.signatures.findOrCreate(signature, input.email).id
          : null
    this.db
      .prepare(
        `INSERT INTO identities
           (id, account_id, name, email, signature_id, gmail_signature_html,
            is_default, source, verified)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.accountId,
        input.name,
        input.email,
        signatureId,
        // Records the imported text so a later edit is recognisable as one.
        source === 'gmail_sendas' ? signature : null,
        input.isDefault ? 1 : 0,
        source,
        input.verified === false ? 0 : 1
      )
    if (input.isDefault) this.setDefault(id)
    return this.get(id)!
  }

  update(
    id: string,
    patch: Partial<Omit<Identity, 'id' | 'signatureHtml'>> & { signatureHtml?: string | null }
  ): Identity {
    const existing = this.get(id)
    if (!existing) throw new Error(`Unknown identity ${id}`)
    const columns: Record<string, string> = {
      name: 'name',
      email: 'email',
      signatureId: 'signature_id',
      isDefault: 'is_default',
      source: 'source',
      accountId: 'account_id',
      verified: 'verified'
    }
    const effective: Record<string, unknown> = { ...patch }
    delete effective.signatureHtml
    if (patch.signatureId === undefined && patch.signatureHtml !== undefined) {
      effective.signatureId = this.linkSignature(
        existing.signatureId,
        patch.signatureHtml,
        existing.email
      )
    }
    const sets: string[] = []
    const values: Array<string | number | null> = []
    for (const [key, column] of Object.entries(columns)) {
      const value = effective[key]
      if (value === undefined) continue
      sets.push(`${column} = ?`)
      values.push(typeof value === 'boolean' ? (value ? 1 : 0) : (value as string | number | null))
    }
    if (sets.length > 0) {
      this.db.prepare(`UPDATE identities SET ${sets.join(', ')} WHERE id = ?`).run(...values, id)
    }
    if (patch.isDefault) this.setDefault(id)
    const identity = this.get(id)
    if (!identity) throw new Error(`Unknown identity ${id}`)
    return identity
  }

  /** Exactly one identity per account carries the default flag. */
  setDefault(id: string): void {
    const identity = this.get(id)
    if (!identity) return
    this.db.transaction(() => {
      this.db
        .prepare('UPDATE identities SET is_default = 0 WHERE account_id = ?')
        .run(identity.accountId)
      this.db.prepare('UPDATE identities SET is_default = 1 WHERE id = ?').run(id)
    })()
  }

  remove(id: string): void {
    this.db.prepare('DELETE FROM identities WHERE id = ?').run(id)
  }

  /**
   * Mirrors Gmail's sendAs list: aliases that vanished are dropped, and name,
   * address and verification state are taken over on every run. The signature
   * follows Gmail only while it still matches what Gmail last sent — once it was
   * edited here it is a local preference and survives, just like the default
   * flag, which Gmail sets only for a freshly imported alias.
   */
  replaceGmailIdentities(accountId: string, identities: GmailIdentityInput[]): void {
    this.db.transaction(() => {
      const keep = new Set(identities.map((i) => i.email.toLowerCase()))
      const existing = this.db
        .prepare(`${IdentityRepo.SELECT} WHERE i.account_id = ? AND i.source = 'gmail_sendas'`)
        .all(accountId) as IdentityRow[]
      for (const row of existing) {
        if (!keep.has(row.email.toLowerCase())) {
          this.db.prepare('DELETE FROM identities WHERE id = ?').run(row.id)
        }
      }
      const byEmail = new Map(existing.map((row) => [row.email.toLowerCase(), row]))
      for (const identity of identities) {
        const signature = normalizeSignature(identity.signatureHtml)
        const row = byEmail.get(identity.email.toLowerCase())
        if (!row) {
          this.create({ ...identity, signatureHtml: signature, source: 'gmail_sendas' })
          continue
        }
        const overridden =
          normalizeSignature(row.signature_html) !== normalizeSignature(row.gmail_signature_html)
        const signatureId = overridden
          ? row.signature_id
          : this.linkSignature(row.signature_id, signature, row.email)
        this.db
          .prepare(
            `UPDATE identities
                SET name = ?, verified = ?, gmail_signature_html = ?, signature_id = ?
              WHERE id = ?`
          )
          .run(
            identity.name,
            identity.verified ? 1 : 0,
            // Always the newest text Gmail sent: it is the yardstick a local
            // edit is measured against, not a copy of what is in use.
            signature,
            signatureId,
            row.id
          )
      }
    })()
  }
}
