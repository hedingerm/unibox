import { useEffect, useMemo, useState } from 'react'
import type { Attachment } from '@shared/types'
import { t } from '../i18n'
import { api } from '../lib/bridge'
import { formatBytes } from '../lib/format'
import { sanitizeMessageHtml } from '../lib/sanitize'
import { useUnibox } from '../state'
import { ChevronIcon, CloseIcon } from './Icons'

type PreviewKind = 'image' | 'pdf' | 'text' | 'html' | 'none'

/**
 * What the renderer can show inline. Anything else stays a download — an
 * office document or archive is handed to the OS instead of half-rendered.
 */
export function previewKind(attachment: Attachment): PreviewKind {
  const mime = attachment.mimeType.toLowerCase()
  if (mime.startsWith('image/') && mime !== 'image/svg+xml') return 'image'
  if (mime === 'application/pdf') return 'pdf'
  if (mime === 'text/html') return 'html'
  if (mime.startsWith('text/') || mime === 'application/json') return 'text'
  return 'none'
}

function decodeBase64(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64)
  const bytes = new Uint8Array(new ArrayBuffer(binary.length))
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

interface Loaded {
  attachmentId: string
  /** Object URL for image/pdf rendering, revoked when the preview moves on. */
  url: string | null
  text: string | null
}

function useAttachmentContent(attachment: Attachment): {
  loaded: Loaded | null
  loading: boolean
  error: string | null
} {
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [error, setError] = useState<string | null>(null)
  const kind = previewKind(attachment)

  // The body is keyed by attachment id, so a different attachment remounts
  // this hook — no manual state reset needed when the effect re-runs.
  useEffect(() => {
    if (kind === 'none') return
    let cancelled = false
    let createdUrl: string | null = null
    void (async () => {
      try {
        const content = await api.invoke('attachments:open', attachment.id)
        if (cancelled) return
        const bytes = decodeBase64(content.content)
        if (kind === 'text' || kind === 'html') {
          setLoaded({
            attachmentId: attachment.id,
            url: null,
            text: new TextDecoder().decode(bytes)
          })
          return
        }
        createdUrl = URL.createObjectURL(new Blob([bytes], { type: content.mimeType }))
        setLoaded({ attachmentId: attachment.id, url: createdUrl, text: null })
      } catch (cause) {
        if (cancelled) return
        setError(cause instanceof Error ? cause.message : String(cause))
      }
    })()
    return () => {
      cancelled = true
      if (createdUrl) URL.revokeObjectURL(createdUrl)
    }
  }, [attachment.id, kind])

  return { loaded, loading: !loaded && !error && kind !== 'none', error }
}

function PreviewBody({ attachment }: { attachment: Attachment }): React.JSX.Element {
  const kind = previewKind(attachment)
  const { loaded, loading, error } = useAttachmentContent(attachment)
  const text = loaded?.text ?? null
  const html = useMemo(
    () =>
      kind === 'html' && text !== null
        ? sanitizeMessageHtml(text, { allowRemoteImages: false }).html
        : null,
    [kind, text]
  )

  if (error) return <p className="preview__notice">{error}</p>
  if (kind === 'none') {
    return (
      <div className="preview__notice">
        <p>{t('preview.unsupported', { type: attachment.mimeType })}</p>
      </div>
    )
  }
  if (loading || !loaded) return <p className="preview__notice">{t('reading.downloading')}</p>

  if (kind === 'image' && loaded.url) {
    return <img className="preview__image" src={loaded.url} alt={attachment.filename} />
  }
  if (kind === 'pdf' && loaded.url) {
    return <iframe className="preview__frame" src={loaded.url} title={attachment.filename} />
  }
  if (kind === 'html' && html !== null) {
    return <div className="preview__document" dangerouslySetInnerHTML={{ __html: html }} />
  }
  return <pre className="preview__text">{loaded.text}</pre>
}

/**
 * Full-window look at one attachment, with the message's other attachments
 * reachable via the arrows so a batch can be skimmed without reopening.
 */
export function AttachmentPreview({
  attachments,
  index,
  onSelect,
  onClose
}: {
  attachments: Attachment[]
  index: number
  onSelect: (index: number) => void
  onClose: () => void
}): React.JSX.Element | null {
  const { setError } = useUnibox()
  const [busy, setBusy] = useState(false)
  const attachment = attachments[index]

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
      if (event.key === 'ArrowLeft' && index > 0) onSelect(index - 1)
      if (event.key === 'ArrowRight' && index < attachments.length - 1) onSelect(index + 1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [attachments.length, index, onClose, onSelect])

  if (!attachment) return null

  const run = async (action: 'attachments:openExternal' | 'attachments:saveAs'): Promise<void> => {
    setBusy(true)
    try {
      await api.invoke(action, attachment.id)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="overlay"
      role="dialog"
      aria-modal="true"
      aria-label={attachment.filename}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="window preview">
        <div className="window__titlebar">
          <span className="window__title">{attachment.filename}</span>
          <button
            type="button"
            className="window__close"
            aria-label={t('preview.close')}
            onClick={onClose}
          >
            <CloseIcon />
          </button>
        </div>

        <div className="preview__body">
          {attachments.length > 1 ? (
            <button
              type="button"
              className="preview__nav preview__nav--prev"
              aria-label={t('preview.previous')}
              disabled={index === 0}
              onClick={() => onSelect(index - 1)}
            >
              <ChevronIcon size={16} open={false} />
            </button>
          ) : null}
          <PreviewBody key={attachment.id} attachment={attachment} />
          {attachments.length > 1 ? (
            <button
              type="button"
              className="preview__nav preview__nav--next"
              aria-label={t('preview.next')}
              disabled={index === attachments.length - 1}
              onClick={() => onSelect(index + 1)}
            >
              <ChevronIcon size={16} />
            </button>
          ) : null}
        </div>

        <div className="preview__footer">
          <span className="preview__meta">
            {attachment.mimeType}
            {attachment.size > 0 ? ` · ${formatBytes(attachment.size)}` : ''}
            {attachments.length > 1
              ? ` · ${t('preview.position', { index: index + 1, total: attachments.length })}`
              : ''}
          </span>
          <button
            type="button"
            className="button-secondary"
            disabled={busy}
            onClick={() => void run('attachments:openExternal')}
          >
            {t('preview.openExternal')}
          </button>
          <button
            type="button"
            className="button-primary"
            disabled={busy}
            onClick={() => void run('attachments:saveAs')}
          >
            {t('preview.save')}
          </button>
        </div>
      </div>
    </div>
  )
}
