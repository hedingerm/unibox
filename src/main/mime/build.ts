import { randomUUID } from 'node:crypto'
import type { EmailAddress } from '@shared/types'
import { formatAddressList } from './addresses'

export interface MimeAttachment {
  filename: string
  mimeType: string
  /** base64-encoded content. */
  content: string
  contentId?: string
  inline?: boolean
}

export interface BuildMimeInput {
  from: EmailAddress
  to: EmailAddress[]
  cc?: EmailAddress[]
  bcc?: EmailAddress[]
  replyTo?: EmailAddress[]
  subject: string
  html: string
  text: string
  attachments?: MimeAttachment[]
  inReplyTo?: string | null
  references?: string[]
  messageId?: string
  date?: Date
}

function encodeHeaderValue(value: string): string {
  if (/^[\x20-\x7e]*$/.test(value)) return value
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`
}

function foldBase64(content: string): string {
  return (content.match(/.{1,76}/g) ?? []).join('\r\n')
}

function boundary(): string {
  return `----unibox-${randomUUID().replace(/-/g, '')}`
}

function bodyPart(mimeType: string, content: string): string[] {
  return [
    `Content-Type: ${mimeType}; charset="UTF-8"`,
    'Content-Transfer-Encoding: base64',
    '',
    foldBase64(Buffer.from(content, 'utf8').toString('base64'))
  ]
}

function attachmentPart(attachment: MimeAttachment): string[] {
  const disposition = attachment.inline ? 'inline' : 'attachment'
  const lines = [
    `Content-Type: ${attachment.mimeType}; name="${encodeHeaderValue(attachment.filename)}"`,
    'Content-Transfer-Encoding: base64',
    `Content-Disposition: ${disposition}; filename="${encodeHeaderValue(attachment.filename)}"`
  ]
  if (attachment.contentId) lines.push(`Content-ID: <${attachment.contentId}>`)
  lines.push('', foldBase64(attachment.content))
  return lines
}

function multipart(type: string, parts: string[][]): string[] {
  const marker = boundary()
  const lines = [`Content-Type: ${type}; boundary="${marker}"`, '']
  for (const part of parts) {
    lines.push(`--${marker}`, ...part)
  }
  lines.push(`--${marker}--`)
  return lines
}

export function generateMessageId(domain: string): string {
  return `<${randomUUID()}@${domain}>`
}

/**
 * Builds an RFC 5322 message. Inline images are wrapped in `multipart/related`
 * so that `cid:` references in the HTML resolve in the recipient's client.
 */
export function buildMimeMessage(input: BuildMimeInput): { raw: string; messageId: string } {
  const inline = (input.attachments ?? []).filter((a) => a.inline && a.contentId)
  const files = (input.attachments ?? []).filter((a) => !(a.inline && a.contentId))
  const domain = input.from.email.split('@')[1] ?? 'unibox.local'
  const messageId = input.messageId ?? generateMessageId(domain)

  const alternative = multipart('multipart/alternative', [
    bodyPart('text/plain', input.text),
    bodyPart('text/html', input.html)
  ])
  const withInline =
    inline.length > 0
      ? multipart('multipart/related', [alternative, ...inline.map(attachmentPart)])
      : alternative
  const body =
    files.length > 0
      ? multipart('multipart/mixed', [withInline, ...files.map(attachmentPart)])
      : withInline

  const headers = [
    `From: ${formatAddressList([input.from])}`,
    `To: ${formatAddressList(input.to)}`
  ]
  if (input.cc && input.cc.length > 0) headers.push(`Cc: ${formatAddressList(input.cc)}`)
  if (input.bcc && input.bcc.length > 0) headers.push(`Bcc: ${formatAddressList(input.bcc)}`)
  if (input.replyTo && input.replyTo.length > 0) {
    headers.push(`Reply-To: ${formatAddressList(input.replyTo)}`)
  }
  headers.push(`Subject: ${encodeHeaderValue(input.subject)}`)
  headers.push(`Date: ${(input.date ?? new Date()).toUTCString()}`)
  headers.push(`Message-ID: ${messageId}`)
  headers.push('MIME-Version: 1.0')
  if (input.inReplyTo) headers.push(`In-Reply-To: ${input.inReplyTo}`)
  if (input.references && input.references.length > 0) {
    headers.push(`References: ${input.references.join(' ')}`)
  }

  return { raw: [...headers, ...body].join('\r\n'), messageId }
}

export function toBase64Url(raw: string): string {
  return Buffer.from(raw, 'utf8').toString('base64url')
}

/** Very small HTML-to-text fallback for the plain alternative part. */
export function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
