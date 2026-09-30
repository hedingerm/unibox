import type { MutationOp, MutationPayload, MutationState, QueuedMutation } from '@shared/types'
import type { Db } from '../index'

interface QueueRow {
  id: number
  account_id: string
  message_id: string
  op: MutationOp
  payload: string
  attempts: number
  next_attempt_at: number
  last_error: string | null
  state: MutationState
  created_at: number
}

function toMutation(row: QueueRow): QueuedMutation {
  let payload: MutationPayload = {}
  try {
    payload = JSON.parse(row.payload) as MutationPayload
  } catch {
    payload = {}
  }
  return {
    id: row.id,
    accountId: row.account_id,
    messageId: row.message_id,
    op: row.op,
    payload,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    lastError: row.last_error,
    state: row.state,
    createdAt: row.created_at
  }
}

export class QueueRepo {
  constructor(private readonly db: Db) {}

  enqueue(input: {
    accountId: string
    messageId: string
    op: MutationOp
    payload?: MutationPayload
  }): QueuedMutation {
    const info = this.db
      .prepare(
        `INSERT INTO mutation_queue (account_id, message_id, op, payload, created_at, next_attempt_at)
         VALUES (?, ?, ?, ?, ?, 0)`
      )
      .run(
        input.accountId,
        input.messageId,
        input.op,
        JSON.stringify(input.payload ?? {}),
        Date.now()
      )
    return this.get(Number(info.lastInsertRowid))!
  }

  get(id: number): QueuedMutation | null {
    const row = this.db.prepare('SELECT * FROM mutation_queue WHERE id = ?').get(id) as
      | QueueRow
      | undefined
    return row ? toMutation(row) : null
  }

  /** Pending work in insertion order — the order the user performed the actions. */
  pending(now = Date.now()): QueuedMutation[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM mutation_queue WHERE state = 'pending' AND next_attempt_at <= ? ORDER BY id ASC`
      )
      .all(now) as QueueRow[]
    return rows.map(toMutation)
  }

  list(): QueuedMutation[] {
    const rows = this.db
      .prepare(`SELECT * FROM mutation_queue WHERE state != 'done' ORDER BY id ASC`)
      .all() as QueueRow[]
    return rows.map(toMutation)
  }

  markDone(id: number): void {
    this.db.prepare(`UPDATE mutation_queue SET state = 'done', last_error = NULL WHERE id = ?`).run(id)
  }

  markFailed(id: number, error: string, nextAttemptAt: number, permanent = false): void {
    this.db
      .prepare(
        `UPDATE mutation_queue
         SET attempts = attempts + 1, last_error = ?, next_attempt_at = ?, state = ?
         WHERE id = ?`
      )
      .run(error, nextAttemptAt, permanent ? 'failed' : 'pending', id)
  }

  /** Re-arms a mutation the service had given up on, due immediately. */
  retry(id: number): boolean {
    const mutation = this.get(id)
    if (!mutation || mutation.state !== 'failed') return false
    this.db
      .prepare(
        `UPDATE mutation_queue SET state = 'pending', next_attempt_at = 0, attempts = 0,
           last_error = NULL WHERE id = ?`
      )
      .run(id)
    return true
  }

  discard(id: number): boolean {
    const mutation = this.get(id)
    if (!mutation || mutation.state === 'done') return false
    this.db.prepare('DELETE FROM mutation_queue WHERE id = ?').run(id)
    return true
  }

  /**
   * Drops still-pending work of one kind for one target. Autosave queues a draft
   * push on every pause; only the newest one is worth sending, and Gmail
   * replaces the draft wholesale rather than applying a delta.
   */
  discardPending(messageId: string, op: MutationOp): void {
    this.db
      .prepare(`DELETE FROM mutation_queue WHERE message_id = ? AND op = ? AND state = 'pending'`)
      .run(messageId, op)
  }

  /** Write-backs still owed to the server, counted for the offline banner. */
  pendingCount(): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM mutation_queue WHERE state = 'pending'`)
      .get() as { n: number }
    return row.n
  }

  purgeDone(): void {
    this.db.prepare(`DELETE FROM mutation_queue WHERE state = 'done'`).run()
  }
}
