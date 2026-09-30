import { useEffect, useRef, useState } from 'react'
import type { MessageSource } from '@shared/types'
import { t } from '../i18n'
import { api } from '../lib/bridge'
import { errorMessage } from '../lib/errors'
import { useFocusTrap } from '../hooks/useFocusTrap'
import { CloseIcon } from './Icons'
import { InlineError } from './InlineError'

/**
 * "Original anzeigen": the message as it travelled, headers first. Fetched when
 * the dialog opens — the provider's copy is never stored, it is only looked at.
 */
export function MessageSourceDialog({
  messageId,
  onClose
}: {
  messageId: string
  onClose: () => void
}): React.JSX.Element {
  const [source, setSource] = useState<MessageSource | null>(null)
  const [error, setError] = useState<string | null>(null)
  const panel = useRef<HTMLDivElement | null>(null)
  useFocusTrap(panel)

  useEffect(() => {
    let cancelled = false
    api
      .invoke('messages:source', messageId)
      .then((result) => {
        if (!cancelled) setSource(result)
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(errorMessage(cause))
      })
    return () => {
      cancelled = true
    }
  }, [messageId])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      ref={panel}
      className="overlay"
      role="dialog"
      aria-modal="true"
      aria-label={t('reading.sourceTitle')}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="window source-dialog">
        <div className="window__titlebar">
          <span className="window__title">{t('reading.sourceTitle')}</span>
          <button
            type="button"
            className="window__close"
            aria-label={t('reading.sourceClose')}
            onClick={onClose}
          >
            <CloseIcon />
          </button>
        </div>
        <div className="source-dialog__body">
          {error ? <InlineError message={error} /> : null}
          {!source && !error ? (
            <p className="source-dialog__note">{t('reading.sourceLoading')}</p>
          ) : null}
          {source?.origin === 'reconstructed' ? (
            <p className="source-dialog__note">{t('reading.sourceReconstructed')}</p>
          ) : null}
          {source ? <pre className="source-dialog__raw">{source.raw}</pre> : null}
        </div>
        {source ? (
          <div className="source-dialog__actions">
            <button
              type="button"
              className="button-secondary"
              onClick={() => void api.invoke('clipboard:write', source.raw)}
            >
              {t('reading.sourceCopy')}
            </button>
          </div>
        ) : null}
      </div>
    </div>
  )
}
