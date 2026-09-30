import { useCallback, useEffect, useRef, useState } from 'react'
import { useFocusTrap } from '../../hooks/useFocusTrap'
import { t } from '../../i18n'
import { api } from '../../lib/bridge'
import { errorMessage } from '../../lib/errors'
import { CloseIcon } from '../Icons'
import {
  AlertIcon,
  ArrowDownIcon,
  ArrowUpIcon,
  CheckCircleIcon,
  CircleIcon,
  CopyIcon,
  MinusCircleIcon,
  PlusIcon
} from './icons'

/** Title, one muted sentence under it and the page's primary action on the right. */
export function PageHeader({
  title,
  description,
  action
}: {
  title: string
  description?: string
  action?: React.ReactNode
}): React.JSX.Element {
  return (
    <header className="admin-page__head">
      <div className="admin-page__heading">
        <h1 className="admin-page__title">{title}</h1>
        {description ? <p className="admin-page__desc">{description}</p> : null}
      </div>
      {action}
    </header>
  )
}

export function AddButton({
  label,
  onClick,
  disabled
}: {
  label: string
  onClick: () => void
  disabled?: boolean
}): React.JSX.Element {
  return (
    <button type="button" className="button-primary admin-add" disabled={disabled} onClick={onClick}>
      <PlusIcon size={16} />
      {label}
    </button>
  )
}

/** A white, borderless card on the tinted ground. */
export function Card({
  title,
  description,
  action,
  children,
  className
}: {
  title?: string
  description?: string
  action?: React.ReactNode
  children?: React.ReactNode
  className?: string
}): React.JSX.Element {
  return (
    <section className={['admin-card', className].filter(Boolean).join(' ')}>
      {title ? (
        <div className="admin-card__head">
          <div className="admin-card__heading">
            <h2 className="admin-card__title">{title}</h2>
            {description ? <p className="admin-card__desc">{description}</p> : null}
          </div>
          {action}
        </div>
      ) : null}
      {children}
    </section>
  )
}

export type Tone = 'success' | 'warning' | 'neutral' | 'danger' | 'info'

const TONE_ICON: Record<Tone, (props: { size?: number }) => React.JSX.Element> = {
  success: CheckCircleIcon,
  warning: AlertIcon,
  neutral: MinusCircleIcon,
  danger: AlertIcon,
  info: CircleIcon
}

/** Status as a tinted pill: green works, amber waits, grey is switched off. */
export function Chip({
  tone,
  children,
  icon = true
}: {
  tone: Tone
  children: React.ReactNode
  icon?: boolean
}): React.JSX.Element {
  const Icon = TONE_ICON[tone]
  return (
    <span className={`admin-chip admin-chip--${tone}`}>
      {icon ? <Icon size={13} /> : null}
      {children}
    </span>
  )
}

export function Switch({
  on,
  label,
  busy,
  onToggle
}: {
  on: boolean
  label: string
  busy?: boolean
  onToggle: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      aria-busy={busy}
      disabled={busy}
      className={`switch${on ? ' switch--on' : ''}`}
      onClick={onToggle}
    >
      <span className="switch__knob" />
    </button>
  )
}

/**
 * A modal for create and edit forms. Escape and a click on the dim close it;
 * focus stays inside while it is open and goes back where it came from.
 */
export function Dialog({
  title,
  description,
  onClose,
  children,
  footer
}: {
  title: string
  description?: string
  onClose: () => void
  children: React.ReactNode
  footer?: React.ReactNode
}): React.JSX.Element {
  const box = useRef<HTMLDivElement>(null)
  useFocusTrap(box)
  useEffect(() => {
    box.current?.querySelector<HTMLElement>('input, select, textarea')?.focus()
  }, [])
  return (
    <div
      className="overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        ref={box}
        className="admin-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation()
            onClose()
          }
        }}
      >
        <div className="admin-dialog__head">
          <div>
            <h2 className="admin-dialog__title">{title}</h2>
            {description ? <p className="admin-dialog__desc">{description}</p> : null}
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label={t('admin.common.close')}
            onClick={onClose}
          >
            <CloseIcon size={14} />
          </button>
        </div>
        <div className="admin-dialog__body">{children}</div>
        {footer ? <div className="admin-dialog__footer">{footer}</div> : null}
      </div>
    </div>
  )
}

/** Puts a value on the clipboard and says so for a moment. */
export function CopyButton({ value, label }: { value: string; label?: string }): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const handle = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(handle)
  }, [copied])
  return (
    <button
      type="button"
      className="admin-copy"
      aria-label={label ?? t('admin.common.copy')}
      data-tip={copied ? t('admin.common.copied') : (label ?? t('admin.common.copy'))}
      onClick={() => {
        void api
          .invoke('clipboard:write', value)
          .then(() => setCopied(true))
          .catch(() => undefined)
      }}
    >
      <CopyIcon size={14} />
      {copied ? <span className="admin-copy__done">{t('admin.common.copied')}</span> : null}
    </button>
  )
}

/** The up/down pair that orders a list without a drag gesture. */
export function MoveButtons({
  name,
  first,
  last,
  disabled,
  onMove
}: {
  name: string
  first: boolean
  last: boolean
  disabled?: boolean
  onMove: (delta: -1 | 1) => void
}): React.JSX.Element {
  return (
    <span className="admin-move">
      <button
        type="button"
        className="icon-button admin-icon-button"
        aria-label={t('admin.common.moveUp', { name })}
        disabled={first || disabled}
        onClick={() => onMove(-1)}
      >
        <ArrowUpIcon size={15} />
      </button>
      <button
        type="button"
        className="icon-button admin-icon-button"
        aria-label={t('admin.common.moveDown', { name })}
        disabled={last || disabled}
        onClick={() => onMove(1)}
      >
        <ArrowDownIcon size={15} />
      </button>
    </span>
  )
}

/** Moves the entry at `index` by `delta`, returning a new array. */
export function moved<T>(list: T[], index: number, delta: -1 | 1): T[] {
  return movedTo(list, index, index + delta)
}

/** Moves the entry at `from` to position `to`, returning a new array. */
export function movedTo<T>(list: T[], from: number, to: number): T[] {
  if (from === to || to < 0 || to >= list.length) return list
  const next = [...list]
  const [entry] = next.splice(from, 1)
  next.splice(to, 0, entry!)
  return next
}

/**
 * Loads once on mount and again after every `reload`. A failed reload keeps
 * what was shown before and only adds the cause next to it.
 */
export function useLoaded<T>(load: () => Promise<T>): {
  data: T | null
  error: string | null
  reload: () => void
  setData: (data: T) => void
} {
  const [state, setState] = useState<{ data: T | null; error: string | null }>({
    data: null,
    error: null
  })
  const [version, setVersion] = useState(0)
  const latest = useRef(load)
  useEffect(() => {
    latest.current = load
  })
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const data = await latest.current()
        if (!cancelled) setState({ data, error: null })
      } catch (cause) {
        if (!cancelled) setState((current) => ({ data: current.data, error: errorMessage(cause) }))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [version])
  const reload = useCallback(() => setVersion((current) => current + 1), [])
  const setData = useCallback((data: T) => setState({ data, error: null }), [])
  return { data: state.data, error: state.error, reload, setData }
}
