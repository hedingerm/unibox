import { isAutoReplyHeaders } from '@shared/followup'
import type { EmailAddress, MessageBody } from '@shared/types'
import { decodeEncodedWords, parseAddress, parseAddressList } from '../mime/addresses'
import type { GmailMessage, GmailPart } from './client'

export interface ParsedAttachment {
  partId: string
  filename: string
  mimeType: string
  size: number
  attachmentId: string | null
  contentId: string | null
  inline: boolean
  /** Present when Gmail inlined the payload instead of handing out an id. */
  data: string | null
}

export interface ParsedGmailMessage {
  remoteId: string
  threadRemoteId: string
  labelIds: string[]
  subject: string
  from: EmailAddress
  to: EmailAddress[]
  cc: EmailAddress[]
  bcc: EmailAddress[]
  replyTo: EmailAddress[]
  date: number
  snippet: string
  messageIdHeader: string | null
  inReplyTo: string | null
  references: string[]
  /** Machine-generated: an absence notice, a list blast, a bounce. */
  autoReply: boolean
  body: MessageBody
  attachments: ParsedAttachment[]
}

export function headerValue(part: GmailPart | undefined, name: string): string | null {
  const header = part?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())
  return header ? header.value : null
}

function decodeBase64Url(data: string): string {
  return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
}

function walk(part: GmailPart | undefined, visit: (part: GmailPart, path: string) => void, path = ''): void {
  if (!part) return
  const id = part.partId ?? path
  visit(part, id)
  for (const [index, child] of (part.parts ?? []).entries()) {
    walk(child, visit, `${id ? `${id}.` : ''}${index}`)
  }
}

function isAttachmentPart(part: GmailPart): boolean {
  const disposition = headerValue(part, 'content-disposition') ?? ''
  if (part.filename && part.filename.length > 0) return true
  return /attachment|inline/i.test(disposition) && Boolean(part.body?.attachmentId)
}

export function parseGmailMessage(message: GmailMessage): ParsedGmailMessage {
  const payload = message.payload
  const subject = decodeEncodedWords(headerValue(payload, 'subject') ?? '')
  const fromHeader = headerValue(payload, 'from') ?? ''
  const from = parseAddress(fromHeader) ?? { name: null, email: '' }

  let html: string | null = null
  let text: string | null = null
  const attachments: ParsedAttachment[] = []

  walk(payload, (part, partId) => {
    const mimeType = part.mimeType ?? 'application/octet-stream'
    if (isAttachmentPart(part)) {
      const disposition = headerValue(part, 'content-disposition') ?? ''
      const contentId = (headerValue(part, 'content-id') ?? '').replace(/^<|>$/g, '') || null
      attachments.push({
        partId: partId || part.filename || mimeType,
        filename: decodeEncodedWords(part.filename || 'anhang'),
        mimeType,
        size: part.body?.size ?? 0,
        attachmentId: part.body?.attachmentId ?? null,
        contentId,
        inline: /inline/i.test(disposition) || Boolean(contentId),
        data: part.body?.data ?? null
      })
      return
    }
    if (!part.body?.data) return
    if (mimeType === 'text/html' && html === null) html = decodeBase64Url(part.body.data)
    if (mimeType === 'text/plain' && text === null) text = decodeBase64Url(part.body.data)
  })

  const dateHeader = headerValue(payload, 'date')
  const internal = message.internalDate ? Number(message.internalDate) : Number.NaN
  const parsedDate = dateHeader ? Date.parse(dateHeader) : Number.NaN
  const date = Number.isFinite(internal) ? internal : Number.isFinite(parsedDate) ? parsedDate : Date.now()

  const references = (headerValue(payload, 'references') ?? '')
    .split(/\s+/)
    .map((r) => r.trim())
    .filter(Boolean)

  return {
    remoteId: message.id,
    threadRemoteId: message.threadId,
    labelIds: message.labelIds ?? [],
    subject,
    from,
    to: parseAddressList(headerValue(payload, 'to')),
    cc: parseAddressList(headerValue(payload, 'cc')),
    bcc: parseAddressList(headerValue(payload, 'bcc')),
    replyTo: parseAddressList(headerValue(payload, 'reply-to')),
    date,
    snippet: decodeEncodedWords(message.snippet ?? ''),
    messageIdHeader: headerValue(payload, 'message-id'),
    inReplyTo: headerValue(payload, 'in-reply-to'),
    references,
    // Gmail's own vacation responder keeps the original subject and says so
    // only here, so the headers are the only reliable tell.
    autoReply: isAutoReplyHeaders({
      'auto-submitted': headerValue(payload, 'auto-submitted'),
      precedence: headerValue(payload, 'precedence'),
      'x-autoreply': headerValue(payload, 'x-autoreply'),
      'x-autorespond': headerValue(payload, 'x-autorespond'),
      'list-id': headerValue(payload, 'list-id')
    }),
    body: { html, text },
    attachments
  }
}

/**
 * The address of ours a message was delivered to. Used to pick the matching
 * send-as alias when replying.
 */
export function deliveredToAddress(
  parsed: Pick<ParsedGmailMessage, 'to' | 'cc' | 'bcc'>,
  ownAddresses: string[],
  deliveredToHeader?: string | null
): string | null {
  const own = new Set(ownAddresses.map((a) => a.toLowerCase()))
  const delivered = deliveredToHeader ? parseAddress(deliveredToHeader)?.email : null
  if (delivered && own.has(delivered.toLowerCase())) return delivered
  for (const address of [...parsed.to, ...parsed.cc, ...parsed.bcc]) {
    if (own.has(address.email.toLowerCase())) return address.email
  }
  return null
}
