import type { ActivityEntry, ActivityKind, ActivityListArgs, ActivityPage } from '@shared/admin'
import type { Db } from '../index'

interface ActivityRow {
  id: number
  ts: number
  kind: ActivityKind
  account_id: string | null
  summary: string
  meta_json: string
  count: number
}

function toEntry(row: ActivityRow): ActivityEntry {
  let meta: Record<string, unknown> = {}
  try {
    const parsed: unknown = JSON.parse(row.meta_json)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      meta = parsed as Record<string, unknown>
    }
  } catch {
    // A broken meta blob still leaves a readable entry.
  }
  return {
    id: row.id,
    ts: row.ts,
    kind: row.kind,
    accountId: row.account_id,
    summary: row.summary,
    meta,
    count: row.count
  }
}

/** How many entries the log keeps; older ones are dropped as new ones come. */
export const ACTIVITY_RETENTION = 5000

export interface ActivityRecordInput {
  kind: ActivityKind
  summary: string
  accountId?: string | null
  meta?: Record<string, unknown>
  /**
   * Folds this entry into the newest one of the same kind and account when
   * that one carries the same summary: a sync error that repeats every 30
   * seconds is one entry with a count, not a wall of identical lines.
   */
  dedupe?: boolean
  ts?: number
}

export class ActivityRepo {
  private inserts = 0

  constructor(
    private readonly db: Db,
    private readonly retention = ACTIVITY_RETENTION
  ) {}

  record(input: ActivityRecordInput): ActivityEntry {
    const ts = input.ts ?? Date.now()
    const accountId = input.accountId ?? null
    const meta = JSON.stringify(input.meta ?? {})
    if (input.dedupe) {
      const last = this.db
        .prepare(
          `SELECT * FROM activity_log WHERE kind = ? AND account_id IS ?
           ORDER BY id DESC LIMIT 1`
        )
        .get(input.kind, accountId) as ActivityRow | undefined
      if (last && last.summary === input.summary) {
        this.db
          .prepare('UPDATE activity_log SET ts = ?, count = count + 1, meta_json = ? WHERE id = ?')
          .run(ts, meta, last.id)
        return toEntry({ ...last, ts, count: last.count + 1, meta_json: meta })
      }
    }
    const result = this.db
      .prepare(
        `INSERT INTO activity_log (ts, kind, account_id, summary, meta_json)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(ts, input.kind, accountId, input.summary, meta)
    const id = Number(result.lastInsertRowid)
    // Pruning on every insert would be a delete per sync; every fiftieth
    // keeps the table within a rounding error of the limit.
    this.inserts += 1
    if (this.inserts % 50 === 1) this.prune()
    return toEntry({
      id,
      ts,
      kind: input.kind,
      account_id: accountId,
      summary: input.summary,
      meta_json: meta,
      count: 1
    })
  }

  prune(): void {
    this.db
      .prepare('DELETE FROM activity_log WHERE id <= (SELECT MAX(id) FROM activity_log) - ?')
      .run(this.retention)
  }

  list(args: ActivityListArgs = {}): ActivityPage {
    const limit = Math.max(1, Math.min(args.limit ?? 50, 500))
    const conditions: string[] = []
    const params: Record<string, unknown> = { limit: limit + 1 }
    const kinds = args.kind ? (Array.isArray(args.kind) ? args.kind : [args.kind]) : []
    if (kinds.length > 0) {
      conditions.push('kind IN (SELECT value FROM json_each(@kinds))')
      params.kinds = JSON.stringify(kinds)
    }
    if (args.accountId) {
      conditions.push('account_id = @accountId')
      params.accountId = args.accountId
    }
    if (args.beforeId) {
      conditions.push('id < @beforeId')
      params.beforeId = args.beforeId
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    const rows = this.db
      .prepare(`SELECT * FROM activity_log ${where} ORDER BY id DESC LIMIT @limit`)
      .all(params) as ActivityRow[]
    const entries = rows.slice(0, limit).map(toEntry)
    return {
      entries,
      nextBeforeId: rows.length > limit ? (entries[entries.length - 1]?.id ?? null) : null
    }
  }

  /** The newest entry of a kind, for "last backup" and the like. */
  latest(kind: ActivityKind): ActivityEntry | null {
    const row = this.db
      .prepare('SELECT * FROM activity_log WHERE kind = ? ORDER BY id DESC LIMIT 1')
      .get(kind) as ActivityRow | undefined
    return row ? toEntry(row) : null
  }

  countSince(kind: ActivityKind, since: number): number {
    return (
      this.db
        .prepare('SELECT COUNT(*) AS n FROM activity_log WHERE kind = ? AND ts >= ?')
        .get(kind, since) as { n: number }
    ).n
  }
}
