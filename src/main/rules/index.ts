import type {
  RoutingRule,
  RuleAction,
  RuleInput,
  RulePatch,
  RuleTestMatch,
  RuleTestResult
} from '@shared/admin'
import { RULE_ACTIONS, RULE_MATCH_FIELDS, RULE_OPERATORS } from '@shared/admin'
import type { Label, Message } from '@shared/types'
import type { Store } from '../db/store'
import { bodyToPlainText } from '../db/repos/messages'
import type { MutationService } from '../mutations'
import type { ResendClient } from '../resend/client'
import { htmlToText } from '../mime/build'
import type { RuleSubject } from './engine'
import { compileMatcher, ruleMatches, selectRules } from './engine'

/**
 * Set on every mail a rule forwards. A forward that comes back in — through
 * someone else's forwarding, an alias chain, a reply-all — must never be
 * forwarded again, or two rules can bounce one message around forever.
 */
export const FORWARDED_HEADER = 'X-Unibox-Forwarded'

export interface RoutingServiceDeps {
  mutations: MutationService
  resendClient: () => ResendClient | null
  /** Reads a stored attachment, so a forward carries the files along. */
  readFile?: (path: string) => Promise<Buffer>
  now?: () => number
}

export interface RuleRunResult {
  /** Actions carried out, across all messages. */
  applied: number
  /** Accounts whose mail changed. */
  accountIds: string[]
}

const EMAIL_PATTERN = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/

function domainOf(email: string): string {
  return email.slice(email.lastIndexOf('@') + 1).toLowerCase()
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function describeAction(action: RuleAction, arg: string | null, label: Label | null): string {
  switch (action) {
    case 'label':
      return `Label «${label?.name ?? arg ?? ''}» gesetzt`
    case 'archive':
      return 'archiviert'
    case 'mark_read':
      return 'als gelesen markiert'
    case 'spam':
      return 'als Spam markiert'
    case 'trash':
      return 'in den Papierkorb gelegt'
    case 'forward':
      return `weitergeleitet an ${arg ?? ''}`
    case 'drop':
      return 'verworfen'
    default:
      return action
  }
}

/**
 * Routing rules over Resend's catch-all. They are explicit configuration, so
 * they act without a review step — but only on mail that arrives after they
 * exist, and every action lands in the activity log where it can be traced.
 */
export class RoutingService {
  private readonly now: () => number

  constructor(
    private readonly store: Store,
    private readonly deps: RoutingServiceDeps
  ) {
    this.now = deps.now ?? Date.now
  }

  // ---------------------------------------------------------------- config

  /** Addresses on a domain whose catch-all lands here — forwarding there loops. */
  private isOwnCatchAll(email: string): boolean {
    const domain = domainOf(email)
    return this.store.accounts
      .list()
      .some((account) => account.kind === 'resend' && account.email.toLowerCase() === domain)
  }

  /** Fills defaults and refuses anything the engine could not run. */
  normalize(input: RuleInput): Required<RuleInput> {
    const name = input.name.trim()
    if (!name) throw new Error('Die Regel braucht einen Namen.')
    if (!RULE_MATCH_FIELDS.includes(input.matchField)) throw new Error('Unbekanntes Feld.')
    if (!RULE_OPERATORS.includes(input.operator)) throw new Error('Unbekannter Vergleich.')
    if (!RULE_ACTIONS.includes(input.action)) throw new Error('Unbekannte Aktion.')
    if (!input.value.trim()) throw new Error('Die Regel braucht einen Wert zum Vergleichen.')
    const matcher = compileMatcher(input.operator, input.value)
    if (!matcher.ok) throw new Error(matcher.error)
    if (input.accountId !== null) {
      const account = this.store.accounts.get(input.accountId)
      if (!account || account.kind !== 'resend') {
        throw new Error('Regeln gelten nur für Resend-Domains.')
      }
    }

    let actionArg: string | null = null
    if (input.action === 'label') {
      const label = input.actionArg ? this.store.labels.byId(input.actionArg) : null
      if (!label) throw new Error('Das Label für diese Regel existiert nicht.')
      actionArg = label.id
    } else if (input.action === 'forward') {
      const target = (input.actionArg ?? '').trim().toLowerCase()
      if (!EMAIL_PATTERN.test(target)) throw new Error('Die Weiterleitungsadresse ist ungültig.')
      if (this.isOwnCatchAll(target)) {
        throw new Error(
          'Weiterleiten an eine eigene Resend-Domain würde die Mail im Kreis schicken.'
        )
      }
      actionArg = target
    }

    return {
      accountId: input.accountId,
      name,
      enabled: input.enabled ?? true,
      matchField: input.matchField,
      operator: input.operator,
      value: input.value,
      action: input.action,
      actionArg,
      stopProcessing: input.stopProcessing ?? true
    }
  }

  create(input: RuleInput): RoutingRule {
    return this.store.rules.create(this.normalize(input))
  }

  update(id: string, patch: RulePatch): RoutingRule {
    const existing = this.store.rules.get(id)
    if (!existing) throw new Error('Unbekannte Regel')
    const merged: RuleInput = {
      accountId: patch.accountId === undefined ? existing.accountId : patch.accountId,
      name: patch.name ?? existing.name,
      enabled: patch.enabled ?? existing.enabled,
      matchField: patch.matchField ?? existing.matchField,
      operator: patch.operator ?? existing.operator,
      value: patch.value ?? existing.value,
      action: patch.action ?? existing.action,
      actionArg: patch.actionArg === undefined ? existing.actionArg : patch.actionArg,
      stopProcessing: patch.stopProcessing ?? existing.stopProcessing
    }
    return this.store.rules.update(id, this.normalize(merged))
  }

  // ----------------------------------------------------------------- match

  subjectOf(message: Message): RuleSubject {
    return {
      accountId: message.accountId,
      from: message.from,
      recipients: [...message.to, ...message.cc].map((address) => address.email.toLowerCase()),
      subject: message.subject,
      body: bodyToPlainText(this.store.messages.body(message.id))
    }
  }

  private resendAccountIds(accountId: string | null): string[] {
    return this.store.accounts
      .list()
      .filter((account) => account.kind === 'resend' && (!accountId || account.id === accountId))
      .map((account) => account.id)
  }

  /**
   * Dry run: which of the last `limit` received messages the rule would have
   * caught. Applies nothing and does not count as a match. The rule does not
   * have to be saved — or even complete, apart from what matching needs.
   */
  test(input: Pick<RuleInput, 'accountId' | 'matchField' | 'operator' | 'value'>, limit = 50): RuleTestResult {
    const matcher = compileMatcher(input.operator, input.value)
    if (!matcher.ok) return { scanned: 0, matches: [], error: matcher.error }
    const messages = this.store.messages.recentIncoming(
      this.resendAccountIds(input.accountId),
      Math.max(1, Math.min(limit, 1000))
    )
    const matches: RuleTestMatch[] = []
    for (const message of messages) {
      if (!ruleMatches(input, this.subjectOf(message))) continue
      matches.push({
        messageId: message.id,
        threadId: message.threadId,
        accountId: message.accountId,
        subject: message.subject,
        from: message.from.name ? `${message.from.name} <${message.from.email}>` : message.from.email,
        date: message.date
      })
    }
    return { scanned: messages.length, matches, error: null }
  }

  // ----------------------------------------------------------------- apply

  /**
   * Runs the rules over freshly received mail. `autoForwarded` names the
   * messages that carry the forward marker: they are routed like any other
   * mail but never forwarded again.
   */
  async applyToNew(messageIds: string[], autoForwarded: ReadonlySet<string>): Promise<RuleRunResult> {
    const rules = this.store.rules.list().filter((rule) => rule.enabled)
    if (rules.length === 0 || messageIds.length === 0) return { applied: 0, accountIds: [] }
    let applied = 0
    const accounts = new Set<string>()
    for (const messageId of messageIds) {
      const message = this.store.messages.get(messageId)
      if (!message || message.direction !== 'incoming') continue
      const account = this.store.accounts.get(message.accountId)
      if (!account || account.kind !== 'resend') continue
      const fired = selectRules(rules, this.subjectOf(message))
      for (const rule of fired) {
        const ok = await this.execute(rule, message, autoForwarded.has(messageId))
        if (ok) {
          applied += 1
          accounts.add(message.accountId)
        }
        // Nothing left for a later rule to act on.
        if (rule.action === 'drop' && ok) break
      }
    }
    return { applied, accountIds: [...accounts] }
  }

  /** Label ids are per account; a rule for every domain finds its label by name. */
  private labelFor(rule: RoutingRule, accountId: string): Label | null {
    const label = rule.actionArg ? this.store.labels.byId(rule.actionArg) : null
    if (!label) return null
    if (label.accountId === accountId) return label
    const existing = this.store.labels
      .list(accountId)
      .find((candidate) => candidate.name.toLowerCase() === label.name.toLowerCase())
    if (existing) return existing
    // Resend labels are purely local, so the missing one is simply made here.
    return this.store.labels.upsert(accountId, {
      remoteId: `LOCAL_${label.name.replace(/[^\w/]+/g, '_').toUpperCase()}`,
      name: label.name,
      type: 'user'
    })
  }

  private async execute(rule: RoutingRule, message: Message, autoForwarded: boolean): Promise<boolean> {
    const at = this.now()
    let label: Label | null = null
    let error: string | null = null
    try {
      switch (rule.action) {
        case 'label':
          label = this.labelFor(rule, message.accountId)
          if (!label) throw new Error('Das Label der Regel existiert nicht mehr.')
          this.deps.mutations.changeLabels([message.id], [label.id], [])
          break
        case 'archive':
          this.deps.mutations.archive([message.id])
          break
        case 'mark_read':
          this.deps.mutations.setRead([message.id], true)
          break
        case 'spam':
          this.deps.mutations.markSpam([message.id])
          break
        case 'trash':
          this.deps.mutations.trash([message.id])
          break
        case 'drop':
          // Resend accepted the mail at SMTP already and cannot reject it
          // after the fact; dropping means forgetting it here for good.
          this.store.messages.addTombstone(message.accountId, message.remoteId)
          this.store.messages.remove(message.id)
          break
        case 'forward':
          await this.forward(rule, message, autoForwarded)
          break
      }
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause)
    }

    if (!error) this.store.rules.recordMatch(rule.id, at)
    const what = describeAction(rule.action, rule.actionArg, label)
    this.store.activity.record({
      kind: 'rule_action',
      accountId: message.accountId,
      ts: at,
      summary: error
        ? `Regel «${rule.name}» fehlgeschlagen: ${error}`
        : `Regel «${rule.name}»: «${message.subject || '(kein Betreff)'}» ${what}`,
      meta: {
        ruleId: rule.id,
        action: rule.action,
        actionArg: rule.actionArg,
        messageId: message.id,
        threadId: message.threadId,
        subject: message.subject,
        from: message.from.email,
        error
      }
    })
    return error === null
  }

  private async forward(rule: RoutingRule, message: Message, autoForwarded: boolean): Promise<void> {
    const target = rule.actionArg
    if (!target) throw new Error('Keine Weiterleitungsadresse.')
    if (autoForwarded) {
      throw new Error('Die Mail wurde bereits automatisch weitergeleitet und wird nicht erneut weitergeleitet.')
    }
    // Checked again at send time: the target may have become a receiving
    // domain of its own since the rule was saved.
    if (this.isOwnCatchAll(target)) {
      throw new Error('Weiterleiten an eine eigene Resend-Domain würde die Mail im Kreis schicken.')
    }
    const client = this.deps.resendClient()
    if (!client) throw new Error('Kein Resend-API-Key hinterlegt')
    const account = this.store.accounts.get(message.accountId)
    if (!account) throw new Error('Unbekanntes Konto')

    // Sent from the address the mail came in on, so the recipient sees which
    // mailbox it was meant for; the original sender stays reachable by reply.
    const domain = account.email.toLowerCase()
    const sender =
      [...message.to, ...message.cc].find((address) => domainOf(address.email) === domain)?.email ??
      `noreply@${domain}`
    const body = this.store.messages.body(message.id)
    const original = body.html ?? `<pre>${escapeHtml(body.text ?? '')}</pre>`
    const fromLine = message.from.name
      ? `${message.from.name} &lt;${escapeHtml(message.from.email)}&gt;`
      : escapeHtml(message.from.email)
    const header =
      '<p>---------- Weitergeleitete Nachricht ----------<br>' +
      `Von: ${fromLine}<br>` +
      `Datum: ${new Date(message.date).toUTCString()}<br>` +
      `Betreff: ${escapeHtml(message.subject)}<br>` +
      `An: ${escapeHtml(message.to.map((address) => address.email).join(', '))}</p>`
    const html = `${header}${original}`

    const attachments: Array<{ filename: string; content: string; content_type?: string }> = []
    if (this.deps.readFile) {
      for (const attachment of this.store.messages.attachments(message.id)) {
        if (attachment.inline || !attachment.filePath) continue
        try {
          const data = await this.deps.readFile(attachment.filePath)
          attachments.push({
            filename: attachment.filename,
            content: data.toString('base64'),
            content_type: attachment.mimeType
          })
        } catch {
          // A file that went missing is left out rather than failing the forward.
        }
      }
    }

    const subject = /^(fwd?|wg):/i.test(message.subject) ? message.subject : `Fwd: ${message.subject}`
    await client.sendEmail(
      {
        from: sender,
        to: [target],
        reply_to: [message.from.email],
        subject,
        html,
        text: htmlToText(html),
        headers: { [FORWARDED_HEADER]: '1' },
        attachments: attachments.length > 0 ? attachments : undefined
      },
      // A retry after a crash sends the same forward once, not twice.
      `rule-forward/${rule.id}/${message.id}`
    )
  }
}
