import type {
  Account,
  Label,
  SettleApplyResult,
  SettleDecision,
  SettleProgress,
  SettleReport,
  SettleSuggestion
} from '@shared/types'
import { SYSTEM_LABELS } from '@shared/types'
import type { Store } from '../db/store'
import { labelKey } from '../db/ids'
import type { GmailClient } from '../google/client'
import type { MutationService } from '../mutations'
import type { ClaudeRunner } from '../claude'
import { EvidenceRepo } from './evidence'
import { parseDecisions } from './parse'
import type { LabelHint, PromptContext, SettleCandidate } from './prompt'
import { buildSystemPrompt, buildUserPrompt } from './prompt'

export interface SettleDeps {
  runClaude: ClaudeRunner | null
  gmailClientFor: (accountId: string) => GmailClient | null
  onProgress?: (progress: SettleProgress) => void
}

/** Upper bound per run so one click cannot fan out into hundreds of calls. */
const MAX_THREADS = 200

/** Characters of mail body handed to the model — enough to judge, cheap to send. */
const EXCERPT_LENGTH = 900

/** Example mails shown per existing label, mined from the user's own filing. */
const EXAMPLES_PER_LABEL = 3

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim()
}

function formatAddress(address: { name: string | null; email: string }): string {
  return address.name ? `${address.name} <${address.email}>` : address.email
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let index = 0; index < items.length; index += size) {
    out.push(items.slice(index, index + size))
  }
  return out
}

/**
 * Turns mail into suggestions with the locally installed Claude Code CLI and
 * applies the ones the user confirmed. Nothing here writes to the mailbox on
 * its own — `analyze` is read-only, `apply` runs strictly on decisions that
 * came back from the review sheet.
 */
export class SettleService {
  private readonly evidence: EvidenceRepo

  constructor(
    private readonly store: Store,
    private readonly mutations: MutationService,
    private readonly deps: SettleDeps
  ) {
    this.evidence = new EvidenceRepo(store.db)
  }

  private userLabels(accountId: string): Label[] {
    return this.store.labels.list(accountId).filter((label) => label.type === 'user')
  }

  /**
   * Existing labels plus a few mails the user filed under each of them. Empty
   * labels stay in the list: the user created them on purpose, so they are a
   * valid target even before the first mail lands there.
   */
  private labelHints(accountId: string): LabelHint[] {
    return this.userLabels(accountId).map((label) => {
      const examples = this.store.messages
        .messageIdsWithLabel(label.id, EXAMPLES_PER_LABEL)
        .map((id) => this.store.messages.get(id))
        .filter((message): message is NonNullable<typeof message> => message !== null)
        .map((message) => ({
          from: formatAddress(message.from),
          subject: message.subject || '(kein Betreff)'
        }))
      return {
        name: label.name,
        examples,
        total: this.store.messages.countWithLabel(label.id)
      }
    })
  }

  /**
   * Builds the mails to classify. `threadIds` narrows the run to exactly those
   * conversations — the user settling their current selection; `null` takes the
   * account's whole inbox.
   */
  private candidatesFor(account: Account, threadIds: string[] | null): SettleCandidate[] {
    const ids =
      threadIds ??
      this.store.messages.listThreadIds({
        accountId: account.id,
        labelRemoteId: SYSTEM_LABELS.inbox,
        limit: MAX_THREADS
      })
    const candidates: SettleCandidate[] = []
    for (const threadId of ids) {
      const summary = this.store.messages.threadSummary(threadId)
      // A targeted run gets ids from a merged list, so each account picks its own.
      if (!summary || summary.accountId !== account.id) continue
      const messages = this.store.messages.messagesInThread(threadId)
      const last = messages[messages.length - 1]
      if (!last) continue
      const body = this.store.messages.body(last.id)
      const text = body.text?.trim() || (body.html ? stripHtml(body.html) : '') || summary.snippet
      candidates.push({
        ref: `m${candidates.length + 1}`,
        threadId,
        accountId: account.id,
        accountEmail: account.email,
        from: formatAddress(last.from),
        to: last.to.map(formatAddress).join(', ') || account.email,
        subject: summary.subject || '(kein Betreff)',
        date: new Date(summary.lastMessageAt).toISOString().slice(0, 10),
        messageCount: summary.messageCount,
        excerpt: text.slice(0, EXCERPT_LENGTH),
        // The thread itself is excluded, so a mail can never cite itself as
        // precedent for where it belongs.
        evidence: this.evidence.for(account.id, threadId, last.from.email, summary.subject)
      })
    }
    return candidates
  }

  /** Matches a proposed label name against the account's labels, case-insensitively. */
  private findLabel(accountId: string, name: string): Label | null {
    const wanted = name.trim().toLowerCase()
    return this.userLabels(accountId).find((label) => label.name.toLowerCase() === wanted) ?? null
  }

  /**
   * Reads the mail and proposes where it belongs. `threadIds` restricts the run
   * to that selection; without it the whole inbox is scanned.
   */
  async analyze(
    batchSize: number,
    model: string,
    threadIds: string[] | null = null
  ): Promise<SettleReport> {
    const run = this.deps.runClaude
    if (!run) throw new Error('Claude Code ist nicht verfügbar.')

    this.deps.onProgress?.({ phase: 'collecting', processed: 0, total: 0 })
    const perAccount = this.store.accounts.list().map((account) => ({
      account,
      candidates: this.candidatesFor(account, threadIds)
    }))
    const total = perAccount.reduce((sum, entry) => sum + entry.candidates.length, 0)
    this.deps.onProgress?.({ phase: 'classifying', processed: 0, total })

    const system = buildSystemPrompt()
    const suggestions: SettleSuggestion[] = []
    let processed = 0
    let skipped = 0
    let warning: string | null = null

    for (const { account, candidates } of perAccount) {
      if (candidates.length === 0) continue
      const labels = this.labelHints(account.id)
      for (const batch of chunk(candidates, Math.max(1, batchSize))) {
        const context: PromptContext = {
          accountEmail: account.email,
          accountKind: account.kind,
          labels,
          candidates: batch,
          allowNewLabels: true
        }
        let decisions: ReturnType<typeof parseDecisions> = []
        try {
          const answer = await run({
            systemPrompt: system,
            prompt: buildUserPrompt(context),
            model
          })
          decisions = parseDecisions(answer)
        } catch (error) {
          // One failing batch must not throw away the batches that worked.
          warning = error instanceof Error ? error.message : String(error)
        }
        const byRef = new Map(decisions.map((decision) => [decision.ref, decision]))
        for (const candidate of batch) {
          const decision = byRef.get(candidate.ref)
          if (!decision) {
            skipped += 1
            continue
          }
          const summary = this.store.messages.threadSummary(candidate.threadId)
          if (!summary) continue
          const existing = decision.label ? this.findLabel(account.id, decision.label) : null
          const action = decision.action === 'label' && !decision.label ? 'keep' : decision.action
          suggestions.push({
            threadId: candidate.threadId,
            accountId: account.id,
            subject: candidate.subject,
            from: summary.lastFrom,
            snippet: summary.snippet,
            lastMessageAt: summary.lastMessageAt,
            messageCount: summary.messageCount,
            unread: summary.unread,
            action,
            labelName: existing?.name ?? (action === 'label' ? decision.label : null),
            labelId: existing?.id ?? null,
            archive: action === 'label' || action === 'trash' || action === 'spam',
            reason: decision.reason,
            confidence: decision.confidence
          })
        }
        processed += batch.length
        this.deps.onProgress?.({ phase: 'classifying', processed, total })
      }
    }

    this.deps.onProgress?.({ phase: 'done', processed, total })
    return { suggestions, skipped, scanned: total, warning }
  }

  /** Creates a label that does not exist yet, remotely first for Gmail. */
  private async ensureLabel(accountId: string, name: string): Promise<Label> {
    const existing = this.findLabel(accountId, name)
    if (existing) return existing
    const account = this.store.accounts.get(accountId)
    if (!account) throw new Error('Unbekanntes Konto')

    if (account.kind === 'google') {
      const client = this.deps.gmailClientFor(accountId)
      if (!client) throw new Error('Kein Gmail-Zugriff für dieses Konto')
      const created = await client.createLabel(name)
      return this.store.labels.upsert(accountId, {
        remoteId: created.id,
        name: created.name,
        type: 'user'
      })
    }
    // Resend has no remote label store; the label lives only in the local db.
    const remoteId = `LOCAL_${name.replace(/[^\w/]+/g, '_').toUpperCase()}`
    return this.store.labels.upsert(accountId, { remoteId, name, type: 'user' })
  }

  /**
   * Puts back what `apply` did. A settle that ran without a confirmation step
   * is only defensible if it is one click from being undone, so this is the
   * exact inverse: the label comes off, INBOX goes back on, trash and spam are
   * restored the same way the toolbar restores them.
   */
  revert(decisions: SettleDecision[]): SettleApplyResult {
    const result: SettleApplyResult = { applied: 0, createdLabels: [], failed: [] }

    for (const decision of decisions) {
      if (decision.action === 'keep') continue
      try {
        const messages = this.store.messages.messagesInThread(decision.threadId)
        if (messages.length === 0) throw new Error('Konversation existiert nicht mehr')
        const accountId = messages[0]!.accountId
        const messageIds = messages.map((message) => message.id)

        if (decision.action === 'trash') {
          this.mutations.untrash(messageIds)
        } else if (decision.action === 'spam') {
          this.mutations.unmarkSpam(messageIds)
        } else {
          const label = decision.labelId
            ? this.store.labels.list(accountId).find((l) => l.id === decision.labelId)
            : decision.labelName
              ? this.findLabel(accountId, decision.labelName)
              : null
          // The label that was created for this mail stays; only its use here
          // is undone. Deleting it could take other mail down with it.
          this.mutations.changeLabels(
            messageIds,
            decision.archive ? [labelKey(accountId, SYSTEM_LABELS.inbox)] : [],
            label ? [label.id] : []
          )
        }
        result.applied += 1
      } catch (error) {
        result.failed.push({
          threadId: decision.threadId,
          message: error instanceof Error ? error.message : String(error)
        })
      }
    }
    return result
  }

  async apply(decisions: SettleDecision[]): Promise<SettleApplyResult> {
    const result: SettleApplyResult = { applied: 0, createdLabels: [], failed: [] }

    for (const decision of decisions) {
      if (decision.action === 'keep') continue
      try {
        const messages = this.store.messages.messagesInThread(decision.threadId)
        if (messages.length === 0) throw new Error('Konversation existiert nicht mehr')
        const accountId = messages[0]!.accountId
        const messageIds = messages.map((message) => message.id)

        if (decision.action === 'trash') {
          this.mutations.trash(messageIds)
        } else if (decision.action === 'spam') {
          this.mutations.markSpam(messageIds)
        } else {
          const name = decision.labelName?.trim()
          if (!name) throw new Error('Kein Label angegeben')
          const known = decision.labelId
            ? (this.store.labels.list(accountId).find((l) => l.id === decision.labelId) ?? null)
            : null
          const label = known ?? (await this.ensureLabel(accountId, name))
          if (!known && !result.createdLabels.includes(label.name)) {
            result.createdLabels.push(label.name)
          }
          this.mutations.changeLabels(messageIds, [label.id], [])
          if (decision.archive) {
            this.mutations.changeLabels(messageIds, [], [labelKey(accountId, SYSTEM_LABELS.inbox)])
          }
        }
        result.applied += 1
      } catch (error) {
        result.failed.push({
          threadId: decision.threadId,
          message: error instanceof Error ? error.message : String(error)
        })
      }
    }
    return result
  }
}
