import type { AiJob, AiRequest } from '@shared/types'
import type { Store } from '../db/store'
import { newId } from '../db/ids'
import type { IdentityService } from '../identities'
import type { ClaudeRunner } from '../claude'
import type { AiPromptContext, ThreadMessage } from './prompt'
import { THREAD_DEPTH, THREAD_EXCERPT_LENGTH, buildSystemPrompt, buildUserPrompt } from './prompt'
import type { RecipientDossier } from './recipients'
import { buildDossiers } from './recipients'
import { stripHtml } from './text'

export interface AiDeps {
  runClaude: ClaudeRunner | null
  identities: IdentityService
  /** Called whenever a job changes state, with the whole job. */
  onChange: (job: AiJob) => void
}

/** Jobs kept around after they finished, so a late toast still finds its result. */
const MAX_RETAINED = 20

function formatAddress(address: { name: string | null; email: string }): string {
  return address.name ? `${address.name} <${address.email}>` : address.email
}

/**
 * Takes the mail text out of whatever the model wrapped it in. A fence or a
 * "Hier ist dein Entwurf:" line would otherwise land verbatim in the editor.
 */
export function cleanAnswer(text: string): string {
  let body = text.trim()
  const fenced = /^```(?:\w+)?\s*\n([\s\S]*?)\n?```$/.exec(body)
  if (fenced?.[1]) body = fenced[1].trim()
  // A single leading line that announces the mail instead of being it.
  body = body.replace(/^(hier ist|hier wäre|gerne, hier)[^\n]*:\s*\n+/i, '')
  return body.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

/**
 * Writes and reworks mail with the locally installed Claude Code CLI. A job
 * lives here rather than in the compose window on purpose: the user starts it,
 * closes the window and gets called back when it is done.
 */
export class AiService {
  private readonly jobs = new Map<string, AiJob>()

  constructor(
    private readonly store: Store,
    private readonly deps: AiDeps
  ) {}

  list(): AiJob[] {
    return [...this.jobs.values()].sort((a, b) => a.createdAt - b.createdAt)
  }

  get(jobId: string): AiJob | null {
    return this.jobs.get(jobId) ?? null
  }

  dismiss(jobId: string): void {
    this.jobs.delete(jobId)
  }

  /** The conversation being replied to, oldest first, newest message last. */
  private threadFor(replyToMessageId: string | null): ThreadMessage[] {
    if (!replyToMessageId) return []
    const anchor = this.store.messages.get(replyToMessageId)
    if (!anchor) return []
    return this.store.messages
      .messagesInThread(anchor.threadId)
      .slice(-THREAD_DEPTH)
      .map((message) => {
        const body = this.store.messages.body(message.id)
        const text =
          body.text?.trim() || (body.html ? stripHtml(body.html) : '') || message.snippet
        return {
          from: formatAddress(message.from),
          to: message.to.map(formatAddress).join(', '),
          date: new Date(message.date).toISOString().slice(0, 16).replace('T', ' '),
          direction: message.direction,
          excerpt: text.slice(0, THREAD_EXCERPT_LENGTH)
        }
      })
  }

  /**
   * What the archive knows about the people addressed. A correction gets
   * nothing: it may only fix language, and context is how a correction starts
   * improving the content instead.
   */
  private recipientsFor(request: AiRequest, thread: ThreadMessage[]): RecipientDossier[] {
    if (request.mode === 'correct') return []
    return buildDossiers(this.store, {
      to: request.context.to,
      cc: request.context.cc,
      // Measured against the thread that actually travels, not against the
      // anchor id: a reply whose anchor is gone would otherwise end up with
      // no conversation and no excerpts either.
      isReply: thread.length > 0,
      now: Date.now()
    })
  }

  private promptContext(request: AiRequest, draft: string): AiPromptContext {
    const identity =
      (request.context.identityId
        ? this.deps.identities.list().find((entry) => entry.id === request.context.identityId)
        : null) ?? this.deps.identities.defaultFor(request.context.accountId)
    const thread = this.threadFor(request.context.replyToMessageId)
    return {
      mode: request.mode,
      instruction: request.instruction,
      senderName: identity?.name ?? '',
      senderEmail: identity?.email ?? '',
      to: request.context.to,
      cc: request.context.cc,
      subject: request.context.subject,
      thread,
      recipients: this.recipientsFor(request, thread),
      draft,
      spot: request.context.spot?.text || null
    }
  }

  /**
   * Registers the job and returns it straight away, still running. The caller
   * learns the outcome from `onChange`, not from this promise.
   */
  start(request: AiRequest, model: string, style: string): AiJob {
    // A spot job is measured against the marked place, not against the mail
    // around it: the diff has to show what changes there, and the draft the
    // model reads is the one carrying the marker.
    const spot = request.context.spot
    const source = spot ? spot.text : stripHtml(request.context.html)
    const job: AiJob = {
      id: newId(),
      mode: request.mode,
      instruction: request.instruction,
      context: request.context,
      state: 'running',
      result: null,
      source,
      error: null,
      createdAt: Date.now()
    }
    this.jobs.set(job.id, job)
    this.prune()
    void this.run(job, model, style)
    return job
  }

  private async run(job: AiJob, model: string, style: string): Promise<void> {
    const settle = (patch: Partial<AiJob>): void => {
      const current = this.jobs.get(job.id)
      // A job the user dismissed while it ran must not come back to life.
      if (!current) return
      const next = { ...current, ...patch }
      this.jobs.set(job.id, next)
      this.deps.onChange(next)
    }

    const run = this.deps.runClaude
    if (!run) {
      settle({ state: 'error', error: 'Claude Code ist nicht verfügbar.' })
      return
    }
    try {
      const draft = job.context.spot ? job.context.spot.draft : job.source
      const answer = await run({
        systemPrompt: buildSystemPrompt(job.mode, style),
        prompt: buildUserPrompt(this.promptContext(job, draft)),
        model
      })
      const result = cleanAnswer(answer)
      if (!result) {
        settle({ state: 'error', error: 'Claude hat keinen Text zurückgegeben.' })
        return
      }
      settle({ state: 'done', result })
    } catch (error) {
      settle({ state: 'error', error: error instanceof Error ? error.message : String(error) })
    }
  }

  /** Keeps the map from growing without bound over a long-running session. */
  private prune(): void {
    const done = this.list().filter((entry) => entry.state !== 'running')
    for (const entry of done.slice(0, Math.max(0, done.length - MAX_RETAINED))) {
      this.jobs.delete(entry.id)
    }
  }
}
