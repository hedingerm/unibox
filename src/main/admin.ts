import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type {
  AdminOverview,
  BackupFile,
  Mailbox,
  MailboxInput,
  MailboxPatch,
  ResendWebhook,
  ResendWebhookCreated
} from '@shared/admin'
import type { WebhookInput } from '@shared/ipc'
import type { AccountKind } from '@shared/types'
import type { Store } from './db/store'
import { normalizeAddress } from './db/repos/mailboxes'
import type { ResendClient, ResendWebhookData } from './resend/client'
import type { ResendDomainService } from './resend/domains'

const DAY_MS = 24 * 60 * 60 * 1000

/** Daily backups kept; older ones are deleted as new ones are written. */
export const AUTO_BACKUP_KEEP = 7

const AUTO_PREFIX = 'unibox-auto-'
const MANUAL_PREFIX = 'unibox-backup-'

/** `2026-09-25-1405` — sortable, and unique enough for a file made by hand. */
function stamp(now: number): string {
  const iso = new Date(now).toISOString()
  return `${iso.slice(0, 10)}-${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}`
}

const EMAIL_PATTERN = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/

function toWebhook(data: ResendWebhookData): ResendWebhook {
  const createdAt = data.created_at ? Date.parse(data.created_at) : Number.NaN
  return {
    id: data.id,
    endpoint: data.endpoint,
    events: data.events ?? [],
    status: data.status ?? null,
    createdAt: Number.isFinite(createdAt) ? createdAt : null
  }
}

export interface AdminServiceDeps {
  backupsPath: string
  domainService: () => ResendDomainService | null
  now?: () => number
}

/** Snapshot of the domain flags the overview counts, from the last listing. */
interface DomainFlags {
  verified: boolean
  receivingEnabled: boolean
}

/**
 * The admin area's bookkeeping: mailbox validation, the overview numbers,
 * backups and webhooks. Everything that changes mail lives elsewhere.
 */
export class AdminService {
  private readonly now: () => number
  private domains: DomainFlags[] | null = null

  constructor(
    private readonly store: Store,
    private readonly deps: AdminServiceDeps
  ) {
    this.now = deps.now ?? Date.now
  }

  // ------------------------------------------------------------- mailboxes

  listMailboxes(accountId: string | null): Mailbox[] {
    return this.store.mailboxes.list(accountId, (addresses, owner) =>
      this.store.messages.countUnreadInbox({ accountId: owner, recipients: addresses })
    )
  }

  private checkAddress(address: string, domain: string): string {
    const email = normalizeAddress(address)
    if (!EMAIL_PATTERN.test(email)) throw new Error(`Die Adresse ${address} ist ungültig.`)
    if (email.slice(email.lastIndexOf('@') + 1) !== domain) {
      throw new Error(`Die Adresse ${email} muss zur Domain ${domain} gehören.`)
    }
    return email
  }

  private domainOf(accountId: string): string {
    const account = this.store.accounts.get(accountId)
    if (!account || account.kind !== 'resend') {
      throw new Error('Postfächer gibt es nur auf Resend-Domains.')
    }
    return account.email.toLowerCase()
  }

  private checkIdentity(identityId: string | null | undefined, accountId: string): string | null {
    if (!identityId) return null
    const identity = this.store.identities.get(identityId)
    if (!identity || identity.accountId !== accountId) {
      throw new Error('Die Identität gehört nicht zu dieser Domain.')
    }
    return identity.id
  }

  private cleanAliases(aliases: string[], address: string, domain: string): string[] {
    return [
      ...new Set(
        aliases
          .map((alias) => alias.trim())
          .filter(Boolean)
          .map((alias) => this.checkAddress(alias, domain))
      )
    ].filter((alias) => alias !== address)
  }

  createMailbox(input: MailboxInput): Mailbox {
    const domain = this.domainOf(input.accountId)
    const address = this.checkAddress(input.address, domain)
    const created = this.store.mailboxes.create({
      accountId: input.accountId,
      address,
      displayName: input.displayName?.trim() || address.slice(0, address.indexOf('@')),
      aliases: this.cleanAliases(input.aliases ?? [], address, domain),
      identityId: this.checkIdentity(input.identityId, input.accountId)
    })
    return this.withUnread(created)
  }

  updateMailbox(id: string, patch: MailboxPatch): Mailbox {
    const existing = this.store.mailboxes.get(id)
    if (!existing) throw new Error('Unbekanntes Postfach')
    const domain = this.domainOf(existing.accountId)
    const address = patch.address !== undefined ? this.checkAddress(patch.address, domain) : undefined
    const updated = this.store.mailboxes.update(id, {
      address,
      displayName: patch.displayName?.trim() || undefined,
      aliases:
        patch.aliases !== undefined
          ? this.cleanAliases(patch.aliases, address ?? existing.address, domain)
          : undefined,
      identityId:
        patch.identityId !== undefined
          ? this.checkIdentity(patch.identityId, existing.accountId)
          : undefined
    })
    return this.withUnread(updated)
  }

  private withUnread(mailbox: Mailbox): Mailbox {
    return {
      ...mailbox,
      unread: this.store.messages.countUnreadInbox({
        accountId: mailbox.accountId,
        recipients: [mailbox.address, ...mailbox.aliases]
      })
    }
  }

  // --------------------------------------------------------------- domains

  /** Keeps the flags of the last listing for the overview; returns the list. */
  rememberDomains<T extends DomainFlags>(domains: T[]): T[] {
    this.domains = domains.map((domain) => ({
      verified: domain.verified,
      receivingEnabled: domain.receivingEnabled
    }))
    return domains
  }

  private async domainFlags(): Promise<DomainFlags[]> {
    if (this.domains) return this.domains
    const service = this.deps.domainService()
    if (!service) return []
    try {
      const listed = await service.list()
      return this.rememberDomains(
        listed.map((domain) => ({
          verified: domain.status === 'verified',
          receivingEnabled: domain.receivingEnabled
        }))
      )
    } catch {
      // Offline: the overview still shows everything that is local.
      return []
    }
  }

  // -------------------------------------------------------------- overview

  async overview(): Promise<AdminOverview> {
    const accounts = this.store.accounts.list()
    const byKind: Record<AccountKind, number> = { google: 0, resend: 0 }
    for (const account of accounts) byKind[account.kind] += 1
    const domains = await this.domainFlags()
    const weekAgo = this.now() - 7 * DAY_MS
    const counts = this.store.messages.countSince(weekAgo)
    const bounced = this.store.deliveries.summary({ since: weekAgo }).byStatus.bounced ?? 0
    const newestFile = this.listBackups()[0]?.createdAt ?? null
    const logged = this.store.activity.latest('backup_created')?.ts ?? null
    const lastBackupAt =
      newestFile === null ? logged : logged === null ? newestFile : Math.max(newestFile, logged)
    return {
      accounts: { total: accounts.length, byKind },
      domains: {
        total: domains.length,
        verified: domains.filter((domain) => domain.verified).length,
        receiving: domains.filter((domain) => domain.receivingEnabled).length
      },
      mailboxes: this.store.mailboxes.count(),
      activeRules: this.store.rules.countEnabled(),
      last7Days: { received: counts.incoming, sent: counts.outgoing, bounced },
      lastBackupAt,
      dbSizeBytes: this.store.sizeBytes(),
      sync: accounts.map((account) => ({
        accountId: account.id,
        email: account.email,
        kind: account.kind,
        status: account.status,
        lastSyncedAt: account.lastSyncedAt,
        lastError: account.lastError
      })),
      recentErrors: this.store.activity.countSince('sync_error', this.now() - DAY_MS)
    }
  }

  // --------------------------------------------------------------- backups

  ensureBackupsPath(): string {
    mkdirSync(this.deps.backupsPath, { recursive: true })
    return this.deps.backupsPath
  }

  listBackups(): BackupFile[] {
    let names: string[]
    try {
      names = readdirSync(this.deps.backupsPath)
    } catch {
      return []
    }
    const files: BackupFile[] = []
    for (const name of names) {
      if (!name.endsWith('.db')) continue
      const path = join(this.deps.backupsPath, name)
      try {
        const stat = statSync(path)
        files.push({
          name,
          path,
          size: stat.size,
          createdAt: stat.mtimeMs,
          auto: name.startsWith(AUTO_PREFIX)
        })
      } catch {
        // Removed between listing and stat.
      }
    }
    return files.sort((a, b) => b.createdAt - a.createdAt || b.name.localeCompare(a.name))
  }

  createBackup(auto: boolean): BackupFile {
    const directory = this.ensureBackupsPath()
    const now = this.now()
    const name = `${auto ? AUTO_PREFIX : MANUAL_PREFIX}${stamp(now)}.db`
    const path = join(directory, name)
    // VACUUM INTO refuses to overwrite; a second backup in the same second
    // replaces the first rather than failing.
    rmSync(path, { force: true })
    this.store.backupTo(path)
    const size = statSync(path).size
    this.store.activity.record({
      kind: 'backup_created',
      ts: now,
      summary: auto ? 'Automatisches Backup erstellt' : 'Backup erstellt',
      meta: { path, auto, size }
    })
    if (auto) this.pruneAutoBackups()
    return { name, path, size, createdAt: now, auto }
  }

  private pruneAutoBackups(): void {
    const autos = this.listBackups().filter((file) => file.auto)
    for (const file of autos.slice(AUTO_BACKUP_KEEP)) rmSync(file.path, { force: true })
  }

  /** Writes a daily backup when the newest one is a day old or missing. */
  autoBackupIfDue(): BackupFile | null {
    const newest = this.listBackups().find((file) => file.auto)
    if (newest && this.now() - newest.createdAt < DAY_MS) return null
    return this.createBackup(true)
  }

  // -------------------------------------------------------------- webhooks

  async listWebhooks(client: ResendClient): Promise<ResendWebhook[]> {
    const page = await client.listWebhooks()
    return (page.data ?? []).map(toWebhook)
  }

  async createWebhook(client: ResendClient, input: WebhookInput): Promise<ResendWebhookCreated> {
    let url: URL
    try {
      url = new URL(input.endpoint.trim())
    } catch {
      throw new Error('Die Webhook-Adresse ist ungültig.')
    }
    if (url.protocol !== 'https:') throw new Error('Webhooks brauchen eine https-Adresse.')
    const events = [...new Set(input.events.map((event) => event.trim()).filter(Boolean))]
    if (events.length === 0) throw new Error('Wähle mindestens ein Ereignis.')
    const created = await client.createWebhook({ endpoint: url.toString(), events })
    return {
      id: created.id,
      endpoint: url.toString(),
      events,
      status: 'enabled',
      createdAt: this.now(),
      signingSecret: created.signing_secret ?? null
    }
  }
}
