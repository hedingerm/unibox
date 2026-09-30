/**
 * Types behind the admin area: domain authentication, local mailboxes, routing
 * rules, delivery status, the activity log, the overview and backups. Kept out
 * of `types.ts` because none of it touches reading or writing mail.
 */

import type { AccountKind, AccountStatus, ResendDomainInfo } from './types'

// ------------------------------------------------------------------ domains

/** One DNS record a domain needs, with what was found for it. */
export type DomainRecordStatus = 'found' | 'missing' | 'pending'

/**
 * What a record is for. `mx_receiving` is the inbound MX that routes the
 * catch-all to Resend, `return_path` the MX Resend bounces through, `dmarc`
 * the policy record Resend does not check but mailbox providers read.
 */
export type DomainRecordKind = 'mx_receiving' | 'spf' | 'dkim' | 'return_path' | 'dmarc' | 'other'

export interface DomainRecordCheck {
  kind: DomainRecordKind
  /** DNS type: `MX`, `TXT`, `CNAME`. */
  type: string
  /** Host as Resend names it (`send`, `resend._domainkey`, `@`, `_dmarc`). */
  name: string
  value: string
  priority: number | null
  ttl: string | null
  status: DomainRecordStatus
  /** `resend` = status as reported by the Resend API, `dns` = looked up here. */
  source: 'resend' | 'dns'
  /** Whether sending or receiving depends on it; DMARC is advice only. */
  required: boolean
}

export interface DomainDmarc {
  status: 'found' | 'missing'
  /** The TXT record as published, chunks joined. */
  value: string | null
  /** The `p=` tag: `none`, `quarantine`, `reject`. */
  policy: string | null
  /** What to publish when nothing is there yet. */
  suggested: string
}

/** The MailFlare-style authentication panel of one Resend domain. */
export interface DomainDetails extends ResendDomainInfo {
  sendingEnabled: boolean
  /** Resend says every sending record checks out. */
  verified: boolean
  records: DomainRecordCheck[]
  dmarc: DomainDmarc
  createdAt: number | null
}

// ---------------------------------------------------------------- mailboxes

/**
 * A named address on a Resend domain. Not a real mailbox — Resend delivers the
 * whole domain as one catch-all — but a filtered view onto it: the threads in
 * which a message was addressed (To/Cc) to the address or one of its aliases.
 */
export interface Mailbox {
  id: string
  /** The Resend domain account the address belongs to. */
  accountId: string
  address: string
  displayName: string
  aliases: string[]
  /** Identity replies to this mailbox start from; `null` = the usual pick. */
  identityId: string | null
  sort: number
  createdAt: number
  /** Unread conversations in the inbox addressed to it. */
  unread: number
}

export interface MailboxInput {
  accountId: string
  address: string
  displayName?: string
  aliases?: string[]
  identityId?: string | null
}

export type MailboxPatch = Partial<Omit<MailboxInput, 'accountId'>>

// -------------------------------------------------------------------- rules

export type RuleMatchField = 'from' | 'to' | 'subject' | 'body' | 'any'
export type RuleOperator = 'contains' | 'exact' | 'starts_with' | 'ends_with' | 'regex'
export type RuleAction = 'label' | 'archive' | 'mark_read' | 'spam' | 'trash' | 'forward' | 'drop'

export const RULE_MATCH_FIELDS: RuleMatchField[] = ['from', 'to', 'subject', 'body', 'any']
export const RULE_OPERATORS: RuleOperator[] = ['contains', 'exact', 'starts_with', 'ends_with', 'regex']
export const RULE_ACTIONS: RuleAction[] = [
  'label',
  'archive',
  'mark_read',
  'spam',
  'trash',
  'forward',
  'drop'
]

/**
 * A routing rule, applied to newly received Resend mail during sync — never
 * to mail that is already there. Rules run by ascending `priority`; the first
 * match ends the run unless its `stopProcessing` is off.
 */
export interface RoutingRule {
  id: string
  /** Resend domain account the rule is limited to; `null` = every domain. */
  accountId: string | null
  name: string
  enabled: boolean
  priority: number
  matchField: RuleMatchField
  operator: RuleOperator
  /** Compared case-insensitively; a regex is compiled with the `i` flag. */
  value: string
  action: RuleAction
  /** Label id for `label`, target address for `forward`, else `null`. */
  actionArg: string | null
  stopProcessing: boolean
  matchCount: number
  lastMatchedAt: number | null
  createdAt: number
}

export interface RuleInput {
  accountId: string | null
  name: string
  enabled?: boolean
  matchField: RuleMatchField
  operator: RuleOperator
  value: string
  action: RuleAction
  actionArg?: string | null
  /** Defaults to true: first match wins. */
  stopProcessing?: boolean
}

export type RulePatch = Partial<RuleInput>

/** A message a rule would have matched in a dry run. */
export interface RuleTestMatch {
  messageId: string
  threadId: string
  accountId: string
  subject: string
  from: string
  date: number
}

export interface RuleTestResult {
  /** How many messages were looked at. */
  scanned: number
  matches: RuleTestMatch[]
  /** Set when the value is not a valid regular expression. */
  error: string | null
}

// ----------------------------------------------------------------- delivery

/** Resend's `last_event` of a sent mail. Unknown future events pass through. */
export type DeliveryEvent =
  | 'sent'
  | 'delivered'
  | 'delivery_delayed'
  | 'bounced'
  | 'complained'
  | 'opened'
  | 'clicked'
  | 'failed'
  | 'scheduled'
  | 'canceled'
  | 'queued'
  | (string & {})

export interface Delivery {
  /** Resend's email id. */
  remoteId: string
  /** Sending domain, lower case. */
  domain: string
  from: string
  to: string[]
  subject: string
  sentAt: number
  lastEvent: DeliveryEvent | null
  /** When the status last changed here. */
  updatedAt: number
  /** Local message id when the mail is in the store, else `null`. */
  messageId: string | null
}

export interface DeliveryListArgs {
  status?: DeliveryEvent | null
  domain?: string | null
  limit?: number
  offset?: number
}

export interface DeliverySummary {
  total: number
  /** Count per `last_event`, `unknown` for mail without one yet. */
  byStatus: Record<string, number>
}

/** Event names the Resend webhook API accepts. */
export const RESEND_WEBHOOK_EVENTS = [
  'email.sent',
  'email.delivered',
  'email.delivery_delayed',
  'email.complained',
  'email.bounced',
  'email.opened',
  'email.clicked',
  'email.received',
  'email.failed'
] as const

export interface ResendWebhook {
  id: string
  endpoint: string
  events: string[]
  status: string | null
  createdAt: number | null
}

export interface ResendWebhookCreated extends ResendWebhook {
  /** Only handed out once, at creation — Resend never shows it again here. */
  signingSecret: string | null
}

// ------------------------------------------------------------ new domains

/** The regions Resend sends from; a domain's region is fixed at creation. */
export const DOMAIN_REGIONS = ['eu-west-1', 'us-east-1', 'sa-east-1', 'ap-northeast-1'] as const
export type DomainRegion = (typeof DOMAIN_REGIONS)[number]

export interface DomainCreateInput {
  name: string
  region: DomainRegion
}

/**
 * A bare hostname with at least one dot: what Resend accepts as a domain.
 * Lowercased and trimmed; null when it is not one.
 */
export function normalizeDomainName(input: string): string | null {
  const name = input.trim().toLowerCase().replace(/\.$/, '')
  const label = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?'
  return new RegExp(`^(?:${label}\\.)+[a-z]{2,63}$`).test(name) ? name : null
}

// ----------------------------------------------------------------- activity

export type ActivityKind =
  | 'mail_sent'
  | 'rule_action'
  | 'domain_created'
  | 'receiving_enabled'
  | 'receiving_disabled'
  | 'account_connected'
  | 'account_removed'
  | 'reconnect_required'
  | 'backup_created'
  | 'sync_error'

export interface ActivityEntry {
  id: number
  ts: number
  kind: ActivityKind
  accountId: string | null
  /** German one-liner, ready to show. */
  summary: string
  meta: Record<string, unknown>
  /** How often an identical entry repeated (sync errors are folded). */
  count: number
}

export interface ActivityListArgs {
  kind?: ActivityKind | ActivityKind[] | null
  accountId?: string | null
  limit?: number
  /** Entries with an id below this one — the paging cursor. */
  beforeId?: number | null
}

export interface ActivityPage {
  entries: ActivityEntry[]
  /** Pass as `beforeId` for the next page; `null` when there is none. */
  nextBeforeId: number | null
}

// ----------------------------------------------------------------- overview

export interface AdminOverview {
  accounts: { total: number; byKind: Record<AccountKind, number> }
  domains: { total: number; verified: number; receiving: number }
  mailboxes: number
  activeRules: number
  last7Days: { received: number; sent: number; bounced: number }
  lastBackupAt: number | null
  dbSizeBytes: number
  sync: Array<{
    accountId: string
    email: string
    kind: AccountKind
    status: AccountStatus
    lastSyncedAt: number | null
    lastError: string | null
  }>
  /** Sync errors logged in the last 24 hours. */
  recentErrors: number
}

// ------------------------------------------------------------------ backups

export interface BackupFile {
  name: string
  path: string
  size: number
  createdAt: number
  /** Written by the daily timer rather than by hand. */
  auto: boolean
}
