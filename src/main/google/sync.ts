import type { SyncStatus } from '@shared/types'
import { SYSTEM_LABELS } from '@shared/types'
import type { Store } from '../db/store'
import { attachmentKey, messageKey, threadKey } from '../db/ids'
import type { GmailClient, GmailLabel } from './client'
import { GmailApiError, MAX_BATCH_SIZE } from './client'
import { parseGmailMessage } from './parse'

export interface GmailSyncOptions {
  pageSize?: number
  onProgress?: (status: SyncStatus) => void
  /** Guard rail for tests; the app syncs the complete history. */
  maxMessages?: number
  /** Sub-requests per batch; Gmail caps this at 100. */
  batchSize?: number
  /** How often a rate-limited message is re-requested before it is skipped. */
  batchRetries?: number
}

export interface GmailSyncResult {
  /** Remote ids touched by this cycle: added, deleted or relabelled. */
  changed: string[]
  /**
   * Remote ids of messages this cycle put on disk for the first time. Only
   * these can be new mail; everything else in `changed` is an update to
   * something we already had.
   */
  imported: string[]
  resynced: boolean
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size))
  }
  return chunks
}

const INITIAL_CURSOR = 'gmail:initial'
const INITIAL_TOTAL = 'gmail:initialTotal'
/** Set once a reconcile has run; mailboxes from before it existed get one. */
const RECONCILED = 'gmail:reconciled'

function labelType(label: GmailLabel): 'system' | 'user' {
  return label.type === 'user' ? 'user' : 'system'
}

export class GmailSync {
  constructor(
    private readonly store: Store,
    private readonly accountId: string,
    private readonly client: GmailClient,
    private readonly options: GmailSyncOptions = {}
  ) {}

  private progress(status: Omit<SyncStatus, 'accountId'>): void {
    this.options.onProgress?.({ accountId: this.accountId, ...status })
  }

  async syncLabels(): Promise<void> {
    const response = await this.client.listLabels()
    const labels = response.labels ?? []
    this.store.labels.replaceAll(
      this.accountId,
      labels.map((label) => ({
        remoteId: label.id,
        name: label.name,
        type: labelType(label),
        color: label.color?.backgroundColor ?? null
      }))
    )
    this.store.labels.ensureSystemLabels(this.accountId)
  }

  /**
   * Aliases still awaiting verification come along: they carry a signature, and
   * dropping them would lose it — plus the local edits on the row — until the
   * confirmation arrives. They are marked unverified instead, which keeps them
   * out of the sender picker.
   */
  async syncSendAs(): Promise<void> {
    const response = await this.client.listSendAs()
    const entries = response.sendAs ?? []
    const account = this.store.accounts.get(this.accountId)
    this.store.identities.replaceGmailIdentities(
      this.accountId,
      entries.map((entry) => ({
        accountId: this.accountId,
        name: entry.displayName || (account?.displayName ?? entry.sendAsEmail),
        email: entry.sendAsEmail,
        signatureHtml: entry.signature ? entry.signature : null,
        isDefault: Boolean(entry.isDefault ?? entry.isPrimary),
        verified: entry.verificationStatus !== 'pending'
      }))
    )
  }

  /** Addresses this account can legitimately send from (primary + aliases). */
  ownAddresses(): string[] {
    const account = this.store.accounts.get(this.accountId)
    const identities = this.store.identities.listForAccount(this.accountId)
    return [account?.email, ...identities.filter((i) => i.verified).map((i) => i.email)].filter(
      (value): value is string => Boolean(value)
    )
  }

  /**
   * One batch round trip, with a follow-up round for the sub-answers that were
   * merely throttled. A message Gmail refuses for good (deleted meanwhile, no
   * access) is dropped rather than stalling the whole import.
   */
  private async fetchBatch(ids: string[]): Promise<Parameters<typeof parseGmailMessage>[0][]> {
    const collected: Parameters<typeof parseGmailMessage>[0][] = []
    let outstanding = ids
    const maxRounds = (this.options.batchRetries ?? 3) + 1

    for (let round = 0; round < maxRounds && outstanding.length > 0; round += 1) {
      const results = await this.client.batchGetMessages(outstanding)
      const retry: string[] = []
      for (const result of results) {
        if (result.message) collected.push(result.message)
        else if (result.error?.isRetryable) retry.push(result.id)
      }
      outstanding = retry
    }

    return collected
  }

  /**
   * @returns whether this put a message on disk that was not there before —
   * which is what separates newly arrived mail from an update to a message we
   * already hold, and therefore what may raise a notification.
   */
  private async importMessage(remoteId: string): Promise<boolean> {
    const known = this.store.messages.getByRemoteId(this.accountId, remoteId) !== null
    let raw: Parameters<typeof parseGmailMessage>[0]
    try {
      raw = await this.client.getMessage(remoteId, 'full')
    } catch (error) {
      // Gone again by the time we ask — a draft Gmail replaced on autosave, or
      // mail deleted for good. Its own `messagesDeleted` record may lie beyond
      // this history page, so it is dropped here. Letting the 404 escape would
      // read as an expired history and trigger a resync that never prunes.
      if (error instanceof GmailApiError && error.status === 404) {
        this.store.messages.remove(messageKey(this.accountId, remoteId))
        return false
      }
      throw error
    }
    this.persist(raw)
    return !known && this.store.messages.getByRemoteId(this.accountId, remoteId) !== null
  }

  private persist(raw: Parameters<typeof parseGmailMessage>[0]): void {
    const parsed = parseGmailMessage(raw)
    const own = new Set(this.ownAddresses().map((a) => a.toLowerCase()))
    const id = messageKey(this.accountId, parsed.remoteId)
    // Gmail hands drafts out as ordinary thread messages. They are editing
    // state, not mail — the drafts table owns them, and letting one in here
    // would make every unfinished reply look like a sent answer.
    if (parsed.labelIds.includes(SYSTEM_LABELS.drafts)) {
      this.store.messages.remove(id)
      return
    }
    this.store.messages.upsert({
      id,
      accountId: this.accountId,
      threadId: threadKey(this.accountId, parsed.threadRemoteId),
      remoteId: parsed.remoteId,
      messageIdHeader: parsed.messageIdHeader,
      inReplyTo: parsed.inReplyTo,
      references: parsed.references,
      subject: parsed.subject,
      from: parsed.from,
      to: parsed.to,
      cc: parsed.cc,
      bcc: parsed.bcc,
      replyTo: parsed.replyTo,
      date: parsed.date,
      snippet: parsed.snippet,
      direction:
        parsed.labelIds.includes(SYSTEM_LABELS.sent) || own.has(parsed.from.email.toLowerCase())
          ? 'outgoing'
          : 'incoming',
      autoReply: parsed.autoReply,
      labelRemoteIds: parsed.labelIds,
      body: parsed.body,
      attachments: parsed.attachments.map((attachment) => ({
        id: attachmentKey(id, attachment.partId),
        filename: attachment.filename,
        mimeType: attachment.mimeType,
        size: attachment.size,
        remoteAttachmentId: attachment.attachmentId,
        contentId: attachment.contentId,
        inline: attachment.inline,
        downloaded: false
      }))
    })
  }

  /**
   * Downloads the complete mailbox. The history id is taken *before* the first
   * page so that anything arriving during the run is picked up by the following
   * incremental sync instead of being lost.
   */
  async initialSync(): Promise<void> {
    const profile = await this.client.getProfile()
    const startHistoryId =
      this.store.cursors.get(this.accountId, 'gmail:startHistoryId') ?? profile.historyId
    this.store.cursors.set(this.accountId, 'gmail:startHistoryId', startHistoryId)

    await this.syncLabels()
    await this.syncSendAs()

    const storedTotal = this.store.cursors.get(this.accountId, INITIAL_TOTAL)
    const total = storedTotal ? Number(storedTotal) : profile.messagesTotal
    this.store.cursors.set(this.accountId, INITIAL_TOTAL, String(total))

    let pageToken = this.store.cursors.get(this.accountId, INITIAL_CURSOR) ?? undefined
    let processed = this.store.messages.countByLabelRemoteId(SYSTEM_LABELS.inbox, this.accountId)
    let imported = 0

    const batchSize = Math.min(this.options.batchSize ?? MAX_BATCH_SIZE, MAX_BATCH_SIZE)

    for (;;) {
      const page = await this.client.listMessages({
        pageToken,
        maxResults: this.options.pageSize ?? 100,
        includeSpamTrash: true
      })

      // Anything already on disk is skipped, which is what makes a restart mid
      // import cheap and free of duplicates.
      let wanted = (page.messages ?? [])
        .filter((item) => !this.store.messages.getByRemoteId(this.accountId, item.id))
        .map((item) => item.id)
      if (this.options.maxMessages) {
        wanted = wanted.slice(0, Math.max(0, this.options.maxMessages - imported))
      }

      for (const ids of chunk(wanted, batchSize)) {
        const fetched = await this.fetchBatch(ids)
        for (const message of fetched) {
          this.persist(message)
          processed += 1
          imported += 1
          if (imported % 25 === 0) {
            this.progress({ phase: 'initial', processed, total, message: null })
          }
        }
      }

      if (this.options.maxMessages && imported >= this.options.maxMessages) break
      if (!page.nextPageToken) break
      pageToken = page.nextPageToken
      this.store.cursors.set(this.accountId, INITIAL_CURSOR, pageToken)
    }

    this.store.cursors.set(this.accountId, INITIAL_CURSOR, null)
    this.store.accounts.update(this.accountId, {
      initialSyncDone: true,
      historyId: startHistoryId,
      lastSyncedAt: Date.now(),
      status: 'ok'
    })
    this.progress({ phase: 'idle', processed, total, message: null })
  }

  private async listAllIds(labelId?: string): Promise<string[]> {
    const ids: string[] = []
    let pageToken: string | undefined
    do {
      const page = await this.client.listMessages({
        pageToken,
        maxResults: 500,
        labelIds: labelId ? [labelId] : undefined,
        includeSpamTrash: true
      })
      for (const item of page.messages ?? []) ids.push(item.id)
      pageToken = page.nextPageToken
    } while (pageToken)
    return ids
  }

  /**
   * Brings the messages already on disk back in line with Gmail. The import
   * skips anything it holds, so after a resync this is what applies the
   * deletions and label changes the lost history would have carried. It only
   * lists ids — once overall, once per label — instead of fetching every
   * message; whatever changes meanwhile is replayed by the next history run.
   */
  async reconcile(): Promise<void> {
    const remote = new Map<string, string[]>()
    for (const id of await this.listAllIds()) remote.set(id, [])
    for (const label of this.store.labels.list(this.accountId)) {
      for (const id of await this.listAllIds(label.remoteId)) remote.get(id)?.push(label.remoteId)
    }
    this.store.messages.reconcileRemote(this.accountId, remote)
    this.store.cursors.set(this.accountId, RECONCILED, '1')
  }

  /** Applies `history.list` deltas; falls back to a full resync when the cursor expired. */
  async incrementalSync(): Promise<GmailSyncResult> {
    const account = this.store.accounts.get(this.accountId)
    if (!account?.historyId || !account.initialSyncDone) {
      await this.initialSync()
      return { changed: [], imported: [], resynced: true }
    }

    const changed = new Set<string>()
    const imported = new Set<string>()
    let pageToken: string | undefined
    let latestHistoryId = account.historyId

    try {
      for (;;) {
        const page = await this.client.listHistory({
          startHistoryId: account.historyId,
          pageToken
        })
        for (const record of page.history ?? []) {
          latestHistoryId = record.id
          for (const added of record.messagesAdded ?? []) {
            if (await this.importMessage(added.message.id)) imported.add(added.message.id)
            changed.add(added.message.id)
          }
          for (const deleted of record.messagesDeleted ?? []) {
            this.store.messages.remove(messageKey(this.accountId, deleted.message.id))
            changed.add(deleted.message.id)
          }
          for (const change of [...(record.labelsAdded ?? []), ...(record.labelsRemoved ?? [])]) {
            const local = this.store.messages.getByRemoteId(this.accountId, change.message.id)
            const current = new Set(change.message.labelIds ?? [])
            if (!local) {
              // A message we do not hold yet turning up in a label change is
              // still an arrival: the `messagesAdded` record for it fell off
              // the end of the history window.
              if (await this.importMessage(change.message.id)) imported.add(change.message.id)
            } else if (current.has(SYSTEM_LABELS.drafts)) {
              // Turned back into a draft at Gmail; the drafts table takes over.
              this.store.messages.remove(local.id)
            } else {
              this.store.messages.setLabelRemoteIds(local.id, this.accountId, [...current])
            }
            changed.add(change.message.id)
          }
        }
        if (page.historyId) latestHistoryId = page.historyId
        if (!page.nextPageToken) break
        pageToken = page.nextPageToken
      }
    } catch (error) {
      if (error instanceof GmailApiError && error.isHistoryExpired) {
        this.store.accounts.update(this.accountId, { historyId: null, initialSyncDone: false })
        this.store.cursors.set(this.accountId, 'gmail:startHistoryId', null)
        await this.initialSync()
        await this.reconcile()
        // A resync re-reads the whole mailbox: none of it is news, so it
        // reports nothing as imported.
        return { changed: [], imported: [], resynced: true }
      }
      throw error
    }

    this.store.accounts.update(this.accountId, {
      historyId: latestHistoryId,
      lastSyncedAt: Date.now(),
      status: 'ok'
    })
    return { changed: [...changed], imported: [...imported], resynced: false }
  }

  async sync(): Promise<GmailSyncResult> {
    const account = this.store.accounts.get(this.accountId)
    if (!account?.initialSyncDone) {
      await this.initialSync()
      return { changed: [], imported: [], resynced: true }
    }
    await this.syncLabels()
    // Gmail has no history entries for settings, so the sendAs list is simply
    // re-read: without it a signature edited in Gmail, or an alias added there,
    // would never reach a mailbox that is already imported.
    await this.syncSendAs()
    const result = await this.incrementalSync()
    if (!result.resynced && !this.store.cursors.get(this.accountId, RECONCILED)) {
      await this.reconcile()
    }
    return result
  }

  /** Fetches an attachment on first open and caches it on disk. */
  async downloadAttachment(
    attachmentId: string,
    writeFile: (data: Buffer, filename: string) => Promise<string>
  ): Promise<string> {
    const attachment = this.store.messages.attachment(attachmentId)
    if (!attachment) throw new Error(`Unbekannter Anhang ${attachmentId}`)
    if (attachment.downloaded && attachment.filePath) return attachment.filePath
    const message = this.store.messages.get(attachment.messageId)
    if (!message) throw new Error(`Unbekannte Nachricht zu Anhang ${attachmentId}`)
    if (!attachment.remoteAttachmentId) throw new Error('Anhang ohne Remote-ID')
    const remote = await this.client.getAttachment(message.remoteId, attachment.remoteAttachmentId)
    const data = Buffer.from(remote.data.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
    const path = await writeFile(data, attachment.filename)
    this.store.messages.markAttachmentDownloaded(attachmentId, path, data.byteLength)
    return path
  }
}
