import type { FollowUp, Message, OutboxItem } from '@shared/types'
import {
  addWorkingDays,
  isAutoReplySubject,
  isFollowUpCandidate,
  isNoReplyAddress
} from '@shared/followup'
import type { Store } from './db/store'

export interface FollowUpDeps {
  now?: () => number
}

/**
 * How long a follow-up may wait for its sent message to reach the local store.
 * Only a send whose follow-on sync failed leaves one dangling, and Gmail's next
 * regular cycle is minutes away — a week is generous.
 */
const UNATTACHED_TTL_MS = 7 * 24 * 3600 * 1000

/**
 * The outbound mirror of the inbox: what was sent and is waiting for an answer.
 *
 * Nothing here talks to a server. A follow-up is armed when a mail goes out,
 * resolves itself the moment somebody writes back, and otherwise surfaces once
 * its date has passed. That the reminder is local is the point — Gmail has
 * nowhere to put it, and the whole state is reconstructible from the mail.
 */
export class FollowUpService {
  private readonly now: () => number

  constructor(
    private readonly store: Store,
    deps: FollowUpDeps = {}
  ) {
    this.now = deps.now ?? Date.now
  }

  /** The date the composer's default offer lands on. */
  defaultDueAt(from = this.now()): number {
    return addWorkingDays(from, this.store.settings.get().followUpDays)
  }

  /**
   * Arms a follow-up for a mail that has just gone out. `localMessageId` is
   * where that mail will live locally — for Gmail the post-send sync usually
   * has it on disk already, and when that sync failed the row waits without a
   * conversation until `reconcile` finds the message.
   *
   * Unchecking the box in the composer arms nothing; it never clears a reminder
   * that an earlier mail in the conversation set. Those are ended in the
   * conversation itself, where the user can see what they are ending.
   */
  track(item: OutboxItem, localMessageId: string): FollowUp | null {
    if (item.followUpDays === null || item.followUpDays === undefined) return null
    if (!this.store.settings.get().followUpEnabled) return null
    if (!isFollowUpCandidate([...item.to, ...item.cc])) return null

    const now = this.now()
    const threadId =
      this.store.messages.get(localMessageId)?.threadId ??
      (item.replyToMessageId
        ? (this.store.messages.get(item.replyToMessageId)?.threadId ?? '')
        : '')
    const dueAt = addWorkingDays(now, item.followUpDays)

    const existing = threadId ? this.store.followUps.openForThread(threadId) : null
    if (existing) {
      // Writing again into a waiting conversation is a nudge, not a second
      // reminder: the wait starts over from the mail just sent.
      this.store.followUps.nudge(existing.id, localMessageId, dueAt, 1)
      return this.store.followUps.get(existing.id)
    }
    return this.store.followUps.create({
      accountId: item.accountId,
      threadId,
      messageId: localMessageId,
      dueAt,
      now
    })
  }

  /** Starts a follow-up on a conversation the user points at. */
  arm(threadId: string, dueAt: number): FollowUp {
    const existing = this.store.followUps.openForThread(threadId)
    if (existing) {
      this.store.followUps.reschedule(existing.id, dueAt)
      return this.store.followUps.get(existing.id)!
    }
    const messages = this.store.messages.messagesInThread(threadId)
    if (messages.length === 0) throw new Error('Unbekannte Konversation')
    // The wait hangs off the last thing *we* said; only if we never wrote does
    // the conversation's last message stand in for it.
    const anchor =
      [...messages].reverse().find((message) => message.direction === 'outgoing') ??
      messages[messages.length - 1]!
    return this.store.followUps.create({
      accountId: anchor.accountId,
      threadId,
      messageId: anchor.id,
      dueAt,
      now: this.now()
    })
  }

  /** The user says the matter is settled — no answer is being waited for. */
  clear(threadId: string): void {
    const existing = this.store.followUps.openForThread(threadId)
    if (existing) this.store.followUps.resolve(existing.id, 'manual', this.now())
  }

  /** Pushes a reminder back without ending it. */
  postpone(threadId: string, dueAt: number): void {
    const existing = this.store.followUps.openForThread(threadId)
    if (existing) this.store.followUps.reschedule(existing.id, dueAt)
  }

  listOpen(accountId?: string | null): FollowUp[] {
    return this.store.followUps.listOpen(accountId)
  }

  /** Conversations thrown away stop waiting — nothing is owed to the bin. */
  forgetByMessages(messageIds: string[]): void {
    const threadIds = new Set<string>()
    for (const messageId of messageIds) {
      const threadId = this.store.messages.get(messageId)?.threadId
      if (threadId) threadIds.add(threadId)
    }
    this.store.followUps.forgetThreads([...threadIds], this.now())
  }

  /**
   * An answer, or something that only looks like one. A vacation responder
   * keeps the original subject and marks itself in the headers; a mailing list
   * or a no-reply sender never meant to answer at all.
   */
  private isRealReply(message: Message): boolean {
    if (message.direction !== 'incoming') return false
    if (message.autoReply) return false
    if (isAutoReplySubject(message.subject)) return false
    return !isNoReplyAddress(message.from.email)
  }

  /**
   * Walks every open follow-up against what the mailbox now holds. Runs after
   * each sync: it is the only thing that ever ends a wait by itself, and it is
   * cheap because it only reads conversations that are actually waiting.
   */
  reconcile(): { resolved: number; nudged: number } {
    const now = this.now()
    const days = this.store.settings.get().followUpDays
    let resolved = 0
    let nudged = 0

    // A send whose follow-on sync failed left the conversation blank; the
    // message reaches the store with the next regular cycle.
    for (const pending of this.store.followUps.unattached()) {
      const threadId = this.store.messages.get(pending.messageId)?.threadId
      if (threadId) this.store.followUps.attachThread(pending.id, threadId)
    }
    this.store.followUps.purgeUnattached(now - UNATTACHED_TTL_MS)

    for (const followUp of this.store.followUps.listOpen()) {
      if (followUp.threadId === '') continue
      const messages = this.store.messages.messagesInThread(followUp.threadId)
      if (messages.length === 0) {
        this.store.followUps.resolve(followUp.id, 'dropped', now)
        resolved += 1
        continue
      }
      // What counts as "since we sent" has two yardsticks, and it needs both.
      // Position in the conversation is the obvious one, but a sender with a
      // wrong clock sorts its answer *before* the mail it answers — so
      // anything this machine stored after the wait began counts as well. The
      // `Date` header is exactly what cannot be trusted here.
      const anchor = messages.findIndex((message) => message.id === followUp.messageId)
      // The second yardstick moves with the anchor, not with the row: after a
      // nudge the mail that caused it is the new "since", or the same nudge
      // would be counted again on every cycle that follows.
      const since = messages[anchor]?.storedAt ?? followUp.createdAt
      const after = messages.filter(
        (message, index) =>
          message.id !== followUp.messageId &&
          ((anchor >= 0 && index > anchor) || message.storedAt > since)
      )

      if (after.some((message) => this.isRealReply(message))) {
        this.store.followUps.resolve(followUp.id, 'replied', now)
        resolved += 1
        continue
      }

      const own = after.filter((message) => message.direction === 'outgoing')
      const latest = own[own.length - 1]
      if (!latest) continue
      // We wrote again and still heard nothing: that is a nudge, and the wait
      // restarts from it. The anchor moves so the same mail is not counted the
      // next time round.
      this.store.followUps.nudge(
        followUp.id,
        latest.id,
        addWorkingDays(latest.date, days),
        own.length
      )
      nudged += 1
    }
    return { resolved, nudged }
  }

  /**
   * Follow-ups whose date has passed and that nobody has been told about. They
   * are marked as announced right here: a reminder that repeated on every sync
   * would be the fastest way to have notifications switched off.
   */
  takeDue(): Array<{ followUp: FollowUp; subject: string; recipients: string }> {
    const now = this.now()
    const due = this.store.followUps.dueForNotification(now)
    if (due.length === 0) return []
    this.store.followUps.markNotified(
      due.map((followUp) => followUp.id),
      now
    )
    return due.map((followUp) => {
      const message = this.store.messages.get(followUp.messageId)
      const summary = this.store.messages.threadSummary(followUp.threadId)
      return {
        followUp,
        subject: message?.subject || summary?.subject || '',
        recipients: (message?.to ?? []).map((address) => address.name ?? address.email).join(', ')
      }
    })
  }
}
