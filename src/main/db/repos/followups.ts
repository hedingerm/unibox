import type { FollowUp, FollowUpResolution } from '@shared/types'
import type { Db } from '../index'
import { newId } from '../ids'

interface FollowUpRow {
  id: string
  account_id: string
  thread_id: string
  message_id: string
  due_at: number
  created_at: number
  state: FollowUp['state']
  resolved_at: number | null
  resolved_reason: FollowUpResolution | null
  nudge_count: number
  notified_at: number | null
}

function toFollowUp(row: FollowUpRow): FollowUp {
  return {
    id: row.id,
    accountId: row.account_id,
    threadId: row.thread_id,
    messageId: row.message_id,
    dueAt: row.due_at,
    createdAt: row.created_at,
    state: row.state,
    resolvedAt: row.resolved_at,
    resolvedReason: row.resolved_reason,
    nudgeCount: row.nudge_count,
    notifiedAt: row.notified_at
  }
}

export interface CreateFollowUpInput {
  accountId: string
  /** Empty while the sent message has not reached the local store yet. */
  threadId: string
  messageId: string
  dueAt: number
  now: number
}

/**
 * Sent mail that is waiting for an answer. Local only: nothing about this
 * reaches Gmail or Resend — it is the app's own memory of what it asked and
 * has not heard back about.
 */
export class FollowUpRepo {
  constructor(private readonly db: Db) {}

  create(input: CreateFollowUpInput): FollowUp {
    const id = newId()
    this.db
      .prepare(
        `INSERT INTO follow_ups (id, account_id, thread_id, message_id, due_at, created_at)
         VALUES (@id, @accountId, @threadId, @messageId, @dueAt, @now)`
      )
      .run({ id, ...input })
    return this.get(id)!
  }

  get(id: string): FollowUp | null {
    const row = this.db.prepare('SELECT * FROM follow_ups WHERE id = ?').get(id) as
      | FollowUpRow
      | undefined
    return row ? toFollowUp(row) : null
  }

  /**
   * The one open follow-up of a conversation. A partial unique index enforces
   * that there is never a second: answering into a thread that is already
   * waiting moves the existing row rather than stacking another on top.
   */
  openForThread(threadId: string): FollowUp | null {
    const row = this.db
      .prepare(`SELECT * FROM follow_ups WHERE thread_id = ? AND state = 'open'`)
      .get(threadId) as FollowUpRow | undefined
    return row ? toFollowUp(row) : null
  }

  /** Everything still waiting, the most urgent first. */
  listOpen(accountId?: string | null): FollowUp[] {
    const rows = accountId
      ? (this.db
          .prepare(
            `SELECT * FROM follow_ups WHERE state = 'open' AND account_id = ?
             ORDER BY due_at ASC`
          )
          .all(accountId) as FollowUpRow[])
      : (this.db
          .prepare(`SELECT * FROM follow_ups WHERE state = 'open' ORDER BY due_at ASC`)
          .all() as FollowUpRow[])
    return rows.map(toFollowUp)
  }

  /**
   * Conversations of the "Wartet auf Antwort" mailbox, due first. Rows whose
   * message never reached the local store carry no thread and would draw an
   * empty line, so they stay out until the repair in `reconcile` finds them.
   */
  openThreadIds(accountId: string | null, limit: number, offset: number): string[] {
    const rows = this.db
      .prepare(
        `SELECT thread_id FROM follow_ups
         WHERE state = 'open' AND thread_id <> ''
           AND (@accountId IS NULL OR account_id = @accountId)
         ORDER BY due_at ASC LIMIT @limit OFFSET @offset`
      )
      .all({ accountId: accountId ?? null, limit, offset }) as Array<{ thread_id: string }>
    return rows.map((row) => row.thread_id)
  }

  /** Open rows whose moment has come and that nobody has been told about yet. */
  dueForNotification(now: number): FollowUp[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM follow_ups
         WHERE state = 'open' AND thread_id <> '' AND due_at <= ? AND notified_at IS NULL
         ORDER BY due_at ASC`
      )
      .all(now) as FollowUpRow[]
    return rows.map(toFollowUp)
  }

  markNotified(ids: string[], now: number): void {
    if (ids.length === 0) return
    const statement = this.db.prepare('UPDATE follow_ups SET notified_at = ? WHERE id = ?')
    this.db.transaction(() => {
      for (const id of ids) statement.run(now, id)
    })()
  }

  resolve(id: string, reason: FollowUpResolution, now: number): void {
    this.db
      .prepare(
        `UPDATE follow_ups SET state = 'resolved', resolved_at = ?, resolved_reason = ?
         WHERE id = ? AND state = 'open'`
      )
      .run(now, reason, id)
  }

  /**
   * The user wrote into the conversation again without getting an answer. The
   * anchor moves to that message so the same nudge is not counted twice, and
   * the wait starts over from it.
   */
  nudge(id: string, messageId: string, dueAt: number, added: number): void {
    this.db
      .prepare(
        `UPDATE follow_ups SET message_id = ?, due_at = ?, nudge_count = nudge_count + ?,
           notified_at = NULL
         WHERE id = ? AND state = 'open'`
      )
      .run(messageId, dueAt, added, id)
  }

  /** Moves the reminder without touching the nudge count — a plain "later". */
  reschedule(id: string, dueAt: number): void {
    this.db
      .prepare(`UPDATE follow_ups SET due_at = ?, notified_at = NULL WHERE id = ? AND state = 'open'`)
      .run(dueAt, id)
  }

  /** Fills in the conversation once the sent message has reached the store. */
  attachThread(id: string, threadId: string): void {
    this.db.prepare('UPDATE follow_ups SET thread_id = ? WHERE id = ?').run(threadId, id)
  }

  /** Open rows still waiting for their message to appear — candidates for repair. */
  unattached(): FollowUp[] {
    const rows = this.db
      .prepare(`SELECT * FROM follow_ups WHERE state = 'open' AND thread_id = ''`)
      .all() as FollowUpRow[]
    return rows.map(toFollowUp)
  }

  /**
   * Drops rows whose message never turned up. Only a send whose follow-on sync
   * failed leaves one behind, and after this long it is never going to resolve.
   */
  purgeUnattached(before: number): number {
    return this.db
      .prepare(`DELETE FROM follow_ups WHERE state = 'open' AND thread_id = '' AND created_at < ?`)
      .run(before).changes
  }

  /** A conversation that was thrown away is no longer waiting for anything. */
  forgetThreads(threadIds: string[], now: number): void {
    if (threadIds.length === 0) return
    const statement = this.db.prepare(
      `UPDATE follow_ups SET state = 'resolved', resolved_at = ?, resolved_reason = 'dropped'
       WHERE thread_id = ? AND state = 'open'`
    )
    this.db.transaction(() => {
      for (const threadId of threadIds) statement.run(now, threadId)
    })()
  }

  countOpen(accountId?: string | null): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM follow_ups
         WHERE state = 'open' AND thread_id <> ''
           AND (@accountId IS NULL OR account_id = @accountId)`
      )
      .get({ accountId: accountId ?? null }) as { n: number }
    return row.n
  }

  countOverdue(now: number, accountId?: string | null): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM follow_ups
         WHERE state = 'open' AND thread_id <> '' AND due_at <= @now
           AND (@accountId IS NULL OR account_id = @accountId)`
      )
      .get({ now, accountId: accountId ?? null }) as { n: number }
    return row.n
  }
}
