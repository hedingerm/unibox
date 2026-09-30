import { useEffect, useState } from 'react'
import type { ActivityEntry, ActivityKind } from '@shared/admin'
import { t } from '../../i18n'
import { api } from '../../lib/bridge'
import { formatFullDate } from '../../lib/format'
import { useAction } from '../../lib/useAction'
import { InlineError } from '../InlineError'
import type { Tone } from './ui'
import { Card, PageHeader } from './ui'

const PAGE = 50

const KINDS: ActivityKind[] = [
  'mail_sent',
  'rule_action',
  'domain_created',
  'receiving_enabled',
  'receiving_disabled',
  'account_connected',
  'account_removed',
  'reconnect_required',
  'backup_created',
  'sync_error'
]

function kindTone(kind: ActivityKind): Tone {
  if (kind === 'sync_error' || kind === 'reconnect_required') return 'danger'
  if (kind === 'receiving_disabled' || kind === 'account_removed') return 'neutral'
  if (kind === 'rule_action') return 'info'
  return 'success'
}

export function ActivityPage(): React.JSX.Element {
  const [kind, setKind] = useState<ActivityKind | null>(null)
  const [entries, setEntries] = useState<ActivityEntry[]>([])
  const [next, setNext] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const page = await api.invoke('activity:list', { kind, limit: PAGE })
        if (cancelled) return
        setEntries(page.entries)
        setNext(page.nextBeforeId)
        setError(null)
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [kind])

  const more = useAction(async () => {
    const page = await api.invoke('activity:list', { kind, limit: PAGE, beforeId: next })
    setEntries((current) => [...current, ...page.entries])
    setNext(page.nextBeforeId)
  })

  return (
    <>
      <PageHeader
        title={t('admin.nav.activity')}
        description={t('admin.activity.description')}
        action={
          <select
            aria-label={t('admin.activity.filter')}
            value={kind ?? ''}
            onChange={(event) => setKind((event.target.value || null) as ActivityKind | null)}
          >
            <option value="">{t('admin.activity.all')}</option>
            {KINDS.map((entry) => (
              <option key={entry} value={entry}>
                {t(`admin.activity.kinds.${entry}`)}
              </option>
            ))}
          </select>
        }
      />
      <InlineError message={error ?? more.error} />
      <Card>
        {entries.length === 0 ? (
          <p className="admin-empty">{t('admin.activity.empty')}</p>
        ) : (
          <ol className="admin-timeline">
            {entries.map((entry) => (
              <li key={entry.id} className="admin-timeline__entry">
                <span className={`admin-timeline__dot admin-timeline__dot--${kindTone(entry.kind)}`} />
                <span className="admin-timeline__body">
                  <span className="admin-timeline__summary">
                    {entry.summary}
                    {entry.count > 1 ? (
                      <span className="badge badge--neutral">
                        {t('admin.activity.repeated', { count: entry.count })}
                      </span>
                    ) : null}
                  </span>
                  <span className="admin-muted">
                    {t(`admin.activity.kinds.${entry.kind}`)} · {formatFullDate(entry.ts)}
                  </span>
                </span>
              </li>
            ))}
          </ol>
        )}
        {next !== null ? (
          <button
            type="button"
            className="button-secondary admin-more"
            aria-busy={more.busy}
            disabled={more.busy}
            onClick={() => void more.run()}
          >
            {t('admin.activity.older')}
          </button>
        ) : null}
      </Card>
    </>
  )
}
