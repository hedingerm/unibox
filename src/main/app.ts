import { mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  ActivityPage,
  AdminOverview,
  BackupFile,
  Delivery,
  DeliverySummary,
  DomainDetails,
  Mailbox,
  ResendWebhook,
  ResendWebhookCreated,
  RoutingRule,
  RuleTestResult
} from '@shared/admin'
import type {
  AttachmentCacheInfo,
  IpcApi,
  IpcEventName,
  IpcEvents,
  SearchResult
} from '@shared/ipc'
import type {
  Account,
  AiJob,
  AiRequest,
  AppSettings,
  Attachment,
  Draft,
  DraftInput,
  DraftSummary,
  EmailAddress,
  Identity,
  Label,
  LabelWithCounts,
  OutboxDraft,
  OutboxItem,
  RemoteImageTrust,
  ResendDomainInfo,
  SettleApplyResult,
  SettleAvailability,
  SettleDecision,
  SettleReport,
  Signature,
  Snooze,
  SyncStatus,
  Template,
  TemplateInput,
  ThreadSummary
} from '@shared/types'
import { SYSTEM_LABELS } from '@shared/types'
import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENT_MB, mimeTypeForFile } from '@shared/attachments'
import { Store } from './db/store'
import { labelKey, messageKey } from './db/ids'
import type { FetchLike, GoogleOAuthConfig } from './google/auth'
import {
  GoogleAuthClient,
  ReconnectRequiredError,
  createPkcePair,
  startLoopbackServer
} from './google/auth'
import { GmailClient } from './google/client'
import { GmailDraftSync } from './google/drafts'
import { GmailSync } from './google/sync'
import { GoogleTokenManager } from './google/tokens'
import { IdentityService } from './identities'
import { MutationService } from './mutations'
import { ResendClient } from './resend/client'
import { ResendDomainService } from './resend/domains'
import { ResendSync } from './resend/sync'
import type { MxResolver, TxtResolver } from './resend/mx'
import type { SecretStore } from './secrets'
import { TokenVault } from './secrets'
import { SendService } from './send'
import type { ClaudeRunner } from './claude'
import { resolveClaudeBinary } from './claude'
import { SettleService } from './settle'
import { FollowUpService } from './followups'
import { SnoozeService } from './snooze'
import { AiService } from './ai'
import { RoutingService } from './rules'
import { AdminService } from './admin'
import { messageSource } from './source'

/** A button on a notification; it acts on the whole conversation. */
export type NotificationAction = 'archive' | 'read'

export interface NotificationRequest {
  title: string
  body: string
  accountId: string
  threadId: string
  actions?: NotificationAction[]
}

export interface AppEnvironment {
  userDataPath: string
  secrets: SecretStore
  googleOAuth: GoogleOAuthConfig | null
  resolveMx: MxResolver
  /** TXT lookups for the DMARC check; DMARC reads as missing without one. */
  resolveTxt?: TxtResolver
  openExternal: (url: string) => Promise<void>
  notify: (request: NotificationRequest) => void
  emit: <K extends IpcEventName>(name: K, payload: IpcEvents[K]) => void
  pickFiles: () => Promise<string[]>
  /** Opens a local file in the OS' default application for its type. */
  openPath: (path: string) => Promise<void>
  /** Asks where to put a copy of `sourcePath`; resolves null when cancelled. */
  saveFileAs: (defaultName: string, sourcePath: string) => Promise<string | null>
  /** Asks only for a destination path; the caller writes the file itself. */
  chooseSavePath: (defaultName: string) => Promise<string | null>
  /** The system clipboard as text, for the paste the renderer cannot do itself. */
  readClipboard: () => string
  writeClipboard: (text: string) => void
  readFile: (path: string) => Promise<Buffer>
  /**
   * Runs one headless turn of the locally installed Claude Code CLI. `null`
   * when the machine has none — settling is then simply unavailable.
   */
  runClaude?: ClaudeRunner | null
  /** Explicit CLI path for the availability check; falls back to auto-detect. */
  claudeBinaryPath?: string | null
  fetch?: FetchLike
  /** Overridable for tests; the app uses an on-disk database. */
  databaseFile?: string
}

function safeName(name: string): string {
  return name.replace(/[^\w.\- ]+/g, '_').slice(0, 120) || 'anhang'
}

/** A new template as it goes into the library: named, and trimmed of stray space. */
function cleanTemplate(input: TemplateInput): TemplateInput {
  if (!input.name.trim()) throw new Error('Die Vorlage braucht einen Namen.')
  return { ...input, name: input.name.trim(), subject: input.subject.trim() }
}

/** `unibox-backup-2026-08-20.db` — sortable and obvious in a downloads folder. */
export function backupFileName(now: number): string {
  return `unibox-backup-${new Date(now).toISOString().slice(0, 10)}.db`
}

/** Resend mail is polling-only; this keeps its arrival latency tolerable. */
const RESEND_POLL_SECONDS = 15

/**
 * How often each Gmail mailbox is asked whether anything moved at all. One
 * profile read per account — a single quota unit — so new mail shows up within
 * seconds instead of waiting for the full cycle.
 */
const GMAIL_QUICK_CHECK_SECONDS = 15

/**
 * How often snoozed mail is checked for its return. A minute is finer than any
 * wake time a user picks, and the check is two indexed queries.
 */
const SNOOZE_TICK_SECONDS = 60

/** How often the UI is refreshed while a first backfill is running. */
const BACKFILL_REFRESH_MS = 3_000

/** How often the daily backup checks whether one is due. */
const AUTO_BACKUP_TICK_MS = 60 * 60 * 1000

export class UniboxApp {
  readonly store: Store
  readonly vault: TokenVault
  readonly identities: IdentityService
  readonly mutations: MutationService
  readonly send: SendService
  readonly settle: SettleService
  readonly snooze: SnoozeService
  readonly followUps: FollowUpService
  readonly ai: AiService
  readonly routing: RoutingService
  readonly admin: AdminService
  private readonly auth: GoogleAuthClient | null
  private readonly gmailClients = new Map<string, GmailClient>()
  private readonly tokens: GoogleTokenManager | null
  private readonly syncStatus = new Map<string, SyncStatus>()
  private readonly attachmentsPath: string
  private timers: NodeJS.Timeout[] = []
  private syncQueue: Promise<void> = Promise.resolve()
  private lastBackfillRefresh = 0
  private readonly settleRuns = new Map<string, Promise<SettleReport>>()
  private closed = false

  constructor(private readonly env: AppEnvironment) {
    this.store = Store.openFile(env.databaseFile ?? join(env.userDataPath, 'unibox.db'))
    this.attachmentsPath = join(env.userDataPath, 'attachments')
    mkdirSync(this.attachmentsPath, { recursive: true })
    this.vault = new TokenVault(env.secrets)
    this.identities = new IdentityService(this.store)
    this.auth = env.googleOAuth ? new GoogleAuthClient(env.googleOAuth, { fetch: env.fetch }) : null
    this.tokens = this.auth
      ? new GoogleTokenManager(this.auth, this.vault, this.store.accounts)
      : null
    this.mutations = new MutationService(this.store, {
      gmailClientFor: (accountId) => this.gmailClientFor(accountId)
    })
    this.followUps = new FollowUpService(this.store)
    this.send = new SendService(this.store, {
      gmailClientFor: (accountId) => this.gmailClientFor(accountId),
      resendClient: () => this.resendClient(),
      // Pull the message Gmail just created so the thread updates immediately.
      afterGmailSend: async (accountId) => {
        const client = this.gmailClientFor(accountId)
        if (!client) return
        await new GmailSync(this.store, accountId, client).incrementalSync().catch(() => undefined)
      },
      followUps: this.followUps,
      onChange: () => this.env.emit('outbox:changed', { items: this.store.outbox.list() }),
      onSent: (item, remoteId) => {
        const recipients = [...item.to, ...item.cc, ...item.bcc].map((a) => a.email)
        this.store.activity.record({
          kind: 'mail_sent',
          accountId: item.accountId,
          summary: `«${item.subject || '(kein Betreff)'}» an ${recipients.join(', ')} gesendet`,
          meta: {
            outboxId: item.id,
            remoteId,
            from: item.identityEmail,
            to: recipients,
            subject: item.subject
          }
        })
      }
    })
    this.settle = new SettleService(this.store, this.mutations, {
      runClaude: env.runClaude ?? null,
      gmailClientFor: (accountId) => this.gmailClientFor(accountId),
      onProgress: (progress) => this.env.emit('settle:progress', progress)
    })
    this.snooze = new SnoozeService(this.store, this.mutations)
    this.ai = new AiService(this.store, {
      runClaude: env.runClaude ?? null,
      identities: this.identities,
      onChange: (job) => this.env.emit('ai:job', job)
    })
    this.routing = new RoutingService(this.store, {
      mutations: this.mutations,
      resendClient: () => this.resendClient(),
      readFile: env.readFile
    })
    this.admin = new AdminService(this.store, {
      backupsPath: join(env.userDataPath, 'backups'),
      domainService: () => this.domainService()
    })
  }

  // ---------------------------------------------------------------- clients

  /** The Gmail client of one account, `null` for Resend and unlinked accounts. */
  gmailClientFor(accountId: string): GmailClient | null {
    const account = this.store.accounts.get(accountId)
    if (!account || account.kind !== 'google' || !this.tokens) return null
    const cached = this.gmailClients.get(accountId)
    if (cached) return cached
    const client = new GmailClient({
      fetch: this.env.fetch,
      accessToken: () => this.tokens!.accessToken(accountId)
    })
    this.gmailClients.set(accountId, client)
    return client
  }

  private resendClient(): ResendClient | null {
    if (!this.vault.getResendApiKey()) return null
    return new ResendClient({
      apiKey: () => this.vault.getResendApiKey(),
      fetch: this.env.fetch
    })
  }

  private requireResendClient(): ResendClient {
    const client = this.resendClient()
    if (!client) throw new Error('Kein Resend-API-Key hinterlegt')
    return client
  }

  private requireDomainService(): ResendDomainService {
    const service = this.domainService()
    if (!service) throw new Error('Kein Resend-API-Key hinterlegt')
    return service
  }

  private domainService(): ResendDomainService | null {
    const client = this.resendClient()
    if (!client) return null
    return new ResendDomainService(this.store, {
      client,
      resolveMx: this.env.resolveMx,
      resolveTxt: this.env.resolveTxt
    })
  }

  private resendSync(): ResendSync | null {
    const client = this.resendClient()
    if (!client) return null
    return new ResendSync(this.store, client, {
      saveAttachment: (data, filename, messageId) => this.saveAttachment(data, filename, messageId)
    })
  }

  /**
   * Resolves an attachment to a file on disk, fetching it from Gmail on first
   * use. Resend attachments are stored eagerly, so they are always present.
   */
  /**
   * Creates a user label. Gmail owns the id, so it is created there first and
   * only mirrored locally; a Resend domain has no remote label store at all.
   */
  private async createLabel(accountId: string, name: string): Promise<Label> {
    if (!name) throw new Error('Der Labelname darf nicht leer sein')
    const account = this.store.accounts.get(accountId)
    if (!account) throw new Error('Unbekanntes Konto')
    const existing = this.store.labels
      .list(accountId)
      .find((label) => label.name.toLowerCase() === name.toLowerCase())
    if (existing) throw new Error('Ein Label mit diesem Namen existiert bereits')

    if (account.kind === 'google') {
      const client = this.gmailClientFor(accountId)
      if (!client) throw new Error('Kein Gmail-Zugriff für dieses Konto')
      const created = await client.createLabel(name)
      return this.store.labels.upsert(accountId, {
        remoteId: created.id,
        name: created.name,
        type: 'user'
      })
    }
    const remoteId = `LOCAL_${name.replace(/[^\w/]+/g, '_').toUpperCase()}`
    return this.store.labels.upsert(accountId, { remoteId, name, type: 'user' })
  }

  private async materializeAttachment(
    attachmentId: string
  ): Promise<{ attachment: Attachment; filePath: string }> {
    const attachment = this.store.messages.attachment(attachmentId)
    if (!attachment) throw new Error('Unbekannter Anhang')
    if (attachment.downloaded && attachment.filePath) {
      return { attachment, filePath: attachment.filePath }
    }
    const message = this.store.messages.get(attachment.messageId)
    if (!message) throw new Error('Unbekannte Nachricht')
    const client = this.gmailClientFor(message.accountId)
    if (!client) throw new Error('Anhang ist nicht verfügbar')
    const sync = new GmailSync(this.store, message.accountId, client)
    const filePath = await sync.downloadAttachment(attachmentId, (data, filename) =>
      this.saveAttachment(data, filename, attachment.messageId)
    )
    return { attachment, filePath }
  }

  private async saveAttachment(data: Buffer, filename: string, messageId: string): Promise<string> {
    const directory = join(this.attachmentsPath, safeName(messageId))
    mkdirSync(directory, { recursive: true })
    const path = join(directory, safeName(filename))
    writeFileSync(path, data)
    return path
  }

  // ------------------------------------------------------------------ sync

  private setStatus(status: SyncStatus): void {
    this.syncStatus.set(status.accountId, status)
    this.env.emit('sync:progress', status)
    // A first backfill of a large mailbox runs for hours. Without interim
    // refreshes the UI would sit empty the whole time even though messages are
    // already on disk, so nudge it periodically while the import runs.
    const now = Date.now()
    if (status.phase === 'initial' && now - this.lastBackfillRefresh >= BACKFILL_REFRESH_MS) {
      this.lastBackfillRefresh = now
      this.env.emit('data:changed', { accountIds: [status.accountId] })
    }
  }

  /**
   * Accounts still doing their first full backfill. Importing history is not
   * new mail, so it must never raise a notification per imported message.
   */
  private backfillingAccounts(): Set<string> {
    return new Set(
      this.store.accounts
        .list()
        .filter((a) => !a.initialSyncDone)
        .map((a) => a.id)
    )
  }

  private notifyNewMail(messageIds: string[], backfilling: ReadonlySet<string>): void {
    if (!this.store.settings.get().notificationsEnabled) return
    for (const messageId of messageIds) {
      const message = this.store.messages.get(messageId)
      if (!message || message.direction !== 'incoming') continue
      if (backfilling.has(message.accountId)) continue
      const account = this.store.accounts.get(message.accountId)
      if (!account?.notificationsEnabled) continue
      if (!message.labelIds.includes(labelKey(account.id, SYSTEM_LABELS.inbox))) continue
      this.env.notify({
        title: message.from.name ?? message.from.email,
        body: message.subject || message.snippet,
        accountId: account.id,
        threadId: message.threadId,
        actions: ['archive', 'read']
      })
    }
  }

  /** A notification button, applied to the conversation it announced. */
  notificationAction(threadId: string, action: NotificationAction): void {
    const messageIds = this.store.messages.messagesInThread(threadId).map((message) => message.id)
    if (messageIds.length === 0) return
    if (action === 'archive') this.mutations.archive(messageIds)
    else this.mutations.setRead(messageIds, true)
    this.afterMutation()
  }

  /** Syncs are serialised so a manual refresh never races the poll timer. */
  async syncAll(): Promise<void> {
    this.syncQueue = this.syncQueue.then(() => this.runSync()).catch(() => undefined)
    return this.syncQueue
  }

  /** The Resend-only cycle, on the same queue so it never races a full sync. */
  async syncResendAccounts(): Promise<void> {
    this.syncQueue = this.syncQueue.then(() => this.runResendSync()).catch(() => undefined)
    return this.syncQueue
  }

  /** The cheap Gmail check, on the same queue so it never races a full sync. */
  async checkGmail(): Promise<void> {
    this.syncQueue = this.syncQueue.then(() => this.runGmailCheck()).catch(() => undefined)
    return this.syncQueue
  }

  /**
   * Reads each mailbox's current history id and runs the history sync only
   * where it moved. Labels and send-as addresses are left to the full cycle;
   * this is only about getting new mail in fast.
   */
  private async runGmailCheck(): Promise<void> {
    if (this.closed) return
    const changed: string[] = []
    const backfilling = this.backfillingAccounts()
    for (const account of this.store.accounts.list()) {
      if (account.kind !== 'google' || !account.initialSyncDone || !account.historyId) continue
      const client = this.gmailClientFor(account.id)
      if (!client) continue
      try {
        const { historyId } = await client.getProfile()
        if (historyId === account.historyId) continue
        // Local edits go out first, for the same reason as in the full cycle.
        await this.mutations.flush()
        const result = await new GmailSync(this.store, account.id, client).incrementalSync()
        await new GmailDraftSync(this.store, account.id, client).sync()
        changed.push(account.id)
        this.notifyNewMail(
          result.imported.map((remoteId) => messageKey(account.id, remoteId)),
          backfilling
        )
      } catch {
        // Reporting failures is the full cycle's job; the next check retries.
      }
    }
    if (changed.length === 0 || this.closed) return
    // Answers arrive as ordinary mail, so this is the moment a wait can end.
    this.reviewFollowUps()
    this.env.emit('data:changed', { accountIds: changed })
  }

  private async runResendSync(): Promise<void> {
    if (this.closed) return
    const changed = await this.syncResend(this.backfillingAccounts())
    this.reviewFollowUps()
    if (changed.length > 0 && !this.closed) this.env.emit('data:changed', { accountIds: changed })
  }

  private async syncResend(backfilling: ReadonlySet<string>): Promise<string[]> {
    const resendSync = this.resendSync()
    if (!resendSync) return []
    const domains = this.store.accounts.list().filter((account) => account.kind === 'resend')
    try {
      const result = await resendSync.poll()
      for (const account of domains) this.markAccountHealthy(account.id)
      // Rules act before anyone is told about the mail: something a rule
      // archives, trashes or drops must not raise a notification first.
      await this.applyRules(result.imported, new Set(result.autoForwarded), backfilling)
      // Backfilled bodies change what an open conversation shows, so they count
      // as a change even though nothing new arrived.
      const touched = [...result.imported, ...result.updated]
      if (touched.length === 0) return []
      this.notifyNewMail(result.imported, backfilling)
      return [...new Set(touched.map((id) => id.split(':')[0] ?? ''))]
    } catch (error) {
      // Polling errors are transient — the next cycle retries — but they used
      // to vanish entirely. Record the cause so the sidebar can name it.
      for (const account of domains) this.markAccountFailed(account.id, error)
      return []
    }
  }

  /**
   * Routing rules see newly received mail only. A first backfill is history,
   * not arrival — a rule written today must not rewrite last month's mail.
   */
  private async applyRules(
    imported: string[],
    autoForwarded: ReadonlySet<string>,
    backfilling: ReadonlySet<string>
  ): Promise<void> {
    const fresh = imported.filter((id) => !backfilling.has(id.split(':')[0] ?? ''))
    if (fresh.length === 0) return
    try {
      const outcome = await this.routing.applyToNew(fresh, autoForwarded)
      if (outcome.applied > 0) void this.mutations.flush().catch(() => undefined)
    } catch {
      // Every action logs itself; a rule run that breaks as a whole must not
      // take the poll down with it — the mail is on disk either way.
    }
  }

  /** Records why an account stopped syncing, in the words of the API itself. */
  private markAccountFailed(accountId: string, error: unknown): void {
    const reconnect = error instanceof ReconnectRequiredError
    const status: Account['status'] = reconnect ? 'reconnect_required' : 'error'
    const lastError = error instanceof Error ? error.message : String(error)
    const previous = this.store.accounts.get(accountId)
    if (reconnect && previous?.status !== 'reconnect_required') {
      this.store.activity.record({
        kind: 'reconnect_required',
        accountId,
        summary: `${previous?.email ?? 'Konto'} muss neu verbunden werden`,
        meta: { error: lastError }
      })
    } else if (!reconnect) {
      this.store.activity.record({
        kind: 'sync_error',
        accountId,
        summary: `Sync von ${previous?.email ?? 'Konto'} fehlgeschlagen: ${lastError}`,
        meta: { error: lastError },
        dedupe: true
      })
    }
    this.store.accounts.update(accountId, { status, lastError })
    if (!this.closed) this.env.emit('account:status', { accountId, status, lastError })
  }

  private markAccountHealthy(accountId: string): void {
    // A previous failure keeps showing until something says otherwise.
    if (this.syncStatus.get(accountId)?.phase === 'error') {
      this.setStatus({ accountId, phase: 'idle', processed: 0, total: null, message: null })
    }
    const account = this.store.accounts.get(accountId)
    if (!account || (account.status === 'ok' && account.lastError === null)) return
    this.store.accounts.update(accountId, { status: 'ok', lastError: null })
    if (!this.closed) {
      this.env.emit('account:status', { accountId, status: 'ok', lastError: null })
    }
  }

  private async runSync(): Promise<void> {
    if (this.closed) return
    const changed: string[] = []
    const backfilling = this.backfillingAccounts()
    try {
      // Local edits go out before anything is pulled back in — otherwise the
      // pull would see stale drafts and report conflicts against our own work.
      await this.mutations.flush()
      for (const account of this.store.accounts.list()) {
        if (account.kind !== 'google') continue
        const client = this.gmailClientFor(account.id)
        if (!client) continue
        const sync = new GmailSync(this.store, account.id, client, {
          onProgress: (status) => this.setStatus(status)
        })
        try {
          const result = await sync.sync()
          // Drafts are mirrored after the messages: what the queue owes Gmail
          // went out at the start of this cycle, so what comes back now is the
          // remote state as it really is.
          await new GmailDraftSync(this.store, account.id, client).sync()
          changed.push(account.id)
          // What the cycle newly put on disk — a reply into a conversation we
          // already show is new mail just as much as a whole new thread is.
          this.notifyNewMail(
            result.imported.map((remoteId) => messageKey(account.id, remoteId)),
            backfilling
          )
          if (result.resynced)
            this.setStatus({
              accountId: account.id,
              phase: 'idle',
              processed: 0,
              total: null,
              message: null
            })
          this.markAccountHealthy(account.id)
        } catch (error) {
          this.markAccountFailed(account.id, error)
          // A sync error is never terminal: it is reported and the next cycle
          // starts over from the same cursor.
          this.setStatus({
            accountId: account.id,
            phase: 'error',
            processed: 0,
            total: null,
            message: error instanceof Error ? error.message : String(error)
          })
        }
      }

      changed.push(...(await this.syncResend(backfilling)))

      await this.mutations.flush()
      await this.send.tick()
      // Answers arrive as ordinary mail, so this is the moment a wait can end.
      this.reviewFollowUps()
    } finally {
      if (!this.closed) this.env.emit('data:changed', { accountIds: [...new Set(changed)] })
    }
  }

  /**
   * Converges local Resend accounts with the API before anything is synced: a
   * domain whose receiving is already on at Resend must not need a toggle here
   * to become an account. Cheap and idempotent, so it also runs on every key
   * change and domain listing.
   */
  private async reconcileResendDomains(): Promise<void> {
    const service = this.domainService()
    if (!service) return
    await this.withAccountSync(() => service.list().catch(() => undefined))
  }

  /**
   * Any domain call may adopt or retire a Resend account as a side effect, and
   * the renderer only learns about accounts through events — so a changed
   * account set is announced right where it happens.
   */
  private async withAccountSync<T>(run: () => Promise<T>): Promise<T> {
    const fingerprint = (): string =>
      this.store.accounts
        .list()
        .map((account) => `${account.id}:${account.receivingEnabled ? 1 : 0}`)
        .join()
    const before = fingerprint()
    const result = await run()
    if (!this.closed && fingerprint() !== before) {
      this.env.emit('data:changed', { accountIds: [] })
    }
    return result
  }

  start(): void {
    const settings = this.store.settings.get()
    void this.reconcileResendDomains().then(() => this.syncAll())
    this.timers.push(setInterval(() => void this.syncAll(), settings.pollIntervalSeconds * 1000))
    // Resend has no push channel at all, and two cheap REST calls per cycle, so
    // its mail is pulled more often than the (far heavier) Gmail sync.
    this.timers.push(
      setInterval(
        () => void this.syncResendAccounts(),
        Math.min(settings.pollIntervalSeconds, RESEND_POLL_SECONDS) * 1000
      )
    )
    this.timers.push(setInterval(() => void this.checkGmail(), GMAIL_QUICK_CHECK_SECONDS * 1000))
    this.timers.push(setInterval(() => void this.send.tick(), 5_000))
    this.timers.push(setInterval(() => void this.mutations.flush(), 30_000))
    // Once at startup, because a wake that fell due while the app was closed
    // is exactly the case the minute timer can never catch.
    this.wakeSnoozed()
    this.timers.push(setInterval(() => this.wakeSnoozed(), SNOOZE_TICK_SECONDS * 1000))
    // A follow-up that fell due while the app was closed has to surface on the
    // way in; after that the sync cycle is what moves it along.
    this.reviewFollowUps()
    this.timers.push(setInterval(() => this.reviewFollowUps(), SNOOZE_TICK_SECONDS * 1000))
    // The daily backup is checked hourly and once on the way in, so a day
    // the app was closed through is made up for on the next launch.
    this.runAutoBackup()
    this.timers.push(setInterval(() => this.runAutoBackup(), AUTO_BACKUP_TICK_MS))
  }

  /** Writes the daily backup when it is switched on and due. */
  runAutoBackup(): void {
    if (this.closed || !this.store.settings.get().autoBackup) return
    try {
      this.admin.autoBackupIfDue()
    } catch (error) {
      this.store.activity.record({
        kind: 'sync_error',
        summary: `Automatisches Backup fehlgeschlagen: ${error instanceof Error ? error.message : String(error)}`,
        dedupe: true
      })
    }
  }

  /**
   * Ends the waits that have been answered and announces the ones that have run
   * out of time. Reading only conversations that are actually waiting keeps
   * this cheap enough to run on every cycle.
   */
  private reviewFollowUps(): void {
    if (this.closed) return
    try {
      const { resolved, nudged } = this.followUps.reconcile()
      const due = this.followUps.takeDue()
      if (this.store.settings.get().notificationsEnabled) {
        for (const entry of due) {
          const account = this.store.accounts.get(entry.followUp.accountId)
          if (!account?.notificationsEnabled) continue
          this.env.notify({
            title: entry.recipients
              ? `Keine Antwort von ${entry.recipients}`
              : 'Keine Antwort erhalten',
            body: entry.subject,
            accountId: entry.followUp.accountId,
            threadId: entry.followUp.threadId
          })
        }
      }
      if (!this.closed && (resolved > 0 || nudged > 0 || due.length > 0)) {
        this.env.emit('data:changed', { accountIds: [] })
      }
    } catch {
      // A failed review is retried on the next cycle; nothing is lost by it.
    }
  }

  /** Puts everything whose time has come back into the inbox. */
  private wakeSnoozed(): void {
    if (this.closed) return
    try {
      if (this.snooze.tick().length > 0) this.afterMutation()
    } catch {
      // A failed wake is retried on the next tick; the reminder stays put.
    }
  }

  stop(): void {
    this.closed = true
    for (const timer of this.timers) clearInterval(timer)
    this.timers = []
    this.store.close()
  }

  // ----------------------------------------------------------------- google

  async connectGoogle(loginHint?: string): Promise<Account> {
    if (!this.auth) throw new Error('Google-OAuth ist nicht konfiguriert (siehe README).')
    const pkce = createPkcePair()
    const state = createPkcePair().verifier
    const loopback = await startLoopbackServer()
    try {
      await this.env.openExternal(
        this.auth.buildAuthUrl({
          redirectUri: loopback.redirectUri,
          challenge: pkce.challenge,
          state,
          loginHint
        })
      )
      const result = await loopback.waitForCode()
      if (result.state !== state) throw new Error('OAuth-State stimmt nicht überein.')
      const tokens = await this.auth.exchangeCode({
        code: result.code,
        verifier: pkce.verifier,
        redirectUri: loopback.redirectUri
      })

      const probe = new GmailClient({
        fetch: this.env.fetch,
        accessToken: async () => tokens.accessToken
      })
      const profile = await probe.getProfile()
      const account = this.store.accounts.upsert({
        kind: 'google',
        email: profile.emailAddress,
        displayName: profile.emailAddress
      })
      this.vault.setGoogleTokens(account.id, tokens)
      this.store.labels.ensureSystemLabels(account.id)
      this.store.accounts.update(account.id, { status: 'ok', lastError: null })
      this.gmailClients.delete(account.id)
      this.store.activity.record({
        kind: 'account_connected',
        accountId: account.id,
        summary: `${account.email} verbunden`,
        meta: { kind: 'google', reconnect: Boolean(loginHint) }
      })
      void this.syncAll()
      return this.store.accounts.get(account.id)!
    } finally {
      loopback.close()
    }
  }

  // ------------------------------------------------------------------- api

  get api(): IpcApi {
    return {
      'accounts:list': async (): Promise<Account[]> => this.store.accounts.list(),
      'accounts:update': async (accountId, patch): Promise<Account> =>
        this.store.accounts.update(accountId, patch),
      'accounts:remove': async (accountId): Promise<void> => {
        const removed = this.store.accounts.get(accountId)
        if (removed) {
          this.store.activity.record({
            kind: 'account_removed',
            accountId,
            summary: `${removed.email} entfernt`,
            meta: { kind: removed.kind }
          })
        }
        this.vault.clearGoogleTokens(accountId)
        this.gmailClients.delete(accountId)
        this.store.accounts.remove(accountId)
      },

      'google:connect': async (): Promise<Account> => this.connectGoogle(),
      'google:reconnect': async (accountId): Promise<Account> => {
        const account = this.store.accounts.get(accountId)
        if (!account) throw new Error('Unbekanntes Konto')
        return this.connectGoogle(account.email)
      },

      'resend:setKey': async (apiKey): Promise<ResendDomainInfo[]> => {
        this.vault.setResendApiKey(apiKey.trim())
        const service = this.domainService()
        if (!service) throw new Error('Kein Resend-API-Key hinterlegt')
        try {
          return await this.withAccountSync(() => service.list())
        } catch (error) {
          this.vault.clearResendApiKey()
          throw error
        }
      },
      'resend:hasKey': async (): Promise<boolean> => Boolean(this.vault.getResendApiKey()),
      'resend:listDomains': async (): Promise<ResendDomainInfo[]> => {
        const service = this.domainService()
        return service ? this.withAccountSync(() => service.list()) : []
      },
      'resend:inspectDomain': async (domainId): Promise<ResendDomainInfo> => {
        const service = this.domainService()
        if (!service) throw new Error('Kein Resend-API-Key hinterlegt')
        return this.withAccountSync(() => service.refreshVerification(domainId))
      },
      'resend:enableReceiving': async (domainId, acknowledge): Promise<ResendDomainInfo> => {
        const service = this.domainService()
        if (!service) throw new Error('Kein Resend-API-Key hinterlegt')
        const info = await this.withAccountSync(() =>
          service.enableReceiving(domainId, acknowledge ?? false)
        )
        this.store.activity.record({
          kind: 'receiving_enabled',
          accountId: info.connectedAccountId,
          summary: `Empfang für ${info.name} aktiviert`,
          meta: { domainId, acknowledgedMxConflict: acknowledge ?? false }
        })
        void this.syncAll()
        return info
      },
      'resend:disableReceiving': async (domainId): Promise<ResendDomainInfo> => {
        const service = this.domainService()
        if (!service) throw new Error('Kein Resend-API-Key hinterlegt')
        const info = await this.withAccountSync(() => service.disableReceiving(domainId))
        this.store.activity.record({
          kind: 'receiving_disabled',
          accountId: info.connectedAccountId,
          summary: `Empfang für ${info.name} deaktiviert`,
          meta: { domainId }
        })
        return info
      },

      'domains:list': async (): Promise<DomainDetails[]> => {
        const service = this.domainService()
        if (!service) return []
        return this.admin.rememberDomains(await this.withAccountSync(() => service.detailsAll()))
      },
      'domains:get': async (domainId): Promise<DomainDetails> => {
        const service = this.requireDomainService()
        return this.withAccountSync(() => service.details(domainId))
      },
      'domains:create': async (input): Promise<DomainDetails> => {
        const service = this.requireDomainService()
        const domain = await this.withAccountSync(() => service.create(input))
        this.store.activity.record({
          kind: 'domain_created',
          accountId: null,
          summary: `Domain ${domain.name} bei Resend angelegt (${domain.region})`,
          meta: { domainId: domain.id, region: domain.region }
        })
        return domain
      },
      'domains:verify': async (domainId): Promise<DomainDetails> => {
        const service = this.requireDomainService()
        return this.withAccountSync(() => service.verify(domainId))
      },

      'mailboxes:list': async (accountId): Promise<Mailbox[]> =>
        this.admin.listMailboxes(accountId ?? null),
      'mailboxes:create': async (input): Promise<Mailbox> => {
        const mailbox = this.admin.createMailbox(input)
        this.afterMutation()
        return mailbox
      },
      'mailboxes:update': async (id, patch): Promise<Mailbox> => {
        const mailbox = this.admin.updateMailbox(id, patch)
        this.afterMutation()
        return mailbox
      },
      'mailboxes:remove': async (id): Promise<void> => {
        this.store.mailboxes.remove(id)
        this.afterMutation()
      },
      'mailboxes:reorder': async (ids): Promise<void> => {
        this.store.mailboxes.reorder(ids)
        this.afterMutation()
      },

      'rules:list': async (): Promise<RoutingRule[]> => this.store.rules.list(),
      'rules:create': async (input): Promise<RoutingRule> => this.routing.create(input),
      'rules:update': async (id, patch): Promise<RoutingRule> => this.routing.update(id, patch),
      'rules:remove': async (id): Promise<void> => {
        this.store.rules.remove(id)
      },
      'rules:reorder': async (ids): Promise<RoutingRule[]> => {
        this.store.rules.reorder(ids)
        return this.store.rules.list()
      },
      'rules:test': async (rule, limit): Promise<RuleTestResult> => this.routing.test(rule, limit),

      'delivery:list': async (args): Promise<Delivery[]> => this.store.deliveries.list(args ?? {}),
      'delivery:summary': async (args): Promise<DeliverySummary> =>
        this.store.deliveries.summary({
          domain: args?.domain ?? null,
          since: args?.sinceDays ? Date.now() - args.sinceDays * 24 * 60 * 60 * 1000 : null
        }),
      'webhooks:list': async (): Promise<ResendWebhook[]> =>
        this.admin.listWebhooks(this.requireResendClient()),
      'webhooks:create': async (input): Promise<ResendWebhookCreated> =>
        this.admin.createWebhook(this.requireResendClient(), input),
      'webhooks:remove': async (id): Promise<void> => {
        await this.requireResendClient().removeWebhook(id)
      },

      'activity:list': async (args): Promise<ActivityPage> => this.store.activity.list(args ?? {}),
      'admin:overview': async (): Promise<AdminOverview> => this.admin.overview(),

      'backups:list': async (): Promise<BackupFile[]> => this.admin.listBackups(),
      'backups:create': async (): Promise<BackupFile> => this.admin.createBackup(false),
      'backups:openFolder': async (): Promise<void> => {
        await this.env.openPath(this.admin.ensureBackupsPath())
      },

      'labels:list': async (accountId): Promise<LabelWithCounts[]> =>
        this.store.labels.listWithCounts(accountId),
      'labels:create': async (accountId, name): Promise<Label> => {
        const label = await this.createLabel(accountId, name.trim())
        this.afterMutation()
        return label
      },
      'labels:rename': async (labelId, name): Promise<Label> => {
        const label = this.store.labels.byId(labelId)
        if (!label) throw new Error('Label existiert nicht')
        if (label.type !== 'user') throw new Error('Systemlabels lassen sich nicht umbenennen')
        const client = this.gmailClientFor(label.accountId)
        // Gmail first: a rename that the server refuses must not show up locally.
        if (client) await client.renameLabel(label.remoteId, name.trim())
        const renamed = this.store.labels.rename(labelId, name.trim())
        this.afterMutation()
        return renamed
      },
      'labels:remove': async (labelId): Promise<void> => {
        const label = this.store.labels.byId(labelId)
        if (!label) return
        if (label.type !== 'user') throw new Error('Systemlabels lassen sich nicht löschen')
        const client = this.gmailClientFor(label.accountId)
        if (client) await client.deleteLabel(label.remoteId)
        this.store.labels.remove(labelId)
        this.afterMutation()
      },
      'labels:markAllRead': async (labelId): Promise<void> => {
        const label = this.store.labels.byId(labelId)
        if (!label) return
        const unreadId = labelKey(label.accountId, SYSTEM_LABELS.unread)
        const ids = this.store.messages.idsWithLabel(labelId, unreadId)
        if (ids.length === 0) return
        this.mutations.setRead(ids, true)
        this.afterMutation()
      },
      'labels:empty': async (labelId): Promise<void> => {
        const label = this.store.labels.byId(labelId)
        if (!label) return
        // Only the two mailboxes that are meant to be emptied — everywhere else
        // this would be an unrecoverable delete of ordinary mail.
        if (label.remoteId !== SYSTEM_LABELS.trash && label.remoteId !== SYSTEM_LABELS.spam) {
          throw new Error('Nur Papierkorb und Spam lassen sich leeren')
        }
        const ids = this.store.messages.idsWithLabel(labelId)
        if (ids.length === 0) return
        this.mutations.deletePermanently(ids)
        this.afterMutation()
      },
      'mailbox:counts': async (): Promise<Record<string, number>> => {
        const counts: Record<string, number> = {}
        counts.all = this.store.accounts
          .list()
          .reduce(
            (sum, account) =>
              sum +
              (this.store.labels
                .listWithCounts(account.id)
                .find((l) => l.remoteId === SYSTEM_LABELS.inbox)?.unread ?? 0),
            0
          )
        // Not an unread count like the others: a put-aside conversation is
        // usually already read, and what the row reports is how much is waiting.
        counts.snoozed = this.snooze.count()
        // Same idea for the answers still outstanding, plus how many of those
        // are already late — the row colours itself from the second number.
        counts.followups = this.store.followUps.countOpen()
        counts.followupsOverdue = this.store.followUps.countOverdue(Date.now())
        for (const account of this.store.accounts.list()) {
          for (const label of this.store.labels.listWithCounts(account.id)) {
            counts[label.id] = label.unread
          }
        }
        for (const mailbox of this.admin.listMailboxes(null)) {
          counts[`mailbox:${mailbox.id}`] = mailbox.unread
        }
        // One count per Resend domain, so every domain section in the sidebar
        // can show its own row; `unassigned` stays the total for the admin page.
        counts.unassigned = 0
        for (const account of this.store.accounts.list()) {
          if (account.kind !== 'resend') continue
          const n = this.store.messages.countUnreadInbox({ unassigned: true, accountId: account.id })
          counts[`unassigned:${account.id}`] = n
          counts.unassigned += n
        }
        return counts
      },

      'threads:list': async (args): Promise<ThreadSummary[]> => {
        // Snoozed mail is archived mail plus a local row — no label holds it
        // together, so this view is listed from the reminders themselves.
        if (args.view === 'snoozed') {
          return this.store.messages.threadSummaries(
            this.store.messages.snoozedThreadIds(args.accountId, args.limit, args.offset)
          )
        }
        // Nor does a label hold together what is waiting for an answer: the
        // reminders themselves are the list, most urgent first.
        // Starred is a label on every account; the view lists it across all of
        // them the way the merged inbox lists INBOX.
        if (args.view === 'starred') {
          return this.store.messages.threadSummaries(
            this.store.messages.listThreadIds({
              accountId: args.accountId,
              labelRemoteId: SYSTEM_LABELS.starred,
              limit: args.limit,
              offset: args.offset
            })
          )
        }
        if (args.view === 'followups') {
          return this.store.messages.threadSummaries(
            this.store.followUps.openThreadIds(
              args.accountId ?? null,
              args.limit ?? 100,
              args.offset ?? 0
            )
          )
        }
        // A mailbox is an address filter over the catch-all, not a label: it
        // narrows whatever label is selected, the inbox by default.
        const recipientFilter =
          args.view === 'mailbox'
            ? { recipients: args.mailboxId ? this.store.mailboxes.addressesOf(args.mailboxId) : [] }
            : args.view === 'unassigned'
              ? { unassigned: true }
              : {}
        const label = args.labelId
          ? this.store.accounts
              .list()
              .flatMap((account) => this.store.labels.list(account.id))
              .find((l) => l.id === args.labelId)
          : null
        const ids = this.store.messages.listThreadIds({
          accountId: args.accountId,
          labelId: label && label.type === 'user' ? label.id : null,
          labelRemoteId: label ? label.remoteId : SYSTEM_LABELS.inbox,
          limit: args.limit,
          offset: args.offset,
          ...recipientFilter
        })
        return this.store.messages.threadSummaries(ids)
      },
      'threads:get': async (threadId) => this.store.messages.threadDetail(threadId),
      'threads:messageIds': async (threadIds): Promise<string[]> =>
        threadIds.flatMap((threadId) =>
          this.store.messages.messagesInThread(threadId).map((message) => message.id)
        ),

      'messages:mark': async ({ messageIds, read }): Promise<void> => {
        this.mutations.setRead(messageIds, read)
        this.afterMutation()
      },
      'messages:archive': async (messageIds): Promise<void> => {
        this.mutations.archive(messageIds)
        this.afterMutation()
      },
      'messages:unarchive': async (messageIds): Promise<void> => {
        // Back in the inbox by hand — the reminder has done its job early.
        this.snooze.forgetByMessages(messageIds)
        this.mutations.unarchive(messageIds)
        this.afterMutation()
      },
      'messages:trash': async (messageIds): Promise<void> => {
        // Out of the inbox for good — bringing it back later would undo the
        // very decision the user just made.
        this.snooze.forgetByMessages(messageIds)
        this.followUps.forgetByMessages(messageIds)
        this.mutations.trash(messageIds)
        this.afterMutation()
      },
      'messages:untrash': async (messageIds): Promise<void> => {
        this.mutations.untrash(messageIds)
        this.afterMutation()
      },
      'messages:spam': async (messageIds): Promise<void> => {
        // Out of the inbox for good — bringing it back later would undo the
        // very decision the user just made.
        this.snooze.forgetByMessages(messageIds)
        this.followUps.forgetByMessages(messageIds)
        this.mutations.markSpam(messageIds)
        this.afterMutation()
      },
      'messages:unspam': async (messageIds): Promise<void> => {
        this.mutations.unmarkSpam(messageIds)
        this.afterMutation()
      },
      'messages:delete': async (messageIds): Promise<void> => {
        // Out of the inbox for good — bringing it back later would undo the
        // very decision the user just made.
        this.snooze.forgetByMessages(messageIds)
        this.followUps.forgetByMessages(messageIds)
        this.mutations.deletePermanently(messageIds)
        this.afterMutation()
      },
      'messages:changeLabels': async ({
        messageIds,
        addLabelIds,
        removeLabelIds
      }): Promise<void> => {
        this.mutations.changeLabels(messageIds, addLabelIds ?? [], removeLabelIds ?? [])
        this.afterMutation()
      },
      'threads:star': async (threadIds, starred): Promise<void> => {
        const ids = threadIds.flatMap((threadId) => {
          const messages = this.store.messages.messagesInThread(threadId)
          // Gmail stars one message and shows the conversation starred; the
          // newest is the one the user is looking at. Taking the star off has
          // to reach every message, or an older one keeps the thread starred.
          // Messages come oldest first.
          if (!starred) return messages.map((message) => message.id)
          const newest = messages.at(-1)
          return newest ? [newest.id] : []
        })
        if (ids.length === 0) return
        this.mutations.setStarred(ids, starred)
        this.afterMutation()
      },
      'messages:source': async (messageId) =>
        messageSource(
          {
            store: this.store,
            gmailClientFor: (accountId) => this.gmailClientFor(accountId),
            resendClient: () => this.resendClient()
          },
          messageId
        ),

      'snooze:set': async (threadIds, wakeAt): Promise<void> => {
        this.snooze.snooze(threadIds, wakeAt)
        this.afterMutation()
      },
      'snooze:cancel': async (threadIds): Promise<void> => {
        if (this.snooze.unsnooze(threadIds).length > 0) this.afterMutation()
      },
      'snooze:list': async (accountId): Promise<Snooze[]> => this.snooze.list(accountId),

      'followups:list': async (accountId): Promise<ThreadSummary[]> =>
        this.store.messages.threadSummaries(
          this.store.followUps.openThreadIds(accountId ?? null, 200, 0)
        ),
      'followups:set': async (threadId, dueAt): Promise<void> => {
        this.followUps.arm(threadId, dueAt)
        this.afterMutation()
      },
      'followups:clear': async (threadId): Promise<void> => {
        this.followUps.clear(threadId)
        this.afterMutation()
      },
      'followups:defaultDueAt': async (): Promise<number> => this.followUps.defaultDueAt(),

      'search:query': async (query): Promise<SearchResult[]> => this.store.search.query(query),
      'search:addresses': async ({ field, prefix, limit }): Promise<EmailAddress[]> =>
        field === 'recipient'
          ? this.store.messages.knownAddresses(['from', 'to', 'cc'], prefix, limit ?? 8, {
              forRecipients: true
            })
          : this.store.messages.knownAddresses(
              field === 'to' ? ['to', 'cc'] : [field],
              prefix,
              limit ?? 8
            ),

      'identities:list': async (): Promise<Identity[]> => this.identities.list(),
      'identities:create': async (identity): Promise<Identity> => this.identities.create(identity),
      'identities:update': async (id, patch): Promise<Identity> =>
        this.identities.update(id, patch),
      'identities:remove': async (id): Promise<void> => this.identities.remove(id),
      'identities:forReply': async (messageId): Promise<Identity | null> =>
        this.identities.forReply(messageId),

      'signatures:list': async (): Promise<Signature[]> => this.store.signatures.list(),
      'signatures:create': async (input): Promise<Signature> => {
        if (!input.name.trim()) throw new Error('Die Signatur braucht einen Namen.')
        return this.store.signatures.create({ name: input.name.trim(), html: input.html })
      },
      'signatures:update': async (id, patch): Promise<Signature> => {
        if (patch.name !== undefined && !patch.name.trim()) {
          throw new Error('Die Signatur braucht einen Namen.')
        }
        return this.store.signatures.update(id, {
          ...patch,
          ...(patch.name === undefined ? {} : { name: patch.name.trim() })
        })
      },
      'signatures:remove': async (id): Promise<void> => this.store.signatures.remove(id),

      'templates:list': async (): Promise<Template[]> => this.store.templates.list(),
      'templates:create': async (input): Promise<Template> =>
        this.store.templates.create(cleanTemplate(input)),
      'templates:update': async (id, patch): Promise<Template> => {
        if (patch.name !== undefined && !patch.name.trim()) {
          throw new Error('Die Vorlage braucht einen Namen.')
        }
        return this.store.templates.update(id, {
          ...patch,
          ...(patch.name === undefined ? {} : { name: patch.name.trim() })
        })
      },
      'templates:remove': async (id): Promise<void> => this.store.templates.remove(id),

      'compose:send': async (draft: OutboxDraft): Promise<OutboxItem> => this.send.enqueue(draft),
      'compose:schedule': async (draft: OutboxDraft, sendAt: number): Promise<OutboxItem> =>
        this.send.schedule(draft, sendAt),
      'compose:cancel': async (outboxId): Promise<void> => {
        this.send.cancel(outboxId)
      },
      'outbox:list': async (): Promise<OutboxItem[]> => this.store.outbox.list(),
      'outbox:retry': async (outboxId): Promise<void> => {
        await this.send.retry(outboxId)
      },
      'outbox:discard': async (outboxId): Promise<void> => {
        this.send.discard(outboxId)
      },

      'drafts:list': async (): Promise<DraftSummary[]> => this.store.drafts.list(),
      'drafts:get': async (draftId): Promise<Draft | null> => this.store.drafts.get(draftId),
      // Autosave runs while the user types, so this stays quiet: it emits no
      // `data:changed` (which would reload the whole UI every 1.5 s) and hands
      // the window back the id it saves under next time. For a Google account
      // the draft is mirrored to Gmail through the same offline queue as every
      // other write-back.
      'drafts:save': async (input: DraftInput): Promise<Draft> => {
        const draft = this.store.drafts.save(input)
        this.mutations.mirrorDraft(draft)
        void this.mutations.flush().catch(() => undefined)
        return draft
      },
      'drafts:remove': async (draftId): Promise<void> => {
        const draft = this.store.drafts.get(draftId)
        if (!draft) return
        this.mutations.removeDraftRemotely(draft)
        this.store.drafts.remove(draftId)
        void this.mutations.flush().catch(() => undefined)
      },

      'attachments:open': async (attachmentId) => {
        const { attachment, filePath } = await this.materializeAttachment(attachmentId)
        const content = await this.env.readFile(filePath)
        return {
          filePath,
          mimeType: attachment.mimeType,
          filename: attachment.filename,
          content: content.toString('base64')
        }
      },
      'attachments:openExternal': async (attachmentId): Promise<void> => {
        const { filePath } = await this.materializeAttachment(attachmentId)
        await this.env.openPath(filePath)
      },
      'attachments:saveAs': async (attachmentId) => {
        const { attachment, filePath } = await this.materializeAttachment(attachmentId)
        return this.env.saveFileAs(attachment.filename, filePath)
      },
      'attachments:pick': async () => {
        const paths = await this.env.pickFiles()
        return Promise.all(
          paths.map(async (path) => {
            const content = await this.env.readFile(path)
            const filename = path.split('/').pop() ?? 'anhang'
            // Refused here rather than at send time: from this point on the
            // file is base64 in the draft row and in every autosave that
            // mirrors the draft to Gmail.
            if (content.byteLength > MAX_ATTACHMENT_BYTES) {
              throw new Error(
                `«${filename}» ist grösser als ${MAX_ATTACHMENT_MB} MB und passt nicht in eine E-Mail.`
              )
            }
            return {
              filename,
              mimeType: mimeTypeForFile(filename),
              content: content.toString('base64')
            }
          })
        )
      },

      'attachments:cacheInfo': async (): Promise<AttachmentCacheInfo> => this.cacheInfo(),
      'attachments:clearCache': async (): Promise<AttachmentCacheInfo> => {
        for (const attachment of this.store.messages.downloadedAttachments()) {
          if (!this.isReclaimable(attachment)) continue
          rmSync(attachment.filePath, { force: true })
          this.store.messages.markAttachmentCleared(attachment.id)
        }
        return this.cacheInfo()
      },

      'shell:openUrl': async (url): Promise<void> => {
        // Mail html reaches this call, so the scheme is decided here rather
        // than trusted from the window: `file:` would open something on this
        // machine, and the sanitiser is one link rewrite away from a miss.
        if (!/^(https?|mailto):/i.test(url)) throw new Error('Nicht erlaubte Adresse.')
        await this.env.openExternal(url)
      },
      'clipboard:write': async (text): Promise<void> => {
        this.env.writeClipboard(text)
      },
      'clipboard:read': async (): Promise<string> => this.env.readClipboard(),

      'db:backup': async (): Promise<string | null> => {
        const target = await this.env.chooseSavePath(backupFileName(Date.now()))
        if (!target) return null
        // VACUUM INTO refuses an existing file, and the save dialog has already
        // asked the user about overwriting.
        rmSync(target, { force: true })
        this.store.backupTo(target)
        this.store.activity.record({
          kind: 'backup_created',
          summary: `Backup gespeichert unter ${target}`,
          meta: { path: target, auto: false }
        })
        return target
      },

      'settle:available': async (): Promise<SettleAvailability> => {
        const binaryPath = resolveClaudeBinary(
          this.env.claudeBinaryPath ?? this.store.settings.get().claudePath
        )
        if (!this.env.runClaude) {
          return { available: false, binaryPath, message: 'Claude Code ist nicht eingebunden.' }
        }
        return {
          available: binaryPath !== null,
          binaryPath,
          message: binaryPath ? null : 'Claude Code wurde nicht gefunden.'
        }
      },
      'settle:analyze': async (threadIds): Promise<SettleReport> => {
        const scope = threadIds && threadIds.length > 0 ? [...threadIds].sort().join(',') : 'inbox'
        // One run per scope at a time: a second click would classify the same
        // mail twice and double the CLI calls for nothing. Switching scope in
        // the sheet is a different run and starts immediately.
        const running = this.settleRuns.get(scope)
        if (running) return running
        const settings = this.store.settings.get()
        const run = this.settle
          .analyze(settings.settleBatchSize, settings.settleModel, threadIds ?? null)
          .finally(() => {
            this.settleRuns.delete(scope)
          })
        this.settleRuns.set(scope, run)
        return run
      },
      'settle:apply': async (decisions: SettleDecision[]): Promise<SettleApplyResult> => {
        const result = await this.settle.apply(decisions)
        if (result.applied > 0) this.afterMutation()
        return result
      },
      'settle:undo': async (decisions: SettleDecision[]): Promise<SettleApplyResult> => {
        const result = this.settle.revert(decisions)
        if (result.applied > 0) this.afterMutation()
        return result
      },

      'ai:start': async (request: AiRequest): Promise<AiJob> => {
        const settings = this.store.settings.get()
        return this.ai.start(request, settings.aiModel, settings.aiStylePrompt)
      },
      'ai:jobs': async (): Promise<AiJob[]> => this.ai.list(),
      'ai:dismiss': async (jobId: string): Promise<void> => {
        this.ai.dismiss(jobId)
      },

      'sync:now': async (): Promise<void> => {
        await this.syncAll()
      },
      'sync:status': async (): Promise<SyncStatus[]> => [...this.syncStatus.values()],
      'queue:list': async () =>
        this.store.queue.list().map((mutation) => ({
          ...mutation,
          subject: this.store.messages.get(mutation.messageId)?.subject ?? null,
          accountEmail: this.store.accounts.get(mutation.accountId)?.email ?? ''
        })),
      'queue:retry': async (id): Promise<void> => {
        await this.mutations.retry(id)
        this.afterMutation()
      },
      'queue:discard': async (id): Promise<void> => {
        this.mutations.discard(id)
        this.afterMutation()
      },
      'queue:pending': async () => ({
        mutations: this.store.queue.pendingCount(),
        outbox: this.store.outbox.pendingCount()
      }),

      'remoteImages:list': async (): Promise<RemoteImageTrust[]> => this.store.remoteImages.list(),
      'remoteImages:trust': async (kind, value): Promise<void> => {
        this.store.remoteImages.trust(kind, value)
      },
      'remoteImages:revoke': async (kind, value): Promise<void> => {
        this.store.remoteImages.revoke(kind, value)
      },

      'settings:get': async (): Promise<AppSettings> => this.store.settings.get(),
      'settings:set': async (patch): Promise<AppSettings> => this.store.settings.set(patch)
    }
  }

  /**
   * Only Gmail attachments are throwaway. Resend deletes its mail after 30
   * days, so its attachments are originals and are never cleared.
   */
  private isReclaimable(attachment: {
    accountId: string
    remoteAttachmentId: string | null
  }): boolean {
    if (!attachment.remoteAttachmentId) return false
    return this.store.accounts.get(attachment.accountId)?.kind === 'google'
  }

  private cacheInfo(): AttachmentCacheInfo {
    let bytes = 0
    let files = 0
    let reclaimableBytes = 0
    let reclaimableFiles = 0
    for (const attachment of this.store.messages.downloadedAttachments()) {
      let size = 0
      try {
        size = statSync(attachment.filePath).size
      } catch {
        // The row outlived its file; it counts for nothing.
        continue
      }
      bytes += size
      files += 1
      if (this.isReclaimable(attachment)) {
        reclaimableBytes += size
        reclaimableFiles += 1
      }
    }
    return { bytes, files, reclaimableBytes, reclaimableFiles }
  }

  private afterMutation(): void {
    if (this.closed) return
    this.env.emit('data:changed', { accountIds: [] })
    void this.mutations.flush().catch(() => undefined)
  }
}
