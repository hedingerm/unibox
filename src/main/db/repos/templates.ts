import type { Template, TemplateInput } from '@shared/types'
import { scanTemplate } from '@shared/template-vars'
import type { Db } from '../index'
import { newId } from '../ids'

interface TemplateRow {
  id: string
  name: string
  shortcut: string | null
  subject: string
  html: string
  created_at: number
  updated_at: number
}

function toTemplate(row: TemplateRow): Template {
  return {
    id: row.id,
    name: row.name,
    shortcut: row.shortcut,
    subject: row.subject,
    html: row.html,
    // Derived rather than stored: the variables are whatever the text says
    // right now, and a second copy of that would start drifting on the first
    // edit that forgot to update it.
    variables: [...new Set([...scanTemplate(row.subject), ...scanTemplate(row.html)])],
    updatedAt: row.updated_at
  }
}

/** Raised when two templates would answer to the same `/kürzel`. */
export class ShortcutTakenError extends Error {
  constructor(shortcut: string) {
    super(`Das Kürzel «${shortcut}» ist bereits vergeben.`)
    this.name = 'ShortcutTakenError'
  }
}

/**
 * The template library. Entries belong to no account, the same way signatures
 * do: one text, edited once, usable from every address.
 */
export class TemplateRepo {
  constructor(private readonly db: Db) {}

  list(): Template[] {
    const rows = this.db
      .prepare('SELECT * FROM templates ORDER BY name COLLATE NOCASE')
      .all() as TemplateRow[]
    return rows.map(toTemplate)
  }

  get(id: string): Template | null {
    const row = this.db.prepare('SELECT * FROM templates WHERE id = ?').get(id) as
      | TemplateRow
      | undefined
    return row ? toTemplate(row) : null
  }

  /**
   * The template a `/kürzel` names. Matched without regard to case, because
   * that is how it was typed into the draft rather than picked from a list.
   */
  byShortcut(shortcut: string): Template | null {
    const row = this.db
      .prepare('SELECT * FROM templates WHERE lower(shortcut) = lower(?)')
      .get(shortcut.trim()) as TemplateRow | undefined
    return row ? toTemplate(row) : null
  }

  create(input: TemplateInput, now = Date.now()): Template {
    const id = newId()
    const shortcut = normalizeShortcut(input.shortcut)
    this.guardShortcut(shortcut, null)
    this.db
      .prepare(
        `INSERT INTO templates (id, name, shortcut, subject, html, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(id, input.name, shortcut, input.subject, input.html, now, now)
    return this.get(id)!
  }

  update(id: string, patch: Partial<TemplateInput>, now = Date.now()): Template {
    const sets: string[] = []
    const values: Array<string | null> = []
    if (patch.name !== undefined) {
      sets.push('name = ?')
      values.push(patch.name)
    }
    if (patch.shortcut !== undefined) {
      const shortcut = normalizeShortcut(patch.shortcut)
      this.guardShortcut(shortcut, id)
      sets.push('shortcut = ?')
      values.push(shortcut)
    }
    if (patch.subject !== undefined) {
      sets.push('subject = ?')
      values.push(patch.subject)
    }
    if (patch.html !== undefined) {
      sets.push('html = ?')
      values.push(patch.html)
    }
    if (sets.length > 0) {
      this.db
        .prepare(`UPDATE templates SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`)
        .run(...values, now, id)
    }
    const template = this.get(id)
    if (!template) throw new Error(`Unknown template ${id}`)
    return template
  }

  remove(id: string): void {
    this.db.prepare('DELETE FROM templates WHERE id = ?').run(id)
  }

  /**
   * The unique index would refuse the write anyway, but with SQLite's wording.
   * Saying which shortcut is taken is what lets the user fix it.
   */
  private guardShortcut(shortcut: string | null, exceptId: string | null): void {
    if (shortcut === null) return
    const clash = this.byShortcut(shortcut)
    if (clash && clash.id !== exceptId) throw new ShortcutTakenError(shortcut)
  }
}

/**
 * A shortcut as it is stored: without the leading slash the user types, and
 * empty means none. Keeping the slash out is what lets `/offerte` and `offerte`
 * be typed into the settings field interchangeably.
 */
export function normalizeShortcut(shortcut: string | null): string | null {
  const trimmed = (shortcut ?? '').trim().replace(/^\/+/, '')
  return trimmed === '' ? null : trimmed
}
