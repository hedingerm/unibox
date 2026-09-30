import type { OutboxAttachment, OutboxDraft, OutboxItem, OutboxState } from '@shared/types'
import type { EmailAddress } from '@shared/types'
import type { Db } from '../index'
import { newId } from '../ids'

interface OutboxRow {
  id: string
  account_id: string
  identity_name: string
  identity_email: string
  to_json: string
  cc_json: string
  bcc_json: string
  subject: string
  html: string
  text: string
  attachments_json: string
  reply_to_message_id: string | null
  follow_up_days: number | null
  state: OutboxState
  send_at: number
  attempts: number
  last_error: string | null
  created_at: number
  sent_message_id: string | null
}

function parse<T>(json: string, fallback: T): T {
  try {
    return JSON.parse(json) as T
  } catch {
    return fallback
  }
}

function toItem(row: OutboxRow): OutboxItem {
  return {
    id: row.id,
    accountId: row.account_id,
    identityName: row.identity_name,
    identityEmail: row.identity_email,
    to: parse<EmailAddress[]>(row.to_json, []),
    cc: parse<EmailAddress[]>(row.cc_json, []),
    bcc: parse<EmailAddress[]>(row.bcc_json, []),
    subject: row.subject,
    html: row.html,
    text: row.text,
    attachments: parse<OutboxAttachment[]>(row.attachments_json, []),
    replyToMessageId: row.reply_to_message_id,
    followUpDays: row.follow_up_days,
    state: row.state,
    sendAt: row.send_at,
    attempts: row.attempts,
    lastError: row.last_error,
    createdAt: row.created_at,
    sentMessageId: row.sent_message_id
  }
}

export class OutboxRepo {
  constructor(private readonly db: Db) {}

  create(draft: OutboxDraft, state: OutboxState, sendAt: number): OutboxItem {
    const id = newId()
    this.db
      .prepare(
        `INSERT INTO outbox (id, account_id, identity_name, identity_email, to_json, cc_json,
           bcc_json, subject, html, text, attachments_json, reply_to_message_id, follow_up_days,
           state, send_at, created_at)
         VALUES (@id, @accountId, @identityName, @identityEmail, @toJson, @ccJson, @bccJson,
           @subject, @html, @text, @attachmentsJson, @replyToMessageId, @followUpDays, @state,
           @sendAt, @createdAt)`
      )
      .run({
        id,
        accountId: draft.accountId,
        identityName: draft.identityName,
        identityEmail: draft.identityEmail,
        toJson: JSON.stringify(draft.to),
        ccJson: JSON.stringify(draft.cc),
        bccJson: JSON.stringify(draft.bcc),
        subject: draft.subject,
        html: draft.html,
        text: draft.text,
        attachmentsJson: JSON.stringify(draft.attachments),
        replyToMessageId: draft.replyToMessageId,
        // Older rows predate the column and read back as `null` — no reminder,
        // which is the right answer for a mail sent before the feature existed.
        followUpDays: draft.followUpDays ?? null,
        state,
        sendAt,
        createdAt: Date.now()
      })
    return this.get(id)!
  }

  get(id: string): OutboxItem | null {
    const row = this.db.prepare('SELECT * FROM outbox WHERE id = ?').get(id) as
      | OutboxRow
      | undefined
    return row ? toItem(row) : null
  }

  list(): OutboxItem[] {
    const rows = this.db
      .prepare(`SELECT * FROM outbox WHERE state NOT IN ('sent', 'cancelled') ORDER BY send_at ASC`)
      .all() as OutboxRow[]
    return rows.map(toItem)
  }

  all(): OutboxItem[] {
    return (this.db.prepare('SELECT * FROM outbox ORDER BY created_at ASC').all() as OutboxRow[]).map(
      toItem
    )
  }

  /** Everything whose send moment has arrived and that is not already in flight. */
  due(now: number): OutboxItem[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM outbox WHERE state IN ('undoable', 'scheduled') AND send_at <= ?
         ORDER BY send_at ASC`
      )
      .all(now) as OutboxRow[]
    return rows.map(toItem)
  }

  setState(id: string, state: OutboxState, extra?: { lastError?: string | null; sentMessageId?: string | null }): void {
    this.db
      .prepare(
        `UPDATE outbox SET state = ?, last_error = COALESCE(?, last_error),
           sent_message_id = COALESCE(?, sent_message_id) WHERE id = ?`
      )
      .run(state, extra?.lastError ?? null, extra?.sentMessageId ?? null, id)
  }

  incrementAttempts(id: string, error: string, nextSendAt: number): void {
    this.db
      .prepare(
        `UPDATE outbox SET attempts = attempts + 1, last_error = ?, send_at = ?, state = 'scheduled'
         WHERE id = ?`
      )
      .run(error, nextSendAt, id)
  }

  /** Puts a permanently failed mail back in the queue, due immediately. */
  retry(id: string, sendAt: number): boolean {
    const item = this.get(id)
    if (!item || item.state !== 'failed') return false
    this.db
      .prepare(
        `UPDATE outbox SET state = 'scheduled', send_at = ?, attempts = 0, last_error = NULL
         WHERE id = ?`
      )
      .run(sendAt, id)
    return true
  }

  /** Drops a failed mail for good; it stays in the table as history. */
  discard(id: string): boolean {
    const item = this.get(id)
    if (!item || item.state === 'sent') return false
    this.db.prepare(`UPDATE outbox SET state = 'cancelled' WHERE id = ?`).run(id)
    return true
  }

  /** Mails still waiting to go out — the number the offline banner reports. */
  pendingCount(): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM outbox WHERE state IN ('undoable', 'scheduled', 'sending')`
      )
      .get() as { n: number }
    return row.n
  }

  cancel(id: string): boolean {
    const item = this.get(id)
    if (!item) return false
    if (item.state !== 'undoable' && item.state !== 'scheduled') return false
    this.db.prepare(`UPDATE outbox SET state = 'cancelled' WHERE id = ?`).run(id)
    return true
  }
}
