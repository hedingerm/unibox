import { emailDomain, isSharedDomain } from '@shared/email-domain'
import type { RemoteImageDecision, RemoteImageTrust, RemoteImageTrustKind } from '@shared/types'
import type { Db } from '../index'

const RECIPIENT_KINDS = "('to', 'cc', 'bcc')"

/**
 * Decides which senders may load their remote images without being asked.
 *
 * Blocking buys two things and no more: the sender does not learn that the mail
 * was opened, and does not see the IP it was opened from — the request itself
 * is already stripped of cookies and referrer in the main process. Against
 * somebody the user has written to themselves, neither is worth a click, so
 * correspondence is what earns the trust. Everybody else is asked once, and the
 * answer is remembered here.
 */
export class RemoteImageRepo {
  constructor(private readonly db: Db) {}

  list(): RemoteImageTrust[] {
    const rows = this.db
      .prepare('SELECT kind, value, created_at FROM remote_image_trust ORDER BY created_at DESC')
      .all() as Array<{ kind: RemoteImageTrustKind; value: string; created_at: number }>
    return rows.map((row) => ({ kind: row.kind, value: row.value, createdAt: row.created_at }))
  }

  trust(kind: RemoteImageTrustKind, value: string): void {
    const normalized = normalize(kind, value)
    if (!normalized) return
    this.db
      .prepare(
        `INSERT INTO remote_image_trust (kind, value, created_at) VALUES (?, ?, ?)
         ON CONFLICT(kind, value) DO NOTHING`
      )
      .run(kind, normalized, Date.now())
  }

  revoke(kind: RemoteImageTrustKind, value: string): void {
    this.db
      .prepare('DELETE FROM remote_image_trust WHERE kind = ? AND value = ?')
      .run(kind, normalize(kind, value))
  }

  /**
   * One verdict per distinct sender of a thread. Taking the thread as a whole
   * matters: once the user has answered in it, every party to the conversation
   * already knows they are reading it, so withholding images from the rest of
   * it protects nothing and only costs a click.
   */
  decideForThread(threadId: string, senders: string[]): Map<string, RemoteImageDecision> {
    const answered = Boolean(
      this.db
        .prepare("SELECT 1 FROM messages WHERE thread_id = ? AND direction = 'outgoing' LIMIT 1")
        .get(threadId)
    )

    const decisions = new Map<string, RemoteImageDecision>()
    for (const sender of senders) {
      const email = sender.trim().toLowerCase()
      decisions.set(email, answered || this.allowsSender(email) ? 'allow' : 'ask')
    }
    return decisions
  }

  /** Whether this address has earned unasked image loading on its own. */
  allowsSender(email: string): boolean {
    const address = email.trim().toLowerCase()
    if (!address.includes('@')) return false
    const domain = emailDomain(address)

    if (this.isTrusted('sender', address) || this.isTrusted('domain', domain)) return true
    if (this.isSelf(address, domain)) return true
    if (this.hasWrittenTo(address)) return true
    return !isSharedDomain(domain) && this.hasWrittenToDomain(domain)
  }

  private isTrusted(kind: RemoteImageTrustKind, value: string): boolean {
    if (!value) return false
    return Boolean(
      this.db
        .prepare('SELECT 1 FROM remote_image_trust WHERE kind = ? AND value = ? LIMIT 1')
        .get(kind, value)
    )
  }

  /** The user's own mail — their accounts, their identities, their domains. */
  private isSelf(address: string, domain: string): boolean {
    const rows = this.db
      .prepare('SELECT email FROM accounts UNION SELECT email FROM identities')
      .all() as Array<{ email: string }>
    return rows.some((row) => {
      const own = row.email.trim().toLowerCase()
      if (!own.includes('@')) return false
      return own === address || (!isSharedDomain(domain) && emailDomain(own) === domain)
    })
  }

  private hasWrittenTo(address: string): boolean {
    return Boolean(
      this.db
        .prepare(
          `SELECT 1 FROM message_addresses ma JOIN messages m ON m.id = ma.message_id
           WHERE ma.email = ? AND ma.kind IN ${RECIPIENT_KINDS} AND m.direction = 'outgoing'
           LIMIT 1`
        )
        .get(address)
    )
  }

  private hasWrittenToDomain(domain: string): boolean {
    if (!domain) return false
    return Boolean(
      this.db
        .prepare(
          `SELECT 1 FROM message_addresses ma JOIN messages m ON m.id = ma.message_id
           WHERE substr(ma.email, instr(ma.email, '@') + 1) = ?
             AND ma.kind IN ${RECIPIENT_KINDS} AND m.direction = 'outgoing'
           LIMIT 1`
        )
        .get(domain)
    )
  }
}

/** A domain is stored bare, an address in full — both lowercased. */
function normalize(kind: RemoteImageTrustKind, value: string): string {
  const trimmed = value.trim().toLowerCase().replace(/^@/, '')
  return kind === 'domain' ? emailDomain(`x@${trimmed}`) : trimmed
}
