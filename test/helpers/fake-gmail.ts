import type { GmailLabel, GmailMessage, GmailSendAs } from '@main/google/client'

export interface FakeMessageSpec {
  id: string
  threadId?: string
  labelIds?: string[]
  from?: string
  to?: string
  cc?: string
  subject?: string
  text?: string
  html?: string
  date?: number
  messageIdHeader?: string
  inReplyTo?: string
  references?: string
  attachments?: Array<{
    filename: string
    mimeType: string
    attachmentId: string
    size: number
    contentId?: string
    inline?: boolean
  }>
}

const b64 = (value: string): string => Buffer.from(value, 'utf8').toString('base64url')

/** Reads back enough of an uploaded MIME message to answer `drafts.get`. */
function specFromRaw(raw: string): Partial<FakeMessageSpec> {
  const decoded = Buffer.from(raw, 'base64url').toString('utf8')
  const header = (name: string): string | undefined =>
    decoded.match(new RegExp(`^${name}: (.*)$`, 'im'))?.[1]?.trim()
  // The HTML alternative is a base64 part; decoding it is what makes a
  // round trip through Gmail testable at all.
  const htmlPart = decoded.split(/Content-Type: text\/html[^\r\n]*\r?\n/i)[1]
  const payload = htmlPart
    ?.split(/\r?\n\r?\n/)
    .slice(1)
    .join('\n')
    .split(/\r?\n--/)[0]
  const html = payload ? Buffer.from(payload.replace(/\s+/g, ''), 'base64').toString('utf8') : ''
  return {
    subject: header('Subject'),
    from: header('From'),
    to: header('To'),
    cc: header('Cc'),
    inReplyTo: header('In-Reply-To'),
    html: html || undefined,
    text: html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() || undefined
  }
}

export function buildGmailMessage(spec: FakeMessageSpec): GmailMessage {
  const date = spec.date ?? Date.parse('2026-08-18T08:00:00Z')
  const headers = [
    { name: 'Subject', value: spec.subject ?? 'Betreff' },
    { name: 'From', value: spec.from ?? 'Sandra Keller <s.keller@keller-farben.ch>' },
    { name: 'To', value: spec.to ?? 'max@muster-it.ch' },
    { name: 'Date', value: new Date(date).toUTCString() },
    { name: 'Message-ID', value: spec.messageIdHeader ?? `<${spec.id}@mail.example>` }
  ]
  if (spec.cc) headers.push({ name: 'Cc', value: spec.cc })
  if (spec.inReplyTo) headers.push({ name: 'In-Reply-To', value: spec.inReplyTo })
  if (spec.references) headers.push({ name: 'References', value: spec.references })

  const parts = [
    {
      partId: '0',
      mimeType: 'text/plain',
      headers: [],
      body: { size: 10, data: b64(spec.text ?? 'Hallo Welt') }
    },
    {
      partId: '1',
      mimeType: 'text/html',
      headers: [],
      body: { size: 10, data: b64(spec.html ?? `<p>${spec.text ?? 'Hallo Welt'}</p>`) }
    },
    ...(spec.attachments ?? []).map((attachment, index) => ({
      partId: String(index + 2),
      mimeType: attachment.mimeType,
      filename: attachment.filename,
      headers: [
        {
          name: 'Content-Disposition',
          value: `${attachment.inline ? 'inline' : 'attachment'}; filename="${attachment.filename}"`
        },
        ...(attachment.contentId
          ? [{ name: 'Content-ID', value: `<${attachment.contentId}>` }]
          : [])
      ],
      body: { size: attachment.size, attachmentId: attachment.attachmentId }
    }))
  ]

  return {
    id: spec.id,
    threadId: spec.threadId ?? spec.id,
    labelIds: spec.labelIds ?? ['INBOX', 'UNREAD'],
    snippet: spec.text ?? 'Hallo Welt',
    internalDate: String(date),
    payload: { partId: '', mimeType: 'multipart/mixed', headers, parts }
  }
}

export interface SentRecord {
  raw: string
  threadId?: string
}

/**
 * In-process stand-in for the Gmail REST API. Exposes a `fetch` implementation
 * so the production client runs completely unmodified against it.
 */
export class FakeGmail {
  messages = new Map<string, GmailMessage>()
  labels: GmailLabel[] = [
    { id: 'INBOX', name: 'INBOX', type: 'system' },
    { id: 'SENT', name: 'SENT', type: 'system' },
    { id: 'UNREAD', name: 'UNREAD', type: 'system' },
    { id: 'TRASH', name: 'TRASH', type: 'system' },
    { id: 'SPAM', name: 'SPAM', type: 'system' },
    { id: 'DRAFT', name: 'DRAFT', type: 'system' },
    { id: 'STARRED', name: 'STARRED', type: 'system' }
  ]
  sendAs: GmailSendAs[] = []
  history: Array<{ id: string; record: Record<string, unknown> }> = []
  historyId = '1000'
  attachments = new Map<string, string>()
  sent: SentRecord[] = []
  modifications: Array<{ id: string; addLabelIds?: string[]; removeLabelIds?: string[] }> = []
  trashed: string[] = []
  untrashed: string[] = []
  deleted: string[] = []
  emailAddress = 'max@muster-it.ch'
  /** Number of upcoming requests that should fail with 429. */
  rateLimitFor = 0
  historyExpired = false
  offline = false
  requestCount = 0
  pageSize = 2
  /** How many `POST /batch/gmail/v1` round trips the client made. */
  batchRequests = 0
  /** Largest number of sub-requests seen in one batch. */
  largestBatch = 0
  /** Message ids whose *sub-answer* should fail, and with what. */
  partFailures = new Map<string, { status: number; reason: string; message: string }>()
  /** Ids that fail once with 429 and succeed on the next attempt. */
  rateLimitedOnce = new Set<string>()
  /** Drafts by their own id; each holds the id of the message inside it. */
  drafts = new Map<string, { id: string; messageId: string; raw: string }>()
  deletedDrafts: string[] = []
  private draftCounter = 0

  addMessage(spec: FakeMessageSpec): GmailMessage {
    const message = buildGmailMessage(spec)
    this.messages.set(message.id, message)
    return message
  }

  /** Puts a draft into the account the way the Gmail web client would. */
  addDraft(spec: FakeMessageSpec & { draftId?: string }): { id: string; messageId: string } {
    const message = this.addMessage({ ...spec, labelIds: spec.labelIds ?? ['DRAFT'] })
    this.draftCounter += 1
    const id = spec.draftId ?? `r${this.draftCounter}`
    this.drafts.set(id, { id, messageId: message.id, raw: '' })
    return { id, messageId: message.id }
  }

  /** Stands in for an edit made elsewhere: same draft, new message inside it. */
  editDraft(draftId: string, spec: Omit<FakeMessageSpec, 'id'>): void {
    const draft = this.drafts.get(draftId)
    if (!draft) throw new Error(`Unknown draft ${draftId}`)
    this.messages.delete(draft.messageId)
    this.draftCounter += 1
    const message = this.addMessage({
      ...spec,
      id: `remote-edit-${this.draftCounter}`,
      labelIds: ['DRAFT']
    })
    this.drafts.set(draftId, { ...draft, messageId: message.id })
  }

  addUserLabel(id: string, name: string): void {
    this.labels.push({ id, name, type: 'user' })
  }

  pushHistory(record: Record<string, unknown>): string {
    this.historyId = String(Number(this.historyId) + 1)
    this.history.push({ id: this.historyId, record })
    return this.historyId
  }

  private headerOf(init: RequestInit | undefined, name: string): string {
    const headers = (init?.headers ?? {}) as Record<string, string>
    const key = Object.keys(headers).find((entry) => entry.toLowerCase() === name.toLowerCase())
    return key ? headers[key]! : ''
  }

  /** Mirrors Gmail's `multipart/mixed` batch endpoint, sub-failures included. */
  private batch(body: string, contentType: string): Response {
    this.batchRequests += 1
    const boundary = /boundary=([^;\s]+)/.exec(contentType)?.[1] ?? 'batch'
    const ids = [...body.matchAll(/GET \/gmail\/v1\/users\/me\/messages\/([^?\s]+)/g)].map(
      (match) => decodeURIComponent(match[1]!)
    )
    this.largestBatch = Math.max(this.largestBatch, ids.length)

    const replyBoundary = `batch_reply_${this.batchRequests}`
    const parts = ids.map((id, index) => {
      const failure = this.partFailures.get(id)
      const throttled = this.rateLimitedOnce.delete(id)
      const payload = throttled
        ? {
            status: 429,
            body: {
              error: {
                code: 429,
                message: 'Rate limit',
                errors: [{ reason: 'rateLimitExceeded' }]
              }
            }
          }
        : failure
          ? {
              status: failure.status,
              body: {
                error: {
                  code: failure.status,
                  message: failure.message,
                  errors: [{ reason: failure.reason }]
                }
              }
            }
          : this.messages.has(id)
            ? { status: 200, body: this.messages.get(id)! }
            : {
                status: 404,
                body: {
                  error: { code: 404, message: 'Not Found', errors: [{ reason: 'notFound' }] }
                }
              }
      const json = JSON.stringify(payload.body)
      return [
        `--${replyBoundary}`,
        'Content-Type: application/http',
        `Content-ID: <response-item-${index}>`,
        '',
        `HTTP/1.1 ${payload.status} ${payload.status === 200 ? 'OK' : 'Error'}`,
        'Content-Type: application/json; charset=UTF-8',
        `Content-Length: ${json.length}`,
        '',
        json,
        ''
      ].join('\r\n')
    })

    void boundary
    return new Response(`${parts.join('')}--${replyBoundary}--\r\n`, {
      status: 200,
      headers: { 'Content-Type': `multipart/mixed; boundary=${replyBoundary}` }
    })
  }

  private json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' }
    })
  }

  private error(status: number, reason: string, message: string): Response {
    return this.json({ error: { code: status, message, errors: [{ reason }] } }, status)
  }

  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    this.requestCount += 1
    if (this.offline) throw new TypeError('fetch failed')
    if (this.rateLimitFor > 0) {
      this.rateLimitFor -= 1
      return this.error(429, 'rateLimitExceeded', 'Rate limit exceeded')
    }

    const url = new URL(typeof input === 'string' ? input : input.toString())
    const method = init?.method ?? 'GET'

    if (url.pathname === '/batch/gmail/v1' && method === 'POST') {
      return this.batch(String(init?.body ?? ''), String(this.headerOf(init, 'Content-Type')))
    }

    const path = url.pathname.replace('/gmail/v1', '')

    if (path === '/users/me/profile') {
      return this.json({
        emailAddress: this.emailAddress,
        historyId: this.historyId,
        messagesTotal: this.messages.size
      })
    }
    if (path === '/users/me/labels' && method === 'POST') {
      const body = JSON.parse(String(init?.body ?? '{}')) as { name?: string }
      const name = body.name ?? ''
      const existing = this.labels.find((label) => label.name === name)
      if (existing) return this.json(existing)
      const label = { id: `Label_${this.labels.length + 1}`, name, type: 'user' as const }
      this.labels.push(label)
      return this.json(label)
    }
    if (path === '/users/me/labels') return this.json({ labels: this.labels })
    if (path.startsWith('/users/me/labels/') && (method === 'PATCH' || method === 'DELETE')) {
      const id = decodeURIComponent(path.slice('/users/me/labels/'.length))
      const index = this.labels.findIndex((label) => label.id === id)
      if (index < 0) return this.error(404, 'notFound', 'Label not found')
      if (method === 'DELETE') {
        this.labels.splice(index, 1)
        for (const message of this.messages.values()) {
          message.labelIds = (message.labelIds ?? []).filter((label) => label !== id)
        }
        return this.json({})
      }
      const body = JSON.parse(String(init?.body ?? '{}')) as { name?: string }
      const label = { ...this.labels[index]!, name: body.name ?? this.labels[index]!.name }
      this.labels[index] = label
      return this.json(label)
    }
    if (path === '/users/me/settings/sendAs') return this.json({ sendAs: this.sendAs })

    if (path === '/users/me/messages' && method === 'GET') {
      const label = url.searchParams.get('labelIds')
      const ids = [...this.messages.keys()].filter(
        (id) => !label || (this.messages.get(id)!.labelIds ?? []).includes(label)
      )
      const start = Number(url.searchParams.get('pageToken') ?? '0')
      const size = Number(url.searchParams.get('maxResults') ?? String(this.pageSize))
      const slice = ids.slice(start, start + size)
      const next = start + size < ids.length ? String(start + size) : undefined
      return this.json({
        messages: slice.map((id) => ({ id, threadId: this.messages.get(id)!.threadId })),
        nextPageToken: next,
        resultSizeEstimate: ids.length
      })
    }

    if (path === '/users/me/history') {
      if (this.historyExpired) {
        return this.error(404, 'notFound', 'Requested entity was not found.')
      }
      const start = Number(url.searchParams.get('startHistoryId') ?? '0')
      const records = this.history.filter((h) => Number(h.id) > start)
      return this.json({
        history: records.map((h) => ({ id: h.id, ...h.record })),
        historyId: this.historyId
      })
    }

    if (path === '/users/me/messages/send' && method === 'POST') {
      const body = JSON.parse(String(init?.body ?? '{}')) as { raw: string; threadId?: string }
      this.sent.push({ raw: body.raw, threadId: body.threadId })
      const id = `sent-${this.sent.length}`
      const message = buildGmailMessage({
        id,
        threadId: body.threadId ?? id,
        labelIds: ['SENT']
      })
      this.messages.set(id, message)
      return this.json({ id, threadId: message.threadId, labelIds: ['SENT'] })
    }

    if (path === '/users/me/drafts' && method === 'GET') {
      return this.json({
        drafts: [...this.drafts.values()].map((draft) => ({
          id: draft.id,
          message: { id: draft.messageId, threadId: this.messages.get(draft.messageId)?.threadId }
        }))
      })
    }

    if (path === '/users/me/drafts' && method === 'POST') {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        message?: { raw?: string; threadId?: string }
      }
      this.draftCounter += 1
      const id = `d${this.draftCounter}`
      const messageId = `dm${this.draftCounter}`
      const message = buildGmailMessage({
        id: messageId,
        threadId: body.message?.threadId ?? messageId,
        labelIds: ['DRAFT'],
        ...specFromRaw(body.message?.raw ?? '')
      })
      this.messages.set(messageId, message)
      this.drafts.set(id, { id, messageId, raw: body.message?.raw ?? '' })
      return this.json({ id, message: { id: messageId, threadId: message.threadId } })
    }

    const draftMatch = path.match(/^\/users\/me\/drafts\/([^/]+)$/)
    if (draftMatch) {
      const id = decodeURIComponent(draftMatch[1]!)
      const draft = this.drafts.get(id)
      if (!draft) return this.error(404, 'notFound', `Unknown draft ${id}`)
      if (method === 'DELETE') {
        this.deletedDrafts.push(id)
        this.messages.delete(draft.messageId)
        this.drafts.delete(id)
        return new Response('', { status: 204 })
      }
      if (method === 'PUT') {
        const body = JSON.parse(String(init?.body ?? '{}')) as {
          message?: { raw?: string; threadId?: string }
        }
        // Gmail replaces the message inside the draft, and with it its id.
        this.messages.delete(draft.messageId)
        this.draftCounter += 1
        const messageId = `dm${this.draftCounter}`
        const message = buildGmailMessage({
          id: messageId,
          threadId: body.message?.threadId ?? messageId,
          labelIds: ['DRAFT'],
          ...specFromRaw(body.message?.raw ?? '')
        })
        this.messages.set(messageId, message)
        this.drafts.set(id, { id, messageId, raw: body.message?.raw ?? '' })
        return this.json({ id, message: { id: messageId, threadId: message.threadId } })
      }
      const message = this.messages.get(draft.messageId)
      if (!message) return this.error(404, 'notFound', 'Not found')
      return this.json({ id, message })
    }

    const modifyMatch = path.match(/^\/users\/me\/messages\/([^/]+)\/modify$/)
    if (modifyMatch && method === 'POST') {
      const id = decodeURIComponent(modifyMatch[1]!)
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        addLabelIds?: string[]
        removeLabelIds?: string[]
      }
      const message = this.messages.get(id)
      if (!message) return this.error(404, 'notFound', `Unknown message ${id}`)
      this.modifications.push({ id, ...body })
      const labels = new Set(message.labelIds ?? [])
      for (const label of body.addLabelIds ?? []) labels.add(label)
      for (const label of body.removeLabelIds ?? []) labels.delete(label)
      message.labelIds = [...labels]
      return this.json(message)
    }

    const trashMatch = path.match(/^\/users\/me\/messages\/([^/]+)\/(trash|untrash)$/)
    if (trashMatch && method === 'POST') {
      const id = decodeURIComponent(trashMatch[1]!)
      if (trashMatch[2] === 'trash') this.trashed.push(id)
      else this.untrashed.push(id)
      return this.json({ id })
    }

    const attachmentMatch = path.match(/^\/users\/me\/messages\/([^/]+)\/attachments\/([^/]+)$/)
    if (attachmentMatch) {
      const data = this.attachments.get(decodeURIComponent(attachmentMatch[2]!)) ?? 'PDF-DATEN'
      const encoded = Buffer.from(data, 'utf8').toString('base64url')
      return this.json({ size: data.length, data: encoded })
    }

    const messageMatch = path.match(/^\/users\/me\/messages\/([^/]+)$/)
    if (messageMatch) {
      const id = decodeURIComponent(messageMatch[1]!)
      if (method === 'DELETE') {
        this.deleted.push(id)
        this.messages.delete(id)
        return new Response('', { status: 204 })
      }
      const message = this.messages.get(id)
      if (!message) return this.error(404, 'notFound', 'Not found')
      if (url.searchParams.get('format') === 'raw') {
        const lines = (message.payload?.headers ?? []).map((h) => `${h.name}: ${h.value}`)
        const raw = [...lines, 'X-Fake-Gmail: raw', '', 'Hallo Welt'].join('\r\n')
        return this.json({ id, threadId: message.threadId, raw: b64(raw) })
      }
      return this.json(message)
    }

    return this.error(404, 'notFound', `Unhandled path ${path}`)
  }
}
