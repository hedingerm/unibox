import type { FetchLike } from './auth'
import { ReconnectRequiredError } from './auth'
import {
  batchBoundary,
  buildBatchBody,
  parseBatchResponse,
  parseBoundary,
  partIndex
} from './batch'

export const GMAIL_BASE_URL = 'https://gmail.googleapis.com/gmail/v1'

export interface GmailHeader {
  name: string
  value: string
}

export interface GmailPart {
  partId?: string
  mimeType?: string
  filename?: string
  headers?: GmailHeader[]
  body?: { attachmentId?: string; size?: number; data?: string }
  parts?: GmailPart[]
}

export interface GmailMessage {
  id: string
  threadId: string
  labelIds?: string[]
  snippet?: string
  historyId?: string
  internalDate?: string
  sizeEstimate?: number
  payload?: GmailPart
  raw?: string
}

export interface GmailLabel {
  id: string
  name: string
  type?: 'system' | 'user'
  color?: { backgroundColor?: string; textColor?: string }
  messageListVisibility?: string
  labelListVisibility?: string
}

export interface GmailSendAs {
  sendAsEmail: string
  displayName?: string
  replyToAddress?: string
  signature?: string
  isPrimary?: boolean
  isDefault?: boolean
  verificationStatus?: string
}

export interface GmailDraft {
  id: string
  message?: GmailMessage
}

export interface GmailDraftList {
  drafts?: GmailDraft[]
  nextPageToken?: string
}

export interface GmailHistoryRecord {
  id: string
  messages?: Array<{ id: string; threadId: string }>
  messagesAdded?: Array<{ message: GmailMessage }>
  messagesDeleted?: Array<{ message: GmailMessage }>
  labelsAdded?: Array<{ message: GmailMessage; labelIds: string[] }>
  labelsRemoved?: Array<{ message: GmailMessage; labelIds: string[] }>
}

export interface GmailHistoryResponse {
  history?: GmailHistoryRecord[]
  nextPageToken?: string
  historyId?: string
}

export interface GmailListResponse {
  messages?: Array<{ id: string; threadId: string }>
  nextPageToken?: string
  resultSizeEstimate?: number
}

export class GmailApiError extends Error {
  constructor(
    readonly status: number,
    readonly reason: string,
    message: string
  ) {
    super(message)
    this.name = 'GmailApiError'
  }

  get isHistoryExpired(): boolean {
    return this.status === 404
  }

  get isRateLimited(): boolean {
    return (
      this.status === 429 ||
      (this.status === 403 &&
        ['rateLimitExceeded', 'userRateLimitExceeded', 'quotaExceeded'].includes(this.reason))
    )
  }

  get isRetryable(): boolean {
    return this.isRateLimited || this.status >= 500
  }
}

/** Gmail's per-user budget, in quota units per second. */
export const QUOTA_UNITS_PER_SECOND = 250

/** What one `messages.get` costs against that budget. */
export const MESSAGE_GET_UNITS = 5

/** Gmail refuses batches larger than this. */
export const MAX_BATCH_SIZE = 100

/**
 * Paces requests so the *average* spend stays inside Gmail's budget. A batch of
 * 100 messages still costs 100 individual gets, so bundling buys round trips,
 * never quota — without this the batch sync would simply trade latency for 429s.
 */
export class QuotaLimiter {
  private nextAt = 0

  constructor(
    private readonly unitsPerSecond: number,
    private readonly sleep: (ms: number) => Promise<void>,
    private readonly now: () => number = Date.now
  ) {}

  async take(units: number): Promise<void> {
    const now = this.now()
    const start = Math.max(now, this.nextAt)
    this.nextAt = start + (units / this.unitsPerSecond) * 1000
    if (start > now) await this.sleep(start - now)
  }

  /** A rate-limit answer means the estimate was too optimistic. */
  penalise(ms: number): void {
    this.nextAt = Math.max(this.nextAt, this.now() + ms)
  }
}

export interface BatchMessageResult {
  id: string
  message: GmailMessage | null
  error: GmailApiError | null
}

export interface GmailClientDeps {
  fetch?: FetchLike
  baseUrl?: string
  /** Resolves a fresh access token for the account this client speaks for. */
  accessToken: () => Promise<string>
  sleep?: (ms: number) => Promise<void>
  maxRetries?: number
  now?: () => number
  /** Overridable for tests; production stays on Gmail's documented budget. */
  quotaUnitsPerSecond?: number
}

interface ApiErrorBody {
  error?: { code?: number; message?: string; errors?: Array<{ reason?: string }> }
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

export class GmailClient {
  private readonly fetchImpl: FetchLike
  private readonly baseUrl: string
  private readonly sleep: (ms: number) => Promise<void>
  private readonly maxRetries: number
  private readonly quota: QuotaLimiter
  private batchSeed = 0

  constructor(private readonly deps: GmailClientDeps) {
    this.fetchImpl = deps.fetch ?? globalThis.fetch
    this.baseUrl = deps.baseUrl ?? GMAIL_BASE_URL
    this.sleep = deps.sleep ?? defaultSleep
    this.maxRetries = deps.maxRetries ?? 5
    this.quota = new QuotaLimiter(
      deps.quotaUnitsPerSecond ?? QUOTA_UNITS_PER_SECOND,
      this.sleep,
      deps.now ?? Date.now
    )
  }

  /** `https://gmail.googleapis.com/gmail/v1` → `…/batch/gmail/v1`. */
  private get batchUrl(): string {
    return `${this.baseUrl.replace(/\/gmail\/v1\/?$/, '')}/batch/gmail/v1`
  }

  private async request<T>(
    path: string,
    init: RequestInit & { query?: Record<string, string | string[] | undefined> } = {}
  ): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`)
    for (const [key, value] of Object.entries(init.query ?? {})) {
      if (value === undefined) continue
      if (Array.isArray(value)) for (const item of value) url.searchParams.append(key, item)
      else url.searchParams.set(key, value)
    }

    let attempt = 0
    for (;;) {
      const token = await this.deps.accessToken()
      const response = await this.fetchImpl(url.toString(), {
        ...init,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          ...(init.headers ?? {})
        }
      })
      if (response.ok) {
        const text = await response.text()
        return (text ? JSON.parse(text) : {}) as T
      }

      const text = await response.text()
      let body: ApiErrorBody = {}
      try {
        body = JSON.parse(text) as ApiErrorBody
      } catch {
        body = {}
      }
      const reason = body.error?.errors?.[0]?.reason ?? ''
      const error = new GmailApiError(
        response.status,
        reason,
        body.error?.message ?? `Gmail API ${response.status}`
      )
      if (response.status === 401) throw new ReconnectRequiredError(null, error.message)
      if (!error.isRetryable || attempt >= this.maxRetries) throw error
      const backoff = Math.min(2 ** attempt * 500, 32_000)
      await this.sleep(backoff)
      attempt += 1
    }
  }

  /**
   * Fetches up to 100 messages in a single round trip. Each answer stands on
   * its own: one message can be gone or rate-limited while the rest arrive, so
   * the caller decides per id what to retry.
   */
  async batchGetMessages(
    ids: string[],
    format: 'full' | 'metadata' | 'minimal' = 'full'
  ): Promise<BatchMessageResult[]> {
    if (ids.length === 0) return []
    if (ids.length > MAX_BATCH_SIZE) {
      throw new Error(`Gmail-Batch erlaubt höchstens ${MAX_BATCH_SIZE} Teilanfragen`)
    }
    await this.quota.take(ids.length * MESSAGE_GET_UNITS)

    let attempt = 0
    for (;;) {
      const boundary = batchBoundary(this.batchSeed++)
      const body = buildBatchBody(
        ids.map((id) => ({
          id,
          path: `/gmail/v1/users/me/messages/${encodeURIComponent(id)}?format=${format}`
        })),
        boundary
      )
      const token = await this.deps.accessToken()
      const response = await this.fetchImpl(this.batchUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': `multipart/mixed; boundary=${boundary}`
        },
        body
      })

      if (response.ok) {
        const text = await response.text()
        const replyBoundary = parseBoundary(response.headers.get('Content-Type')) ?? boundary
        return this.collectBatch(ids, parseBatchResponse(text, replyBoundary))
      }

      const error = await this.toApiError(response)
      if (error instanceof ReconnectRequiredError) throw error
      if (!error.isRetryable || attempt >= this.maxRetries) throw error
      if (error.isRateLimited) this.quota.penalise(2 ** attempt * 1_000)
      await this.sleep(Math.min(2 ** attempt * 500, 32_000))
      attempt += 1
    }
  }

  private collectBatch(
    ids: string[],
    parts: ReturnType<typeof parseBatchResponse>
  ): BatchMessageResult[] {
    const results: BatchMessageResult[] = ids.map((id) => ({
      id,
      message: null,
      error: new GmailApiError(500, '', 'Keine Teilantwort erhalten')
    }))

    parts.forEach((part, position) => {
      const index = partIndex(part.id, position)
      const id = ids[index]
      if (id === undefined) return
      if (part.status >= 200 && part.status < 300) {
        try {
          results[index] = { id, message: JSON.parse(part.body) as GmailMessage, error: null }
        } catch {
          results[index] = {
            id,
            message: null,
            error: new GmailApiError(500, '', 'Teilantwort war kein JSON')
          }
        }
        return
      }
      results[index] = { id, message: null, error: this.errorFromBody(part.status, part.body) }
    })

    // One rate-limited sub-answer means the whole run is going too fast.
    if (results.some((result) => result.error?.isRateLimited)) this.quota.penalise(1_000)
    return results
  }

  private errorFromBody(status: number, text: string): GmailApiError {
    let body: ApiErrorBody = {}
    try {
      body = JSON.parse(text) as ApiErrorBody
    } catch {
      body = {}
    }
    return new GmailApiError(
      status,
      body.error?.errors?.[0]?.reason ?? '',
      body.error?.message ?? `Gmail API ${status}`
    )
  }

  private async toApiError(response: Response): Promise<GmailApiError | ReconnectRequiredError> {
    const error = this.errorFromBody(response.status, await response.text())
    if (response.status === 401) return new ReconnectRequiredError(null, error.message)
    return error
  }

  getProfile(): Promise<{ emailAddress: string; historyId: string; messagesTotal: number }> {
    return this.request('/users/me/profile')
  }

  listLabels(): Promise<{ labels?: GmailLabel[] }> {
    return this.request('/users/me/labels')
  }

  createLabel(name: string): Promise<GmailLabel> {
    return this.request('/users/me/labels', {
      method: 'POST',
      body: JSON.stringify({
        name,
        labelListVisibility: 'labelShow',
        messageListVisibility: 'show'
      })
    })
  }

  renameLabel(labelId: string, name: string): Promise<GmailLabel> {
    return this.request(`/users/me/labels/${encodeURIComponent(labelId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ name })
    })
  }

  /** Removes the label itself; the messages that carried it stay in Gmail. */
  async deleteLabel(labelId: string): Promise<void> {
    await this.request(`/users/me/labels/${encodeURIComponent(labelId)}`, { method: 'DELETE' })
  }

  listSendAs(): Promise<{ sendAs?: GmailSendAs[] }> {
    return this.request('/users/me/settings/sendAs')
  }

  async listMessages(args: {
    pageToken?: string
    maxResults?: number
    q?: string
    labelIds?: string[]
    includeSpamTrash?: boolean
  }): Promise<GmailListResponse> {
    // Listing costs the same as a get and runs on the same hot path.
    await this.quota.take(MESSAGE_GET_UNITS)
    return this.request('/users/me/messages', {
      query: {
        pageToken: args.pageToken,
        maxResults: String(args.maxResults ?? 100),
        q: args.q,
        labelIds: args.labelIds,
        includeSpamTrash: args.includeSpamTrash ? 'true' : undefined
      }
    })
  }

  getMessage(
    id: string,
    format: 'full' | 'metadata' | 'minimal' | 'raw' = 'full'
  ): Promise<GmailMessage> {
    return this.request(`/users/me/messages/${encodeURIComponent(id)}`, { query: { format } })
  }

  getAttachment(messageId: string, attachmentId: string): Promise<{ size: number; data: string }> {
    return this.request(
      `/users/me/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`
    )
  }

  listHistory(args: {
    startHistoryId: string
    pageToken?: string
    maxResults?: number
  }): Promise<GmailHistoryResponse> {
    return this.request('/users/me/history', {
      query: {
        startHistoryId: args.startHistoryId,
        pageToken: args.pageToken,
        maxResults: String(args.maxResults ?? 500)
      }
    })
  }

  modifyMessage(
    id: string,
    body: { addLabelIds?: string[]; removeLabelIds?: string[] }
  ): Promise<GmailMessage> {
    return this.request(`/users/me/messages/${encodeURIComponent(id)}/modify`, {
      method: 'POST',
      body: JSON.stringify(body)
    })
  }

  trashMessage(id: string): Promise<GmailMessage> {
    return this.request(`/users/me/messages/${encodeURIComponent(id)}/trash`, { method: 'POST' })
  }

  untrashMessage(id: string): Promise<GmailMessage> {
    return this.request(`/users/me/messages/${encodeURIComponent(id)}/untrash`, { method: 'POST' })
  }

  deleteMessage(id: string): Promise<void> {
    return this.request(`/users/me/messages/${encodeURIComponent(id)}`, { method: 'DELETE' })
  }

  sendMessage(args: { raw: string; threadId?: string }): Promise<GmailMessage> {
    return this.request('/users/me/messages/send', {
      method: 'POST',
      body: JSON.stringify({ raw: args.raw, threadId: args.threadId })
    })
  }

  /**
   * Drafts carry their own id, separate from the message inside them: editing
   * one keeps the draft id and replaces the message, which is why both have to
   * be tracked locally.
   */
  listDrafts(args: { pageToken?: string; maxResults?: number } = {}): Promise<GmailDraftList> {
    return this.request('/users/me/drafts', {
      query: { pageToken: args.pageToken, maxResults: String(args.maxResults ?? 100) }
    })
  }

  getDraft(id: string, format: 'full' | 'metadata' | 'minimal' = 'full'): Promise<GmailDraft> {
    return this.request(`/users/me/drafts/${encodeURIComponent(id)}`, { query: { format } })
  }

  createDraft(args: { raw: string; threadId?: string }): Promise<GmailDraft> {
    return this.request('/users/me/drafts', {
      method: 'POST',
      body: JSON.stringify({ message: { raw: args.raw, threadId: args.threadId } })
    })
  }

  updateDraft(id: string, args: { raw: string; threadId?: string }): Promise<GmailDraft> {
    return this.request(`/users/me/drafts/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify({ message: { raw: args.raw, threadId: args.threadId } })
    })
  }

  deleteDraft(id: string): Promise<void> {
    return this.request(`/users/me/drafts/${encodeURIComponent(id)}`, { method: 'DELETE' })
  }
}
