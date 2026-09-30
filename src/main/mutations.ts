import type { Draft, MutationOp, MutationPayload, QueuedMutation } from '@shared/types'
import { SYSTEM_LABELS } from '@shared/types'
import type { Store } from './db/store'
import { labelKey } from './db/ids'
import type { GmailClient } from './google/client'
import { GmailApiError } from './google/client'
import { parseAddressList } from './mime/addresses'
import { buildMimeMessage, htmlToText, toBase64Url } from './mime/build'
import { replyContext } from './reply-context'

export interface MutationServiceDeps {
  /** Returns `null` for accounts that have no remote write-back (Resend). */
  gmailClientFor: (accountId: string) => GmailClient | null
  now?: () => number
  maxAttempts?: number
}

interface LabelChange {
  add: string[]
  remove: string[]
}

const CHANGES: Record<string, LabelChange> = {
  archive: { add: [], remove: [SYSTEM_LABELS.inbox] },
  unarchive: { add: [SYSTEM_LABELS.inbox], remove: [] },
  read: { add: [], remove: [SYSTEM_LABELS.unread] },
  unread: { add: [SYSTEM_LABELS.unread], remove: [] },
  star: { add: [SYSTEM_LABELS.starred], remove: [] },
  unstar: { add: [], remove: [SYSTEM_LABELS.starred] },
  trash: { add: [SYSTEM_LABELS.trash], remove: [SYSTEM_LABELS.inbox] },
  untrash: { add: [SYSTEM_LABELS.inbox], remove: [SYSTEM_LABELS.trash] },
  spam: { add: [SYSTEM_LABELS.spam], remove: [SYSTEM_LABELS.inbox] },
  unspam: { add: [SYSTEM_LABELS.inbox], remove: [SYSTEM_LABELS.spam] }
}

export function backoffDelay(attempts: number): number {
  return Math.min(2 ** attempts * 5_000, 15 * 60_000)
}

export class MutationService {
  private readonly now: () => number
  private readonly maxAttempts: number
  /** Tail of the running drain, so flushes queue up instead of overlapping. */
  private flushing: Promise<void> = Promise.resolve()

  constructor(
    private readonly store: Store,
    private readonly deps: MutationServiceDeps
  ) {
    this.now = deps.now ?? Date.now
    this.maxAttempts = deps.maxAttempts ?? 8
  }

  private applyLocally(messageIds: string[], change: LabelChange): void {
    for (const messageId of messageIds) {
      const message = this.store.messages.get(messageId)
      if (!message) continue
      if (change.add.length > 0) {
        this.store.messages.addLabels(
          [messageId],
          change.add.map((remoteId) => labelKey(message.accountId, remoteId))
        )
      }
      if (change.remove.length > 0) {
        this.store.messages.removeLabels(
          [messageId],
          change.remove.map((remoteId) => labelKey(message.accountId, remoteId))
        )
      }
    }
  }

  private enqueueForGoogle(messageIds: string[], op: MutationOp, payload: MutationPayload): void {
    for (const messageId of messageIds) {
      const message = this.store.messages.get(messageId)
      if (!message) continue
      const account = this.store.accounts.get(message.accountId)
      // Resend keeps archive/read/trash/spam as purely local state.
      if (!account || account.kind !== 'google') continue
      this.store.queue.enqueue({ accountId: account.id, messageId, op, payload })
    }
  }

  private run(messageIds: string[], key: keyof typeof CHANGES, op: MutationOp): void {
    const change = CHANGES[key]!
    this.applyLocally(messageIds, change)
    const payload: MutationPayload =
      op === 'add_labels' || op === 'remove_labels'
        ? { addLabelIds: change.add, removeLabelIds: change.remove }
        : { addLabelIds: change.add, removeLabelIds: change.remove }
    this.enqueueForGoogle(messageIds, op, payload)
  }

  archive(messageIds: string[]): void {
    this.run(messageIds, 'archive', 'remove_labels')
  }

  unarchive(messageIds: string[]): void {
    this.run(messageIds, 'unarchive', 'add_labels')
  }

  setRead(messageIds: string[], read: boolean): void {
    this.run(messageIds, read ? 'read' : 'unread', read ? 'remove_labels' : 'add_labels')
  }

  /**
   * STARRED is a system label on both sides of the sync, so a star travels
   * like read/unread: Gmail gets the label change, a Resend domain keeps it
   * as local state — and `is:starred` finds it either way.
   */
  setStarred(messageIds: string[], starred: boolean): void {
    this.run(messageIds, starred ? 'star' : 'unstar', starred ? 'add_labels' : 'remove_labels')
  }

  trash(messageIds: string[]): void {
    this.applyLocally(messageIds, CHANGES.trash!)
    this.enqueueForGoogle(messageIds, 'trash', {})
  }

  untrash(messageIds: string[]): void {
    this.applyLocally(messageIds, CHANGES.untrash!)
    this.enqueueForGoogle(messageIds, 'untrash', {})
  }

  markSpam(messageIds: string[]): void {
    this.applyLocally(messageIds, CHANGES.spam!)
    this.enqueueForGoogle(messageIds, 'spam', {
      addLabelIds: [SYSTEM_LABELS.spam],
      removeLabelIds: [SYSTEM_LABELS.inbox]
    })
  }

  unmarkSpam(messageIds: string[]): void {
    this.applyLocally(messageIds, CHANGES.unspam!)
    this.enqueueForGoogle(messageIds, 'unspam', {
      addLabelIds: [SYSTEM_LABELS.inbox],
      removeLabelIds: [SYSTEM_LABELS.spam]
    })
  }

  /** Label ids here are *local* ids; they are translated back to remote ids for Gmail. */
  changeLabels(messageIds: string[], addLabelIds: string[], removeLabelIds: string[]): void {
    for (const messageId of messageIds) {
      const message = this.store.messages.get(messageId)
      if (!message) continue
      if (addLabelIds.length > 0) this.store.messages.addLabels([messageId], addLabelIds)
      if (removeLabelIds.length > 0) this.store.messages.removeLabels([messageId], removeLabelIds)
      const account = this.store.accounts.get(message.accountId)
      if (!account || account.kind !== 'google') continue
      const toRemote = (ids: string[]): string[] =>
        ids
          .map((id) => this.store.labels.list(account.id).find((l) => l.id === id)?.remoteId)
          .filter((id): id is string => Boolean(id))
      this.store.queue.enqueue({
        accountId: account.id,
        messageId,
        op: addLabelIds.length > 0 ? 'add_labels' : 'remove_labels',
        payload: { addLabelIds: toRemote(addLabelIds), removeLabelIds: toRemote(removeLabelIds) }
      })
    }
  }

  /**
   * Mirrors a draft to Gmail. Autosave calls this on every pause, so a pending
   * push for the same draft is replaced rather than stacked — only the newest
   * state is worth sending, and Gmail replaces the draft wholesale anyway.
   */
  mirrorDraft(draft: Draft): void {
    const account = this.store.accounts.get(draft.accountId)
    if (!account || account.kind !== 'google') return
    this.store.queue.discardPending(draft.id, 'draft_upsert')
    this.store.queue.enqueue({
      accountId: account.id,
      messageId: draft.id,
      op: 'draft_upsert',
      payload: {}
    })
  }

  /** Removes the Gmail draft behind a local one that was sent or thrown away. */
  removeDraftRemotely(draft: Draft): void {
    const account = this.store.accounts.get(draft.accountId)
    if (!account || account.kind !== 'google' || !draft.remoteId) return
    this.store.queue.discardPending(draft.id, 'draft_upsert')
    this.store.queue.enqueue({
      accountId: account.id,
      messageId: draft.id,
      op: 'draft_delete',
      payload: { remoteDraftId: draft.remoteId }
    })
  }

  /** Turns a stored draft into the RFC 5322 message Gmail wants to hold. */
  private draftMessage(draft: Draft): { raw: string; threadId?: string } {
    const context = replyContext(this.store, draft.replyToMessageId)
    const { raw } = buildMimeMessage({
      from: { name: draft.identityName || null, email: draft.identityEmail },
      // Recipients are stored as typed, so a half-written address simply drops
      // out here instead of making the draft unsavable at Gmail.
      to: parseAddressList(draft.to),
      cc: parseAddressList(draft.cc),
      bcc: parseAddressList(draft.bcc),
      subject: draft.subject,
      html: draft.html,
      text: htmlToText(draft.html),
      attachments: draft.attachments,
      inReplyTo: context.inReplyTo,
      references: context.references,
      date: new Date(this.now())
    })
    return { raw: toBase64Url(raw), threadId: context.threadRemoteId ?? undefined }
  }

  private async pushDraft(draftId: string, client: GmailClient): Promise<void> {
    const draft = this.store.drafts.get(draftId)
    // Gone in the meantime: its deletion is queued as its own mutation.
    if (!draft) return
    const message = this.draftMessage(draft)
    const response = draft.remoteId
      ? await client
          .updateDraft(draft.remoteId, message)
          .catch(async (error: unknown) => {
            // The draft was removed at Gmail while this push waited; recreating
            // it is closer to the user's intent than reporting a dead id.
            if (error instanceof GmailApiError && error.status === 404) {
              return client.createDraft(message)
            }
            throw error
          })
      : await client.createDraft(message)
    this.store.drafts.linkRemote(draft.id, {
      remoteId: response.id,
      remoteMessageId: response.message?.id ?? null,
      at: this.now()
    })
  }

  deletePermanently(messageIds: string[]): void {
    for (const messageId of messageIds) {
      const message = this.store.messages.get(messageId)
      if (!message) continue
      const account = this.store.accounts.get(message.accountId)
      if (account?.kind === 'google') {
        this.store.queue.enqueue({ accountId: account.id, messageId, op: 'delete', payload: {} })
      }
      this.store.messages.remove(messageId)
    }
  }

  /** Re-arms a write-back the queue had given up on and drains straight away. */
  async retry(id: number): Promise<boolean> {
    if (!this.store.queue.retry(id)) return false
    await this.flush()
    return true
  }

  discard(id: number): boolean {
    return this.store.queue.discard(id)
  }

  private async execute(mutation: QueuedMutation): Promise<void> {
    const client = this.deps.gmailClientFor(mutation.accountId)
    if (!client) return

    // Draft ops address a draft, not a message: the queue's message column
    // carries the local draft id for them.
    if (mutation.op === 'draft_upsert') {
      await this.pushDraft(mutation.messageId, client)
      return
    }
    if (mutation.op === 'draft_delete') {
      const remoteId = mutation.payload.remoteDraftId
      if (!remoteId) return
      await client.deleteDraft(remoteId).catch((error: unknown) => {
        // Already gone at Gmail is the state this asked for.
        if (error instanceof GmailApiError && error.status === 404) return
        throw error
      })
      return
    }

    const message = this.store.messages.get(mutation.messageId)
    // The row may already be gone locally; fall back to the id embedded in the key.
    const remoteId = message?.remoteId ?? mutation.messageId.slice(mutation.accountId.length + 1)

    switch (mutation.op) {
      case 'trash':
        await client.trashMessage(remoteId)
        return
      case 'untrash':
        await client.untrashMessage(remoteId)
        return
      case 'delete':
        await client.deleteMessage(remoteId)
        return
      default:
        await client.modifyMessage(remoteId, {
          addLabelIds: mutation.payload.addLabelIds ?? [],
          removeLabelIds: mutation.payload.removeLabelIds ?? []
        })
    }
  }

  /**
   * Drains the queue in insertion order. A failing account pauses only its own
   * chain, so one offline account cannot block write-back for the others.
   *
   * Runs are serialised: autosave asks for a flush on every pause, and two
   * drains over the same pending row would create the same Gmail draft twice.
   */
  async flush(): Promise<{ done: number; failed: number; retry: number }> {
    const run = this.flushing.catch(() => undefined).then(() => this.drain())
    this.flushing = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  private async drain(): Promise<{ done: number; failed: number; retry: number }> {
    const pending = this.store.queue.pending(this.now())
    const blocked = new Set<string>()
    let done = 0
    let failed = 0
    let retry = 0

    for (const mutation of pending) {
      if (blocked.has(mutation.accountId)) continue
      try {
        await this.execute(mutation)
        this.store.queue.markDone(mutation.id)
        done += 1
      } catch (error) {
        // A reconnect-required error is never permanent: the queue waits for the
        // user to reconnect and then replays in order.
        const permanent = error instanceof GmailApiError && !error.isRetryable
        const attempts = mutation.attempts + 1
        const giveUp = permanent || attempts >= this.maxAttempts
        this.store.queue.markFailed(
          mutation.id,
          error instanceof Error ? error.message : String(error),
          this.now() + backoffDelay(attempts),
          giveUp
        )
        blocked.add(mutation.accountId)
        if (giveUp) failed += 1
        else retry += 1
      }
    }
    return { done, failed, retry }
  }
}
