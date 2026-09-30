import type { FetchLike } from '../google/auth'

export const RESEND_BASE_URL = 'https://api.resend.com'

export interface ResendDnsRecord {
  record?: string
  name?: string
  type: string
  ttl?: string
  status?: string
  value: string
  priority?: number
}

export interface ResendDomain {
  id: string
  name: string
  status: string
  created_at?: string
  region?: string
  records?: ResendDnsRecord[]
  capabilities?: { sending?: string; receiving?: string }
}

export interface ResendAttachmentMeta {
  id: string
  filename: string
  content_type?: string
  size?: number
  download_url?: string
  expires_at?: string
  content_id?: string
}

export type ResendHeaders = Record<string, string> | Array<{ name: string; value: string }>

export interface ResendReceivedEmail {
  id: string
  from: string
  to?: string[]
  cc?: string[]
  bcc?: string[]
  reply_to?: string[]
  subject?: string
  html?: string | null
  text?: string | null
  headers?: ResendHeaders
  created_at: string
  attachments?: ResendAttachmentMeta[]
  /** The message as it arrived, behind a short-lived signed URL. */
  raw?: { download_url?: string; expires_at?: string } | null
}

export interface ResendSentEmail {
  id: string
  from: string
  to?: string[]
  cc?: string[]
  bcc?: string[]
  subject?: string
  html?: string | null
  text?: string | null
  headers?: ResendHeaders
  created_at: string
  last_event?: string
  attachments?: ResendAttachmentMeta[]
}

export interface ResendWebhookData {
  id: string
  endpoint: string
  events?: string[]
  status?: string
  created_at?: string
}

export interface ResendPage<T> {
  data: T[]
  has_more?: boolean
}

export interface SendEmailPayload {
  from: string
  to: string[]
  cc?: string[]
  bcc?: string[]
  reply_to?: string[]
  subject: string
  html?: string
  text?: string
  headers?: Record<string, string>
  attachments?: Array<{ filename: string; content: string; content_type?: string; content_id?: string }>
}

export class ResendApiError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
    this.name = 'ResendApiError'
  }

  get isRetryable(): boolean {
    return this.status === 429 || this.status >= 500
  }

  get isUnauthorized(): boolean {
    return this.status === 401 || this.status === 403
  }
}

export interface ResendClientDeps {
  apiKey: () => string | null
  fetch?: FetchLike
  baseUrl?: string
  sleep?: (ms: number) => Promise<void>
  maxRetries?: number
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export class ResendClient {
  private readonly fetchImpl: FetchLike
  private readonly baseUrl: string
  private readonly sleep: (ms: number) => Promise<void>
  private readonly maxRetries: number

  constructor(private readonly deps: ResendClientDeps) {
    this.fetchImpl = deps.fetch ?? globalThis.fetch
    this.baseUrl = deps.baseUrl ?? RESEND_BASE_URL
    this.sleep = deps.sleep ?? defaultSleep
    this.maxRetries = deps.maxRetries ?? 4
  }

  private async request<T>(
    path: string,
    init: RequestInit & { query?: Record<string, string | undefined> } = {}
  ): Promise<T> {
    const key = this.deps.apiKey()
    if (!key) throw new ResendApiError(401, 'Kein Resend-API-Key hinterlegt')
    const url = new URL(`${this.baseUrl}${path}`)
    for (const [name, value] of Object.entries(init.query ?? {})) {
      if (value !== undefined) url.searchParams.set(name, value)
    }

    let attempt = 0
    for (;;) {
      const response = await this.fetchImpl(url.toString(), {
        ...init,
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
          ...(init.headers ?? {})
        }
      })
      if (response.ok) {
        const text = await response.text()
        return (text ? JSON.parse(text) : {}) as T
      }
      const text = await response.text()
      let message = `Resend API ${response.status}`
      try {
        const body = JSON.parse(text) as { message?: string; error?: string }
        message = body.message ?? body.error ?? message
      } catch {
        if (text) message = text.slice(0, 200)
      }
      const error = new ResendApiError(response.status, message)
      if (!error.isRetryable || attempt >= this.maxRetries) throw error
      await this.sleep(Math.min(2 ** attempt * 1_000, 30_000))
      attempt += 1
    }
  }

  listDomains(): Promise<ResendPage<ResendDomain>> {
    return this.request('/domains')
  }

  createDomain(body: { name: string; region: string }): Promise<ResendDomain> {
    return this.request('/domains', { method: 'POST', body: JSON.stringify(body) })
  }

  getDomain(id: string): Promise<ResendDomain> {
    return this.request(`/domains/${encodeURIComponent(id)}`)
  }

  updateDomain(
    id: string,
    body: { capabilities?: { sending?: string; receiving?: string } }
  ): Promise<ResendDomain> {
    return this.request(`/domains/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(body)
    })
  }

  verifyDomain(id: string): Promise<{ id: string }> {
    return this.request(`/domains/${encodeURIComponent(id)}/verify`, { method: 'POST' })
  }

  listReceivedEmails(args: { limit?: number; after?: string } = {}): Promise<
    ResendPage<ResendReceivedEmail>
  > {
    return this.request('/emails/receiving', {
      query: { limit: String(args.limit ?? 100), after: args.after }
    })
  }

  getReceivedEmail(id: string): Promise<ResendReceivedEmail> {
    return this.request(`/emails/receiving/${encodeURIComponent(id)}`)
  }

  listReceivedAttachments(emailId: string): Promise<ResendPage<ResendAttachmentMeta>> {
    return this.request(`/emails/receiving/${encodeURIComponent(emailId)}/attachments`)
  }

  listSentEmails(args: { limit?: number; after?: string } = {}): Promise<ResendPage<ResendSentEmail>> {
    return this.request('/emails', {
      query: { limit: String(args.limit ?? 100), after: args.after }
    })
  }

  getSentEmail(id: string): Promise<ResendSentEmail> {
    return this.request(`/emails/${encodeURIComponent(id)}`)
  }

  sendEmail(payload: SendEmailPayload, idempotencyKey?: string): Promise<{ id: string }> {
    return this.request('/emails', {
      method: 'POST',
      headers: idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {},
      body: JSON.stringify(payload)
    })
  }

  listWebhooks(): Promise<ResendPage<ResendWebhookData>> {
    return this.request('/webhooks')
  }

  createWebhook(body: { endpoint: string; events: string[] }): Promise<{
    id: string
    signing_secret?: string
  }> {
    return this.request('/webhooks', { method: 'POST', body: JSON.stringify(body) })
  }

  removeWebhook(id: string): Promise<unknown> {
    return this.request(`/webhooks/${encodeURIComponent(id)}`, { method: 'DELETE' })
  }

  /** Attachment payloads live behind short-lived signed URLs. */
  async downloadAttachment(url: string): Promise<Buffer> {
    const response = await this.fetchImpl(url)
    if (!response.ok) throw new ResendApiError(response.status, 'Anhang konnte nicht geladen werden')
    return Buffer.from(await response.arrayBuffer())
  }
}
