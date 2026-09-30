import { useMemo, useState } from 'react'
import { t } from '../i18n'
import type { DiffPart } from '../lib/diff'
import { SparkleIcon } from './Icons'

/**
 * Stands in for the draft while the assistant writes. There is no cancel: the
 * job runs in the main process, and closing the window is how the user walks
 * away from it — the result then arrives as a toast.
 */
export function AiRunning(): React.JSX.Element {
  return (
    <div className="ai-bar ai-bar--running" role="status">
      <SparkleIcon size={14} color="var(--accent)" />
      <span className="ai-bar__status">{t('ai.running')}</span>
      <span className="ai-bar__hint">{t('ai.runningHint')}</span>
    </div>
  )
}

interface AiReviewProps {
  parts: DiffPart[]
  /** Hands over the decisions; putting them into the draft is the caller's. */
  onApply: (accepted: ReadonlySet<number>) => void
  onDiscard: () => void
}

interface Row {
  part: DiffPart
  /** Position among the changes, or -1 for unchanged text. */
  change: number
}

/** Numbers the changes once, so rendering does not have to count as it goes. */
function rows(parts: DiffPart[]): Row[] {
  let change = -1
  return parts.map((part) => {
    if (part.kind === 'equal') return { part, change: -1 }
    change += 1
    return { part, change }
  })
}

/**
 * Shows what the assistant would change, one clickable decision per change.
 * Nothing here touches the draft: the review is a proposal until `onApply`.
 */
export function AiReview({ parts, onApply, onDiscard }: AiReviewProps): React.JSX.Element {
  const numbered = useMemo(() => rows(parts), [parts])
  const total = numbered.filter((row) => row.change >= 0).length
  // Everything starts accepted: taking the proposal over is the common case,
  // and rejecting single changes is the exception the review exists for.
  const [accepted, setAccepted] = useState<ReadonlySet<number>>(
    () => new Set(Array.from({ length: total }, (_, index) => index))
  )
  const toggle = (index: number): void => {
    setAccepted((current) => {
      const next = new Set(current)
      if (next.has(index)) next.delete(index)
      else next.add(index)
      return next
    })
  }

  return (
    <div className="ai-review">
      <div className="ai-review__head">
        <span className="ai-review__title">{t('ai.reviewTitle', { count: total })}</span>
        <button
          type="button"
          className="ai-review__link"
          onClick={() => setAccepted(new Set(Array.from({ length: total }, (_, i) => i)))}
        >
          {t('ai.acceptAll')}
        </button>
        <button
          type="button"
          className="ai-review__link"
          onClick={() => setAccepted(new Set<number>())}
        >
          {t('ai.rejectAll')}
        </button>
      </div>
      <div className="ai-review__body">
        {numbered.map((row, position) => {
          if (row.part.kind === 'equal') {
            return (
              <span key={position} className="ai-review__equal">
                {row.part.text}
              </span>
            )
          }
          const isAccepted = accepted.has(row.change)
          // A span, not a button: a button box drops the whitespace at its
          // edges, and a change that starts or ends with a space or a line
          // break would render as if the text ran together.
          return (
            <span
              key={position}
              role="button"
              tabIndex={0}
              className={`ai-review__change${isAccepted ? ' is-accepted' : ''}`}
              aria-pressed={isAccepted}
              title={isAccepted ? t('ai.changeAccepted') : t('ai.changeRejected')}
              onClick={() => toggle(row.change)}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return
                event.preventDefault()
                toggle(row.change)
              }}
            >
              {row.part.before ? (
                <span className="ai-review__before">{row.part.before}</span>
              ) : null}
              {row.part.after ? <span className="ai-review__after">{row.part.after}</span> : null}
            </span>
          )
        })}
      </div>
      <div className="ai-review__foot">
        <button
          type="button"
          className="button-primary"
          onClick={() => onApply(accepted)}
        >
          {t('ai.apply', { count: accepted.size })}
        </button>
        <button type="button" className="button-secondary" onClick={onDiscard}>
          {t('ai.discard')}
        </button>
        <span className="ai-review__hint">{t('ai.reviewHint')}</span>
      </div>
    </div>
  )
}
