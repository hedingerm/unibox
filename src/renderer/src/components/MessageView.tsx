import { useEffect, useMemo, useState } from 'react'
import { emailDomain, isSharedDomain } from '@shared/email-domain'
import type { Attachment, RemoteImageTrustKind, ThreadMessage } from '@shared/types'
import { t } from '../i18n'
import { api } from '../lib/bridge'
import {
  avatarColors,
  displayName,
  formatBytes,
  formatFullDate,
  formatMessageDate,
  initials
} from '../lib/format'
import { useOpenLink } from '../lib/links'
import { plainTextToHtml, sanitizeMessageHtml } from '../lib/sanitize'
import { splitQuotedHtml, splitQuotedText } from '../lib/quote'
import { useAction } from '../lib/useAction'
import { useUnibox } from '../state'
import { AttachmentPreview } from './AttachmentPreview'
import { LinkMenu } from './LinkMenu'
import { AttachIcon, ChevronIcon, CodeIcon, ForwardIcon, MoreIcon, ReplyIcon } from './Icons'
import { ContextMenu, MenuDivider, MenuItem, type MenuPosition } from './ContextMenu'
import { MessageSourceDialog } from './MessageSource'

/** A stored message with everything needed to render it. */
export type FullMessage = ThreadMessage

function useInlineImages(attachments: Attachment[]): Record<string, string> {
  const [images, setImages] = useState<Record<string, string>>({})
  const inline = useMemo(
    () => attachments.filter((attachment) => attachment.inline && attachment.contentId),
    [attachments]
  )

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const entries: Array<[string, string]> = []
      for (const attachment of inline) {
        try {
          const content = await api.invoke('attachments:open', attachment.id)
          entries.push([
            attachment.contentId ?? attachment.id,
            `data:${content.mimeType};base64,${content.content}`
          ])
        } catch {
          // An inline image that cannot be fetched is simply not rendered.
        }
      }
      if (cancelled) return
      setImages(Object.fromEntries(entries))
    })()
    return () => {
      cancelled = true
    }
  }, [inline])

  return images
}

/** The link a pointer event landed on, or null for anything else in the mail. */
function linkAt(target: EventTarget | null): string | null {
  const element = target instanceof Element ? target.closest('a[href]') : null
  return element?.getAttribute('href') ?? null
}

export function MessageBodyView({ message }: { message: FullMessage }): React.JSX.Element {
  // The main process has already asked whether this sender earned it; the local
  // flag only carries a decision made right here, on this mail.
  const [allowRemote, setAllowRemote] = useState(message.remoteImages === 'allow')
  const [linkMenu, setLinkMenu] = useState<(MenuPosition & { href: string }) | null>(null)
  // Where the link under the pointer actually goes. Mail is the one place
  // where the words of a link and its address routinely disagree on purpose,
  // so the address gets shown before it is followed, the way a browser does.
  const [hovered, setHovered] = useState<string | null>(null)
  const openLink = useOpenLink()
  const inlineImages = useInlineImages(message.attachments)
  const [quoteOpen, setQuoteOpen] = useState(false)
  // The quoted history is split off before sanitising: the marks Outlook and
  // Apple Mail put on it are ids and attributes the sanitiser removes.
  const parts = useMemo(() => {
    if (message.body.html) return splitQuotedHtml(message.body.html)
    const text = splitQuotedText(message.body.text ?? '')
    return {
      body: plainTextToHtml(text.body),
      quote: text.quote === null ? null : plainTextToHtml(text.quote)
    }
  }, [message.body.html, message.body.text])
  const { html, quote, blockedImages } = useMemo(() => {
    const options = { allowRemoteImages: allowRemote, inlineImages }
    const body = sanitizeMessageHtml(parts.body, options)
    const quoted = parts.quote === null ? null : sanitizeMessageHtml(parts.quote, options)
    return {
      html: body.html,
      quote: quoted?.html ?? null,
      blockedImages: body.blockedImages + (quoted?.blockedImages ?? 0)
    }
  }, [parts, allowRemote, inlineImages])

  const sender = message.from.email
  const domain = emailDomain(sender)
  const trust = useAction(async (kind: RemoteImageTrustKind) => {
    await api.invoke('remoteImages:trust', kind, kind === 'domain' ? domain : sender)
    setAllowRemote(true)
  })

  return (
    <>
      {/* Reading is not a tab route: the bar's buttons sit next to the text
          they belong to and stay on the mouse, so Tab keeps running past the
          message to the controls that act on the thread. */}
      {blockedImages > 0 ? (
        <div className="message__blocked">
          <span className="message__blocked-text">{t('reading.imagesBlocked')}</span>
          <button
            type="button"
            className="button-secondary"
            tabIndex={-1}
            onClick={() => setAllowRemote(true)}
          >
            {t('reading.showImages')}
          </button>
          <button
            type="button"
            className="button-secondary"
            disabled={trust.busy}
            tabIndex={-1}
            onClick={() => void trust.run('sender')}
          >
            {t('reading.trustSender')}
          </button>
          {domain && !isSharedDomain(domain) ? (
            <button
              type="button"
              className="button-secondary"
              disabled={trust.busy}
              tabIndex={-1}
              onClick={() => void trust.run('domain')}
            >
              {t('reading.trustDomain', { domain })}
            </button>
          ) : null}
        </div>
      ) : null}
      <div
        className="message__body"
        onContextMenu={(event) => {
          const href = linkAt(event.target)
          if (!href) return
          event.preventDefault()
          setLinkMenu({ href, x: event.clientX, y: event.clientY })
        }}
        onMouseOver={(event) => setHovered(linkAt(event.target))}
        onMouseOut={() => setHovered(null)}
      >
        <div dangerouslySetInnerHTML={{ __html: html }} />
        {/* The history every reply drags along stays folded behind a pill, the
            way Gmail does it: it is the same text the messages above already
            show, and it would otherwise be most of what is on screen. */}
        {quote !== null ? (
          <>
            <button
              type="button"
              className="quote-toggle"
              aria-expanded={quoteOpen}
              aria-label={quoteOpen ? t('reading.hideQuote') : t('reading.showQuote')}
              title={quoteOpen ? t('reading.hideQuote') : t('reading.showQuote')}
              tabIndex={-1}
              onClick={() => setQuoteOpen((value) => !value)}
            >
              •••
            </button>
            {quoteOpen ? (
              <div className="message__quote" dangerouslySetInnerHTML={{ __html: quote }} />
            ) : null}
          </>
        ) : null}
      </div>
      {hovered ? <span className="link-status">{hovered}</span> : null}
      {linkMenu ? (
        <LinkMenu
          href={linkMenu.href}
          x={linkMenu.x}
          y={linkMenu.y}
          onOpen={openLink}
          onClose={() => setLinkMenu(null)}
        />
      ) : null}
    </>
  )
}

export function AttachmentChips({
  attachments
}: {
  attachments: Attachment[]
}): React.JSX.Element | null {
  const [previewIndex, setPreviewIndex] = useState<number | null>(null)
  const visible = useMemo(
    () => attachments.filter((attachment) => !attachment.inline),
    [attachments]
  )
  if (visible.length === 0) return null

  return (
    <>
      <div className="message__attachments">
        {visible.map((attachment, index) => (
          <button
            key={attachment.id}
            type="button"
            className="attachment-chip"
            onClick={() => setPreviewIndex(index)}
          >
            <AttachIcon size={13} />
            <span>{attachment.filename}</span>
            {attachment.size > 0 ? (
              <span className="attachment-chip__size">{formatBytes(attachment.size)}</span>
            ) : null}
          </button>
        ))}
      </div>
      {previewIndex !== null ? (
        <AttachmentPreview
          attachments={visible}
          index={previewIndex}
          onSelect={setPreviewIndex}
          onClose={() => setPreviewIndex(null)}
        />
      ) : null}
    </>
  )
}

/**
 * "an mich, Sandra Keller" — the reader's own addresses read as "mich", the
 * way Gmail says it, because who else got the mail is what the line is for.
 */
function recipientSummary(message: FullMessage, own: Set<string>): string {
  const names = [...message.to, ...message.cc].map((address) =>
    own.has(address.email.toLowerCase()) ? t('reading.me') : displayName(address)
  )
  const unique = [...new Set(names)]
  const shown = unique.length > 3 ? [...unique.slice(0, 3), `+${unique.length - 3}`] : unique
  return t('reading.to', { recipients: shown.join(', ') })
}

/** Name and address, for the details under a header — nothing abbreviated. */
function fullAddresses(addresses: FullMessage['to']): string {
  return addresses
    .map((address) => (address.name ? `${address.name} <${address.email}>` : address.email))
    .join(', ')
}

export function MessageView({ message }: { message: FullMessage }): React.JSX.Element {
  const colors = avatarColors(message.from)
  const { setSearchText, identities, accounts, openReply, openForward } = useUnibox()
  const [details, setDetails] = useState(false)
  const [menu, setMenu] = useState<MenuPosition | null>(null)
  const [sourceOpen, setSourceOpen] = useState(false)
  const own = useMemo(
    () =>
      new Set(
        [...identities.map((entry) => entry.email), ...accounts.map((entry) => entry.email)].map(
          (email) => email.toLowerCase()
        )
      ),
    [identities, accounts]
  )
  return (
    <article className="message">
      <div className="message__head">
        <div className="avatar" style={{ background: colors.background, color: colors.color }}>
          {initials(message.from)}
        </div>
        <div className="message__from">
          <span className="message__from-name">
            {displayName(message.from)}{' '}
            <span className="message__from-address">&lt;{message.from.email}&gt;</span>
          </span>
          <button
            type="button"
            className="message__to"
            aria-expanded={details}
            title={t('reading.toggleRecipients')}
            tabIndex={-1}
            onClick={() => setDetails((value) => !value)}
          >
            <span className="message__to-names">{recipientSummary(message, own)}</span>
            <ChevronIcon size={10} open={!details} />
          </button>
        </div>
        <span className="message__date" title={formatFullDate(message.date)}>
          {formatMessageDate(message.date)}
        </span>
        <button
          type="button"
          className="icon-button message__action"
          title={t('reading.reply')}
          aria-label={t('reading.reply')}
          tabIndex={-1}
          onClick={() => void openReply(message.id)}
        >
          <ReplyIcon size={16} />
        </button>
        <button
          type="button"
          className="icon-button message__action"
          title={t('reading.moreActions')}
          aria-label={t('reading.moreActions')}
          aria-haspopup="menu"
          tabIndex={-1}
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect()
            setMenu({ x: rect.left, y: rect.bottom + 4 })
          }}
        >
          <MoreIcon size={16} />
        </button>
      </div>
      {details ? (
        <dl className="message__details">
          <dt>{t('reading.detailsFrom')}</dt>
          <dd>{fullAddresses([message.from])}</dd>
          <dt>{t('reading.detailsTo')}</dt>
          <dd>{fullAddresses(message.to)}</dd>
          {message.cc.length > 0 ? (
            <>
              <dt>{t('reading.detailsCc')}</dt>
              <dd>{fullAddresses(message.cc)}</dd>
            </>
          ) : null}
          <dt>{t('reading.detailsDate')}</dt>
          <dd>{formatFullDate(message.date)}</dd>
          <dt>{t('reading.detailsSubject')}</dt>
          <dd>{message.subject}</dd>
        </dl>
      ) : null}
      <MessageBodyView message={message} />
      <AttachmentChips attachments={message.attachments} />
      {menu ? (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          label={t('reading.moreActions')}
          onClose={() => setMenu(null)}
        >
          <MenuItem
            label={t('reading.reply')}
            icon={<ReplyIcon size={14} />}
            onClick={() => {
              setMenu(null)
              void openReply(message.id)
            }}
          />
          <MenuItem
            label={t('reading.forward')}
            icon={<ForwardIcon size={14} />}
            onClick={() => {
              setMenu(null)
              void openForward(message.id)
            }}
          />
          <MenuDivider />
          {/* The cheap half of "search by sender": it writes the operator into
              the box, so the query stays visible and editable. */}
          <MenuItem
            label={t('search.fromSender')}
            onClick={() => {
              setMenu(null)
              setSearchText(`from:${message.from.email}`)
            }}
          />
          <MenuItem
            label={t('reading.showOriginal')}
            icon={<CodeIcon size={14} />}
            onClick={() => {
              setMenu(null)
              setSourceOpen(true)
            }}
          />
        </ContextMenu>
      ) : null}
      {sourceOpen ? (
        <MessageSourceDialog messageId={message.id} onClose={() => setSourceOpen(false)} />
      ) : null}
    </article>
  )
}
