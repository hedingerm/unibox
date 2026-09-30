import Database from 'better-sqlite3'
import type { Database as DatabaseType } from 'better-sqlite3'
import { migrate } from './migrations'

export type Db = DatabaseType

export function openDatabase(file: string): Db {
  const db = new Database(file)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.pragma('synchronous = NORMAL')
  migrate(db)
  return db
}

export function openMemoryDatabase(): Db {
  return openDatabase(':memory:')
}
