import { useEffect, useRef, useState } from 'react'
import {
  SEQUENCE_TIMEOUT_MS,
  eventBinding,
  isAlwaysOn,
  isSequencePrefix,
  shortcutFor,
  type ShortcutId
} from '../lib/shortcuts'

/**
 * One callback per registry entry. Every action shortcut works on the whole
 * selection, not just the focused row.
 */
export type ShortcutHandlers = Record<ShortcutId, () => void>

export interface ShortcutOptions {
  /** False while something modal (composer, settings, a dialog) owns the keys. */
  active: boolean
  /**
   * The "Tastenkürzel aktiv" setting. Off leaves only what can't be hit by
   * accident: ⌘/Ctrl chords and Esc.
   */
  enabled: boolean
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  // A clicked checkbox keeps the focus but takes no text; j/k must still work.
  if (target instanceof HTMLInputElement) return !['checkbox', 'radio'].includes(target.type)
  return ['TEXTAREA', 'SELECT'].includes(target.tagName)
}

/**
 * The global key handler. Bindings come from the registry in lib/shortcuts;
 * a sequence prefix (`g`) waits up to a second for its second key. Returns the
 * pending prefix so the app can show that it is waiting.
 */
export function useShortcuts(handlers: ShortcutHandlers, options: ShortcutOptions): string | null {
  const { active, enabled } = options
  const [pending, setPending] = useState<string | null>(null)
  const pendingRef = useRef<string | null>(null)
  // The listener reads handlers through a ref, so a new selection does not
  // re-subscribe it — and a started sequence survives the re-render.
  const handlersRef = useRef(handlers)
  useEffect(() => {
    handlersRef.current = handlers
  }, [handlers])

  useEffect(() => {
    if (!active) return
    let timer: ReturnType<typeof setTimeout> | null = null
    const setSequence = (prefix: string | null): void => {
      if (timer) clearTimeout(timer)
      timer = prefix ? setTimeout(() => setSequence(null), SEQUENCE_TIMEOUT_MS) : null
      pendingRef.current = prefix
      setPending(prefix)
    }

    const onKeyDown = (event: KeyboardEvent): void => {
      const binding = eventBinding(event)
      if (!binding) return
      const always = isAlwaysOn(binding)
      if (!always && (!enabled || isTypingTarget(event.target))) return

      const prefix = pendingRef.current
      if (prefix) {
        setSequence(null)
        const id = shortcutFor(`${prefix} ${binding}`)
        // Any other key ends the sequence and is swallowed with it: `g` then a
        // stray `e` must not archive the open conversation.
        if (!id && !always) {
          event.preventDefault()
          return
        }
        if (id) {
          event.preventDefault()
          handlersRef.current[id]()
          return
        }
      }
      if (!always && isSequencePrefix(binding)) {
        event.preventDefault()
        setSequence(binding)
        return
      }

      const id = shortcutFor(binding)
      if (!id) return
      if (id === 'escape') {
        // A menu or dialog open on top closes itself on Esc; the selection
        // underneath stays.
        if (event.defaultPrevented) return
        if (document.querySelector('[aria-modal="true"], [role="menu"]')) return
      }
      // ⏎ on a focused button still clicks it.
      if (id !== 'open') event.preventDefault()
      handlersRef.current[id]()
    }

    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      setSequence(null)
    }
  }, [active, enabled])

  return pending
}
