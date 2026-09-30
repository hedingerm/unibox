import type { OutboxDraft, OutboxItem } from '@shared/types'
import { SYSTEM_LABELS } from '@shared/types'
import type { Store } from '../db/store'
import { attachmentKey, messageKey, threadKey } from '../db/ids'
import type { GmailClient } from '../google/client'
import type { ResendClient } from '../resend/client'
import { buildMimeMessage, htmlToText, toBase64Url } from '../mime/build'
import type { FollowUpService } from '../followups'
import type { ReplyContext } from '../reply-context'
import { replyContext } from '../reply-context'

export interface SendResult {
  remoteId: string
  threadRemoteId: string | null
  messageIdHeader: string
}

export interface SendServiceDeps {
  gmailClientFor: (accountId: string) => GmailClient | null
  resendClient: () => ResendClient | null
  now?: () => number
  /** Lets the app pull the freshly sent Gmail message into the local store. */
  afterGmailSend?: (accountId: string, remoteMessageId: string) => Promise<void>
  onChange?: () => void
  /**
   * Arms the "waiting for an answer" reminder once a mail is really out. Left
   * out in tests that only care about delivery.
   */
  followUps?: FollowUpService | null
  /** Told about every mail that really went out, for the activity log. */
  onSent?: (item: OutboxItem, remoteId: string) => void
  maxAttempts?: number
}

export class SendService {
  private readonly now: () => number
  private readonly maxAttempts: number

  constructor(
    private readonly store: Store,
    private readonly deps: SendServiceDeps
  ) {
    this.now = deps.now ?? Date.now
    this.maxAttempts = deps.maxAttempts ?? 5
  }

  /**
   * Queues a message with a grace period. Nothing leaves the machine until the
   * undo window elapses, which is what makes "Senden rückgängig" reliable.
   */
  enqueue(draft: OutboxDraft, undoSeconds?: number): OutboxItem {
    const seconds = undoSeconds ?? this.store.settings.get().undoSendSeconds
    const item = this.store.outbox.create(draft, 'undoable', this.now() + seconds * 1000)
    this.deps.onChange?.()
    return item
  }

  schedule(draft: OutboxDraft, sendAt: number): OutboxItem {
    const item = this.store.outbox.create(draft, 'scheduled', sendAt)
    this.deps.onChange?.()
    return item
  }

  cancel(outboxId: string): boolean {
    const cancelled = this.store.outbox.cancel(outboxId)
    if (cancelled) this.deps.onChange?.()
    return cancelled
  }

  list(): OutboxItem[] {
    return this.store.outbox.list()
  }

  /**
   * A mail that ran out of attempts is not lost — it waits in the outbox until
   * the user says "try again", which is the only way out of a hard failure.
   */
  async retry(outboxId: string): Promise<boolean> {
    if (!this.store.outbox.retry(outboxId, this.now())) return false
    this.deps.onChange?.()
    await this.tick()
    return true
  }

  discard(outboxId: string): boolean {
    const discarded = this.store.outbox.discard(outboxId)
    if (discarded) this.deps.onChange?.()
    return discarded
  }

  private replyContext(item: OutboxItem): ReplyContext {
    return replyContext(this.store, item.replyToMessageId)
  }

  private async sendViaGmail(item: OutboxItem): Promise<SendResult> {
    const client = this.deps.gmailClientFor(item.accountId)
    if (!client) throw new Error('Kein Gmail-Zugang für dieses Konto')
    const context = this.replyContext(item)
    const { raw, messageId } = buildMimeMessage({
      from: { name: item.identityName || null, email: item.identityEmail },
      to: item.to,
      cc: item.cc,
      bcc: item.bcc,
      subject: item.subject,
      html: item.html,
      text: item.text || htmlToText(item.html),
      attachments: item.attachments,
      inReplyTo: context.inReplyTo,
      references: context.references,
      date: new Date(this.now())
    })
    const response = await client.sendMessage({
      raw: toBase64Url(raw),
      threadId: context.threadRemoteId ?? undefined
    })
    await this.deps.afterGmailSend?.(item.accountId, response.id)
    return {
      remoteId: response.id,
      threadRemoteId: response.threadId ?? context.threadRemoteId,
      messageIdHeader: messageId
    }
  }

  private async sendViaResend(item: OutboxItem): Promise<SendResult> {
    const client = this.deps.resendClient()
    if (!client) throw new Error('Kein Resend-API-Key hinterlegt')
    const context = this.replyContext(item)
    const headers: Record<string, string> = {}
    if (context.inReplyTo) headers['In-Reply-To'] = context.inReplyTo
    if (context.references.length > 0) headers['References'] = context.references.join(' ')

    const response = await client.sendEmail(
      {
        from: item.identityName
          ? `${item.identityName} <${item.identityEmail}>`
          : item.identityEmail,
        to: item.to.map((a) => a.email),
        cc: item.cc.length > 0 ? item.cc.map((a) => a.email) : undefined,
        bcc: item.bcc.length > 0 ? item.bcc.map((a) => a.email) : undefined,
        subject: item.subject,
        html: item.html,
        text: item.text || htmlToText(item.html),
        headers: Object.keys(headers).length > 0 ? headers : undefined,
        attachments:
          item.attachments.length > 0
            ? item.attachments.map((a) => ({
                filename: a.filename,
                content: a.content,
                content_type: a.mimeType,
                content_id: a.contentId
              }))
            : undefined
      },
      `outbox/${item.id}`
    )

    const messageIdHeader = `<${response.id}@resend.local>`
    this.persistResendSentMessage(item, response.id, messageIdHeader, context)
    return { remoteId: response.id, threadRemoteId: null, messageIdHeader }
  }

  /** Mirrors an outgoing Resend mail locally so the thread updates immediately. */
  private persistResendSentMessage(
    item: OutboxItem,
    remoteId: string,
    messageIdHeader: string,
    context: { inReplyTo: string | null; references: string[] }
  ): void {
    const parent = item.replyToMessageId ? this.store.messages.get(item.replyToMessageId) : null
    const localId = messageKey(item.accountId, remoteId)
    this.store.messages.upsert({
      id: localId,
      accountId: item.accountId,
      threadId: parent?.threadId ?? threadKey(item.accountId, messageIdHeader),
      remoteId,
      messageIdHeader,
      inReplyTo: context.inReplyTo,
      references: context.references,
      subject: item.subject,
      from: { name: item.identityName || null, email: item.identityEmail },
      to: item.to,
      cc: item.cc,
      bcc: item.bcc,
      date: this.now(),
      direction: 'outgoing',
      labelRemoteIds: [SYSTEM_LABELS.sent],
      body: { html: item.html, text: item.text || htmlToText(item.html) },
      attachments: item.attachments.map((attachment, index) => ({
        id: attachmentKey(localId, String(index)),
        filename: attachment.filename,
        mimeType: attachment.mimeType,
        size: Buffer.from(attachment.content, 'base64').byteLength,
        contentId: attachment.contentId ?? null,
        inline: Boolean(attachment.inline),
        downloaded: true
      }))
    })
  }

  private async deliver(item: OutboxItem): Promise<SendResult> {
    const account = this.store.accounts.get(item.accountId)
    if (!account) throw new Error('Unbekanntes Konto')
    return account.kind === 'google' ? this.sendViaGmail(item) : this.sendViaResend(item)
  }

  /**
   * Sends everything whose moment has come. Called on a timer and once at
   * startup, so scheduled mail the app slept through goes out on next launch.
   */
  async tick(): Promise<{ sent: number; failed: number }> {
    const due = this.store.outbox.due(this.now())
    let sent = 0
    let failed = 0
    for (const item of due) {
      this.store.outbox.setState(item.id, 'sending')
      try {
        const result = await this.deliver(item)
        this.store.outbox.setState(item.id, 'sent', { sentMessageId: result.remoteId })
        // Both paths have put the sent mail into the local store by now — Gmail
        // through the follow-on sync, Resend by writing it directly — so the
        // reminder can hang off the message it is waiting on.
        this.deps.followUps?.track(item, messageKey(item.accountId, result.remoteId))
        this.deps.onSent?.(item, result.remoteId)
        sent += 1
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const attempts = item.attempts + 1
        if (attempts >= this.maxAttempts) {
          this.store.outbox.setState(item.id, 'failed', { lastError: message })
          failed += 1
        } else {
          this.store.outbox.incrementAttempts(
            item.id,
            message,
            this.now() + Math.min(2 ** attempts * 30_000, 30 * 60_000)
          )
        }
      }
    }
    if (due.length > 0) this.deps.onChange?.()
    return { sent, failed }
  }
}
