import type { Mailbox } from '@shared/admin'
import type { Db } from '../index'
import { newId } from '../ids'

interface MailboxRow {
  id: string
  account_id: string
  address: string
  display_name: string
  identity_id: string | null
  sort: number
  created_at: number
}

export interface MailboxRecordInput {
  accountId: string
  address: string
  displayName: string
  aliases: string[]
  identityId: string | null
}

/** Raised when an address already names another mailbox or alias. */
export class AddressTakenError extends Error {
  constructor(address: string) {
    super(`Die Adresse ${address} gehört bereits zu einem anderen Postfach.`)
    this.name = 'AddressTakenError'
  }
}

export function normalizeAddress(address: string): string {
  return address.trim().toLowerCase()
}

/**
 * Local mailboxes on a Resend domain. What they hold is computed from
 * `message_addresses` at read time — nothing is copied or moved, so a mailbox
 * created today shows the mail of the last month straight away.
 */
export class MailboxRepo {
  constructor(private readonly db: Db) {}

  private aliasesOf(mailboxId: string): string[] {
    return (
      this.db
        .prepare('SELECT address FROM mailbox_aliases WHERE mailbox_id = ? ORDER BY address')
        .all(mailboxId) as Array<{ address: string }>
    ).map((row) => row.address)
  }

  private toMailbox(row: MailboxRow, unread: number): Mailbox {
    return {
      id: row.id,
      accountId: row.account_id,
      address: row.address,
      displayName: row.display_name,
      aliases: this.aliasesOf(row.id),
      identityId: row.identity_id,
      sort: row.sort,
      createdAt: row.created_at,
      unread
    }
  }

  /** Every mailbox, per domain in the user's order; unread counts included. */
  list(accountId?: string | null, unreadOf?: (addresses: string[], accountId: string) => number): Mailbox[] {
    const rows = (
      accountId
        ? this.db
            .prepare('SELECT * FROM mailboxes WHERE account_id = ? ORDER BY sort, created_at')
            .all(accountId)
        : this.db.prepare('SELECT * FROM mailboxes ORDER BY account_id, sort, created_at').all()
    ) as MailboxRow[]
    return rows.map((row) => {
      const mailbox = this.toMailbox(row, 0)
      return unreadOf
        ? { ...mailbox, unread: unreadOf([mailbox.address, ...mailbox.aliases], row.account_id) }
        : mailbox
    })
  }

  get(id: string): Mailbox | null {
    const row = this.db.prepare('SELECT * FROM mailboxes WHERE id = ?').get(id) as
      | MailboxRow
      | undefined
    return row ? this.toMailbox(row, 0) : null
  }

  /** The mailbox an address (or alias) belongs to. */
  findByAddress(address: string): Mailbox | null {
    const email = normalizeAddress(address)
    const row = this.db
      .prepare(
        `SELECT * FROM mailboxes WHERE address = @email
           OR id IN (SELECT mailbox_id FROM mailbox_aliases WHERE address = @email)`
      )
      .get({ email }) as MailboxRow | undefined
    return row ? this.toMailbox(row, 0) : null
  }

  /** Address plus aliases — what the mailbox view filters on. */
  addressesOf(id: string): string[] {
    const mailbox = this.get(id)
    return mailbox ? [mailbox.address, ...mailbox.aliases] : []
  }

  count(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM mailboxes').get() as { n: number }).n
  }

  private assertFree(addresses: string[], ownId: string | null): void {
    for (const address of addresses) {
      const owner = this.findByAddress(address)
      if (owner && owner.id !== ownId) throw new AddressTakenError(address)
    }
  }

  private writeAliases(mailboxId: string, aliases: string[]): void {
    this.db.prepare('DELETE FROM mailbox_aliases WHERE mailbox_id = ?').run(mailboxId)
    const insert = this.db.prepare(
      'INSERT OR IGNORE INTO mailbox_aliases (mailbox_id, address) VALUES (?, ?)'
    )
    for (const alias of aliases) insert.run(mailboxId, alias)
  }

  create(input: MailboxRecordInput): Mailbox {
    const id = newId()
    this.db.transaction(() => {
      this.assertFree([input.address, ...input.aliases], null)
      // New mailboxes go to the end of their domain's list.
      const next = this.db
        .prepare('SELECT COALESCE(MAX(sort), -1) + 1 AS n FROM mailboxes WHERE account_id = ?')
        .get(input.accountId) as { n: number }
      this.db
        .prepare(
          `INSERT INTO mailboxes (id, account_id, address, display_name, identity_id, sort, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(id, input.accountId, input.address, input.displayName, input.identityId, next.n, Date.now())
      this.writeAliases(id, input.aliases)
    })()
    return this.get(id)!
  }

  update(
    id: string,
    patch: Partial<Pick<MailboxRecordInput, 'address' | 'displayName' | 'aliases' | 'identityId'>>
  ): Mailbox {
    const existing = this.get(id)
    if (!existing) throw new Error('Unbekanntes Postfach')
    this.db.transaction(() => {
      this.assertFree([patch.address ?? existing.address, ...(patch.aliases ?? existing.aliases)], id)
      this.db
        .prepare(
          'UPDATE mailboxes SET address = ?, display_name = ?, identity_id = ? WHERE id = ?'
        )
        .run(
          patch.address ?? existing.address,
          patch.displayName ?? existing.displayName,
          patch.identityId === undefined ? existing.identityId : patch.identityId,
          id
        )
      if (patch.aliases) this.writeAliases(id, patch.aliases)
    })()
    return this.get(id)!
  }

  remove(id: string): void {
    this.db.prepare('DELETE FROM mailboxes WHERE id = ?').run(id)
  }

  /** Writes the order the ids are given in; ids not listed keep theirs. */
  reorder(ids: string[]): void {
    const update = this.db.prepare('UPDATE mailboxes SET sort = ? WHERE id = ?')
    this.db.transaction(() => {
      ids.forEach((id, index) => update.run(index, id))
    })()
  }
}
