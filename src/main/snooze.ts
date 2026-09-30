import type { Snooze } from '@shared/types'
import type { Store } from './db/store'
import type { MutationService } from './mutations'

export interface SnoozeDeps {
  now?: () => number
}

/**
 * Putting a conversation aside and bringing it back.
 *
 * The Gmail API exposes no snooze — it is a feature of the web client only —
 * so this is built from the two moves that *are* available: archive now,
 * un-archive later. The wake time lives in the local `snoozes` table, and both
 * halves go through the mutation queue, so Gmail sees ordinary archiving with
 * the usual offline behaviour.
 *
 * Two consequences are deliberate. A snoozed mail is invisible in Gmail's web
 * client (it sits in the archive, not in Gmail's own Snoozed folder), and a
 * wake can only happen while Unibox runs — the promise is "not before", not
 * "at". The app checks on every start, so a wake missed overnight lands at the
 * next launch.
 */
export class SnoozeService {
  private readonly now: () => number

  constructor(
    private readonly store: Store,
    private readonly mutations: MutationService,
    deps: SnoozeDeps = {}
  ) {
    this.now = deps.now ?? Date.now
  }

  private messageIdsOf(threadIds: string[]): string[] {
    return threadIds.flatMap((threadId) =>
      this.store.messages.messagesInThread(threadId).map((message) => message.id)
    )
  }

  /**
   * Archives the conversations and remembers when to bring them back. A wake
   * time in the past would put the mail back on the very next tick, so it is
   * refused rather than silently doing nothing.
   */
  snooze(threadIds: string[], wakeAt: number): Snooze[] {
    const now = this.now()
    if (!Number.isFinite(wakeAt)) throw new Error('Ungültiger Zeitpunkt')
    if (wakeAt <= now) throw new Error('Der Zeitpunkt liegt in der Vergangenheit')
    const created: Snooze[] = []
    for (const threadId of threadIds) {
      const messages = this.store.messages.messagesInThread(threadId)
      if (messages.length === 0) continue
      this.mutations.archive(messages.map((message) => message.id))
      created.push(this.store.snoozes.upsert(threadId, messages[0]!.accountId, wakeAt, now))
    }
    return created
  }

  /** Brings the conversations back into the inbox and forgets the reminder. */
  unsnooze(threadIds: string[]): string[] {
    const known = threadIds.filter((threadId) => this.store.snoozes.get(threadId) !== null)
    if (known.length === 0) return []
    this.mutations.unarchive(this.messageIdsOf(known))
    this.store.snoozes.remove(known)
    return known
  }

  /**
   * Forgets the reminder without touching the mail. This is what trashing,
   * deleting or marking a snoozed conversation as spam does: it has left the
   * inbox for good, and bringing it back later would undo that decision.
   */
  forget(threadIds: string[]): void {
    this.store.snoozes.remove(threadIds)
  }

  /** Same, addressed by message — the shape every mailbox action works in. */
  forgetByMessages(messageIds: string[]): void {
    const threadIds = new Set<string>()
    for (const messageId of messageIds) {
      const message = this.store.messages.get(messageId)
      if (message) threadIds.add(message.threadId)
    }
    this.forget([...threadIds])
  }

  list(accountId?: string | null): Snooze[] {
    return this.store.snoozes.list(accountId)
  }

  count(): number {
    return this.store.snoozes.count()
  }

  /**
   * One pass of the clock: everything whose time has come goes back to the
   * inbox, and so does anything that got an answer in the meantime — a snooze
   * is a reminder to deal with a conversation, and a new mail in it is that
   * reminder arriving early. Returns the conversations that woke up.
   */
  tick(): string[] {
    this.store.snoozes.pruneOrphans()
    const woken = new Map<string, Snooze>()
    for (const entry of this.store.snoozes.due(this.now())) woken.set(entry.threadId, entry)
    for (const entry of this.store.snoozes.interrupted()) woken.set(entry.threadId, entry)
    if (woken.size === 0) return []
    return this.unsnooze([...woken.keys()])
  }
}
