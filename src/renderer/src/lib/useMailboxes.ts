import { useEffect, useState } from 'react'
import type { Mailbox } from '@shared/admin'
import { useUnibox } from '../state'
import { api } from './bridge'

/**
 * The local mailboxes for the sidebar. Re-read whenever the unread counts are:
 * both change on the same refresh — after a sync, or after the Verwaltung
 * added, renamed or reordered one.
 */
export function useMailboxes(): Mailbox[] {
  const { counts } = useUnibox()
  const [mailboxes, setMailboxes] = useState<Mailbox[]>([])
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const list = await Promise.resolve()
        .then(() => api.invoke('mailboxes:list'))
        .catch(() => null)
      if (!cancelled && list) setMailboxes(list)
    })()
    return () => {
      cancelled = true
    }
  }, [counts])
  return mailboxes
}
