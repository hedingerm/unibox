import type { Draft, DraftInput, OutboxAttachment } from '@shared/types'
import type { Store } from '../db/store'
import { formatAddressList } from '../mime/addresses'
import type { GmailClient, GmailDraft, GmailMessage } from './client'
import { parseGmailMessage } from './parse'

/**
 * Marks the copy that came back from Gmail when both sides had changed. The
 * local edits keep the original row, so neither version is quietly overwritten.
 */
export const CONFLICT_SUFFIX = ' (Konflikt)'

export interface DraftSyncResult {
  imported: number
  updated: number
  removed: number
  conflicts: number
}

/** Gmail hands attachment payloads out base64url-encoded. */
function toBase64(data: string): string {
  return Buffer.from(data, 'base64url').toString('base64')
}

/**
 * Two-way mirror between the local drafts of one Google account and Gmail's.
 * Pushing is the mutation queue's job; this side pulls, so a draft started on
 * the phone can be finished here.
 */
export class GmailDraftSync {
  constructor(
    private readonly store: Store,
    private readonly accountId: string,
    private readonly client: GmailClient
  ) {}

  private async listAll(): Promise<GmailDraft[]> {
    const all: GmailDraft[] = []
    let pageToken: string | undefined
    do {
      const page = await this.client.listDrafts({ pageToken })
      all.push(...(page.drafts ?? []))
      pageToken = page.nextPageToken
    } while (pageToken)
    return all
  }

  /** Pulls the files of a remote draft so an edit here cannot drop them. */
  private async attachmentsOf(message: GmailMessage): Promise<OutboxAttachment[]> {
    const parsed = parseGmailMessage(message)
    const files: OutboxAttachment[] = []
    for (const attachment of parsed.attachments) {
      const data =
        attachment.data ??
        (attachment.attachmentId
          ? (await this.client.getAttachment(message.id, attachment.attachmentId)).data
          : null)
      if (!data) continue
      files.push({
        filename: attachment.filename,
        mimeType: attachment.mimeType,
        content: toBase64(data),
        contentId: attachment.contentId ?? undefined,
        inline: attachment.inline
      })
    }
    return files
  }

  private async toInput(id: string | null, message: GmailMessage): Promise<DraftInput> {
    const parsed = parseGmailMessage(message)
    const identity = this.store.identities
      .list()
      .find(
        (entry) =>
          entry.accountId === this.accountId &&
          entry.email.toLowerCase() === parsed.from.email.toLowerCase()
      )
    // A reply is recognised by its header, not by how Gmail displays it; the
    // local parent is what keeps the draft in its conversation on send.
    const parent = parsed.inReplyTo
      ? this.store.messages.findByHeaderMessageId(this.accountId, parsed.inReplyTo)
      : null
    return {
      id,
      accountId: this.accountId,
      kind: parent ? 'reply' : 'new',
      identityId: identity?.id ?? null,
      identityName: identity?.name ?? parsed.from.name ?? '',
      identityEmail: parsed.from.email,
      to: formatAddressList(parsed.to),
      cc: formatAddressList(parsed.cc),
      bcc: formatAddressList(parsed.bcc),
      subject: parsed.subject,
      html: parsed.body.html ?? (parsed.body.text ? `<p>${parsed.body.text}</p>` : ''),
      attachments: await this.attachmentsOf(message),
      replyToMessageId: parent?.id ?? null
    }
  }

  private async fetch(remoteId: string): Promise<GmailMessage | null> {
    const draft = await this.client.getDraft(remoteId)
    return draft.message ?? null
  }

  /** Writes the remote state into `local`, keeping the row and its id. */
  private async takeOver(local: Draft, remote: GmailDraft): Promise<boolean> {
    const message = await this.fetch(remote.id)
    if (!message) return false
    const input = await this.toInput(local.id, message)
    this.store.drafts.save(input, Date.now(), { dirty: false })
    this.store.drafts.linkRemote(local.id, {
      remoteId: remote.id,
      remoteMessageId: message.id,
      at: Date.now()
    })
    return true
  }

  async sync(): Promise<DraftSyncResult> {
    const result: DraftSyncResult = { imported: 0, updated: 0, removed: 0, conflicts: 0 }
    const remote = await this.listAll()
    const seen = new Set<string>()

    for (const entry of remote) {
      seen.add(entry.id)
      const local = this.store.drafts.byRemoteId(this.accountId, entry.id)
      if (!local) {
        const message = await this.fetch(entry.id)
        if (!message) continue
        const created = this.store.drafts.save(await this.toInput(null, message), Date.now(), {
          dirty: false
        })
        this.store.drafts.linkRemote(created.id, {
          remoteId: entry.id,
          remoteMessageId: message.id,
          at: Date.now()
        })
        result.imported += 1
        continue
      }
      // Editing a draft at Gmail replaces the message inside it, so an unchanged
      // message id means nothing happened over there — no fetch needed.
      const changedRemotely = (entry.message?.id ?? null) !== local.remoteMessageId
      if (!changedRemotely) continue
      if (!local.dirty) {
        if (await this.takeOver(local, entry)) result.updated += 1
        continue
      }
      // Both sides moved. The remote version lands as its own draft and keeps
      // the Gmail link; the local edits stay put and are pushed as a new draft.
      const message = await this.fetch(entry.id)
      if (!message) continue
      const input = await this.toInput(null, message)
      const copy = this.store.drafts.save(
        { ...input, subject: `${input.subject}${CONFLICT_SUFFIX}` },
        Date.now(),
        { dirty: false }
      )
      this.store.drafts.linkRemote(copy.id, {
        remoteId: entry.id,
        remoteMessageId: message.id,
        at: Date.now()
      })
      this.store.drafts.unlinkRemote(local.id)
      result.conflicts += 1
    }

    for (const local of this.store.drafts.listForAccount(this.accountId)) {
      if (!local.remoteId || seen.has(local.remoteId)) continue
      // The Gmail draft is gone — sent or deleted over there. Unsaved local
      // edits are never thrown away for it; they become a draft of their own.
      if (local.dirty) {
        this.store.drafts.unlinkRemote(local.id)
        continue
      }
      this.store.drafts.remove(local.id)
      result.removed += 1
    }

    return result
  }
}
