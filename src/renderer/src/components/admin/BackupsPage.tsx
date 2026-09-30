import { t } from '../../i18n'
import { api } from '../../lib/bridge'
import { formatBytes, formatFullDate } from '../../lib/format'
import { useAction } from '../../lib/useAction'
import { useUnibox } from '../../state'
import { InlineError } from '../InlineError'
import { DatabaseBackup } from './AppPages'
import { DatabaseIcon } from './icons'
import { Card, Chip, PageHeader, Switch, useLoaded } from './ui'

export function BackupsPage(): React.JSX.Element {
  const { settings, saveSettings } = useUnibox()
  const backups = useLoaded(() => api.invoke('backups:list'))
  const create = useAction(async () => {
    await api.invoke('backups:create')
    backups.reload()
  })
  const open = useAction(async () => {
    await api.invoke('backups:openFolder')
  })
  const list = backups.data ?? []

  return (
    <>
      <PageHeader
        title={t('admin.nav.backups')}
        description={t('admin.backups.description')}
        action={
          <button
            type="button"
            className="button-primary admin-add"
            aria-busy={create.busy}
            disabled={create.busy}
            onClick={() => void create.run()}
          >
            <DatabaseIcon size={16} />
            {create.busy ? t('admin.backups.creating') : t('admin.backups.create')}
          </button>
        }
      />
      <InlineError message={create.error ?? open.error ?? backups.error} />
      <Card>
        <div className="admin-toggle-row">
          <span>
            <strong>{t('admin.backups.auto')}</strong>
            <span className="admin-muted">{t('admin.backups.autoHint')}</span>
          </span>
          <Switch
            on={settings.autoBackup ?? false}
            label={t('admin.backups.auto')}
            onToggle={() => void saveSettings({ autoBackup: !(settings.autoBackup ?? false) })}
          />
        </div>
      </Card>
      <Card
        title={t('admin.backups.listTitle')}
        action={
          <button type="button" className="button-secondary" onClick={() => void open.run()}>
            {t('admin.backups.openFolder')}
          </button>
        }
      >
        {backups.data && list.length === 0 ? (
          <p className="admin-empty">{t('admin.backups.empty')}</p>
        ) : (
          <ul className="admin-list">
            {list.map((file) => (
              <li key={file.path} className="admin-row">
                <span className="admin-row__icon">
                  <DatabaseIcon size={18} />
                </span>
                <span className="admin-row__main">
                  <span className="admin-row__title admin-mono">{file.name}</span>
                  <span className="admin-row__sub">
                    {formatFullDate(file.createdAt)} · {formatBytes(file.size)}
                  </span>
                </span>
                <Chip tone={file.auto ? 'info' : 'neutral'} icon={false}>
                  {file.auto ? t('admin.backups.autoChip') : t('admin.backups.manualChip')}
                </Chip>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card>
        <DatabaseBackup />
      </Card>
    </>
  )
}
