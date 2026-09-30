import type { QueuedMutationView } from '@shared/ipc'
import type { OutboxItem } from '@shared/types'
import { t } from '../i18n'
import { api } from '../lib/bridge'
import { formatFullDate, formatRecipients } from '../lib/format'
import { useAction } from '../lib/useAction'
import { useUnibox } from '../state'
import { InlineError } from './InlineError'
import { Card, PageHeader } from './admin/ui'

function pendingLabel(count: number): string {
  return count === 1 ? t('queue.pendingOne') : t('queue.pending', { count })
}

function FailedMail({ item }: { item: OutboxItem }): React.JSX.Element {
  const { reloadOutbox } = useUnibox()
  const retry = useAction(async () => {
    await api.invoke('outbox:retry', item.id)
    await reloadOutbox()
  })
  const discard = useAction(async () => {
    await api.invoke('outbox:discard', item.id)
    await reloadOutbox()
  })

  return (
    <div className="settings__row-group">
      <div className="settings__row">
        <span className="settings__row-label">
          {item.subject || t('queue.noSubject')}
          <br />
          <span className="settings__row-sub">
            {t('reading.to', { recipients: formatRecipients(item.to) })} ·{' '}
            {formatFullDate(item.createdAt)}
          </span>
        </span>
        <button
          type="button"
          className="button-secondary"
          aria-busy={retry.busy}
          disabled={retry.busy}
          onClick={() => void retry.run()}
        >
          {t('queue.retry')}
        </button>
        <button
          type="button"
          className="button-secondary"
          aria-busy={discard.busy}
          disabled={discard.busy}
          onClick={() => void discard.run()}
        >
          {t('queue.discard')}
        </button>
      </div>
      {item.lastError ? <span className="error-text">{item.lastError}</span> : null}
      <InlineError message={retry.error ?? discard.error} />
    </div>
  )
}

function FailedMutation({ mutation }: { mutation: QueuedMutationView }): React.JSX.Element {
  const { reloadQueue, refresh } = useUnibox()
  const retry = useAction(async () => {
    await api.invoke('queue:retry', mutation.id)
    await reloadQueue()
    await refresh()
  })
  const discard = useAction(async () => {
    await api.invoke('queue:discard', mutation.id)
    await reloadQueue()
  })

  return (
    <div className="settings__row-group">
      <div className="settings__row">
        <span className="settings__row-label">
          {t(`queue.ops.${mutation.op}`)}
          <br />
          <span className="settings__row-sub">
            {mutation.subject ?? t('queue.noSubject')} · {mutation.accountEmail} ·{' '}
            {t('queue.attempts', { count: mutation.attempts })}
          </span>
        </span>
        <button
          type="button"
          className="button-secondary"
          aria-busy={retry.busy}
          disabled={retry.busy}
          onClick={() => void retry.run()}
        >
          {t('queue.retry')}
        </button>
        <button
          type="button"
          className="button-secondary"
          aria-busy={discard.busy}
          disabled={discard.busy}
          onClick={() => void discard.run()}
        >
          {t('queue.discard')}
        </button>
      </div>
      {mutation.lastError ? <span className="error-text">{mutation.lastError}</span> : null}
      <InlineError message={retry.error ?? discard.error} />
    </div>
  )
}

/**
 * Everything the app still owes the servers. Without this view a mail that ran
 * out of attempts, or a write-back Gmail refused, would simply stop existing.
 */
export function QueueTab(): React.JSX.Element {
  const { outbox, queue, pending } = useUnibox()
  const failedMails = outbox.filter((item) => item.state === 'failed')
  const failedMutations = queue.filter((mutation) => mutation.state === 'failed')
  const waiting = pending.mutations + pending.outbox

  return (
    <>
      <PageHeader title={t('admin.nav.queue')} description={pendingLabel(waiting)} />
      <Card title={t('queue.failedMails')}>
        {failedMails.length === 0 ? (
          <span className="settings__row-sub">{t('queue.noFailedMails')}</span>
        ) : (
          failedMails.map((item) => <FailedMail key={item.id} item={item} />)
        )}
      </Card>
      <Card title={t('queue.failedMutations')}>
        {failedMutations.length === 0 ? (
          <span className="settings__row-sub">{t('queue.noFailedMutations')}</span>
        ) : (
          failedMutations.map((mutation) => (
            <FailedMutation key={mutation.id} mutation={mutation} />
          ))
        )}
      </Card>
    </>
  )
}
