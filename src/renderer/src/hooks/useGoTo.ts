import { useMemo } from 'react'
import { SYSTEM_LABELS } from '@shared/types'
import { useUnibox } from '../state'

export type GoToId =
  | 'goInbox'
  | 'goStarred'
  | 'goSent'
  | 'goDrafts'
  | 'goSnoozed'
  | 'goArchive'
  | 'goSpam'
  | 'goTrash'
  | 'goAdmin'

/**
 * Archived mail has no mailbox of its own yet; until it does, the search
 * operator already gives the same list across every account.
 */
const ARCHIVE_QUERY = '-in:inbox'

/**
 * The `g …` destinations. Sent, drafts, spam and trash exist per account, so
 * they open in the account being looked at — or the first one in the sidebar
 * when the merged inbox is showing.
 */
export function useGoTo(): Record<GoToId, () => void> {
  const { accounts, labels, selection, select, setSearchText, openAdmin } = useUnibox()

  return useMemo(() => {
    // Same order as the sidebar: Google accounts first, then Resend domains.
    const ordered = [
      ...accounts.filter((account) => account.kind === 'google'),
      ...accounts.filter((account) => account.kind !== 'google')
    ]
    const accountId = selection.accountId ?? ordered[0]?.id ?? null
    const systemLabel = (remoteId: string) => (): void => {
      if (!accountId) return
      const label = (labels[accountId] ?? []).find((entry) => entry.remoteId === remoteId)
      if (label) select({ accountId, labelId: label.id })
    }
    const searchAll = (query: string) => (): void => {
      select({ accountId: null, labelId: null })
      setSearchText(query)
    }
    return {
      goInbox: () => select({ accountId: null, labelId: null }),
      goStarred: () => select({ accountId: null, labelId: null, view: 'starred' }),
      goSent: systemLabel(SYSTEM_LABELS.sent),
      goDrafts: systemLabel(SYSTEM_LABELS.drafts),
      goSnoozed: () => select({ accountId: null, labelId: null, view: 'snoozed' }),
      goArchive: searchAll(ARCHIVE_QUERY),
      goSpam: systemLabel(SYSTEM_LABELS.spam),
      goTrash: systemLabel(SYSTEM_LABELS.trash),
      // The Verwaltung opens on its overview, like the gear in the top bar.
      goAdmin: () => openAdmin('overview')
    }
  }, [accounts, labels, selection.accountId, select, setSearchText, openAdmin])
}
