import type { AdminOverview } from '@shared/admin'
import { t } from '../../i18n'
import { api } from '../../lib/bridge'
import type { AdminPage } from '../../lib/admin-pages'
import { formatBytes, formatFullDate } from '../../lib/format'
import { useUnibox } from '../../state'
import { InlineError } from '../InlineError'
import type { Tone } from './ui'
import { Card, Chip, PageHeader, useLoaded } from './ui'

interface Tile {
  key: string
  label: string
  value: string
  detail: string
  page: AdminPage
  tone?: Tone
}

function tiles(overview: AdminOverview): Tile[] {
  const { accounts, domains, last7Days } = overview
  return [
    {
      key: 'accounts',
      label: t('admin.overview.accounts'),
      value: String(accounts.total),
      detail: t('admin.overview.accountsDetail', {
        google: accounts.byKind.google ?? 0,
        resend: accounts.byKind.resend ?? 0
      }),
      page: 'accounts'
    },
    {
      key: 'domains',
      label: t('admin.overview.domains'),
      value: `${domains.verified}/${domains.total}`,
      detail: t('admin.overview.domainsDetail', { receiving: domains.receiving }),
      page: 'domains',
      tone: domains.verified < domains.total ? 'warning' : undefined
    },
    {
      key: 'mailboxes',
      label: t('admin.overview.mailboxes'),
      value: String(overview.mailboxes),
      detail: t('admin.overview.mailboxesDetail'),
      page: 'mailboxes'
    },
    {
      key: 'rules',
      label: t('admin.overview.rules'),
      value: String(overview.activeRules),
      detail: t('admin.overview.rulesDetail'),
      page: 'routing'
    },
    {
      key: 'received',
      label: t('admin.overview.received'),
      value: String(last7Days.received),
      detail: t('admin.overview.last7Days'),
      page: 'activity'
    },
    {
      key: 'sent',
      label: t('admin.overview.sent'),
      value: String(last7Days.sent),
      detail: t('admin.overview.last7Days'),
      page: 'delivery'
    },
    {
      key: 'bounced',
      label: t('admin.overview.bounced'),
      value: String(last7Days.bounced),
      detail: t('admin.overview.last7Days'),
      page: 'delivery',
      tone: last7Days.bounced > 0 ? 'danger' : undefined
    },
    {
      key: 'backup',
      label: t('admin.overview.lastBackup'),
      value: overview.lastBackupAt ? formatFullDate(overview.lastBackupAt) : t('admin.overview.never'),
      detail: t('admin.overview.dbSize', { size: formatBytes(overview.dbSizeBytes) }),
      page: 'backups',
      tone: overview.lastBackupAt ? undefined : 'warning'
    }
  ]
}

export function OverviewPage(): React.JSX.Element {
  const { openAdmin } = useUnibox()
  const overview = useLoaded(() => api.invoke('admin:overview'))
  const data = overview.data

  return (
    <>
      <PageHeader title={t('admin.nav.overview')} description={t('admin.overview.description')} />
      <InlineError message={overview.error} />
      {data ? (
        <>
          <div className="admin-grid">
            {tiles(data).map((tile) => (
              <button
                key={tile.key}
                type="button"
                className={`admin-tile${tile.tone ? ` admin-tile--${tile.tone}` : ''}`}
                onClick={() => openAdmin(tile.page)}
              >
                <span className="admin-tile__label">{tile.label}</span>
                <span className="admin-tile__value">{tile.value}</span>
                <span className="admin-tile__detail">{tile.detail}</span>
              </button>
            ))}
          </div>
          <Card
            title={t('admin.overview.syncTitle')}
            action={
              data.recentErrors > 0 ? (
                <Chip tone="danger">
                  {t('admin.overview.recentErrors', { count: data.recentErrors })}
                </Chip>
              ) : (
                <Chip tone="success">{t('admin.overview.noErrors')}</Chip>
              )
            }
          >
            {data.sync.length === 0 ? (
              <p className="admin-empty">{t('admin.accounts.empty')}</p>
            ) : (
              <ul className="admin-list">
                {data.sync.map((entry) => (
                  <li key={entry.accountId} className="admin-row">
                    <span className="admin-row__main">
                      <span className="admin-row__title">{entry.email}</span>
                      <span className="admin-row__sub">
                        {t('settings.accounts.lastSync', {
                          time: entry.lastSyncedAt
                            ? formatFullDate(entry.lastSyncedAt)
                            : t('settings.accounts.never')
                        })}
                      </span>
                      {entry.lastError && entry.status !== 'ok' ? (
                        <span className="error-text">{entry.lastError}</span>
                      ) : null}
                    </span>
                    <Chip
                      tone={
                        entry.status === 'ok'
                          ? 'success'
                          : entry.status === 'reconnect_required'
                            ? 'warning'
                            : 'danger'
                      }
                    >
                      {t(`admin.overview.status.${entry.status}`)}
                    </Chip>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </>
      ) : null}
    </>
  )
}
