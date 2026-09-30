import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { t } from '../i18n'

/** What a single open prompt asks the user for. */
export type PromptRequest = {
  /** The line above the field, naming what the value is. */
  label: string
  /** What the field starts with; selected, so typing replaces it. */
  initial?: string
  /** Overrides the confirm button's wording where a verb reads better. */
  confirmLabel?: string
}

/**
 * Stands in for `window.prompt`, which Electron's renderer does not implement:
 * calling it throws and takes the rest of the click handler down with it.
 *
 * `ask` resolves to the typed value, or to `null` when the prompt is cancelled,
 * so a call site reads like the browser function it replaces — an empty string
 * stays distinct from a cancellation.
 */
export function usePrompt(): {
  ask: (request: PromptRequest) => Promise<string | null>
  dialog: React.JSX.Element | null
} {
  const [request, setRequest] = useState<PromptRequest | null>(null)
  const resolveRef = useRef<((value: string | null) => void) | null>(null)

  const ask = useCallback((next: PromptRequest) => {
    // A second ask while one is open would otherwise strand the first promise.
    resolveRef.current?.(null)
    return new Promise<string | null>((resolve) => {
      resolveRef.current = resolve
      setRequest(next)
    })
  }, [])

  const settle = useCallback((value: string | null) => {
    const resolve = resolveRef.current
    resolveRef.current = null
    setRequest(null)
    resolve?.(value)
  }, [])

  // Closing the window while the prompt is up would leave the caller waiting
  // forever; unmounting counts as a cancellation.
  useEffect(
    () => () => {
      resolveRef.current?.(null)
      resolveRef.current = null
    },
    []
  )

  return {
    ask,
    dialog: request ? <PromptDialog request={request} onSettle={settle} /> : null
  }
}

function PromptDialog({
  request,
  onSettle
}: {
  request: PromptRequest
  onSettle: (value: string | null) => void
}): React.JSX.Element {
  const [value, setValue] = useState(request.initial ?? '')
  const inputRef = useRef<HTMLInputElement>(null)
  const fieldId = useId()

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  return createPortal(
    <div
      className="overlay overlay--prompt"
      // The dialog is a portal, so React would still bubble its events into
      // whichever surface opened it — a backdrop click there must not read as
      // a click on the compose window behind it.
      onMouseDown={(event) => {
        event.stopPropagation()
        if (event.target === event.currentTarget) onSettle(null)
      }}
      onKeyDown={(event) => {
        event.stopPropagation()
        if (event.key === 'Escape') onSettle(null)
      }}
    >
      <form
        className="prompt"
        role="dialog"
        aria-modal="true"
        aria-label={request.label}
        onSubmit={(event) => {
          event.preventDefault()
          onSettle(value)
        }}
      >
        <label className="prompt__label" htmlFor={fieldId}>
          {request.label}
        </label>
        <input
          id={fieldId}
          ref={inputRef}
          className="prompt__input"
          type="text"
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
        <div className="prompt__actions">
          <button type="button" className="button-secondary" onClick={() => onSettle(null)}>
            {t('prompt.cancel')}
          </button>
          <button type="submit" className="button-primary">
            {request.confirmLabel ?? t('prompt.confirm')}
          </button>
        </div>
      </form>
    </div>,
    document.body
  )
}
