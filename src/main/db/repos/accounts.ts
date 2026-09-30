import type { Account, AccountKind, AccountStatus } from '@shared/types'
import type { Db } from '../index'
import { newId } from '../ids'

interface AccountRow {
  id: string
  kind: AccountKind
  email: string
  display_name: string
  color: string
  resend_domain_id: string | null
  resend_region: string | null
  receiving_enabled: number
  status: AccountStatus
  last_error: string | null
  history_id: string | null
  initial_sync_done: number
  notifications_enabled: number
  last_synced_at: number | null
  created_at: number
}

const ACCOUNT_COLORS = [
  '#ff9f0a',
  '#0a7aff',
  '#0e8f7e',
  '#bf5af2',
  '#ff375f',
  '#30b0c7',
  '#34c759',
  '#af52de'
]

function toAccount(row: AccountRow): Account {
  return {
    id: row.id,
    kind: row.kind,
    email: row.email,
    displayName: row.display_name,
    color: row.color,
    resendDomainId: row.resend_domain_id,
    resendRegion: row.resend_region,
    receivingEnabled: row.receiving_enabled === 1,
    status: row.status,
    lastError: row.last_error,
    historyId: row.history_id,
    initialSyncDone: row.initial_sync_done === 1,
    notificationsEnabled: row.notifications_enabled === 1,
    lastSyncedAt: row.last_synced_at,
    createdAt: row.created_at
  }
}

export interface UpsertAccountInput {
  kind: AccountKind
  email: string
  displayName: string
  color?: string
  resendDomainId?: string | null
  resendRegion?: string | null
  receivingEnabled?: boolean
}

export class AccountRepo {
  constructor(private readonly db: Db) {}

  list(): Account[] {
    const rows = this.db
      .prepare('SELECT * FROM accounts ORDER BY kind DESC, created_at ASC')
      .all() as AccountRow[]
    return rows.map(toAccount)
  }

  get(id: string): Account | null {
    const row = this.db.prepare('SELECT * FROM accounts WHERE id = ?').get(id) as
      | AccountRow
      | undefined
    return row ? toAccount(row) : null
  }

  findByEmail(kind: AccountKind, email: string): Account | null {
    const row = this.db
      .prepare('SELECT * FROM accounts WHERE kind = ? AND email = ?')
      .get(kind, email) as AccountRow | undefined
    return row ? toAccount(row) : null
  }

  findByResendDomainId(domainId: string): Account | null {
    const row = this.db
      .prepare('SELECT * FROM accounts WHERE resend_domain_id = ?')
      .get(domainId) as AccountRow | undefined
    return row ? toAccount(row) : null
  }

  private nextColor(): string {
    const used = new Set(
      (this.db.prepare('SELECT color FROM accounts').all() as Array<{ color: string }>).map(
        (r) => r.color
      )
    )
    return ACCOUNT_COLORS.find((c) => !used.has(c)) ?? ACCOUNT_COLORS[0]!
  }

  upsert(input: UpsertAccountInput): Account {
    const existing = this.findByEmail(input.kind, input.email)
    if (existing) {
      this.db
        .prepare(
          `UPDATE accounts SET display_name = ?, resend_domain_id = ?, resend_region = ?,
             receiving_enabled = ? WHERE id = ?`
        )
        .run(
          input.displayName,
          input.resendDomainId ?? existing.resendDomainId,
          input.resendRegion ?? existing.resendRegion,
          (input.receivingEnabled ?? existing.receivingEnabled) ? 1 : 0,
          existing.id
        )
      return this.get(existing.id)!
    }
    const id = newId()
    this.db
      .prepare(
        `INSERT INTO accounts
          (id, kind, email, display_name, color, resend_domain_id, resend_region,
           receiving_enabled, status, initial_sync_done, notifications_enabled, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ok', 0, 1, ?)`
      )
      .run(
        id,
        input.kind,
        input.email,
        input.displayName,
        input.color ?? this.nextColor(),
        input.resendDomainId ?? null,
        input.resendRegion ?? null,
        input.receivingEnabled ? 1 : 0,
        Date.now()
      )
    return this.get(id)!
  }

  update(
    id: string,
    patch: Partial<
      Pick<
        Account,
        | 'displayName'
        | 'color'
        | 'notificationsEnabled'
        | 'status'
        | 'lastError'
        | 'historyId'
        | 'initialSyncDone'
        | 'lastSyncedAt'
        | 'receivingEnabled'
      >
    >
  ): Account {
    const columns: Record<string, string> = {
      displayName: 'display_name',
      color: 'color',
      notificationsEnabled: 'notifications_enabled',
      status: 'status',
      lastError: 'last_error',
      historyId: 'history_id',
      initialSyncDone: 'initial_sync_done',
      lastSyncedAt: 'last_synced_at',
      receivingEnabled: 'receiving_enabled'
    }
    const sets: string[] = []
    const values: Array<string | number | null> = []
    for (const [key, column] of Object.entries(columns)) {
      const value = (patch as Record<string, unknown>)[key]
      if (value === undefined) continue
      sets.push(`${column} = ?`)
      values.push(typeof value === 'boolean' ? (value ? 1 : 0) : (value as string | number | null))
    }
    if (sets.length > 0) {
      this.db.prepare(`UPDATE accounts SET ${sets.join(', ')} WHERE id = ?`).run(...values, id)
    }
    const account = this.get(id)
    if (!account) throw new Error(`Unknown account ${id}`)
    return account
  }

  remove(id: string): void {
    this.db.prepare('DELETE FROM accounts WHERE id = ?').run(id)
  }
}
