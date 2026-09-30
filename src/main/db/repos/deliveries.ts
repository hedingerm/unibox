import type { Delivery, DeliveryListArgs, DeliverySummary } from '@shared/admin'
import type { Db } from '../index'

interface DeliveryRow {
  remote_id: string
  domain: string
  from_email: string
  to_json: string
  subject: string
  sent_at: number
  last_event: string | null
  updated_at: number
  message_id: string | null
}

export interface DeliveryInput {
  remoteId: string
  domain: string
  from: string
  to: string[]
  subject: string
  sentAt: number
  lastEvent: string | null
}

function toDelivery(row: DeliveryRow): Delivery {
  let to: string[] = []
  try {
    const parsed: unknown = JSON.parse(row.to_json)
    if (Array.isArray(parsed)) to = parsed.filter((v): v is string => typeof v === 'string')
  } catch {
    // Unreadable recipients are shown as none.
  }
  return {
    remoteId: row.remote_id,
    domain: row.domain,
    from: row.from_email,
    to,
    subject: row.subject,
    sentAt: row.sent_at,
    lastEvent: row.last_event,
    updatedAt: row.updated_at,
    messageId: row.message_id
  }
}

/**
 * Delivery status of mail sent through Resend, as the sent list last reported
 * it. The local message is joined in by remote id where there is one.
 */
export class DeliveryRepo {
  constructor(private readonly db: Db) {}

  /** Returns whether the row is new — pagination walks on while it finds some. */
  upsert(input: DeliveryInput): { created: boolean; changed: boolean } {
    const existing = this.db
      .prepare('SELECT last_event FROM deliveries WHERE remote_id = ?')
      .get(input.remoteId) as { last_event: string | null } | undefined
    if (existing && existing.last_event === input.lastEvent) return { created: false, changed: false }
    const now = Date.now()
    this.db
      .prepare(
        `INSERT INTO deliveries (remote_id, domain, from_email, to_json, subject, sent_at,
           last_event, updated_at)
         VALUES (@remoteId, @domain, @from, @to, @subject, @sentAt, @lastEvent, @now)
         ON CONFLICT(remote_id) DO UPDATE SET
           last_event = COALESCE(excluded.last_event, deliveries.last_event),
           updated_at = excluded.updated_at`
      )
      .run({
        remoteId: input.remoteId,
        domain: input.domain,
        from: input.from,
        to: JSON.stringify(input.to),
        subject: input.subject,
        sentAt: input.sentAt,
        lastEvent: input.lastEvent,
        now
      })
    return { created: !existing, changed: true }
  }

  get(remoteId: string): Delivery | null {
    const row = this.db
      .prepare(`${this.select()} WHERE d.remote_id = ?`)
      .get(remoteId) as DeliveryRow | undefined
    return row ? toDelivery(row) : null
  }

  private select(): string {
    // Resend ids are unique across accounts, so the first local copy is it.
    return `SELECT d.*, (SELECT m.id FROM messages m JOIN accounts a ON a.id = m.account_id
                         WHERE m.remote_id = d.remote_id AND a.kind = 'resend' LIMIT 1) AS message_id
            FROM deliveries d`
  }

  private where(args: Pick<DeliveryListArgs, 'status' | 'domain'>, params: Record<string, unknown>): string {
    const conditions: string[] = []
    if (args.status === 'unknown') {
      conditions.push('d.last_event IS NULL')
    } else if (args.status) {
      conditions.push('d.last_event = @status')
      params.status = args.status
    }
    if (args.domain) {
      conditions.push('d.domain = @domain')
      params.domain = args.domain.toLowerCase()
    }
    return conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
  }

  list(args: DeliveryListArgs = {}): Delivery[] {
    const params: Record<string, unknown> = {
      limit: Math.max(1, Math.min(args.limit ?? 100, 500)),
      offset: args.offset ?? 0
    }
    const rows = this.db
      .prepare(
        `${this.select()} ${this.where(args, params)}
         ORDER BY d.sent_at DESC, d.remote_id DESC LIMIT @limit OFFSET @offset`
      )
      .all(params) as DeliveryRow[]
    return rows.map(toDelivery)
  }

  summary(args: { domain?: string | null; since?: number | null } = {}): DeliverySummary {
    const params: Record<string, unknown> = {}
    let where = this.where({ domain: args.domain }, params)
    if (args.since) {
      where += `${where ? ' AND' : 'WHERE'} d.sent_at >= @since`
      params.since = args.since
    }
    const rows = this.db
      .prepare(
        `SELECT COALESCE(d.last_event, 'unknown') AS event, COUNT(*) AS n FROM deliveries d
         ${where} GROUP BY event`
      )
      .all(params) as Array<{ event: string; n: number }>
    const byStatus: Record<string, number> = {}
    let total = 0
    for (const row of rows) {
      byStatus[row.event] = row.n
      total += row.n
    }
    return { total, byStatus }
  }
}
