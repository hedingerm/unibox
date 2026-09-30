import type { Attachment, Message, MessageBody, MessageSource } from '@shared/types'
import type { Store } from './db/store'
import type { GmailClient } from './google/client'
import type { ResendClient } from './resend/client'
import { formatAddress, formatAddressList } from './mime/addresses'

export interface MessageSourceDeps {
  store: Store
  gmailClientFor: (accountId: string) => GmailClient | null
  resendClient: () => ResendClient | null
}

/**
 * The raw message behind "Original anzeigen". The provider's copy is asked for
 * on demand and never stored: it is only ever looked at, and keeping every
 * message twice would double the database for a dialog opened once a month.
 * Whatever cannot be fetched — offline, a sent Resend mail, an expired link —
 * is rebuilt from the stored headers and body, and says so.
 */
export async function messageSource(
  deps: MessageSourceDeps,
  messageId: string
): Promise<MessageSource> {
  const message = deps.store.messages.get(messageId)
  if (!message) throw new Error('Unbekannte Nachricht')
  const account = deps.store.accounts.get(message.accountId)
  try {
    if (account?.kind === 'google') {
      const client = deps.gmailClientFor(message.accountId)
      const raw = client ? (await client.getMessage(message.remoteId, 'raw')).raw : undefined
      if (raw) return { raw: Buffer.from(raw, 'base64url').toString('utf8'), origin: 'gmail' }
    } else if (account?.kind === 'resend' && message.direction === 'incoming') {
      const client = deps.resendClient()
      const url = client ? (await client.getReceivedEmail(message.remoteId)).raw?.download_url : null
      if (client && url) {
        return { raw: (await client.downloadAttachment(url)).toString('utf8'), origin: 'resend' }
      }
    }
  } catch {
    // The rebuilt copy below is still an answer; a failed fetch is not worth
    // an error dialog in front of the headers the store already has.
  }
  return {
    raw: reconstructSource(
      message,
      deps.store.messages.body(messageId),
      deps.store.messages.attachments(messageId)
    ),
    origin: 'reconstructed'
  }
}

/**
 * An RFC 822-shaped text from what is stored. Bodies are written out as they
 * are rather than base64-encoded: this is for reading, not for re-sending.
 */
export function reconstructSource(
  message: Message,
  body: MessageBody,
  attachments: Attachment[]
): string {
  const headers: Array<[string, string]> = [
    ['Message-ID', message.messageIdHeader ?? ''],
    ['Date', new Date(message.date).toUTCString()],
    ['From', formatAddress(message.from)],
    ['To', formatAddressList(message.to)],
    ['Cc', formatAddressList(message.cc)],
    ['Reply-To', formatAddressList(message.replyTo)],
    ['Subject', message.subject],
    ['In-Reply-To', message.inReplyTo ?? ''],
    ['References', message.references.join(' ')]
  ]
  const lines = headers.filter(([, value]) => value !== '').map(([name, value]) => `${name}: ${value}`)
  const boundary = `unibox-${message.id}`
  lines.push('MIME-Version: 1.0', `Content-Type: multipart/mixed; boundary="${boundary}"`, '')
  const part = (type: string, content: string): void => {
    lines.push(`--${boundary}`, `Content-Type: ${type}; charset="UTF-8"`, '', content, '')
  }
  if (body.text) part('text/plain', body.text)
  if (body.html) part('text/html', body.html)
  for (const attachment of attachments) {
    lines.push(
      `--${boundary}`,
      `Content-Type: ${attachment.mimeType}; name="${attachment.filename}"`,
      `Content-Disposition: ${attachment.inline ? 'inline' : 'attachment'}; filename="${attachment.filename}"`,
      '',
      `[${attachment.size} Bytes]`,
      ''
    )
  }
  lines.push(`--${boundary}--`)
  return lines.join('\r\n')
}
