import { isAutoReplyHeaders } from '@shared/followup'
import type { Account, EmailAddress } from '@shared/types'
import { SYSTEM_LABELS } from '@shared/types'
import type { Store } from '../db/store'
import { attachmentKey, messageKey, threadKey } from '../db/ids'
import { parseAddress, parseAddressList } from '../mime/addresses'
import type {
  ResendAttachmentMeta,
  ResendClient,
  ResendHeaders,
  ResendReceivedEmail,
  ResendSentEmail
} from './client'

export type SaveAttachment = (data: Buffer, filename: string, messageId: string) => Promise<string>

export interface ResendSyncOptions {
  saveAttachment: SaveAttachment
  /** Safety valve for tests and for the very first backfill. */
  maxPages?: number
  pageSize?: number
  /** How many missing bodies are fetched per polling cycle. */
  bodyBackfillPerCycle?: number
}

export function normalizeHeaders(headers: ResendHeaders | undefined): Record<string, string> {
  const result: Record<string, string> = {}
  if (!headers) return result
  if (Array.isArray(headers)) {
    for (const header of headers) result[header.name.toLowerCase()] = header.value
    return result
  }
  for (const [name, value] of Object.entries(headers)) result[name.toLowerCase()] = value
  return result
}

function domainOf(address: string): string {
  const parsed = parseAddress(address)
  const email = parsed?.email ?? address
  const at = email.lastIndexOf('@')
  return at === -1 ? '' : email.slice(at + 1).toLowerCase()
}

function toAddressList(values: string[] | undefined): EmailAddress[] {
  return (values ?? []).flatMap((value) => parseAddressList(value))
}

/** Header a rule forward carries; lower case, as `normalizeHeaders` keys it. */
const FORWARDED_HEADER_KEY = 'x-unibox-forwarded'

export interface ResendPollResult {
  imported: string[]
  updated: string[]
  /**
   * Imported incoming messages that were themselves forwarded by a routing
   * rule. Headers are not kept locally, so this is the only moment the loop
   * guard can see them.
   */
  autoForwarded: string[]
}

export class ResendSync {
  private autoForwarded: string[] = []

  constructor(
    private readonly store: Store,
    private readonly client: ResendClient,
    private readonly options: ResendSyncOptions
  ) {}

  private accountForDomain(domain: string): Account | null {
    return this.store.accounts.findByEmail('resend', domain)
  }

  /**
   * Resolves the conversation a message belongs to using RFC 5322 headers, and
   * adopts messages that already referenced it while it had not arrived yet.
   */
  private resolveThread(
    account: Account,
    messageIdHeader: string | null,
    inReplyTo: string | null,
    references: string[]
  ): { threadId: string; adopt: string[] } {
    const candidates = [inReplyTo, ...references].filter((id): id is string => Boolean(id))
    for (const candidate of candidates) {
      const parent = this.store.messages.findByHeaderMessageId(account.id, candidate)
      if (parent) return { threadId: parent.threadId, adopt: [] }
    }
    const ownId = messageIdHeader ?? null
    const orphans = ownId ? this.store.messages.findReferencing(account.id, ownId) : []
    if (orphans.length > 0) {
      return { threadId: orphans[0]!.threadId, adopt: orphans.map((m) => m.id) }
    }
    return {
      threadId: threadKey(account.id, ownId ?? `local-${Date.now()}-${Math.random()}`),
      adopt: []
    }
  }

  private async importAttachments(
    emailId: string,
    localMessageId: string,
    metas: ResendAttachmentMeta[] | undefined
  ): Promise<Array<{
    id: string
    filename: string
    mimeType: string
    size: number
    contentId: string | null
    inline: boolean
    filePath: string
    downloaded: boolean
  }>> {
    if (!metas || metas.length === 0) return []
    let detailed = metas
    if (metas.some((meta) => !meta.download_url)) {
      const page = await this.client.listReceivedAttachments(emailId)
      const byId = new Map((page.data ?? []).map((item) => [item.id, item]))
      detailed = metas.map((meta) => ({ ...meta, ...(byId.get(meta.id) ?? {}) }))
    }

    const saved = []
    for (const meta of detailed) {
      if (!meta.download_url) continue
      // Resend deletes payloads after 30 days, so they are pulled down immediately.
      const data = await this.client.downloadAttachment(meta.download_url)
      const filePath = await this.options.saveAttachment(data, meta.filename, localMessageId)
      saved.push({
        id: attachmentKey(localMessageId, meta.id),
        filename: meta.filename,
        mimeType: meta.content_type ?? 'application/octet-stream',
        size: meta.size ?? data.byteLength,
        contentId: meta.content_id ?? null,
        inline: Boolean(meta.content_id),
        filePath,
        downloaded: true
      })
    }
    return saved
  }

  /**
   * The list endpoints only carry metadata — body and headers exist solely on
   * the per-message endpoint, so every new message is fetched once in full. A
   * failed detail call must not lose the message, so the summary is kept.
   */
  private async withDetail<T extends ResendReceivedEmail | ResendSentEmail>(
    email: T,
    direction: 'incoming' | 'outgoing'
  ): Promise<T> {
    if (email.html || email.text) return email
    try {
      const detail =
        direction === 'incoming'
          ? await this.client.getReceivedEmail(email.id)
          : await this.client.getSentEmail(email.id)
      return { ...email, ...detail }
    } catch {
      return email
    }
  }

  private async importEmail(
    summary: ResendReceivedEmail | ResendSentEmail,
    direction: 'incoming' | 'outgoing'
  ): Promise<string | null> {
    const recipients = toAddressList(summary.to)
    const from = parseAddress(summary.from) ?? { name: null, email: summary.from }
    const domain =
      direction === 'incoming'
        ? recipients.map((r) => domainOf(r.email)).find((d) => this.accountForDomain(d))
        : domainOf(from.email)
    if (!domain) return null
    const account = this.accountForDomain(domain)
    if (!account) return null

    const localId = messageKey(account.id, summary.id)
    if (this.store.messages.get(localId)) return null
    // Dropped by a rule: Resend still lists it for 30 days, but it stays gone.
    if (this.store.messages.isTombstoned(account.id, summary.id)) return null

    const email = await this.withDetail(summary, direction)
    const headers = normalizeHeaders(email.headers)
    const messageIdHeader = headers['message-id'] ?? `<${email.id}@resend.local>`
    const inReplyTo = headers['in-reply-to'] ?? null
    const references = (headers['references'] ?? '').split(/\s+/).filter(Boolean)
    const { threadId, adopt } = this.resolveThread(account, messageIdHeader, inReplyTo, references)
    if (direction === 'incoming' && headers[FORWARDED_HEADER_KEY]) this.autoForwarded.push(localId)

    const attachments = await this.importAttachments(email.id, localId, email.attachments)

    this.store.messages.upsert({
      id: localId,
      accountId: account.id,
      threadId,
      remoteId: email.id,
      messageIdHeader,
      inReplyTo,
      references,
      subject: email.subject ?? '',
      from,
      to: recipients,
      cc: toAddressList(email.cc),
      bcc: toAddressList(email.bcc),
      replyTo: toAddressList((email as ResendReceivedEmail).reply_to),
      date: Date.parse(email.created_at) || Date.now(),
      direction,
      // The same header check as for Gmail: Resend hands the raw headers out,
      // so an absence notice is recognisable here too.
      autoReply: isAutoReplyHeaders(headers),
      labelRemoteIds:
        direction === 'incoming'
          ? [SYSTEM_LABELS.inbox, SYSTEM_LABELS.unread]
          : [SYSTEM_LABELS.sent],
      body: { html: email.html ?? null, text: email.text ?? null },
      attachments
    })

    if (adopt.length > 0) this.store.messages.moveToThread(adopt, threadId)
    return localId
  }

  /**
   * Keeps the delivery status of every sent mail — including mail from a
   * domain without receiving, which has no account to import it into. The
   * sent list carries `last_event` on each entry, so this costs no request.
   */
  private recordDelivery(email: ResendSentEmail): boolean {
    const from = parseAddress(email.from) ?? { name: null, email: email.from }
    const result = this.store.deliveries.upsert({
      remoteId: email.id,
      domain: domainOf(from.email),
      from: from.email.toLowerCase(),
      to: toAddressList(email.to).map((address) => address.email.toLowerCase()),
      subject: email.subject ?? '',
      sentAt: Date.parse(email.created_at) || Date.now(),
      lastEvent: email.last_event ?? null
    })
    return result.created
  }

  private async importPages<T extends { id: string }>(
    fetchPage: (after?: string) => Promise<{ data: T[]; has_more?: boolean }>,
    importOne: (item: T) => Promise<string | null>,
    /** Records something about every listed item; true when it was new. */
    observe?: (item: T) => boolean
  ): Promise<string[]> {
    const imported: string[] = []
    const maxPages = this.options.maxPages ?? 20
    let after: string | undefined
    for (let page = 0; page < maxPages; page += 1) {
      const response = await fetchPage(after)
      const items = response.data ?? []
      if (items.length === 0) break
      let newInPage = 0
      for (const item of items) {
        const fresh = observe?.(item) ?? false
        const id = await importOne(item)
        if (id) imported.push(id)
        if (id || fresh) newInPage += 1
      }
      after = items[items.length - 1]!.id
      // Once a full page is already known locally, everything older is too.
      if (newInPage === 0) break
      if (!response.has_more) break
    }
    return imported
  }

  /**
   * Fills in bodies that are missing locally — mail imported before the detail
   * fetch existed, or messages whose detail call failed in an earlier cycle.
   * Capped per cycle so a large backlog does not stall the poll.
   */
  private async backfillBodies(account: Account): Promise<string[]> {
    const pending = this.store.messages.listWithoutBody(
      account.id,
      this.options.bodyBackfillPerCycle ?? 50
    )
    const filled: string[] = []
    for (const message of pending) {
      try {
        const detail =
          message.direction === 'incoming'
            ? await this.client.getReceivedEmail(message.remoteId)
            : await this.client.getSentEmail(message.remoteId)
        if (!detail.html && !detail.text) continue
        this.store.messages.setBody(message.id, {
          html: detail.html ?? null,
          text: detail.text ?? null
        })
        filled.push(message.id)
      } catch {
        // Retried on the next cycle; a single unreachable message must not
        // block the ones behind it.
      }
    }
    return filled
  }

  /** One polling cycle: pull inbound and outbound mail for every connected domain. */
  async poll(): Promise<ResendPollResult> {
    this.autoForwarded = []
    const accounts = this.store.accounts.list().filter((a) => a.kind === 'resend')
    if (accounts.length === 0) {
      // No receiving domain, but mail may still be sent from one — its
      // delivery status is worth having all the same.
      await this.importPages(
        (after) => this.client.listSentEmails({ limit: this.options.pageSize ?? 100, after }),
        async () => null,
        (email) => this.recordDelivery(email)
      )
      return { imported: [], updated: [], autoForwarded: [] }
    }

    const limit = this.options.pageSize ?? 100
    const received = await this.importPages(
      (after) => this.client.listReceivedEmails({ limit, after }),
      (email) => this.importEmail(email, 'incoming')
    )
    const sent = await this.importPages(
      (after) => this.client.listSentEmails({ limit, after }),
      (email) => this.importEmail(email, 'outgoing'),
      (email) => this.recordDelivery(email)
    )

    const updated: string[] = []
    for (const account of accounts) updated.push(...(await this.backfillBodies(account)))

    const now = Date.now()
    for (const account of accounts) {
      this.store.accounts.update(account.id, { lastSyncedAt: now, initialSyncDone: true })
    }
    return { imported: [...received, ...sent], updated, autoForwarded: this.autoForwarded }
  }
}
