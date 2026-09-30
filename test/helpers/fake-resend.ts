import type {
  ResendWebhookData,
  ResendAttachmentMeta,
  ResendDomain,
  ResendReceivedEmail,
  ResendSentEmail
} from '@main/resend/client'
import type { MxRecord } from '@main/resend/mx'

export interface FakeResendOptions {
  region?: string
}

/** In-process stand-in for the Resend REST API plus the DNS lookups around it. */
export class FakeResend {
  domains: ResendDomain[] = []
  received: ResendReceivedEmail[] = []
  sent: ResendSentEmail[] = []
  attachments = new Map<string, ResendAttachmentMeta[]>()
  files = new Map<string, string>()
  mx = new Map<string, MxRecord[]>()
  /** TXT records per hostname, each as Node hands them out: chunked. */
  txt = new Map<string, string[][]>()
  webhooks: ResendWebhookData[] = []
  sends: Array<{ payload: Record<string, unknown>; idempotencyKey: string | null }> = []
  verified: string[] = []
  updates: Array<{ id: string; body: unknown }> = []
  requestCount = 0
  offline = false
  /** Mirrors the real API: list responses carry metadata, never the body. */
  listIncludesBody = false
  rateLimitFor = 0
  invalidKey = false
  pageSize = 50

  constructor(private readonly options: FakeResendOptions = {}) {}

  addDomain(name: string, receiving = false): ResendDomain {
    const domain: ResendDomain = {
      id: `dom_${name.replace(/\W/g, '_')}`,
      name,
      status: 'verified',
      region: this.options.region ?? 'eu-west-1',
      capabilities: { sending: 'enabled', receiving: receiving ? 'enabled' : 'disabled' }
    }
    this.domains.push(domain)
    return domain
  }

  addReceived(email: Partial<ResendReceivedEmail> & { id: string }): ResendReceivedEmail {
    const full: ResendReceivedEmail = {
      from: 'Sandra Keller <s.keller@keller-farben.ch>',
      to: ['kontakt@beispielweb.ch'],
      subject: 'Anfrage',
      html: '<p>Guten Tag</p>',
      text: 'Guten Tag',
      created_at: '2026-08-18T09:42:00.000Z',
      ...email
    }
    this.received.unshift(full)
    return full
  }

  addSent(email: Partial<ResendSentEmail> & { id: string }): ResendSentEmail {
    const full: ResendSentEmail = {
      from: 'Max Muster <kontakt@beispielweb.ch>',
      to: ['s.keller@keller-farben.ch'],
      subject: 'Re: Anfrage',
      html: '<p>Besten Dank</p>',
      text: 'Besten Dank',
      created_at: '2026-08-18T10:05:00.000Z',
      ...email
    }
    this.sent.unshift(full)
    return full
  }

  addAttachment(emailId: string, meta: ResendAttachmentMeta, content: string): void {
    const list = this.attachments.get(emailId) ?? []
    const url = `https://files.resend.test/${meta.id}`
    list.push({ ...meta, download_url: url })
    this.attachments.set(emailId, list)
    this.files.set(url, content)
  }

  resolveTxt = async (hostname: string): Promise<string[][]> => {
    const records = this.txt.get(hostname.toLowerCase())
    if (!records) throw new Error('ENODATA')
    return records
  }

  resolveMx = async (hostname: string): Promise<MxRecord[]> => {
    const records = this.mx.get(hostname.toLowerCase())
    if (!records) throw new Error('ENODATA')
    return records
  }

  private asSummary<T extends ResendReceivedEmail | ResendSentEmail>(email: T): T {
    if (this.listIncludesBody) return email
    const { html: _html, text: _text, ...rest } = email
    return rest as T
  }

  private json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' }
    })
  }

  private page<T>(items: T[], url: URL, idOf: (item: T) => string): Response {
    const after = url.searchParams.get('after')
    const limit = Number(url.searchParams.get('limit') ?? String(this.pageSize))
    const start = after ? items.findIndex((item) => idOf(item) === after) + 1 : 0
    const slice = items.slice(start, start + limit)
    return this.json({ data: slice, has_more: start + limit < items.length })
  }

  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    this.requestCount += 1
    if (this.offline) throw new TypeError('fetch failed')
    if (this.rateLimitFor > 0) {
      this.rateLimitFor -= 1
      return this.json({ message: 'Too many requests' }, 429)
    }
    const url = new URL(typeof input === 'string' ? input : input.toString())
    const method = init?.method ?? 'GET'

    if (url.hostname === 'files.resend.test') {
      const content = this.files.get(url.toString())
      if (!content) return new Response('', { status: 404 })
      return new Response(content, { status: 200 })
    }

    if (this.invalidKey) return this.json({ message: 'Invalid API key' }, 401)

    const path = url.pathname
    if (path === '/domains' && method === 'GET') return this.json({ data: this.domains })
    if (path === '/domains' && method === 'POST') {
      const body = JSON.parse(String(init?.body ?? '{}')) as { name: string; region?: string }
      if (this.domains.some((d) => d.name === body.name)) {
        return this.json({ message: 'Domain already exists' }, 409)
      }
      const domain: ResendDomain = {
        id: `dom_${body.name.replace(/\W/g, '_')}`,
        name: body.name,
        status: 'not_started',
        region: body.region ?? 'us-east-1',
        created_at: new Date(Date.UTC(2026, 7, 18, 12, 0, 0)).toISOString(),
        capabilities: { sending: 'enabled', receiving: 'disabled' },
        records: [
          { record: 'SPF', name: 'send', type: 'MX', value: `feedback-smtp.${body.region ?? 'us-east-1'}.amazonses.com`, priority: 10, ttl: 'Auto', status: 'not_started' },
          { record: 'SPF', name: 'send', type: 'TXT', value: 'v=spf1 include:amazonses.com ~all', ttl: 'Auto', status: 'not_started' },
          { record: 'DKIM', name: 'resend._domainkey', type: 'TXT', value: 'p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQ', ttl: 'Auto', status: 'not_started' }
        ]
      }
      this.domains.push(domain)
      return this.json(domain)
    }

    const domainMatch = path.match(/^\/domains\/([^/]+)$/)
    if (domainMatch) {
      const domain = this.domains.find((d) => d.id === domainMatch[1])
      if (!domain) return this.json({ message: 'Not found' }, 404)
      if (method === 'PATCH') {
        const body = JSON.parse(String(init?.body ?? '{}')) as {
          capabilities?: { receiving?: string; sending?: string }
        }
        this.updates.push({ id: domain.id, body })
        domain.capabilities = { ...domain.capabilities, ...body.capabilities }
      }
      return this.json(domain)
    }

    if (path === '/webhooks' && method === 'GET') return this.json({ data: this.webhooks })
    if (path === '/webhooks' && method === 'POST') {
      const body = JSON.parse(String(init?.body ?? '{}')) as { endpoint: string; events: string[] }
      const id = `wh_${this.webhooks.length + 1}`
      this.webhooks.push({
        id,
        endpoint: body.endpoint,
        events: body.events,
        status: 'enabled',
        created_at: new Date(Date.UTC(2026, 7, 18, 12, 0, 0)).toISOString()
      })
      return this.json({ object: 'webhook', id, signing_secret: `whsec_${id}` })
    }
    const webhookMatch = path.match(/^\/webhooks\/([^/]+)$/)
    if (webhookMatch && method === 'DELETE') {
      const before = this.webhooks.length
      this.webhooks = this.webhooks.filter((hook) => hook.id !== webhookMatch[1])
      if (this.webhooks.length === before) return this.json({ message: 'Not found' }, 404)
      return this.json({ object: 'webhook', id: webhookMatch[1], deleted: true })
    }

    const verifyMatch = path.match(/^\/domains\/([^/]+)\/verify$/)
    if (verifyMatch && method === 'POST') {
      this.verified.push(verifyMatch[1]!)
      return this.json({ id: verifyMatch[1] })
    }

    if (path === '/emails/receiving' && method === 'GET') {
      return this.page(this.received.map((e) => this.asSummary(e)), url, (e) => e.id)
    }
    const receivedAttachmentsMatch = path.match(/^\/emails\/receiving\/([^/]+)\/attachments$/)
    if (receivedAttachmentsMatch) {
      return this.json({ data: this.attachments.get(receivedAttachmentsMatch[1]!) ?? [] })
    }
    const receivedMatch = path.match(/^\/emails\/receiving\/([^/]+)$/)
    if (receivedMatch) {
      const email = this.received.find((e) => e.id === receivedMatch[1])
      return email ? this.json(email) : this.json({ message: 'Not found' }, 404)
    }

    if (path === '/emails' && method === 'GET') {
      return this.page(this.sent.map((e) => this.asSummary(e)), url, (e) => e.id)
    }
    if (path === '/emails' && method === 'POST') {
      const payload = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
      const headers = (init?.headers ?? {}) as Record<string, string>
      this.sends.push({ payload, idempotencyKey: headers['Idempotency-Key'] ?? null })
      const id = `email_${this.sends.length}`
      this.addSent({
        id,
        from: String(payload.from ?? ''),
        to: (payload.to as string[]) ?? [],
        subject: String(payload.subject ?? ''),
        html: String(payload.html ?? ''),
        text: String(payload.text ?? ''),
        created_at: new Date(Date.UTC(2026, 7, 18, 12, 0, 0)).toISOString()
      })
      return this.json({ id })
    }

    const sentMatch = path.match(/^\/emails\/([^/]+)$/)
    if (sentMatch && method === 'GET') {
      const email = this.sent.find((e) => e.id === sentMatch[1])
      return email ? this.json(email) : this.json({ message: 'Not found' }, 404)
    }

    return this.json({ message: `Unhandled ${method} ${path}` }, 404)
  }
}
