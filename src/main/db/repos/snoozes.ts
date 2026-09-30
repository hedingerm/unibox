import type { Snooze } from '@shared/types'
import type { Db } from '../index'

interface SnoozeRow {
  thread_id: string
  account_id: string
  wake_at: number
  created_at: number
  seen_message_row: number
}

function toSnooze(row: SnoozeRow): Snooze {
  return {
    threadId: row.thread_id,
    accountId: row.account_id,
    wakeAt: row.wake_at,
    createdAt: row.created_at
  }
}

/**
 * Conversations put aside until a given moment. A snooze is purely local: the
 * mail itself is archived, and waking it up re-adds the inbox label through the
 * usual mutation queue. Nothing here talks to a server.
 */
export class SnoozeRepo {
  constructor(private readonly db: Db) {}

  /**
   * Re-snoozing a conversation moves its wake time rather than adding a row.
   * The high-water mark is taken here, so a mail that arrived before the user
   * decided to wait does not count as the answer they were waiting for.
   */
  upsert(threadId: string, accountId: string, wakeAt: number, now: number): Snooze {
    const seen = this.db
      .prepare('SELECT COALESCE(MAX(rowid), 0) AS seen FROM messages WHERE thread_id = ?')
      .get(threadId) as { seen: number }
    this.db
      .prepare(
        `INSERT INTO snoozes (thread_id, account_id, wake_at, created_at, seen_message_row)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(thread_id) DO UPDATE SET wake_at = excluded.wake_at,
                                              created_at = excluded.created_at,
                                              seen_message_row = excluded.seen_message_row`
      )
      .run(threadId, accountId, wakeAt, now, seen.seen)
    return { threadId, accountId, wakeAt, createdAt: now }
  }

  remove(threadIds: string[]): void {
    if (threadIds.length === 0) return
    const statement = this.db.prepare('DELETE FROM snoozes WHERE thread_id = ?')
    this.db.transaction(() => {
      for (const threadId of threadIds) statement.run(threadId)
    })()
  }

  get(threadId: string): Snooze | null {
    const row = this.db.prepare('SELECT * FROM snoozes WHERE thread_id = ?').get(threadId) as
      | SnoozeRow
      | undefined
    return row ? toSnooze(row) : null
  }

  /** Waiting conversations, the one returning soonest first. */
  list(accountId?: string | null): Snooze[] {
    const rows = accountId
      ? (this.db
          .prepare('SELECT * FROM snoozes WHERE account_id = ? ORDER BY wake_at ASC')
          .all(accountId) as SnoozeRow[])
      : (this.db.prepare('SELECT * FROM snoozes ORDER BY wake_at ASC').all() as SnoozeRow[])
    return rows.map(toSnooze)
  }

  /** Everything whose time has come — what the wake tick puts back. */
  due(now: number): Snooze[] {
    const rows = this.db
      .prepare('SELECT * FROM snoozes WHERE wake_at <= ? ORDER BY wake_at ASC')
      .all(now) as SnoozeRow[]
    return rows.map(toSnooze)
  }

  /**
   * Snoozed conversations that have received mail since they were put aside —
   * measured against the row high-water mark taken at that moment rather than
   * against a timestamp, so nothing depends on whose clock stamped the mail.
   * Only incoming mail counts: answering yourself is not what you waited for.
   */
  interrupted(): Snooze[] {
    const rows = this.db
      .prepare(
        `SELECT s.* FROM snoozes s
         WHERE EXISTS (
           SELECT 1 FROM messages m
           WHERE m.thread_id = s.thread_id
             AND m.direction = 'incoming'
             AND m.rowid > s.seen_message_row
         )`
      )
      .all() as SnoozeRow[]
    return rows.map(toSnooze)
  }

  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM snoozes').get() as { n: number }
    return row.n
  }

  /** Drops rows whose conversation no longer has a single message. */
  pruneOrphans(): void {
    this.db.exec(
      'DELETE FROM snoozes WHERE NOT EXISTS (SELECT 1 FROM messages WHERE thread_id = snoozes.thread_id)'
    )
  }
}
