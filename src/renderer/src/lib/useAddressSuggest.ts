import { useEffect, useState } from 'react'
import type { AddressSuggestArgs } from '@shared/ipc'
import type { EmailAddress } from '@shared/types'
import { api } from './bridge'

/** How long the typing has to pause before the main process is asked. */
const DEBOUNCE_MS = 120

/**
 * Addresses to offer for what is typed so far, or an empty list when there is
 * nothing to complete (`field` is null).
 *
 * The result is kept keyed by the field and prefix it was fetched for, so a
 * list that arrives late is simply not used rather than having to be cleared
 * on every keystroke.
 */
export function useAddressSuggest(
  field: AddressSuggestArgs['field'] | null,
  prefix: string
): EmailAddress[] {
  const key = field === null ? null : `${field}:${prefix}`
  const [fetched, setFetched] = useState<{ key: string; items: EmailAddress[] }>({
    key: '',
    items: []
  })

  useEffect(() => {
    if (key === null) return
    const split = key.indexOf(':')
    const kind = key.slice(0, split) as AddressSuggestArgs['field']
    const typed = key.slice(split + 1)
    let cancelled = false
    const handle = setTimeout(() => {
      void api
        .invoke('search:addresses', { field: kind, prefix: typed })
        .then((found) => {
          if (!cancelled) setFetched({ key, items: found })
        })
        .catch(() => {
          if (!cancelled) setFetched({ key, items: [] })
        })
    }, DEBOUNCE_MS)
    return () => {
      cancelled = true
      clearTimeout(handle)
    }
  }, [key])

  return key !== null && fetched.key === key ? fetched.items : []
}
