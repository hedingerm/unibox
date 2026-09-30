import type {
  Attachment,
  EmailAddress,
  Message,
  MessageBody,
  MessageDirection,
  ThreadDetail,
  ThreadSummary
} from '@shared/types'
import { SYSTEM_LABELS } from '@shared/types'
import type { Db } from '../index'
import { labelKey } from '../ids'
import { containsLike } from '../sql'
import { draftSnippet } from './drafts'
import type { RemoteImageRepo } from './remote-images'

interface MessageRow {
  id: string
  account_id: string
  thread_id: string
  remote_id: string
  message_id_header: string | null
  in_reply_to: string | null
  refs: string
  subject: string
  from_name: string | null
  from_email: string
  to_json: string
  cc_json: string
  bcc_json: string
  reply_to_json: string
  date: number
  snippet: string
  has_attachments: number
  direction: MessageDirection
  auto_reply: number
  created_at: number
}

interface AttachmentRow {
  id: string
  message_id: string
  filename: string
  mime_type: string
  size: number
  remote_attachment_id: string | null
  content_id: string | null
  inline: number
  file_path: string | null
  downloaded: number
}

export interface AttachmentInput {
  id: string
  filename: string
  mimeType: string
  size: number
  remoteAttachmentId?: string | null
  contentId?: string | null
  inline?: boolean
  filePath?: string | null
  downloaded?: boolean
}

/** What the archive holds on one address. */
export interface Correspondence {
  /** Every mail exchanged with the address, not just the ones carried below. */
  count: number
  lastAt: number | null
  /** The most recent ones, newest first. */
  messages: Message[]
}

/** Mailboxes that never read what is sent to them, as LIKE patterns. */
const AUTOMATED_ADDRESS_PATTERNS = [
  '%noreply%',
  '%no-reply%',
  '%no_reply%',
  '%donotreply%',
  '%do-not-reply%',
  '%mailer-daemon%',
  '%postmaster@%'
]


/** Correspondence inside this window counts fully; older mail is damped. */
const RECENT_MS = 30 * 24 * 60 * 60 * 1000
const STALE_MS = 180 * 24 * 60 * 60 * 1000

/**
 * Narrows a thread list to what local mailboxes show. `recipients` keeps mail
 * addressed (To/Cc) to one of the addresses; `unassigned` keeps Resend mail
 * addressed to none of its domain's mailboxes.
 */
export interface RecipientFilter {
  recipients?: string[] | null
  unassigned?: boolean
}

/** Which header an address came out of. */
export type AddressKind = 'from' | 'to' | 'cc' | 'bcc' | 'reply_to'

export interface UpsertMessageInput {
  id: string
  accountId: string
  threadId: string
  remoteId: string
  messageIdHeader?: string | null
  inReplyTo?: string | null
  references?: string[]
  subject: string
  from: EmailAddress
  to?: EmailAddress[]
  cc?: EmailAddress[]
  bcc?: EmailAddress[]
  replyTo?: EmailAddress[]
  date: number
  snippet?: string
  direction?: MessageDirection
  /** Machine-generated mail: an absence notice, a list blast, a bounce. */
  autoReply?: boolean
  labelRemoteIds: string[]
  body?: MessageBody
  attachments?: AttachmentInput[]
}

function parseAddresses(json: string): EmailAddress[] {
  try {
    const parsed: unknown = JSON.parse(json)
    return Array.isArray(parsed) ? (parsed as EmailAddress[]) : []
  } catch {
    return []
  }
}

function toMessage(row: MessageRow, labelIds: string[]): Message {
  return {
    id: row.id,
    accountId: row.account_id,
    threadId: row.thread_id,
    remoteId: row.remote_id,
    messageIdHeader: row.message_id_header,
    inReplyTo: row.in_reply_to,
    references: row.refs ? row.refs.split(' ').filter(Boolean) : [],
    subject: row.subject,
    from: { name: row.from_name, email: row.from_email },
    to: parseAddresses(row.to_json),
    cc: parseAddresses(row.cc_json),
    bcc: parseAddresses(row.bcc_json),
    replyTo: parseAddresses(row.reply_to_json),
    date: row.date,
    snippet: row.snippet,
    hasAttachments: row.has_attachments === 1,
    direction: row.direction,
    autoReply: row.auto_reply === 1,
    storedAt: row.created_at,
    labelIds
  }
}

function toAttachment(row: AttachmentRow): Attachment {
  return {
    id: row.id,
    messageId: row.message_id,
    filename: row.filename,
    mimeType: row.mime_type,
    size: row.size,
    remoteAttachmentId: row.remote_attachment_id,
    contentId: row.content_id,
    inline: row.inline === 1,
    filePath: row.file_path,
    downloaded: row.downloaded === 1
  }
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim()
}

export function bodyToPlainText(body: MessageBody | undefined): string {
  if (!body) return ''
  if (body.text && body.text.trim()) return body.text
  if (body.html) return stripHtml(body.html)
  return ''
}

export function makeSnippet(body: MessageBody | undefined, fallback = ''): string {
  const text = bodyToPlainText(body) || fallback
  return text.slice(0, 200)
}

export class MessageRepo {
  constructor(
    private readonly db: Db,
    private readonly remoteImages: RemoteImageRepo
  ) {}

  private labelIdsFor(accountId: string, remoteIds: string[]): string[] {
    return remoteIds.map((remoteId) => labelKey(accountId, remoteId))
  }

  upsert(input: UpsertMessageInput): void {
    const now = Date.now()
    const references = (input.references ?? []).join(' ')
    const attachments = input.attachments ?? []
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO threads (id, account_id, remote_id, subject, last_message_at)
           VALUES (@id, @accountId, @remoteId, @subject, @date)
           ON CONFLICT(id) DO UPDATE SET
             last_message_at = MAX(last_message_at, excluded.last_message_at),
             subject = CASE WHEN threads.subject = '' THEN excluded.subject ELSE threads.subject END`
        )
        .run({
          id: input.threadId,
          accountId: input.accountId,
          remoteId: input.threadId,
          subject: input.subject,
          date: input.date
        })

      this.db
        .prepare(
          `INSERT INTO messages (id, account_id, thread_id, remote_id, message_id_header,
             in_reply_to, refs, subject, from_name, from_email, to_json, cc_json, bcc_json,
             reply_to_json, date, snippet, has_attachments, direction, auto_reply,
             created_at, updated_at)
           VALUES (@id, @accountId, @threadId, @remoteId, @messageIdHeader, @inReplyTo, @refs,
             @subject, @fromName, @fromEmail, @toJson, @ccJson, @bccJson, @replyToJson, @date,
             @snippet, @hasAttachments, @direction, @autoReply, @now, @now)
           ON CONFLICT(id) DO UPDATE SET
             thread_id = excluded.thread_id,
             message_id_header = excluded.message_id_header,
             in_reply_to = excluded.in_reply_to,
             refs = excluded.refs,
             subject = excluded.subject,
             from_name = excluded.from_name,
             from_email = excluded.from_email,
             to_json = excluded.to_json,
             cc_json = excluded.cc_json,
             bcc_json = excluded.bcc_json,
             reply_to_json = excluded.reply_to_json,
             date = excluded.date,
             snippet = excluded.snippet,
             has_attachments = excluded.has_attachments,
             direction = excluded.direction,
             auto_reply = excluded.auto_reply,
             updated_at = excluded.updated_at`
        )
        .run({
          id: input.id,
          accountId: input.accountId,
          threadId: input.threadId,
          remoteId: input.remoteId,
          messageIdHeader: input.messageIdHeader ?? null,
          inReplyTo: input.inReplyTo ?? null,
          refs: references,
          subject: input.subject,
          fromName: input.from.name,
          fromEmail: input.from.email,
          toJson: JSON.stringify(input.to ?? []),
          ccJson: JSON.stringify(input.cc ?? []),
          bccJson: JSON.stringify(input.bcc ?? []),
          replyToJson: JSON.stringify(input.replyTo ?? []),
          date: input.date,
          snippet: input.snippet ?? makeSnippet(input.body),
          hasAttachments: attachments.some((a) => !a.inline) ? 1 : 0,
          direction: input.direction ?? 'incoming',
          autoReply: input.autoReply ? 1 : 0,
          now
        })

      if (input.body) {
        this.db
          .prepare(
            `INSERT INTO bodies (message_id, html, text) VALUES (?, ?, ?)
             ON CONFLICT(message_id) DO UPDATE SET html = excluded.html, text = excluded.text`
          )
          .run(input.id, input.body.html, input.body.text)
      }

      this.setLabelsInternal(input.id, this.labelIdsFor(input.accountId, input.labelRemoteIds))
      this.setAddresses(input)

      for (const attachment of attachments) {
        this.db
          .prepare(
            `INSERT INTO attachments (id, message_id, filename, mime_type, size,
               remote_attachment_id, content_id, inline, file_path, downloaded)
             VALUES (@id, @messageId, @filename, @mimeType, @size, @remoteAttachmentId,
               @contentId, @inline, @filePath, @downloaded)
             ON CONFLICT(id) DO UPDATE SET
               filename = excluded.filename, mime_type = excluded.mime_type,
               size = excluded.size, remote_attachment_id = excluded.remote_attachment_id,
               content_id = excluded.content_id, inline = excluded.inline,
               file_path = COALESCE(excluded.file_path, attachments.file_path),
               downloaded = MAX(excluded.downloaded, attachments.downloaded)`
          )
          .run({
            id: attachment.id,
            messageId: input.id,
            filename: attachment.filename,
            mimeType: attachment.mimeType,
            size: attachment.size,
            remoteAttachmentId: attachment.remoteAttachmentId ?? null,
            contentId: attachment.contentId ?? null,
            inline: attachment.inline ? 1 : 0,
            filePath: attachment.filePath ?? null,
            downloaded: attachment.downloaded ? 1 : 0
          })
      }

      this.reindex(input.id)
      this.refreshThread(input.threadId)
    })()
  }

  /**
   * Mirrors the message's addresses into their own table, the index behind
   * `from:`/`to:`/`cc:` and the sender autocomplete. Rewritten wholesale on
   * every upsert so a corrected header never leaves a stale row behind.
   */
  private setAddresses(input: UpsertMessageInput): void {
    this.db.prepare('DELETE FROM message_addresses WHERE message_id = ?').run(input.id)
    const insert = this.db.prepare(
      'INSERT OR IGNORE INTO message_addresses (message_id, kind, email, name) VALUES (?, ?, ?, ?)'
    )
    const groups: Array<[AddressKind, EmailAddress[]]> = [
      ['from', [input.from]],
      ['to', input.to ?? []],
      ['cc', input.cc ?? []],
      ['bcc', input.bcc ?? []],
      ['reply_to', input.replyTo ?? []]
    ]
    for (const [kind, addresses] of groups) {
      for (const address of addresses) {
        const email = address.email.trim().toLowerCase()
        if (email.length === 0) continue
        insert.run(input.id, kind, email, address.name ?? null)
      }
    }
  }

  /**
   * Addresses the user has actually corresponded with — what the search box
   * completes `from:`/`to:` from, and what a recipient field offers while a
   * mail is being addressed.
   *
   * The order is how often an address was written to, damped by how long ago
   * that last was: a colleague from this week beats a supplier from two years
   * back even when the supplier has more mail in the archive. Addresses the
   * user themselves put on a message count triple — having written to someone
   * says far more than having been in the same Cc list as them.
   */
  knownAddresses(
    kinds: AddressKind[],
    prefix: string,
    limit = 8,
    options: { forRecipients?: boolean } = {}
  ): EmailAddress[] {
    const pattern = containsLike(prefix.trim().toLowerCase())
    const placeholders = kinds.map(() => '?').join(', ')
    const params: unknown[] = [...kinds, pattern, pattern]
    const conditions: string[] = []
    if (options.forRecipients) {
      // A recipient field is for people. The user's own addresses are reached
      // through the From picker, and nothing sent to a no-reply mailbox ever
      // arrives — offering either is a way to waste a mail.
      const self = this.ownAddresses()
      if (self.length > 0) {
        conditions.push(`ma.email NOT IN (${self.map(() => '?').join(', ')})`)
        params.push(...self)
      }
      conditions.push(
        `NOT EXISTS (SELECT 1 FROM json_each(?) p WHERE ma.email LIKE p.value ESCAPE '\\')`
      )
      params.push(JSON.stringify(AUTOMATED_ADDRESS_PATTERNS))
    }
    const now = Date.now()
    params.push(now - RECENT_MS, now - STALE_MS, limit)
    const rows = this.db
      .prepare(
        `SELECT ma.email AS email, MAX(ma.name) AS name, MAX(m.date) AS last_seen,
                SUM(CASE WHEN m.direction = 'outgoing' AND ma.kind <> 'from' THEN 3 ELSE 1 END) AS weight
         FROM message_addresses ma JOIN messages m ON m.id = ma.message_id
         WHERE ma.kind IN (${placeholders})
           AND (ma.email LIKE ? ESCAPE '\\' OR IFNULL(ma.name, '') LIKE ? ESCAPE '\\')
           ${conditions.map((condition) => `AND ${condition}`).join('\n           ')}
         GROUP BY ma.email
         ORDER BY weight * (CASE WHEN last_seen >= ? THEN 4 WHEN last_seen >= ? THEN 2 ELSE 1 END) DESC,
                  last_seen DESC
         LIMIT ?`
      )
      .all(...params) as Array<{ email: string; name: string | null }>
    return rows.map((row) => ({ name: row.name, email: row.email }))
  }

  /**
   * Mail exchanged with one address, newest first — what the assistant knows
   * about a recipient when there is no conversation to answer. Trash, spam,
   * drafts and machine replies stay out: none of them says anything about how
   * these two write to each other.
   */
  correspondenceWith(
    email: string,
    limit = 6,
    direction?: MessageDirection
  ): Correspondence {
    const excluded = [SYSTEM_LABELS.trash, SYSTEM_LABELS.spam, SYSTEM_LABELS.drafts]
      .map((remoteId) => `'${remoteId}'`)
      .join(', ')
    const where = `WHERE EXISTS (SELECT 1 FROM message_addresses ma
                         WHERE ma.message_id = m.id AND ma.email = @address
                           AND ma.kind IN ('from', 'to', 'cc'))
             AND m.auto_reply = 0
             ${direction ? 'AND m.direction = @direction' : ''}
             AND NOT EXISTS (SELECT 1 FROM message_labels x JOIN labels xl ON xl.id = x.label_id
                             WHERE x.message_id = m.id AND xl.remote_id IN (${excluded}))`
    const params = { address: email.trim().toLowerCase(), limit, direction: direction ?? '' }
    const totals = this.db
      .prepare(`SELECT COUNT(*) AS count, MAX(m.date) AS last_at FROM messages m ${where}`)
      .get(params) as { count: number; last_at: number | null }
    const rows = this.db
      .prepare(`SELECT m.* FROM messages m ${where} ORDER BY m.date DESC LIMIT @limit`)
      .all(params) as MessageRow[]
    return {
      count: totals.count,
      lastAt: totals.last_at ?? null,
      messages: rows.map((row) => toMessage(row, this.labelIdsOf(row.id)))
    }
  }

  /** The user's own addresses: accounts plus every identity they send as. */
  ownAddresses(): string[] {
    const rows = this.db
      .prepare('SELECT email FROM accounts UNION SELECT email FROM identities')
      .all() as Array<{ email: string }>
    return rows.map((row) => row.email.toLowerCase()).filter((email) => email.includes('@'))
  }

  private setLabelsInternal(messageId: string, labelIds: string[]): void {
    this.db.prepare('DELETE FROM message_labels WHERE message_id = ?').run(messageId)
    const insert = this.db.prepare(
      'INSERT OR IGNORE INTO message_labels (message_id, label_id) VALUES (?, ?)'
    )
    for (const labelId of labelIds) insert.run(messageId, labelId)
  }

  setLabelRemoteIds(messageId: string, accountId: string, remoteIds: string[]): void {
    this.setLabelsInternal(messageId, this.labelIdsFor(accountId, remoteIds))
  }

  addLabels(messageIds: string[], labelIds: string[]): void {
    const insert = this.db.prepare(
      'INSERT OR IGNORE INTO message_labels (message_id, label_id) VALUES (?, ?)'
    )
    this.db.transaction(() => {
      for (const messageId of messageIds) {
        for (const labelId of labelIds) insert.run(messageId, labelId)
      }
    })()
  }

  removeLabels(messageIds: string[], labelIds: string[]): void {
    const remove = this.db.prepare(
      'DELETE FROM message_labels WHERE message_id = ? AND label_id = ?'
    )
    this.db.transaction(() => {
      for (const messageId of messageIds) {
        for (const labelId of labelIds) remove.run(messageId, labelId)
      }
    })()
  }

  labelIdsOf(messageId: string): string[] {
    return (
      this.db
        .prepare('SELECT label_id FROM message_labels WHERE message_id = ?')
        .all(messageId) as Array<{ label_id: string }>
    ).map((r) => r.label_id)
  }

  reindex(messageId: string): void {
    const row = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId) as
      MessageRow | undefined
    if (!row) return
    const body = this.db
      .prepare('SELECT html, text FROM bodies WHERE message_id = ?')
      .get(messageId) as { html: string | null; text: string | null } | undefined
    const participants = [
      row.from_name ?? '',
      row.from_email,
      ...parseAddresses(row.to_json).flatMap((a) => [a.name ?? '', a.email]),
      ...parseAddresses(row.cc_json).flatMap((a) => [a.name ?? '', a.email])
    ]
      .filter(Boolean)
      .join(' ')
    this.db.prepare('DELETE FROM messages_fts WHERE message_id = ?').run(messageId)
    this.db
      .prepare(
        `INSERT INTO messages_fts (message_id, account_id, subject, participants, body)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(
        messageId,
        row.account_id,
        row.subject,
        participants,
        bodyToPlainText(body ? { html: body.html, text: body.text } : undefined)
      )
  }

  refreshThread(threadId: string): void {
    const row = this.db
      .prepare('SELECT MAX(date) AS last, COUNT(*) AS n FROM messages WHERE thread_id = ?')
      .get(threadId) as { last: number | null; n: number }
    if (row.n === 0) {
      this.db.prepare('DELETE FROM threads WHERE id = ?').run(threadId)
      return
    }
    this.db
      .prepare('UPDATE threads SET last_message_at = ? WHERE id = ?')
      .run(row.last ?? 0, threadId)
  }

  /** Re-parents messages when late-arriving headers reveal a shared conversation. */
  moveToThread(messageIds: string[], threadId: string): void {
    if (messageIds.length === 0) return
    this.db.transaction(() => {
      const previous = new Set<string>()
      for (const messageId of messageIds) {
        const row = this.db
          .prepare('SELECT thread_id FROM messages WHERE id = ?')
          .get(messageId) as { thread_id: string } | undefined
        if (row) previous.add(row.thread_id)
        this.db.prepare('UPDATE messages SET thread_id = ? WHERE id = ?').run(threadId, messageId)
      }
      for (const old of previous) if (old !== threadId) this.refreshThread(old)
      this.refreshThread(threadId)
    })()
  }

  /** Messages whose In-Reply-To/References mention the given RFC Message-ID. */
  findReferencing(accountId: string, headerId: string): Message[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM messages
         WHERE account_id = ? AND (in_reply_to = ? OR refs LIKE ?)`
      )
      .all(accountId, headerId, `%${headerId}%`) as MessageRow[]
    return rows.map((row) => toMessage(row, this.labelIdsOf(row.id)))
  }

  get(messageId: string): Message | null {
    const row = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId) as
      MessageRow | undefined
    return row ? toMessage(row, this.labelIdsOf(messageId)) : null
  }

  getByRemoteId(accountId: string, remoteId: string): Message | null {
    const row = this.db
      .prepare('SELECT * FROM messages WHERE account_id = ? AND remote_id = ?')
      .get(accountId, remoteId) as MessageRow | undefined
    return row ? toMessage(row, this.labelIdsOf(row.id)) : null
  }

  findByHeaderMessageId(accountId: string, headerId: string): Message | null {
    const row = this.db
      .prepare('SELECT * FROM messages WHERE account_id = ? AND message_id_header = ?')
      .get(accountId, headerId) as MessageRow | undefined
    return row ? toMessage(row, this.labelIdsOf(row.id)) : null
  }

  remove(messageId: string): void {
    const row = this.db.prepare('SELECT thread_id FROM messages WHERE id = ?').get(messageId) as
      { thread_id: string } | undefined
    this.db.prepare('DELETE FROM messages WHERE id = ?').run(messageId)
    if (row) this.refreshThread(row.thread_id)
  }

  /**
   * Messages that arrived without a body. Resend's list endpoints only return
   * metadata, so its mail is imported first and filled in afterwards.
   */
  listWithoutBody(
    accountId: string,
    limit: number
  ): Array<{ id: string; remoteId: string; direction: MessageDirection }> {
    return this.db
      .prepare(
        `SELECT m.id AS id, m.remote_id AS remoteId, m.direction AS direction FROM messages m
         LEFT JOIN bodies b ON b.message_id = m.id
         WHERE m.account_id = ?
           AND COALESCE(NULLIF(b.html, ''), NULLIF(b.text, '')) IS NULL
         ORDER BY m.date DESC LIMIT ?`
      )
      .all(accountId, limit) as Array<{
      id: string
      remoteId: string
      direction: MessageDirection
    }>
  }

  setBody(messageId: string, body: MessageBody): void {
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO bodies (message_id, html, text) VALUES (?, ?, ?)
           ON CONFLICT(message_id) DO UPDATE SET html = excluded.html, text = excluded.text`
        )
        .run(messageId, body.html, body.text)
      this.db
        .prepare('UPDATE messages SET snippet = ?, updated_at = ? WHERE id = ?')
        .run(makeSnippet(body), Date.now(), messageId)
      this.reindex(messageId)
    })()
  }

  body(messageId: string): MessageBody {
    const row = this.db
      .prepare('SELECT html, text FROM bodies WHERE message_id = ?')
      .get(messageId) as { html: string | null; text: string | null } | undefined
    return { html: row?.html ?? null, text: row?.text ?? null }
  }

  attachments(messageId: string): Attachment[] {
    const rows = this.db
      .prepare('SELECT * FROM attachments WHERE message_id = ? ORDER BY rowid')
      .all(messageId) as AttachmentRow[]
    return rows.map(toAttachment)
  }

  attachment(attachmentId: string): Attachment | null {
    const row = this.db.prepare('SELECT * FROM attachments WHERE id = ?').get(attachmentId) as
      AttachmentRow | undefined
    return row ? toAttachment(row) : null
  }

  /** Every attachment currently on disk, with what it would take to refetch it. */
  downloadedAttachments(): Array<{
    id: string
    filePath: string
    accountId: string
    remoteAttachmentId: string | null
  }> {
    const rows = this.db
      .prepare(
        `SELECT a.id AS id, a.file_path AS file_path, m.account_id AS account_id,
                a.remote_attachment_id AS remote_attachment_id
         FROM attachments a
         JOIN messages m ON m.id = a.message_id
         WHERE a.downloaded = 1 AND a.file_path IS NOT NULL`
      )
      .all() as Array<{
      id: string
      file_path: string
      account_id: string
      remote_attachment_id: string | null
    }>
    return rows.map((row) => ({
      id: row.id,
      filePath: row.file_path,
      accountId: row.account_id,
      remoteAttachmentId: row.remote_attachment_id
    }))
  }

  /** Forgets the local copy; the payload is fetched again on next open. */
  markAttachmentCleared(attachmentId: string): void {
    this.db
      .prepare('UPDATE attachments SET file_path = NULL, downloaded = 0 WHERE id = ?')
      .run(attachmentId)
  }

  markAttachmentDownloaded(attachmentId: string, filePath: string, size: number): void {
    this.db
      .prepare('UPDATE attachments SET file_path = ?, downloaded = 1, size = ? WHERE id = ?')
      .run(filePath, size, attachmentId)
  }

  listThreadIds(args: {
    accountId?: string | null
    labelRemoteId?: string | null
    labelId?: string | null
    limit?: number
    offset?: number
  } & RecipientFilter): string[] {
    const limit = args.limit ?? 100
    const offset = args.offset ?? 0
    const conditions: string[] = []
    const params: Record<string, unknown> = { limit, offset }
    this.recipientConditions(args, conditions, params)

    if (args.labelId) {
      conditions.push('ml.label_id = @labelId')
      params.labelId = args.labelId
    } else {
      const remoteId = args.labelRemoteId ?? SYSTEM_LABELS.inbox
      conditions.push('l.remote_id = @labelRemoteId')
      params.labelRemoteId = remoteId
    }
    if (args.accountId) {
      conditions.push('m.account_id = @accountId')
      params.accountId = args.accountId
    }

    const selectedRemote = args.labelRemoteId ?? null
    const showsTrash = selectedRemote === SYSTEM_LABELS.trash
    const showsSpam = selectedRemote === SYSTEM_LABELS.spam
    const excluded: string[] = []
    if (!showsTrash) excluded.push(`'${SYSTEM_LABELS.trash}'`)
    if (!showsSpam) excluded.push(`'${SYSTEM_LABELS.spam}'`)
    if (excluded.length > 0) {
      conditions.push(
        `NOT EXISTS (SELECT 1 FROM message_labels x JOIN labels xl ON xl.id = x.label_id
          WHERE x.message_id = m.id AND xl.remote_id IN (${excluded.join(', ')}))`
      )
    }

    // Sorted by the conversation's own last message, not by the newest one
    // carrying the selected label: a thread that got an answer after being
    // archived shows that answer's date in the row, and would otherwise sit
    // at its old position while claiming to be from today.
    const rows = this.db
      .prepare(
        `SELECT m.thread_id AS thread_id,
                (SELECT MAX(t.date) FROM messages t WHERE t.thread_id = m.thread_id) AS last_date
         FROM messages m
         JOIN message_labels ml ON ml.message_id = m.id
         JOIN labels l ON l.id = ml.label_id
         WHERE ${conditions.join(' AND ')}
         GROUP BY m.thread_id
         ORDER BY last_date DESC, m.thread_id DESC
         LIMIT @limit OFFSET @offset`
      )
      .all(params) as Array<{ thread_id: string }>
    return rows.map((r) => r.thread_id)
  }

  /**
   * The address filters behind local mailboxes. Both look at the message that
   * carries the label, so a mailbox lists a conversation for as long as the
   * mail addressed to it is in the selected label.
   */
  private recipientConditions(
    filter: RecipientFilter,
    conditions: string[],
    params: Record<string, unknown>
  ): void {
    if (filter.recipients) {
      conditions.push(
        `EXISTS (SELECT 1 FROM message_addresses ra WHERE ra.message_id = m.id
           AND ra.kind IN ('to', 'cc')
           AND ra.email IN (SELECT value FROM json_each(@recipients)))`
      )
      params.recipients = JSON.stringify(filter.recipients.map((a) => a.trim().toLowerCase()))
    }
    if (filter.unassigned) {
      // Catch-all mail no mailbox claims: incoming Resend mail addressed to
      // none of its domain's mailbox addresses or aliases.
      conditions.push(
        `m.direction = 'incoming'
         AND EXISTS (SELECT 1 FROM accounts ua WHERE ua.id = m.account_id AND ua.kind = 'resend')
         AND NOT EXISTS (SELECT 1 FROM message_addresses ra WHERE ra.message_id = m.id
           AND ra.kind IN ('to', 'cc')
           AND ra.email IN (SELECT mb.address FROM mailboxes mb WHERE mb.account_id = m.account_id
                            UNION
                            SELECT al.address FROM mailbox_aliases al
                              JOIN mailboxes mb ON mb.id = al.mailbox_id
                             WHERE mb.account_id = m.account_id))`
      )
    }
  }

  /**
   * Unread messages in the inbox, narrowed like a mailbox view — the number
   * next to a mailbox in the sidebar. Messages, not threads, to match what the
   * label rows count.
   */
  countUnreadInbox(filter: RecipientFilter & { accountId?: string | null }): number {
    const conditions: string[] = [
      `EXISTS (SELECT 1 FROM message_labels il JOIN labels ill ON ill.id = il.label_id
               WHERE il.message_id = m.id AND ill.remote_id = '${SYSTEM_LABELS.inbox}')`,
      `EXISTS (SELECT 1 FROM message_labels ul JOIN labels ull ON ull.id = ul.label_id
               WHERE ul.message_id = m.id AND ull.remote_id = '${SYSTEM_LABELS.unread}')`
    ]
    const params: Record<string, unknown> = {}
    if (filter.accountId) {
      conditions.push('m.account_id = @accountId')
      params.accountId = filter.accountId
    }
    this.recipientConditions(filter, conditions, params)
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM messages m WHERE ${conditions.join(' AND ')}`)
      .get(params) as { n: number }
    return row.n
  }

  /**
   * The most recent incoming messages of the given accounts, newest first —
   * what a routing rule is dry-run against.
   */
  recentIncoming(accountIds: string[], limit: number): Message[] {
    if (accountIds.length === 0) return []
    const rows = this.db
      .prepare(
        `SELECT m.* FROM messages m
         WHERE m.direction = 'incoming'
           AND m.account_id IN (SELECT value FROM json_each(?))
         ORDER BY m.date DESC LIMIT ?`
      )
      .all(JSON.stringify(accountIds), limit) as MessageRow[]
    return rows.map((row) => toMessage(row, this.labelIdsOf(row.id)))
  }

  /** Messages per direction dated at or after `since`, drafts aside. */
  countSince(since: number): { incoming: number; outgoing: number } {
    const rows = this.db
      .prepare(
        `SELECT m.direction AS direction, COUNT(*) AS n FROM messages m
         WHERE m.date >= ?
           AND NOT EXISTS (SELECT 1 FROM message_labels x JOIN labels xl ON xl.id = x.label_id
                           WHERE x.message_id = m.id AND xl.remote_id = '${SYSTEM_LABELS.drafts}')
         GROUP BY m.direction`
      )
      .all(since) as Array<{ direction: MessageDirection; n: number }>
    return {
      incoming: rows.find((row) => row.direction === 'incoming')?.n ?? 0,
      outgoing: rows.find((row) => row.direction === 'outgoing')?.n ?? 0
    }
  }

  /** Marks a remote message as deliberately gone, so a later sync skips it. */
  addTombstone(accountId: string, remoteId: string): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO message_tombstones (account_id, remote_id, created_at)
         VALUES (?, ?, ?)`
      )
      .run(accountId, remoteId, Date.now())
  }

  isTombstoned(accountId: string, remoteId: string): boolean {
    return Boolean(
      this.db
        .prepare('SELECT 1 FROM message_tombstones WHERE account_id = ? AND remote_id = ?')
        .get(accountId, remoteId)
    )
  }

  threadSummaries(threadIds: string[]): ThreadSummary[] {
    return threadIds
      .map((threadId) => this.threadSummary(threadId))
      .filter((t): t is ThreadSummary => t !== null)
  }

  /**
   * The unfinished reply waiting in a conversation, newest first. Drafts live
   * in their own table rather than among the messages, so the list has to ask
   * for one instead of finding it as the thread's last message.
   */
  private draftOfThread(threadId: string): ThreadSummary['draft'] {
    const row = this.db
      .prepare(
        `SELECT d.id AS id, d.html AS html FROM drafts d
         JOIN messages m ON m.id = d.reply_to_message_id
         WHERE m.thread_id = ? ORDER BY d.updated_at DESC LIMIT 1`
      )
      .get(threadId) as { id: string; html: string } | undefined
    return row ? { id: row.id, snippet: draftSnippet(row.html) } : null
  }

  threadSummary(threadId: string): ThreadSummary | null {
    const rows = this.db
      .prepare('SELECT * FROM messages WHERE thread_id = ? ORDER BY date ASC')
      .all(threadId) as MessageRow[]
    if (rows.length === 0) return null
    const last = rows[rows.length - 1]!
    const accountId = last.account_id
    const unreadLabel = labelKey(accountId, SYSTEM_LABELS.unread)
    const starredLabel = labelKey(accountId, SYSTEM_LABELS.starred)
    const labelSets = rows.map((row) => this.labelIdsOf(row.id))
    const unread = labelSets.some((ids) => ids.includes(unreadLabel))
    const starred = labelSets.some((ids) => ids.includes(starredLabel))
    const participants = new Map<string, EmailAddress>()
    for (const row of rows)
      participants.set(row.from_email, { name: row.from_name, email: row.from_email })
    const subject = rows.find((r) => r.subject)?.subject ?? ''
    return {
      threadId,
      accountId,
      subject,
      snippet: last.snippet,
      lastMessageAt: last.date,
      messageCount: rows.length,
      unread,
      starred,
      hasAttachments: rows.some((r) => r.has_attachments === 1),
      participants: [...participants.values()],
      lastFrom: { name: last.from_name, email: last.from_email },
      lastDirection: last.direction,
      draft: this.draftOfThread(threadId),
      snoozedUntil: this.snoozedUntil(threadId),
      followUp: this.followUpOf(threadId)
    }
  }

  /**
   * The wake time of a put-aside conversation. Read here rather than joined in
   * the list query, because a snoozed row shows up in every mailbox it still
   * belongs to — search results included — not only in the snooze view.
   */
  private snoozedUntil(threadId: string): number | null {
    const row = this.db.prepare('SELECT wake_at FROM snoozes WHERE thread_id = ?').get(threadId) as
      | { wake_at: number }
      | undefined
    return row ? row.wake_at : null
  }

  /**
   * The answer a conversation is still waiting for. Like the draft marker this
   * is a per-row lookup rather than a join: the row is drawn from a summary,
   * and the summary is what has to know.
   */
  private followUpOf(threadId: string): ThreadSummary['followUp'] {
    const row = this.db
      .prepare(
        `SELECT id, due_at, nudge_count FROM follow_ups
         WHERE thread_id = ? AND state = 'open'`
      )
      .get(threadId) as { id: string; due_at: number; nudge_count: number } | undefined
    return row ? { id: row.id, dueAt: row.due_at, nudgeCount: row.nudge_count } : null
  }

  /** Conversations waiting to come back, the one returning soonest first. */
  snoozedThreadIds(accountId?: string | null, limit = 100, offset = 0): string[] {
    const rows = (
      accountId
        ? this.db
            .prepare(
              `SELECT thread_id FROM snoozes WHERE account_id = ?
               ORDER BY wake_at ASC LIMIT ? OFFSET ?`
            )
            .all(accountId, limit, offset)
        : this.db
            .prepare('SELECT thread_id FROM snoozes ORDER BY wake_at ASC LIMIT ? OFFSET ?')
            .all(limit, offset)
    ) as Array<{ thread_id: string }>
    return rows.map((row) => row.thread_id)
  }

  threadDetail(threadId: string): ThreadDetail | null {
    const rows = this.db
      .prepare('SELECT * FROM messages WHERE thread_id = ? ORDER BY date ASC')
      .all(threadId) as MessageRow[]
    if (rows.length === 0) return null
    // Decided once for the thread's distinct senders rather than per message:
    // a long conversation is the same handful of addresses over and over.
    const decisions = this.remoteImages.decideForThread(
      threadId,
      [...new Set(rows.map((row) => row.from_email.trim().toLowerCase()))]
    )
    const messages = rows.map((row) => ({
      ...toMessage(row, this.labelIdsOf(row.id)),
      body: this.body(row.id),
      attachments: this.attachments(row.id),
      remoteImages: decisions.get(row.from_email.trim().toLowerCase()) ?? 'ask'
    }))
    return {
      threadId,
      accountId: rows[0]!.account_id,
      subject: rows.find((r) => r.subject)?.subject ?? '',
      messages
    }
  }

  messagesInThread(threadId: string): Message[] {
    const rows = this.db
      .prepare('SELECT * FROM messages WHERE thread_id = ? ORDER BY date ASC')
      .all(threadId) as MessageRow[]
    return rows.map((row) => toMessage(row, this.labelIdsOf(row.id)))
  }

  /** Most recent messages carrying a label — the examples the settler learns from. */
  messageIdsWithLabel(labelId: string, limit: number): string[] {
    const rows = this.db
      .prepare(
        `SELECT m.id AS id FROM messages m
         JOIN message_labels ml ON ml.message_id = m.id
         WHERE ml.label_id = ? AND m.direction = 'incoming'
         ORDER BY m.date DESC LIMIT ?`
      )
      .all(labelId, limit) as Array<{ id: string }>
    return rows.map((row) => row.id)
  }

  /** Every message carrying a label, optionally narrowed to the unread ones. */
  idsWithLabel(labelId: string, alsoLabelId?: string): string[] {
    const rows = alsoLabelId
      ? (this.db
          .prepare(
            `SELECT ml.message_id AS id FROM message_labels ml
             JOIN message_labels other ON other.message_id = ml.message_id AND other.label_id = ?
             WHERE ml.label_id = ?`
          )
          .all(alsoLabelId, labelId) as Array<{ id: string }>)
      : (this.db
          .prepare('SELECT message_id AS id FROM message_labels WHERE label_id = ?')
          .all(labelId) as Array<{ id: string }>)
    return rows.map((row) => row.id)
  }

  countWithLabel(labelId: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM message_labels WHERE label_id = ?')
      .get(labelId) as { n: number }
    return row.n
  }

  countByLabelRemoteId(remoteId: string, accountId?: string): number {
    const params: unknown[] = [remoteId]
    let sql = `SELECT COUNT(DISTINCT m.thread_id) AS n
       FROM messages m
       JOIN message_labels ml ON ml.message_id = m.id
       JOIN labels l ON l.id = ml.label_id
       WHERE l.remote_id = ?`
    if (accountId) {
      sql += ' AND m.account_id = ?'
      params.push(accountId)
    }
    const row = this.db.prepare(sql).get(...params) as { n: number }
    return row.n
  }
}
