import type {
  ActivityListArgs,
  ActivityPage,
  AdminOverview,
  BackupFile,
  Delivery,
  DeliveryListArgs,
  DeliverySummary,
  DomainCreateInput,
  DomainDetails,
  Mailbox,
  MailboxInput,
  MailboxPatch,
  ResendWebhook,
  ResendWebhookCreated,
  RoutingRule,
  RuleInput,
  RulePatch,
  RuleTestResult
} from './admin'
import type {
  Account,
  AiJob,
  AiRequest,
  AppSettings,
  Draft,
  DraftInput,
  DraftSummary,
  Identity,
  Label,
  LabelWithCounts,
  MessageSource,
  MailboxSelection,
  OutboxDraft,
  OutboxItem,
  QueuedMutation,
  EmailAddress,
  RemoteImageTrust,
  RemoteImageTrustKind,
  ResendDomainInfo,
  SearchQuery,
  SettleApplyResult,
  SettleAvailability,
  SettleDecision,
  SettleReport,
  SettleProgress,
  Signature,
  Snooze,
  SyncStatus,
  Template,
  TemplateInput,
  ThreadDetail,
  ThreadSummary
} from './types'

export interface ListThreadsArgs extends MailboxSelection {
  limit?: number
  offset?: number
}

/** What a rule dry run needs — a saved rule qualifies as much as a draft. */
export type RuleTestArgs = Pick<RuleInput, 'accountId' | 'matchField' | 'operator' | 'value'>

export interface DeliverySummaryArgs {
  domain?: string | null
  /** Only mail sent in the last n days; omitted = everything stored. */
  sinceDays?: number | null
}

export interface WebhookInput {
  /** Must be https. */
  endpoint: string
  /** Resend event names, e.g. `email.bounced` (see RESEND_WEBHOOK_EVENTS). */
  events: string[]
}

export interface SearchResult extends ThreadSummary {
  matchedMessageId: string
}

/**
 * What is being completed and what is typed so far. `recipient` is the compose
 * window asking: it draws on every header the user has seen an address in, not
 * just the one a search operator names.
 */
export interface AddressSuggestArgs {
  field: 'from' | 'to' | 'cc' | 'recipient'
  prefix: string
  limit?: number
}

export interface MarkArgs {
  messageIds: string[]
  read: boolean
}

export interface LabelChangeArgs {
  messageIds: string[]
  addLabelIds?: string[]
  removeLabelIds?: string[]
}

/** A queued write-back plus the context needed to show it in a list. */
export interface QueuedMutationView extends QueuedMutation {
  /** Subject of the affected message, `null` once the message is gone. */
  subject: string | null
  accountEmail: string
}

/** What the attachment cache currently costs, and what of it can be freed. */
export interface AttachmentCacheInfo {
  bytes: number
  files: number
  /**
   * Gmail attachments can be fetched again, so dropping them is free. Resend
   * mail is deleted upstream after 30 days, which makes the local copy the
   * only one — those are never cleared.
   */
  reclaimableBytes: number
  reclaimableFiles: number
}

export interface AttachmentContent {
  filePath: string
  mimeType: string
  filename: string
  /** base64 payload, provided for inline preview. */
  content: string
}

/**
 * The complete surface the renderer may call. Every entry is exposed 1:1 over
 * `ipcRenderer.invoke` through the preload bridge.
 */
export interface IpcApi {
  'accounts:list': () => Promise<Account[]>
  'accounts:update': (
    accountId: string,
    patch: Partial<Pick<Account, 'displayName' | 'color' | 'notificationsEnabled'>>
  ) => Promise<Account>
  'accounts:remove': (accountId: string) => Promise<void>

  'google:connect': () => Promise<Account>
  'google:reconnect': (accountId: string) => Promise<Account>

  'resend:setKey': (apiKey: string) => Promise<ResendDomainInfo[]>
  'resend:hasKey': () => Promise<boolean>
  'resend:listDomains': () => Promise<ResendDomainInfo[]>
  'resend:inspectDomain': (domainId: string) => Promise<ResendDomainInfo>
  'resend:enableReceiving': (
    domainId: string,
    acknowledgeMxConflict?: boolean
  ) => Promise<ResendDomainInfo>
  'resend:disableReceiving': (domainId: string) => Promise<ResendDomainInfo>

  // ------------------------------------------------------------ admin area

  /** Every Resend domain with its authentication panel (records, DMARC, MX). */
  'domains:list': () => Promise<DomainDetails[]>
  'domains:get': (domainId: string) => Promise<DomainDetails>
  /** Adds a domain at Resend; the result lists the DNS records to publish. */
  'domains:create': (input: DomainCreateInput) => Promise<DomainDetails>
  /** "Prüfen": asks Resend to re-check the records, then reads them back. */
  'domains:verify': (domainId: string) => Promise<DomainDetails>

  /** Local mailboxes, per domain in the user's order; `unread` filled in. */
  'mailboxes:list': (accountId?: string | null) => Promise<Mailbox[]>
  /** The address must be on the account's domain and not used elsewhere. */
  'mailboxes:create': (input: MailboxInput) => Promise<Mailbox>
  'mailboxes:update': (id: string, patch: MailboxPatch) => Promise<Mailbox>
  /** Removes the view only; no mail is touched. */
  'mailboxes:remove': (id: string) => Promise<void>
  /** Sorts mailboxes in the order of `ids`. */
  'mailboxes:reorder': (ids: string[]) => Promise<void>

  /** Routing rules in the order they run. */
  'rules:list': () => Promise<RoutingRule[]>
  /** New rules run last; rejects invalid regexes and looping forwards. */
  'rules:create': (input: RuleInput) => Promise<RoutingRule>
  'rules:update': (id: string, patch: RulePatch) => Promise<RoutingRule>
  'rules:remove': (id: string) => Promise<void>
  /** Priorities follow `ids`; returns the list in its new order. */
  'rules:reorder': (ids: string[]) => Promise<RoutingRule[]>
  /** Dry run against the last `limit` (default 50) received messages. Applies nothing. */
  'rules:test': (rule: RuleTestArgs, limit?: number) => Promise<RuleTestResult>

  /** Sent Resend mail with its last delivery event, newest first. */
  'delivery:list': (args?: DeliveryListArgs) => Promise<Delivery[]>
  'delivery:summary': (args?: DeliverySummaryArgs) => Promise<DeliverySummary>
  /** Webhooks configured at Resend, for users who forward events to a server. */
  'webhooks:list': () => Promise<ResendWebhook[]>
  /** The signing secret is only in this answer. */
  'webhooks:create': (input: WebhookInput) => Promise<ResendWebhookCreated>
  'webhooks:remove': (id: string) => Promise<void>

  /** Newest first, paged by `beforeId`. */
  'activity:list': (args?: ActivityListArgs) => Promise<ActivityPage>
  'admin:overview': () => Promise<AdminOverview>

  /** Backups in the app's backup folder, newest first. */
  'backups:list': () => Promise<BackupFile[]>
  /** Writes a backup into the backup folder right away. */
  'backups:create': () => Promise<BackupFile>
  'backups:openFolder': () => Promise<void>

  'labels:list': (accountId: string) => Promise<LabelWithCounts[]>
  /** Creates a user label — remotely first for Gmail, so the id is Gmail's own. */
  'labels:create': (accountId: string, name: string) => Promise<Label>
  'labels:rename': (labelId: string, name: string) => Promise<Label>
  /** Removes the label everywhere; the messages that carried it stay. */
  'labels:remove': (labelId: string) => Promise<void>
  'labels:markAllRead': (labelId: string) => Promise<void>
  /** Deletes every message in Papierkorb or Spam for good. Irreversible. */
  'labels:empty': (labelId: string) => Promise<void>
  /**
   * Unread counts keyed by label id, plus `all`, `snoozed`, `followups`,
   * `followupsOverdue`, one `mailbox:<id>` per local mailbox, one
   * `unassigned:<accountId>` per Resend domain (inbox catch-all mail no mailbox
   * claims) and `unassigned`, their total.
   */
  'mailbox:counts': () => Promise<Record<string, number>>

  /**
   * `view: 'mailbox'` + `mailboxId` lists the threads addressed (To/Cc) to that
   * mailbox or its aliases; `view: 'unassigned'` the Resend mail no mailbox
   * claims (narrowed by `accountId` when set). Both filter the label in
   * `labelId`, the inbox when it is null.
   */
  'threads:list': (args: ListThreadsArgs) => Promise<ThreadSummary[]>
  'threads:get': (threadId: string) => Promise<ThreadDetail | null>
  /** Every message id of the given threads, for actions on a whole selection. */
  'threads:messageIds': (threadIds: string[]) => Promise<string[]>

  'messages:mark': (args: MarkArgs) => Promise<void>
  'messages:archive': (messageIds: string[]) => Promise<void>
  'messages:unarchive': (messageIds: string[]) => Promise<void>
  'messages:trash': (messageIds: string[]) => Promise<void>
  'messages:untrash': (messageIds: string[]) => Promise<void>
  'messages:spam': (messageIds: string[]) => Promise<void>
  'messages:unspam': (messageIds: string[]) => Promise<void>
  /** Irreversible: removes the messages locally and, for Gmail, upstream. */
  'messages:delete': (messageIds: string[]) => Promise<void>
  'messages:changeLabels': (args: LabelChangeArgs) => Promise<void>
  /**
   * Stars or unstars conversations. Starring marks the newest message, the way
   * Gmail does; unstarring clears every message, or the thread would stay
   * starred through an older one.
   */
  'threads:star': (threadIds: string[], starred: boolean) => Promise<void>
  /** The raw RFC 822 text behind "Original anzeigen". */
  'messages:source': (messageId: string) => Promise<MessageSource>

  /**
   * Puts conversations aside until `wakeAt`: they are archived now and return
   * to the inbox then. Purely local — Gmail has no snooze the API can reach.
   */
  'snooze:set': (threadIds: string[], wakeAt: number) => Promise<void>
  /** Brings them back right away and drops the reminder. */
  'snooze:cancel': (threadIds: string[]) => Promise<void>
  /** Everything still waiting, the one returning soonest first. */
  'snooze:list': (accountId?: string | null) => Promise<Snooze[]>

  /**
   * Sent mail still waiting for an answer, the most urgent first. Rows, not
   * bare reminders: the mailbox draws them exactly like any other conversation
   * and reads the countdown off `ThreadSummary.followUp`.
   */
  'followups:list': (accountId?: string | null) => Promise<ThreadSummary[]>
  /** Starts waiting on a conversation, or moves a wait that is already there. */
  'followups:set': (threadId: string, dueAt: number) => Promise<void>
  /** Ends the wait: the user says the matter is settled. */
  'followups:clear': (threadId: string) => Promise<void>
  /** What the composer offers by default — the settings' working-day count. */
  'followups:defaultDueAt': () => Promise<number>

  'search:query': (query: SearchQuery) => Promise<SearchResult[]>
  'search:addresses': (args: AddressSuggestArgs) => Promise<EmailAddress[]>

  'identities:list': () => Promise<Identity[]>
  'identities:create': (
    identity: Omit<Identity, 'id' | 'source' | 'verified' | 'signatureHtml'>
  ) => Promise<Identity>
  'identities:update': (
    id: string,
    patch: Partial<Omit<Identity, 'id' | 'signatureHtml'>>
  ) => Promise<Identity>
  'identities:remove': (id: string) => Promise<void>
  'identities:forReply': (messageId: string) => Promise<Identity | null>
  'signatures:list': () => Promise<Signature[]>
  'signatures:create': (input: { name: string; html: string }) => Promise<Signature>
  'signatures:update': (
    id: string,
    patch: { name?: string; html?: string }
  ) => Promise<Signature>
  'signatures:remove': (id: string) => Promise<void>

  'templates:list': () => Promise<Template[]>
  'templates:create': (input: TemplateInput) => Promise<Template>
  'templates:update': (id: string, patch: Partial<TemplateInput>) => Promise<Template>
  'templates:remove': (id: string) => Promise<void>

  'compose:send': (draft: OutboxDraft) => Promise<OutboxItem>
  'compose:schedule': (draft: OutboxDraft, sendAt: number) => Promise<OutboxItem>
  'compose:cancel': (outboxId: string) => Promise<void>
  'outbox:list': () => Promise<OutboxItem[]>
  'outbox:retry': (outboxId: string) => Promise<void>
  'outbox:discard': (outboxId: string) => Promise<void>

  /** Every draft, newest first — bodies and files stay in the database. */
  'drafts:list': () => Promise<DraftSummary[]>
  /** The full draft, for putting a compose window back together. */
  'drafts:get': (draftId: string) => Promise<Draft | null>
  /** Creates the draft on the first call and overwrites it on every later one. */
  'drafts:save': (input: DraftInput) => Promise<Draft>
  'drafts:remove': (draftId: string) => Promise<void>

  'attachments:open': (attachmentId: string) => Promise<AttachmentContent>
  /** Hands the file to the OS so it opens in whatever app owns the type. */
  'attachments:openExternal': (attachmentId: string) => Promise<void>
  /** Copies the file wherever the user points the save dialog; null on cancel. */
  'attachments:saveAs': (attachmentId: string) => Promise<string | null>
  'attachments:pick': () => Promise<Array<{ filename: string; mimeType: string; content: string }>>
  'attachments:cacheInfo': () => Promise<AttachmentCacheInfo>
  /** Frees the re-downloadable part of the cache; messages stay untouched. */
  'attachments:clearCache': () => Promise<AttachmentCacheInfo>

  'sync:now': () => Promise<void>
  'sync:status': () => Promise<SyncStatus[]>
  'queue:list': () => Promise<QueuedMutationView[]>
  'queue:retry': (id: number) => Promise<void>
  'queue:discard': (id: number) => Promise<void>
  /** Actions still owed to the servers, split by kind, for the offline banner. */
  'queue:pending': () => Promise<{ mutations: number; outbox: number }>

  /**
   * Opens a link in the browser. The renderer never gets `shell` itself; the
   * scheme is checked on the other side, so a `file:` or `javascript:` url
   * smuggled in through mail html cannot reach the OS.
   */
  'shell:openUrl': (url: string) => Promise<void>
  'clipboard:write': (text: string) => Promise<void>
  /**
   * The system clipboard as text. `navigator.clipboard.readText` needs a
   * secure context and a permission the packaged app has neither of, so paste
   * goes through the main process.
   */
  'clipboard:read': () => Promise<string>

  /** Writes a consistent copy of the database; null when the user cancelled. */
  'db:backup': () => Promise<string | null>

  /** Whether the local Claude Code CLI could be found and run. */
  'settle:available': () => Promise<SettleAvailability>
  /**
   * Read-only: proposes where mail should go. Writes nothing. With `threadIds`
   * only those conversations are looked at, otherwise the whole inbox.
   */
  'settle:analyze': (threadIds?: string[] | null) => Promise<SettleReport>
  /** Carries out exactly the decisions the user confirmed. */
  'settle:apply': (decisions: SettleDecision[]) => Promise<SettleApplyResult>
  /** Puts back what `settle:apply` did — the undo behind the toast. */
  'settle:undo': (decisions: SettleDecision[]) => Promise<SettleApplyResult>

  /**
   * Starts a writing job and returns it while it is still running. The job
   * lives in the main process, so closing the compose window does not cancel
   * it — the result is announced over `ai:job`.
   */
  'ai:start': (request: AiRequest) => Promise<AiJob>
  /** Jobs that are still running or whose result nobody has picked up yet. */
  'ai:jobs': () => Promise<AiJob[]>
  /** Drops a finished job once its result was taken or discarded. */
  'ai:dismiss': (jobId: string) => Promise<void>

  'settings:get': () => Promise<AppSettings>
  'settings:set': (patch: Partial<AppSettings>) => Promise<AppSettings>

  /** Addresses and domains whose remote images load without being asked. */
  'remoteImages:list': () => Promise<RemoteImageTrust[]>
  'remoteImages:trust': (kind: RemoteImageTrustKind, value: string) => Promise<void>
  'remoteImages:revoke': (kind: RemoteImageTrustKind, value: string) => Promise<void>
}

export type IpcChannel = keyof IpcApi

export const IPC_CHANNELS: IpcChannel[] = [
  'accounts:list',
  'accounts:update',
  'accounts:remove',
  'google:connect',
  'google:reconnect',
  'resend:setKey',
  'resend:hasKey',
  'resend:listDomains',
  'resend:inspectDomain',
  'resend:enableReceiving',
  'resend:disableReceiving',
  'domains:list',
  'domains:get',
  'domains:create',
  'domains:verify',
  'mailboxes:list',
  'mailboxes:create',
  'mailboxes:update',
  'mailboxes:remove',
  'mailboxes:reorder',
  'rules:list',
  'rules:create',
  'rules:update',
  'rules:remove',
  'rules:reorder',
  'rules:test',
  'delivery:list',
  'delivery:summary',
  'webhooks:list',
  'webhooks:create',
  'webhooks:remove',
  'activity:list',
  'admin:overview',
  'backups:list',
  'backups:create',
  'backups:openFolder',
  'labels:list',
  'labels:create',
  'labels:rename',
  'labels:remove',
  'labels:markAllRead',
  'labels:empty',
  'mailbox:counts',
  'threads:list',
  'threads:get',
  'threads:messageIds',
  'messages:mark',
  'messages:archive',
  'messages:unarchive',
  'messages:trash',
  'messages:untrash',
  'messages:spam',
  'messages:unspam',
  'messages:delete',
  'messages:changeLabels',
  'threads:star',
  'messages:source',
  'snooze:set',
  'snooze:cancel',
  'snooze:list',
  'followups:list',
  'followups:set',
  'followups:clear',
  'followups:defaultDueAt',
  'search:query',
  'search:addresses',
  'identities:list',
  'identities:create',
  'identities:update',
  'identities:remove',
  'identities:forReply',
  'signatures:list',
  'signatures:create',
  'signatures:update',
  'signatures:remove',
  'templates:list',
  'templates:create',
  'templates:update',
  'templates:remove',
  'compose:send',
  'compose:schedule',
  'compose:cancel',
  'outbox:list',
  'outbox:retry',
  'outbox:discard',
  'drafts:list',
  'drafts:get',
  'drafts:save',
  'drafts:remove',
  'attachments:open',
  'attachments:openExternal',
  'attachments:saveAs',
  'attachments:pick',
  'attachments:cacheInfo',
  'attachments:clearCache',
  'sync:now',
  'sync:status',
  'queue:list',
  'queue:retry',
  'queue:discard',
  'queue:pending',
  'shell:openUrl',
  'clipboard:write',
  'clipboard:read',
  'db:backup',
  'settle:available',
  'settle:analyze',
  'settle:apply',
  'settle:undo',
  'ai:start',
  'ai:jobs',
  'ai:dismiss',
  'settings:get',
  'settings:set',
  'remoteImages:list',
  'remoteImages:trust',
  'remoteImages:revoke'
]

/** Events pushed from main to renderer. */
export interface IpcEvents {
  'data:changed': { accountIds: string[] }
  'sync:progress': SyncStatus
  'outbox:changed': { items: OutboxItem[] }
  'account:status': { accountId: string; status: Account['status']; lastError: string | null }
  'settle:progress': SettleProgress
  /** A writing job changed state; carries the whole job, not a delta. */
  'ai:job': AiJob
}

export type IpcEventName = keyof IpcEvents

export const IPC_EVENTS: IpcEventName[] = [
  'data:changed',
  'sync:progress',
  'outbox:changed',
  'account:status',
  'settle:progress',
  'ai:job'
]
