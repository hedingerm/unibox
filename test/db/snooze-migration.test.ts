import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { migrate, migrations } from '@main/db/migrations'

/**
 * Rebuilds a database as it looked before migration 8 was rewritten: the
 * snooze table stamped a moment instead of a message row, and the rewritten
 * migration never runs again on those installs.
 */
function databaseFromBeforeTheRewrite(): Database.Database {
  const db = new Database(':memory:')
  for (const migration of migrations) {
    if (migration.id >= 8) break
    migration.up(db)
  }
  db.exec(`
    CREATE TABLE snoozes (
      thread_id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      wake_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      seen_message_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL);
  `)
  const applied = db.prepare('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)')
  for (const migration of migrations) {
    if (migration.id > 8) break
    applied.run(migration.id, migration.name, 0)
  }
  return db
}

function seed(db: Database.Database): void {
  db.prepare(
    `INSERT INTO accounts (id, kind, email, display_name, color, created_at)
     VALUES ('acc', 'google', 'max@muster-it.ch', 'Max', '#000', 0)`
  ).run()
  const message = db.prepare(
    `INSERT INTO messages (id, account_id, thread_id, remote_id, date, created_at, updated_at)
     VALUES (?, 'acc', 'thread', ?, ?, 0, 0)`
  )
  message.run('old', 'r1', 1000)
  message.run('new', 'r2', 5000)
  db.prepare(
    `INSERT INTO snoozes (thread_id, account_id, wake_at, created_at, seen_message_at)
     VALUES ('thread', 'acc', 9000, 0, 2000)`
  ).run()
}

describe('snooze high-water mark migration', () => {
  it('carries an existing snooze over to the row it had seen', () => {
    const db = databaseFromBeforeTheRewrite()
    seed(db)

    migrate(db)

    const columns = (db.prepare('PRAGMA table_info(snoozes)').all() as Array<{ name: string }>).map(
      (column) => column.name
    )
    expect(columns).toContain('seen_message_row')
    expect(columns).not.toContain('seen_message_at')

    const row = db.prepare('SELECT seen_message_row FROM snoozes WHERE thread_id = ?').get('thread') as {
      seen_message_row: number
    }
    const older = db.prepare('SELECT rowid FROM messages WHERE id = ?').get('old') as { rowid: number }
    // Only the mail that existed when the snooze started counts as seen; the
    // later one has to be able to wake the conversation.
    expect(row.seen_message_row).toBe(older.rowid)
    db.close()
  })

  it('leaves a database created after the rewrite alone', () => {
    const db = new Database(':memory:')
    migrate(db)
    const before = db.prepare('SELECT seen_message_row FROM snoozes').all()
    expect(migrate(db)).toBe(0)
    expect(db.prepare('SELECT seen_message_row FROM snoozes').all()).toEqual(before)
    db.close()
  })
})
