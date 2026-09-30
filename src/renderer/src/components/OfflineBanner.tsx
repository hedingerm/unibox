import { t } from '../i18n'
import { useUnibox } from '../state'

/**
 * Offline is a normal state for a mail client, not a failure — the app keeps
 * working from the local store. What the user needs to know is that nothing is
 * reaching the servers right now, and how much is waiting.
 */
export function OfflineBanner(): React.JSX.Element | null {
  const { online, pending } = useUnibox()
  if (online) return null

  const waiting = pending.mutations + pending.outbox
  return (
    <div className="banner banner--offline" role="status">
      <span>{t('offline.banner')}</span>
      <span>
        {waiting === 0
          ? t('offline.nothingPending')
          : waiting === 1
            ? t('offline.pendingOne')
            : t('offline.pending', { count: waiting })}
      </span>
    </div>
  )
}
