import type { Draft, DraftInput, DraftKind, DraftSummary, OutboxAttachment } from '@shared/types'
import type { Db } from '../index'
import { newId } from '../ids'
import { htmlToText } from '../../mime/build'

interface DraftRow {
  id: string
  account_id: string
  kind: DraftKind
  identity_id: string | null
  identity_name: string
  identity_email: string
  to_text: string
  cc_text: string
  bcc_text: string
  subject: string
  html: string
  attachments_json: string
  reply_to_message_id: string | null
  remote_id: string | null
  remote_message_id: string | null
  remote_updated_at: number | null
  dirty: number
  created_at: number
  updated_at: number
}

/** How much of the body a list row shows. */
const SNIPPET_LENGTH = 140

function parseAttachments(json: string): OutboxAttachment[] {
  try {
    return JSON.parse(json) as OutboxAttachment[]
  } catch {
    return []
  }
}

function toDraft(row: DraftRow): Draft {
  return {
    id: row.id,
    accountId: row.account_id,
    kind: row.kind,
    identityId: row.identity_id,
    identityName: row.identity_name,
    identityEmail: row.identity_email,
    to: row.to_text,
    cc: row.cc_text,
    bcc: row.bcc_text,
    subject: row.subject,
    html: row.html,
    attachments: parseAttachments(row.attachments_json),
    replyToMessageId: row.reply_to_message_id,
    remoteId: row.remote_id,
    remoteMessageId: row.remote_message_id,
    dirty: row.dirty === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export function draftSnippet(html: string): string {
  const text = htmlToText(html).replace(/\s+/g, ' ').trim()
  return text.length > SNIPPET_LENGTH ? `${text.slice(0, SNIPPET_LENGTH)}…` : text
}

export class DraftRepo {
  constructor(private readonly db: Db) {}

  /**
   * Creates the draft on the first save and overwrites it on every later one.
   * A save is a local edit by default, which is what marks it as owed to Gmail;
   * the sync passes `dirty: false` when it writes what Gmail already has.
   */
  save(input: DraftInput, now = Date.now(), options: { dirty?: boolean } = {}): Draft {
    const id = input.id ?? newId()
    this.db
      .prepare(
        `INSERT INTO drafts (id, account_id, kind, identity_id, identity_name, identity_email,
           to_text, cc_text, bcc_text, subject, html, attachments_json, reply_to_message_id,
           dirty, created_at, updated_at)
         VALUES (@id, @accountId, @kind, @identityId, @identityName, @identityEmail, @to, @cc,
           @bcc, @subject, @html, @attachments, @replyToMessageId, @dirty, @now, @now)
         ON CONFLICT(id) DO UPDATE SET
           account_id = excluded.account_id, kind = excluded.kind,
           identity_id = excluded.identity_id, identity_name = excluded.identity_name,
           identity_email = excluded.identity_email, to_text = excluded.to_text,
           cc_text = excluded.cc_text, bcc_text = excluded.bcc_text, subject = excluded.subject,
           html = excluded.html, attachments_json = excluded.attachments_json,
           reply_to_message_id = excluded.reply_to_message_id, updated_at = excluded.updated_at,
           dirty = excluded.dirty`
      )
      .run({
        id,
        accountId: input.accountId,
        kind: input.kind,
        identityId: input.identityId,
        identityName: input.identityName,
        identityEmail: input.identityEmail,
        to: input.to,
        cc: input.cc,
        bcc: input.bcc,
        subject: input.subject,
        html: input.html,
        attachments: JSON.stringify(input.attachments),
        replyToMessageId: input.replyToMessageId,
        dirty: (options.dirty ?? true) ? 1 : 0,
        now
      })
    return this.get(id)!
  }

  get(id: string): Draft | null {
    const row = this.db.prepare('SELECT * FROM drafts WHERE id = ?').get(id) as DraftRow | undefined
    return row ? toDraft(row) : null
  }

  /**
   * Summaries for the whole app, newest first. Body and files stay in the
   * database — the list only needs a line of text, and an attached PDF would
   * otherwise travel over IPC on every refresh.
   */
  list(): DraftSummary[] {
    const rows = this.db
      .prepare(
        `SELECT id, account_id, kind, subject, html, to_text, attachments_json, updated_at
         FROM drafts ORDER BY updated_at DESC`
      )
      .all() as Array<
      Pick<
        DraftRow,
        | 'id'
        | 'account_id'
        | 'kind'
        | 'subject'
        | 'html'
        | 'to_text'
        | 'attachments_json'
        | 'updated_at'
      >
    >
    return rows.map((row) => ({
      id: row.id,
      accountId: row.account_id,
      kind: row.kind,
      subject: row.subject,
      snippet: draftSnippet(row.html),
      to: row.to_text,
      hasAttachments: parseAttachments(row.attachments_json).length > 0,
      updatedAt: row.updated_at
    }))
  }

  remove(id: string): void {
    this.db.prepare('DELETE FROM drafts WHERE id = ?').run(id)
  }

  /** Every draft of one account, for reconciling against Gmail's list. */
  listForAccount(accountId: string): Draft[] {
    const rows = this.db
      .prepare('SELECT * FROM drafts WHERE account_id = ? ORDER BY updated_at DESC')
      .all(accountId) as DraftRow[]
    return rows.map(toDraft)
  }

  byRemoteId(accountId: string, remoteId: string): Draft | null {
    const row = this.db
      .prepare('SELECT * FROM drafts WHERE account_id = ? AND remote_id = ?')
      .get(accountId, remoteId) as DraftRow | undefined
    return row ? toDraft(row) : null
  }

  /** Records where a draft now lives at Gmail; clears what was owed to it. */
  linkRemote(
    id: string,
    remote: { remoteId: string; remoteMessageId: string | null; at: number }
  ): void {
    this.db
      .prepare(
        `UPDATE drafts SET remote_id = ?, remote_message_id = ?, remote_updated_at = ?, dirty = 0
         WHERE id = ?`
      )
      .run(remote.remoteId, remote.remoteMessageId, remote.at, id)
  }

  /**
   * Cuts a draft loose from a Gmail draft that is gone or lost a conflict. It
   * stays owed, so the next push creates it at Gmail as a draft of its own.
   */
  unlinkRemote(id: string): void {
    this.db
      .prepare(
        `UPDATE drafts SET remote_id = NULL, remote_message_id = NULL, remote_updated_at = NULL,
           dirty = 1 WHERE id = ?`
      )
      .run(id)
  }
}
