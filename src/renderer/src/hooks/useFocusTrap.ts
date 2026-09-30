import { useEffect, type RefObject } from 'react'

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])'
].join(',')

/**
 * Keeps Tab inside an open window. `aria-modal` only says the rest of the app
 * is out of reach; without this the next Tab out of the last button walked into
 * the message list behind the composer and typing carried on there.
 *
 * Focus goes back to whatever held it before the window opened, so closing a
 * draft returns the user to the thread they started from.
 */
export function useFocusTrap(container: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const node = container.current
    if (!node) return
    const before = document.activeElement as HTMLElement | null

    const onKeyDown = (event: KeyboardEvent): void => {
      // The editor uses Tab itself — moving between table cells, for one — and
      // says so by taking the event; the trap only sees what is left over.
      if (event.key !== 'Tab' || event.defaultPrevented) return
      // `hidden` is what the composer uses to park the editor while the
      // assistant's proposal stands in for it; a browser skips such an element
      // anyway, and the wrap-around must not land on it either.
      const targets = Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (element) => element.tabIndex !== -1 && !element.closest('[hidden]')
      )
      const first = targets.at(0)
      const last = targets.at(-1)
      if (!first || !last) return
      const active = document.activeElement
      if (event.shiftKey ? active !== first : active !== last) return
      event.preventDefault()
      ;(event.shiftKey ? last : first).focus()
    }

    node.addEventListener('keydown', onKeyDown)
    return () => {
      node.removeEventListener('keydown', onKeyDown)
      before?.focus?.()
    }
  }, [container])
}
