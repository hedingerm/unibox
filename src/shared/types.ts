export type AccountKind = 'google' | 'resend'

export type AccountStatus = 'ok' | 'reconnect_required' | 'error'

export interface Account {
  id: string
  kind: AccountKind
  /** Google: the account's primary e-mail. Resend: the domain name. */
  email: string
  displayName: string
  /** Hex colour used for the account badge in the UI. */
  color: string
  resendDomainId: string | null
  resendRegion: string | null
  receivingEnabled: boolean
  status: AccountStatus
  /** Verbatim cause of the last failed sync, cleared on the next success. */
  lastError: string | null
  historyId: string | null
  initialSyncDone: boolean
  notificationsEnabled: boolean
  lastSyncedAt: number | null
  createdAt: number
}

export type LabelType = 'system' | 'user'

export interface Label {
  id: string
  accountId: string
  remoteId: string
  /** Full path as delivered by Gmail, e.g. `Kunden/Aktiv`. */
  name: string
  parentId: string | null
  type: LabelType
  color: string | null
}

export interface LabelWithCounts extends Label {
  unread: number
  total: number
}

export interface EmailAddress {
  name: string | null
  email: string
}

export type MessageDirection = 'incoming' | 'outgoing'

export interface Message {
  id: string
  accountId: string
  threadId: string
  remoteId: string
  messageIdHeader: string | null
  inReplyTo: string | null
  references: string[]
  subject: string
  from: EmailAddress
  to: EmailAddress[]
  cc: EmailAddress[]
  bcc: EmailAddress[]
  replyTo: EmailAddress[]
  date: number
  snippet: string
  hasAttachments: boolean
  direction: MessageDirection
  /**
   * Machine-generated: an out-of-office responder, a mailing-list blast, a
   * bounce. It arrives in a conversation like an answer without being one, so
   * a follow-up must not treat it as the reply it was waiting for.
   */
  autoReply: boolean
  /**
   * When this machine first stored the message — not the `Date` header. A
   * sender with a wrong clock can date an answer before the mail it answers,
   * and anything reasoning about "since when" has to survive that.
   */
  storedAt: number
  labelIds: string[]
}

/**
 * A message as it travelled, for "Original anzeigen". `origin` says whether
 * the text is the provider's own copy or was rebuilt from what is stored here
 * — a rebuilt one has the headers that matter, not every relay's stamp.
 */
export interface MessageSource {
  raw: string
  origin: 'gmail' | 'resend' | 'reconstructed'
}

export interface MessageBody {
  html: string | null
  text: string | null
}

export interface Attachment {
  id: string
  messageId: string
  filename: string
  mimeType: string
  size: number
  remoteAttachmentId: string | null
  contentId: string | null
  inline: boolean
  filePath: string | null
  downloaded: boolean
}

export interface ThreadSummary {
  threadId: string
  accountId: string
  subject: string
  snippet: string
  lastMessageAt: number
  messageCount: number
  unread: boolean
  /**
   * Any message in the conversation carries STARRED — Gmail stars messages,
   * the list shows conversations, and one starred mail is enough to mark it.
   */
  starred: boolean
  hasAttachments: boolean
  participants: EmailAddress[]
  /** The most recent message's sender, used for the list row title. */
  lastFrom: EmailAddress
  lastDirection: MessageDirection
  /** An unsent draft belonging to this conversation, marked in its row. */
  draft: { id: string; snippet: string } | null
  /** When a put-aside conversation comes back; `null` when it is not snoozed. */
  snoozedUntil: number | null
  /**
   * The answer this conversation is still waiting for; `null` when nothing is
   * expected. Shown as a countdown on the row, wherever the row appears.
   */
  followUp: { id: string; dueAt: number; nudgeCount: number } | null
}

/**
 * Whether a message may pull its remote images straight away, or whether the
 * reader is asked first. Decided in the main process, where the correspondence
 * history that earns the trust lives.
 */
export type RemoteImageDecision = 'allow' | 'ask'

/** A single address, or a whole domain, the user allowed images for. */
export type RemoteImageTrustKind = 'sender' | 'domain'

export interface RemoteImageTrust {
  kind: RemoteImageTrustKind
  value: string
  createdAt: number
}

export type ThreadMessage = Message & {
  body: MessageBody
  attachments: Attachment[]
  remoteImages: RemoteImageDecision
}

export interface ThreadDetail {
  threadId: string
  accountId: string
  subject: string
  messages: ThreadMessage[]
}

/** One reusable sign-off. Belongs to no address — identities point at it. */
export interface Signature {
  id: string
  name: string
  html: string
  /** How many identities start a draft with this one. */
  usedBy: number
}

/**
 * A reusable mail body. Like a signature it belongs to no account — the same
 * offer goes out under a Gmail alias and a Resend address. Unlike a signature
 * it may carry `{{variablen}}`, which are filled in when it is inserted.
 */
export interface Template {
  id: string
  name: string
  /** Types as `/kürzel` in the body; null means picker only. */
  shortcut: string | null
  /** Applied only to a draft whose subject is still empty. */
  subject: string
  html: string
  /** Every placeholder the body and subject hold, for the library listing. */
  variables: string[]
  updatedAt: number
}

export interface TemplateInput {
  name: string
  shortcut: string | null
  subject: string
  html: string
}

export interface Identity {
  id: string
  accountId: string
  name: string
  email: string
  /** The signature a draft from this address starts with; null = none. */
  signatureId: string | null
  /** Resolved text of `signatureId`, joined for the composer. Read-only. */
  signatureHtml: string | null
  isDefault: boolean
  source: 'gmail_sendas' | 'user'
  /**
   * A Gmail alias whose ownership is still unconfirmed. It is imported so its
   * signature is not lost, but Gmail refuses to send from it — so it stays out
   * of the sender picker until the next sync sees it verified.
   */
  verified: boolean
}

export type MutationOp =
  | 'add_labels'
  | 'remove_labels'
  | 'trash'
  | 'untrash'
  | 'delete'
  | 'spam'
  | 'unspam'
  /** Mirrors a local draft to Gmail, creating it on the first run. */
  | 'draft_upsert'
  /** Removes the Gmail draft a local one was mirrored to. */
  | 'draft_delete'

export interface MutationPayload {
  addLabelIds?: string[]
  removeLabelIds?: string[]
  /** Gmail draft id, for a delete that outlives the local row. */
  remoteDraftId?: string
}

export type MutationState = 'pending' | 'done' | 'failed'

export interface QueuedMutation {
  id: number
  accountId: string
  messageId: string
  op: MutationOp
  payload: MutationPayload
  attempts: number
  nextAttemptAt: number
  lastError: string | null
  state: MutationState
  createdAt: number
}

export type OutboxState =
  | 'undoable'
  | 'scheduled'
  | 'sending'
  | 'sent'
  | 'failed'
  | 'cancelled'

export interface OutboxAttachment {
  filename: string
  mimeType: string
  /** base64-encoded content. */
  content: string
  contentId?: string
  inline?: boolean
}

export interface OutboxDraft {
  accountId: string
  identityName: string
  identityEmail: string
  to: EmailAddress[]
  cc: EmailAddress[]
  bcc: EmailAddress[]
  subject: string
  html: string
  text: string
  attachments: OutboxAttachment[]
  /** Local id of the message being replied to, if any. */
  replyToMessageId: string | null
  /**
   * Working days to wait for an answer before the mail comes back as a
   * reminder; `null` when none is expected. The composer decides — it knows
   * whether the user unticked the box — and the send path checks the recipients
   * before arming anything. Absent is the same as `null`: mail queued before
   * this existed simply expects nothing.
   */
  followUpDays?: number | null
}

export interface OutboxItem extends OutboxDraft {
  id: string
  /** Always settled once the row is on disk, where the column is nullable. */
  followUpDays: number | null
  state: OutboxState
  sendAt: number
  attempts: number
  lastError: string | null
  createdAt: number
  sentMessageId: string | null
}

/** Which of the three compose windows a draft came out of. */
export type DraftKind = 'new' | 'reply' | 'forward'

/**
 * A mail still being written. Unlike `OutboxDraft` this is editing state, not a
 * send payload: recipients stay exactly as typed so a half-written address
 * survives a close, and the body keeps the signature the editor shows.
 */
export interface DraftInput {
  /** Draft to overwrite; `null` creates one. */
  id: string | null
  accountId: string
  kind: DraftKind
  /** Identity the window had picked, `null` for a custom address. */
  identityId: string | null
  identityName: string
  identityEmail: string
  to: string
  cc: string
  bcc: string
  subject: string
  html: string
  attachments: OutboxAttachment[]
  replyToMessageId: string | null
}

export interface Draft extends Omit<DraftInput, 'id'> {
  id: string
  /** Gmail's draft id once the draft was mirrored; `null` while local-only. */
  remoteId: string | null
  /** Gmail's message id inside that draft — it changes on every remote edit. */
  remoteMessageId: string | null
  /** Whether local edits are still owed to Gmail. */
  dirty: boolean
  createdAt: number
  updatedAt: number
}

/** What the list needs to draw a draft row — without body or files. */
export interface DraftSummary {
  id: string
  accountId: string
  kind: DraftKind
  subject: string
  /** Start of the body, for the row's second line. */
  snippet: string
  /** Recipients as typed, shown where a mail row shows its sender. */
  to: string
  hasAttachments: boolean
  updatedAt: number
}

/**
 * A mailbox that is not a label. Snoozed conversations are archived mail plus a
 * local row, so no label anywhere holds them together — the view has to name
 * itself. The same is true of `followups`: what holds those conversations
 * together is a date, and mail carries no date the user chose. `starred` is a
 * label per account; the view is what lists it across all of them at once.
 */
export type MailboxView = 'snoozed' | 'followups' | 'mailbox' | 'unassigned' | 'starred'

export interface MailboxSelection {
  /** `null` = merged view across all accounts. */
  accountId: string | null
  /** System label remote id (`INBOX`, `SENT`, …) or a Gmail label id. */
  labelId: string | null
  /**
   * A label-less mailbox; when set, `labelId` is ignored — except for
   * `mailbox` and `unassigned`, which are address filters over the domain's
   * catch-all and narrow whatever label `labelId` names (INBOX when null).
   */
  view?: MailboxView | null
  /** The local mailbox (`Mailbox.id`) a `view: 'mailbox'` selection shows. */
  mailboxId?: string | null
}

/**
 * A conversation put aside until `wakeAt`. Local only — the Gmail API has no
 * snooze endpoint, so the mail is archived and this row is the reminder.
 */
export interface Snooze {
  threadId: string
  accountId: string
  wakeAt: number
  /** When it was put aside; new mail arriving after this wakes it early. */
  createdAt: number
}

export type FollowUpState = 'open' | 'resolved'

/**
 * Why a wait ended. `replied` is the only one nobody had to do anything for —
 * the rest record a decision or the conversation going away.
 */
export type FollowUpResolution = 'replied' | 'manual' | 'dropped'

/**
 * A sent mail that expects an answer. Local only: there is no field for this
 * anywhere upstream, and none is needed — the state is reconstructible from the
 * conversation, which is exactly what `reconcile` does on every sync.
 */
export interface FollowUp {
  id: string
  accountId: string
  /** Empty while the sent message has not reached the local store yet. */
  threadId: string
  /** The sent mail the wait hangs off; moves forward with every nudge. */
  messageId: string
  dueAt: number
  createdAt: number
  state: FollowUpState
  resolvedAt: number | null
  resolvedReason: FollowUpResolution | null
  /** How often the user has written again without getting an answer. */
  nudgeCount: number
  /** When the reminder was announced, so it is announced exactly once. */
  notifiedAt: number | null
}

export interface SearchQuery {
  text: string
  accountId?: string | null
  labelId?: string | null
  limit?: number
}

export interface ResendDomainInfo {
  id: string
  name: string
  status: string
  region: string
  receivingEnabled: boolean
  /** `true` once the inbound MX record resolves to Resend. */
  mxVerified: boolean
  requiredMxRecord: string
  /** Foreign MX hosts currently configured for the domain. */
  conflictingMx: string[]
  connectedAccountId: string | null
}

export interface SyncStatus {
  accountId: string
  phase: 'idle' | 'initial' | 'incremental' | 'error'
  processed: number
  total: number | null
  message: string | null
}

/** A search the user pinned to the sidebar, stored as the text they typed. */
export interface SavedSearch {
  name: string
  query: string
}

/** Light, dark, or whatever the OS is set to. */
export type ThemePreference = 'system' | 'light' | 'dark'

export interface AppSettings {
  undoSendSeconds: number
  pollIntervalSeconds: number
  notificationsEnabled: boolean
  onboardingComplete: boolean
  /** Model alias handed to the local Claude Code CLI when settling. */
  settleModel: string
  /** How many threads go into one classification call. */
  settleBatchSize: number
  /** Explicit path to the `claude` binary; `null` = auto-detect. */
  claudePath: string | null
  /** Model alias the compose assistant writes with. */
  aiModel: string
  /**
   * How the assistant should sound. Handed to the model verbatim — the CLI runs
   * sandboxed and loads no skills or settings of its own, so the voice has to
   * travel in the prompt.
   */
  aiStylePrompt: string
  /** Pinned queries, shown as their own sidebar section. */
  savedSearches: SavedSearch[]
  /**
   * Whether a mail to a real person arms a reminder by default. Off makes the
   * composer's box start unticked; it never removes a reminder already set.
   */
  followUpEnabled: boolean
  /** Working days the composer offers by default — working, not calendar. */
  followUpDays: number
  /**
   * Colour scheme of the app. Optional so settings written before it existed
   * stay valid; absent means `system`.
   */
  theme?: ThemePreference
  /**
   * Writes a copy of the database into the app's backup folder once a day.
   * Optional so settings stored before it existed read as "off".
   */
  autoBackup?: boolean
  /**
   * Starts Unibox in the background at login, so notifications arrive without
   * opening it first. Optional so older settings read as "off".
   */
  openAtLogin?: boolean
  /**
   * Single-key shortcuts (j, k, e, g i …). Optional so older settings read as
   * "on"; ⌘/Ctrl chords and Esc work either way.
   */
  shortcutsEnabled?: boolean
}

export const SYSTEM_LABELS = {
  inbox: 'INBOX',
  sent: 'SENT',
  drafts: 'DRAFT',
  trash: 'TRASH',
  spam: 'SPAM',
  unread: 'UNREAD',
  starred: 'STARRED'
} as const

export type SystemLabelId = (typeof SYSTEM_LABELS)[keyof typeof SYSTEM_LABELS]

// ------------------------------------------------------------------ settle

/**
 * What Unibox proposes to do with one inbox thread. `keep` means the model had
 * no confident home for it, so the thread stays where it is.
 */
export type SettleActionKind = 'label' | 'trash' | 'spam' | 'keep'

export type SettleConfidence = 'high' | 'medium' | 'low'

export interface SettleSuggestion {
  threadId: string
  accountId: string
  subject: string
  from: EmailAddress
  snippet: string
  lastMessageAt: number
  messageCount: number
  unread: boolean
  action: SettleActionKind
  /** Full label path (`Kunden/Aktiv`), `null` for trash/spam/keep. */
  labelName: string | null
  /** Local label id, `null` when the label does not exist yet. */
  labelId: string | null
  /** Removes INBOX on apply. Always true for trash/spam, never for keep. */
  archive: boolean
  reason: string
  confidence: SettleConfidence
}

/** One row of the review sheet as the user confirmed it. */
export interface SettleDecision {
  threadId: string
  action: SettleActionKind
  labelName: string | null
  labelId: string | null
  archive: boolean
}

export interface SettleReport {
  suggestions: SettleSuggestion[]
  /** Threads the model returned nothing usable for. */
  skipped: number
  scanned: number
  /** Verbatim cause when a batch failed but others succeeded. */
  warning: string | null
}

export interface SettleApplyResult {
  applied: number
  /** Names of labels that had to be created on the way. */
  createdLabels: string[]
  failed: Array<{ threadId: string; message: string }>
}

export interface SettleProgress {
  phase: 'collecting' | 'classifying' | 'done'
  processed: number
  total: number
}

export interface SettleAvailability {
  available: boolean
  /** Resolved path of the Claude Code binary, `null` when it was not found. */
  binaryPath: string | null
  message: string | null
}

/**
 * What the assistant is asked to do. `draft` writes into an empty body,
 * `rewrite` reworks what is already there, `correct` only fixes language,
 * `spot` works on one marked place and leaves the rest of the draft alone.
 */
export type AiMode = 'draft' | 'rewrite' | 'correct' | 'spot'

export type AiJobState = 'running' | 'done' | 'error'

/**
 * Everything needed to put the compose window back together once a job
 * finishes. The job outlives the window, so the window cannot be the place
 * this is kept.
 */
export interface AiComposeContext {
  accountId: string
  identityId: string | null
  to: string
  cc: string
  subject: string
  /** Local id of the message being replied to; supplies the thread context. */
  replyToMessageId: string | null
  /** Draft body at submit time, signature already stripped. */
  html: string
  /** Set only on a `spot` job: the place in the draft that job works on. */
  spot?: AiSpot
}

/**
 * One marked place in the draft. `text` is what the user had selected and what
 * the answer replaces — empty when the caret sat somewhere with nothing
 * selected, which asks for something new at that gap rather than a rewrite.
 *
 * `draft` is the whole draft as text with that place marked, so the model can
 * see what surrounds it: a spot edit that ignores its surroundings produces a
 * sentence that is right on its own and wrong where it stands. It is built in
 * the window, where the selection is exact — locating a fragment again by
 * searching for it would pick the wrong one the moment a word repeats.
 */
export interface AiSpot {
  text: string
  draft: string
}

/** Wraps the marked place in `AiSpot.draft`. Control characters: no mail has them. */
export const SPOT_OPEN = '\u0001'
export const SPOT_CLOSE = '\u0002'

export interface AiRequest {
  mode: AiMode
  /** What the user typed after `@ai`. Empty for `correct`. */
  instruction: string
  context: AiComposeContext
}

export interface AiJob {
  id: string
  mode: AiMode
  instruction: string
  context: AiComposeContext
  state: AiJobState
  /** Generated body as plain text, paragraphs separated by blank lines. */
  result: string | null
  /** The text the result replaces, so the diff has both sides. */
  source: string
  error: string | null
  createdAt: number
}
