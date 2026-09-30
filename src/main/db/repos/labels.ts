import type { Label, LabelType, LabelWithCounts } from '@shared/types'
import { SYSTEM_LABELS } from '@shared/types'
import type { Db } from '../index'
import { labelKey } from '../ids'

interface LabelRow {
  id: string
  account_id: string
  remote_id: string
  name: string
  parent_id: string | null
  type: LabelType
  color: string | null
}

export interface LabelInput {
  remoteId: string
  name: string
  type: LabelType
  color?: string | null
}

/** System label ids that always exist, in the order the sidebar renders them. */
export const DEFAULT_SYSTEM_LABELS: LabelInput[] = [
  { remoteId: SYSTEM_LABELS.inbox, name: 'INBOX', type: 'system' },
  { remoteId: SYSTEM_LABELS.sent, name: 'SENT', type: 'system' },
  { remoteId: SYSTEM_LABELS.drafts, name: 'DRAFT', type: 'system' },
  { remoteId: SYSTEM_LABELS.trash, name: 'TRASH', type: 'system' },
  { remoteId: SYSTEM_LABELS.spam, name: 'SPAM', type: 'system' },
  { remoteId: SYSTEM_LABELS.unread, name: 'UNREAD', type: 'system' },
  { remoteId: SYSTEM_LABELS.starred, name: 'STARRED', type: 'system' }
]

function toLabel(row: LabelRow): Label {
  return {
    id: row.id,
    accountId: row.account_id,
    remoteId: row.remote_id,
    name: row.name,
    parentId: row.parent_id,
    type: row.type,
    color: row.color
  }
}

export class LabelRepo {
  constructor(private readonly db: Db) {}

  list(accountId: string): Label[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM labels WHERE account_id = ? ORDER BY CASE type WHEN 'system' THEN 0 ELSE 1 END, name ASC`
      )
      .all(accountId) as LabelRow[]
    return rows.map(toLabel)
  }

  byId(labelId: string): Label | null {
    const row = this.db.prepare('SELECT * FROM labels WHERE id = ?').get(labelId) as
      LabelRow | undefined
    return row ? toLabel(row) : null
  }

  get(accountId: string, remoteId: string): Label | null {
    const row = this.db
      .prepare('SELECT * FROM labels WHERE account_id = ? AND remote_id = ?')
      .get(accountId, remoteId) as LabelRow | undefined
    return row ? toLabel(row) : null
  }

  /**
   * Replaces the label set of an account. Hierarchy is derived from Gmail's
   * `Parent/Child` naming convention, so nesting survives without extra API calls.
   */
  replaceAll(accountId: string, labels: LabelInput[]): void {
    const insert = this.db.prepare(
      `INSERT INTO labels (id, account_id, remote_id, name, parent_id, type, color)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, parent_id = excluded.parent_id,
         type = excluded.type, color = excluded.color`
    )
    const byName = new Map<string, string>()
    for (const label of labels) byName.set(label.name, labelKey(accountId, label.remoteId))

    this.db.transaction(() => {
      const keep = new Set(labels.map((l) => labelKey(accountId, l.remoteId)))
      const existing = this.db
        .prepare('SELECT id FROM labels WHERE account_id = ?')
        .all(accountId) as Array<{ id: string }>
      for (const row of existing) {
        if (!keep.has(row.id)) this.db.prepare('DELETE FROM labels WHERE id = ?').run(row.id)
      }
      for (const label of labels) {
        const slash = label.name.lastIndexOf('/')
        const parentName = slash > 0 ? label.name.slice(0, slash) : null
        const parentId = parentName ? (byName.get(parentName) ?? null) : null
        insert.run(
          labelKey(accountId, label.remoteId),
          accountId,
          label.remoteId,
          label.name,
          parentId,
          label.type,
          label.color ?? null
        )
      }
    })()
  }

  /**
   * Inserts or updates a single label, deriving its parent from the
   * `Parent/Child` name the same way a full sync would.
   */
  upsert(accountId: string, input: LabelInput): Label {
    const id = labelKey(accountId, input.remoteId)
    const slash = input.name.lastIndexOf('/')
    const parentName = slash > 0 ? input.name.slice(0, slash) : null
    const parent = parentName
      ? (this.db
          .prepare('SELECT id FROM labels WHERE account_id = ? AND name = ?')
          .get(accountId, parentName) as { id: string } | undefined)
      : undefined
    this.db
      .prepare(
        `INSERT INTO labels (id, account_id, remote_id, name, parent_id, type, color)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, parent_id = excluded.parent_id,
           type = excluded.type, color = excluded.color`
      )
      .run(
        id,
        accountId,
        input.remoteId,
        input.name,
        parent?.id ?? null,
        input.type,
        input.color ?? null
      )
    const label = this.get(accountId, input.remoteId)
    if (!label) throw new Error('Label konnte nicht angelegt werden')
    return label
  }

  /**
   * Renames a label, keeping its remote id. The name doubles as the hierarchy
   * path, so the parent link is derived again from the new name.
   */
  rename(labelId: string, name: string): Label {
    const row = this.db
      .prepare(
        'SELECT account_id AS accountId, remote_id AS remoteId, type, color FROM labels WHERE id = ?'
      )
      .get(labelId) as
      { accountId: string; remoteId: string; type: LabelType; color: string | null } | undefined
    if (!row) throw new Error('Label existiert nicht')
    return this.upsert(row.accountId, {
      remoteId: row.remoteId,
      name,
      type: row.type,
      color: row.color
    })
  }

  /**
   * Drops a label and every message's link to it. `message_labels` has no
   * foreign key on the label, so its rows go first.
   */
  remove(labelId: string): void {
    this.db.prepare('DELETE FROM message_labels WHERE label_id = ?').run(labelId)
    this.db.prepare('UPDATE labels SET parent_id = NULL WHERE parent_id = ?').run(labelId)
    this.db.prepare('DELETE FROM labels WHERE id = ?').run(labelId)
  }

  ensureSystemLabels(accountId: string): void {
    const insert = this.db.prepare(
      `INSERT INTO labels (id, account_id, remote_id, name, parent_id, type, color)
       VALUES (?, ?, ?, ?, NULL, 'system', NULL)
       ON CONFLICT(id) DO NOTHING`
    )
    this.db.transaction(() => {
      for (const label of DEFAULT_SYSTEM_LABELS) {
        insert.run(labelKey(accountId, label.remoteId), accountId, label.remoteId, label.name)
      }
    })()
  }

  listWithCounts(accountId: string): LabelWithCounts[] {
    const unreadId = labelKey(accountId, SYSTEM_LABELS.unread)
    const trashId = labelKey(accountId, SYSTEM_LABELS.trash)
    const spamId = labelKey(accountId, SYSTEM_LABELS.spam)
    const rows = this.db
      .prepare(
        `SELECT l.*,
            (SELECT COUNT(*) FROM message_labels ml WHERE ml.label_id = l.id) AS total,
            (SELECT COUNT(*) FROM message_labels ml
              WHERE ml.label_id = l.id
                AND EXISTS (SELECT 1 FROM message_labels u
                             WHERE u.message_id = ml.message_id AND u.label_id = @unread)
                AND NOT EXISTS (SELECT 1 FROM message_labels t
                             WHERE t.message_id = ml.message_id AND t.label_id IN (@trash, @spam))
            ) AS unread
         FROM labels l
         WHERE l.account_id = @accountId
         ORDER BY CASE l.type WHEN 'system' THEN 0 ELSE 1 END, l.name ASC`
      )
      .all({ accountId, unread: unreadId, trash: trashId, spam: spamId }) as Array<
      LabelRow & { total: number; unread: number }
    >
    return rows.map((row) => ({ ...toLabel(row), total: row.total, unread: row.unread }))
  }
}
