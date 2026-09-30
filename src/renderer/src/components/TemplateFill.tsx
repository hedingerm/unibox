import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { t } from '../i18n'

/** What a template still wants to know before it goes into the draft. */
export interface FillRequest {
  /** Named in the heading, so it is clear which template is being filled. */
  templateName: string
  /** The open placeholders, in the order the template mentions them. */
  variables: string[]
}

/**
 * Asks for the variables a template could not answer on its own. The values
 * are typed once, here, rather than hunted for in the finished draft — and
 * whatever is left empty stays a visible `{{platzhalter}}`, which is what the
 * send guard later refuses to let out.
 *
 * `fill` resolves to the values, or to `null` when the dialog is cancelled —
 * the template is then not inserted at all.
 */
export function useTemplateFill(): {
  fill: (request: FillRequest) => Promise<Record<string, string> | null>
  dialog: React.JSX.Element | null
} {
  const [request, setRequest] = useState<FillRequest | null>(null)
  const resolveRef = useRef<((value: Record<string, string> | null) => void) | null>(null)

  const fill = useCallback((next: FillRequest) => {
    resolveRef.current?.(null)
    return new Promise<Record<string, string> | null>((resolve) => {
      resolveRef.current = resolve
      setRequest(next)
    })
  }, [])

  const settle = useCallback((values: Record<string, string> | null) => {
    const resolve = resolveRef.current
    resolveRef.current = null
    setRequest(null)
    resolve?.(values)
  }, [])

  // Closing the composer while the dialog is up would leave the insert waiting
  // forever; unmounting counts as a cancellation.
  useEffect(
    () => () => {
      resolveRef.current?.(null)
      resolveRef.current = null
    },
    []
  )

  return {
    fill,
    dialog: request ? <TemplateFillDialog request={request} onSettle={settle} /> : null
  }
}

function TemplateFillDialog({
  request,
  onSettle
}: {
  request: FillRequest
  onSettle: (values: Record<string, string> | null) => void
}): React.JSX.Element {
  const [values, setValues] = useState<Record<string, string>>({})
  const firstRef = useRef<HTMLInputElement>(null)
  const prefix = useId()

  useEffect(() => {
    firstRef.current?.focus()
    firstRef.current?.select()
  }, [])

  return createPortal(
    <div
      className="overlay overlay--prompt"
      // The dialog is a portal, so React would still bubble its events into
      // the composer that opened it — a backdrop click there must not read as
      // a click on the window behind it.
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
        aria-label={t('templates.fillTitle', { name: request.templateName })}
        onSubmit={(event) => {
          event.preventDefault()
          onSettle(values)
        }}
      >
        <span className="prompt__label">
          {t('templates.fillTitle', { name: request.templateName })}
        </span>
        {request.variables.map((variable, index) => (
          <div key={variable} className="prompt__field">
            {/* The placeholder is its own label: the names are the template
                author's words, and translating them would name something the
                template does not contain. */}
            <label className="prompt__label" htmlFor={`${prefix}-${variable}`}>
              {variable}
            </label>
            <input
              id={`${prefix}-${variable}`}
              ref={index === 0 ? firstRef : undefined}
              className="prompt__input"
              type="text"
              value={values[variable] ?? ''}
              onChange={(event) =>
                setValues((current) => ({ ...current, [variable]: event.target.value }))
              }
            />
          </div>
        ))}
        <div className="prompt__actions">
          <button type="button" className="button-secondary" onClick={() => onSettle(null)}>
            {t('prompt.cancel')}
          </button>
          <button type="submit" className="button-primary">
            {t('templates.insert')}
          </button>
        </div>
      </form>
    </div>,
    document.body
  )
}
