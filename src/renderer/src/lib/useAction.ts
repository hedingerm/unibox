import { useCallback, useEffect, useRef, useState } from 'react'
import { errorMessage } from './errors'

export interface Action<A extends unknown[]> {
  /** Runs the action; never rejects — the cause lands in `error` instead. */
  run: (...args: A) => Promise<void>
  /** True while the action is in flight, for a spinner on the triggering control. */
  busy: boolean
  /** What went wrong, verbatim, to be shown next to that control. */
  error: string | null
  clear: () => void
}

/**
 * The one way an action reports "läuft" and "ist fehlgeschlagen". Keeping both
 * next to the control that triggered the action is what makes a failure
 * impossible to miss — a toast at the window edge was not.
 */
export function useAction<A extends unknown[]>(
  action: (...args: A) => Promise<unknown>
): Action<A> {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // The callback is usually re-created every render; a ref keeps `run` stable
  // so it can be used as a dependency without re-subscribing everything. The
  // ref is only ever read from an event handler, after effects have flushed.
  const latest = useRef(action)
  useEffect(() => {
    latest.current = action
  })

  const run = useCallback(async (...args: A): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await latest.current(...args)
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }, [])

  const clear = useCallback(() => setError(null), [])

  return { run, busy, error, clear }
}
