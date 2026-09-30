import type { Db } from './index'
import { openDatabase, openMemoryDatabase } from './index'
import { AccountRepo } from './repos/accounts'
import { ActivityRepo } from './repos/activity'
import { DeliveryRepo } from './repos/deliveries'
import { MailboxRepo } from './repos/mailboxes'
import { RuleRepo } from './repos/rules'
import { DraftRepo } from './repos/drafts'
import { FollowUpRepo } from './repos/followups'
import { IdentityRepo } from './repos/identities'
import { LabelRepo } from './repos/labels'
import { MessageRepo } from './repos/messages'
import { OutboxRepo } from './repos/outbox'
import { QueueRepo } from './repos/queue'
import { RemoteImageRepo } from './repos/remote-images'
import { SearchRepo } from './repos/search'
import { SignatureRepo } from './repos/signatures'
import { SnoozeRepo } from './repos/snoozes'
import { TemplateRepo } from './repos/templates'
import { CursorRepo, SettingsRepo } from './repos/settings'

export class Store {
  readonly accounts: AccountRepo
  readonly labels: LabelRepo
  readonly messages: MessageRepo
  readonly remoteImages: RemoteImageRepo
  readonly search: SearchRepo
  readonly signatures: SignatureRepo
  readonly templates: TemplateRepo
  readonly identities: IdentityRepo
  readonly queue: QueueRepo
  readonly outbox: OutboxRepo
  readonly drafts: DraftRepo
  readonly snoozes: SnoozeRepo
  readonly followUps: FollowUpRepo
  readonly settings: SettingsRepo
  readonly cursors: CursorRepo
  readonly mailboxes: MailboxRepo
  readonly rules: RuleRepo
  readonly deliveries: DeliveryRepo
  readonly activity: ActivityRepo

  constructor(readonly db: Db) {
    this.accounts = new AccountRepo(db)
    this.labels = new LabelRepo(db)
    this.remoteImages = new RemoteImageRepo(db)
    this.messages = new MessageRepo(db, this.remoteImages)
    this.search = new SearchRepo(db, this.messages)
    this.signatures = new SignatureRepo(db)
    this.templates = new TemplateRepo(db)
    this.identities = new IdentityRepo(db, this.signatures)
    this.queue = new QueueRepo(db)
    this.outbox = new OutboxRepo(db)
    this.drafts = new DraftRepo(db)
    this.snoozes = new SnoozeRepo(db)
    this.followUps = new FollowUpRepo(db)
    this.settings = new SettingsRepo(db)
    this.cursors = new CursorRepo(db)
    this.mailboxes = new MailboxRepo(db)
    this.rules = new RuleRepo(db)
    this.deliveries = new DeliveryRepo(db)
    this.activity = new ActivityRepo(db)
  }

  static openFile(file: string): Store {
    return new Store(openDatabase(file))
  }

  static openMemory(): Store {
    return new Store(openMemoryDatabase())
  }

  /**
   * Writes a consistent copy to `file`. `VACUUM INTO` reads through the WAL, so
   * the copy is a complete database even while the app keeps syncing — a plain
   * file copy would miss whatever is still in the write-ahead log.
   */
  backupTo(file: string): void {
    this.db.prepare('VACUUM INTO ?').run(file)
  }

  /** Bytes the database occupies — pages in use, so it works in memory too. */
  sizeBytes(): number {
    const pages = this.db.pragma('page_count', { simple: true }) as number
    const size = this.db.pragma('page_size', { simple: true }) as number
    return pages * size
  }

  close(): void {
    this.db.close()
  }
}
