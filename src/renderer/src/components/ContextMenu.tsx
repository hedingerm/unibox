import {
  createContext,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState
} from 'react'
import { CheckIcon, ChevronIcon } from './Icons'

export interface MenuPosition {
  x: number
  y: number
}

interface ContextMenuProps extends MenuPosition {
  label: string
  onClose: () => void
  children: React.ReactNode
}

/** Kept clear of the window edge so a menu opened at the very bottom stays whole. */
const EDGE_GAP = 8
/** Matches the panel's own padding, so a flyout's first row lines up with its trigger. */
const PANEL_PADDING = 5
/** A flyout tucks under the parent's padding instead of leaving a visible seam. */
const OVERLAP = 4

/**
 * One open flyout per level. A level closes its own flyout as soon as the
 * pointer reaches a sibling row, while rows *inside* a flyout belong to the
 * next level down and so leave their parent alone.
 */
interface MenuLevel {
  openId: string | null
  setOpenId: (id: string | null) => void
}

const LevelContext = createContext<MenuLevel>({ openId: null, setOpenId: () => {} })

/** The rows of one panel, ignoring anything that belongs to a flyout of it. */
function itemsOf(panel: HTMLElement): HTMLButtonElement[] {
  return [...panel.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')].filter(
    (item) => item.closest('.context-menu') === panel
  )
}

function moveFocus(panel: HTMLElement | null, step: number): void {
  if (!panel) return
  const items = itemsOf(panel)
  if (items.length === 0) return
  const index = items.indexOf(document.activeElement as HTMLButtonElement)
  items[(index + step + items.length) % items.length]?.focus()
}

/** Arrow keys walk the panel's own rows; the caller decides what Escape means. */
function useArrowKeys(
  panel: React.RefObject<HTMLDivElement | null>
): (event: React.KeyboardEvent) => boolean {
  return (event) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return false
    event.preventDefault()
    moveFocus(panel.current, event.key === 'ArrowDown' ? 1 : -1)
    return true
  }
}

/**
 * A menu that floats where the pointer opened it. It closes on the next click
 * anywhere else, on Escape, and whenever the surface under it moves — a menu
 * that keeps hanging over a scrolled list would point at the wrong row.
 */
export function ContextMenu({
  x,
  y,
  label,
  onClose,
  children
}: ContextMenuProps): React.JSX.Element {
  const menu = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<MenuPosition>({ x, y })
  const [openId, setOpenId] = useState<string | null>(null)

  // Flip once the real size is known, rather than guessing it up front.
  useLayoutEffect(() => {
    const element = menu.current
    if (!element) return
    const { width, height } = element.getBoundingClientRect()
    const maxX = window.innerWidth - width - EDGE_GAP
    const maxY = window.innerHeight - height - EDGE_GAP
    setPosition({
      x: Math.max(EDGE_GAP, Math.min(x, maxX)),
      y: Math.max(EDGE_GAP, Math.min(y, maxY))
    })
  }, [x, y, children])

  useEffect(() => {
    // A row that owns the caret — a `MenuInput` — has already taken it during
    // mount; moving focus to the first button here would empty the field the
    // menu was opened for.
    if (!menu.current?.contains(document.activeElement)) {
      menu.current?.querySelector<HTMLElement>('button:not(:disabled)')?.focus()
    }
    const onPointerDown = (event: MouseEvent): void => {
      if (!menu.current?.contains(event.target as Node)) onClose()
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        return
      }
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
      event.preventDefault()
      moveFocus(menu.current, event.key === 'ArrowDown' ? 1 : -1)
    }
    const onScroll = (event: Event): void => {
      // A long label list scrolls inside the menu; only the surface under it counts.
      if (menu.current?.contains(event.target as Node)) return
      onClose()
    }
    window.addEventListener('mousedown', onPointerDown)
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('resize', onClose)
    // Capture: the list scrolls in its own container, not on the window.
    window.addEventListener('scroll', onScroll, true)
    return () => {
      window.removeEventListener('mousedown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('resize', onClose)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [onClose])

  return (
    <div
      className="context-menu"
      role="menu"
      aria-label={label}
      ref={menu}
      style={{ left: position.x, top: position.y }}
      onContextMenu={(event) => event.preventDefault()}
    >
      <LevelContext.Provider value={{ openId, setOpenId }}>{children}</LevelContext.Provider>
    </div>
  )
}

interface MenuItemProps {
  label: string
  icon?: React.ReactNode
  onClick: () => void
  disabled?: boolean
  danger?: boolean
  checked?: boolean
}

export function MenuItem({
  label,
  icon,
  onClick,
  disabled,
  danger,
  checked
}: MenuItemProps): React.JSX.Element {
  const { setOpenId } = useContext(LevelContext)
  return (
    <button
      type="button"
      role={checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
      aria-checked={checked}
      className={danger ? 'context-menu__item context-menu__item--danger' : 'context-menu__item'}
      disabled={disabled}
      // Reaching a plain row means the pointer has left any sibling flyout.
      onMouseEnter={() => setOpenId(null)}
      onClick={onClick}
    >
      {icon ? (
        <span className="context-menu__icon">{icon}</span>
      ) : (
        <span className="context-menu__icon" />
      )}
      <span className="context-menu__label">{label}</span>
      {checked ? <CheckIcon color="var(--accent)" /> : null}
    </button>
  )
}

interface SubmenuProps {
  label: string
  icon?: React.ReactNode
  disabled?: boolean
  /** A branch that is itself applied, so the state shows without opening it. */
  checked?: boolean
  children: React.ReactNode
}

/**
 * A row whose children open beside it. Hovering is enough — the same row still
 * answers to click and to ArrowRight, so pointer and keyboard end up in the
 * same place.
 */
export function Submenu({
  label,
  icon,
  disabled,
  checked,
  children
}: SubmenuProps): React.JSX.Element {
  const id = useId()
  const { openId, setOpenId } = useContext(LevelContext)
  const trigger = useRef<HTMLButtonElement>(null)
  // Set only when the row was opened from the keyboard, so hovering never
  // yanks the focus ring away from where the user actually is.
  const [grabFocus, setGrabFocus] = useState(false)
  const open = openId === id

  const close = (refocus: boolean): void => {
    setOpenId(null)
    if (refocus) trigger.current?.focus()
  }

  return (
    <div className="context-menu__submenu">
      <button
        ref={trigger}
        type="button"
        role="menuitem"
        aria-haspopup="menu"
        aria-expanded={open}
        className="context-menu__item"
        disabled={disabled}
        onMouseEnter={() => {
          setGrabFocus(false)
          setOpenId(id)
        }}
        onClick={() => setOpenId(open ? null : id)}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowRight' && event.key !== 'Enter' && event.key !== ' ') return
          event.preventDefault()
          setGrabFocus(true)
          setOpenId(id)
        }}
      >
        {icon ? (
          <span className="context-menu__icon">{icon}</span>
        ) : (
          <span className="context-menu__icon" />
        )}
        <span className="context-menu__label">{label}</span>
        {checked ? <CheckIcon color="var(--accent)" /> : null}
        <ChevronIcon size={12} color="var(--text-faint)" open={false} />
      </button>
      {open ? (
        <Flyout anchor={trigger} label={label} autoFocus={grabFocus} onClose={close}>
          {children}
        </Flyout>
      ) : null}
    </div>
  )
}

interface FlyoutProps {
  anchor: React.RefObject<HTMLButtonElement | null>
  label: string
  /** Move focus onto the first row — only when the keyboard opened this. */
  autoFocus: boolean
  onClose: (refocus: boolean) => void
  children: React.ReactNode
}

/**
 * The panel beside a submenu row. It is fixed rather than absolute so the
 * parent's own scrollbar cannot clip it, and it flips to the left when the
 * window runs out on the right.
 */
function Flyout({ anchor, label, autoFocus, onClose, children }: FlyoutProps): React.JSX.Element {
  const panel = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<MenuPosition>(() => {
    const rect = anchor.current?.getBoundingClientRect()
    return { x: (rect?.right ?? 0) + OVERLAP, y: (rect?.top ?? 0) - PANEL_PADDING }
  })
  const onArrowKeys = useArrowKeys(panel)

  useLayoutEffect(() => {
    const element = panel.current
    const rect = anchor.current?.getBoundingClientRect()
    if (!element || !rect) return
    const { width, height } = element.getBoundingClientRect()
    const right = rect.right + OVERLAP
    const fits = right + width + EDGE_GAP <= window.innerWidth
    setPosition({
      x: Math.max(EDGE_GAP, fits ? right : rect.left - width - OVERLAP),
      y: Math.max(
        EDGE_GAP,
        Math.min(rect.top - PANEL_PADDING, window.innerHeight - height - EDGE_GAP)
      )
    })
  }, [anchor, children])

  const [openId, setOpenId] = useState<string | null>(null)

  useEffect(() => {
    if (autoFocus) panel.current?.querySelector<HTMLElement>('button:not(:disabled)')?.focus()
  }, [autoFocus])

  return (
    <div
      className="context-menu context-menu--flyout"
      role="menu"
      aria-label={label}
      ref={panel}
      style={{ left: position.x, top: position.y }}
      onKeyDown={(event) => {
        if (onArrowKeys(event)) {
          event.stopPropagation()
          return
        }
        if (event.key !== 'Escape' && event.key !== 'ArrowLeft') return
        event.preventDefault()
        event.stopPropagation()
        onClose(true)
      }}
      onContextMenu={(event) => event.preventDefault()}
    >
      <LevelContext.Provider value={{ openId, setOpenId }}>{children}</LevelContext.Provider>
    </div>
  )
}

export function MenuDivider(): React.JSX.Element {
  return <div className="context-menu__divider" role="separator" />
}

interface MenuInputProps {
  label: string
  placeholder?: string
  /** Runs with the typed text; an empty field submits nothing. */
  onSubmit: (value: string) => void
}

/**
 * A row that asks for a line of text instead of firing on click. Enter submits,
 * Escape hands the key back to the menu so it closes as usual — the keys that
 * walk the rows have to stop here, or typing a name with an arrow key in it
 * would move the focus out of the field mid-word.
 */
export function MenuInput({ label, placeholder, onSubmit }: MenuInputProps): React.JSX.Element {
  const [value, setValue] = useState('')
  const { setOpenId } = useContext(LevelContext)

  return (
    <div className="context-menu__input-row" onMouseEnter={() => setOpenId(null)}>
      <label className="context-menu__input-label">{label}</label>
      <input
        className="context-menu__input"
        type="text"
        value={value}
        placeholder={placeholder}
        // The menu focuses its first button on open; this row is the point of
        // the menu it appears in, so it takes the caret instead.
        autoFocus
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') return
          event.stopPropagation()
          if (event.key !== 'Enter') return
          event.preventDefault()
          const text = value.trim()
          if (text) onSubmit(text)
        }}
      />
    </div>
  )
}
