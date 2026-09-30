import { useSyncExternalStore } from 'react'

let current = Date.now()
const listeners = new Set<() => void>()
let timer: ReturnType<typeof setInterval> | null = null

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  if (!timer) {
    timer = setInterval(() => {
      current = Date.now()
      for (const notify of listeners) notify()
    }, 500)
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && timer) {
      clearInterval(timer)
      timer = null
    }
  }
}

/**
 * A ticking clock as an external store: render reads a cached value, so
 * countdowns stay pure and re-render predictably.
 */
export function useNow(): number {
  return useSyncExternalStore(subscribe, () => current, () => current)
}
