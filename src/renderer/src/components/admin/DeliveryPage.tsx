import { useState } from 'react'
import type { Delivery, ResendWebhook, ResendWebhookCreated } from '@shared/admin'
import { RESEND_WEBHOOK_EVENTS } from '@shared/admin'
import { t } from '../../i18n'
import { api } from '../../lib/bridge'
import { formatFullDate } from '../../lib/format'
import { useAction } from '../../lib/useAction'
import { InlineError } from '../InlineError'
import { DeleteIcon } from './icons'
import type { Tone } from './ui'
import { AddButton, Card, Chip, CopyButton, Dialog, PageHeader, useLoaded } from './ui'

const PAGE = 50

/** The statuses worth a chip of their own, in the order they are shown. */
const SUMMARY_ORDER = [
  'delivered',
  'sent',
  'delivery_delayed',
  'bounced',
  'complained',
  'failed',
  'opened',
  'clicked',
  'scheduled',
  'queued',
  'canceled',
  'unknown'
]

export function deliveryTone(event: string | null): Tone {
  switch (event) {
    case 'delivered':
    case 'opened':
    case 'clicked':
      return 'success'
    case 'bounced':
    case 'complained':
    case 'failed':
      return 'danger'
    case 'delivery_delayed':
    case 'scheduled':
    case 'queued':
    case 'sent':
      return 'warning'
    default:
      return 'neutral'
  }
}

function eventName(event: string | null): string {
  const key = event ?? 'unknown'
  const translated = t(`admin.delivery.events.${key}`)
  return translated.startsWith('admin.') ? key : translated
}

function DeliveryTable({ rows }: { rows: Delivery[] }): React.JSX.Element {
  return (
    <div className="admin-table-wrap">
      <table className="admin-table">
        <thead>
          <tr>
            <th>{t('admin.delivery.columns.subject')}</th>
            <th>{t('admin.delivery.columns.to')}</th>
            <th>{t('admin.delivery.columns.sent')}</th>
            <th>{t('admin.delivery.columns.status')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.remoteId}>
              <td>
                <span className="admin-table__strong">{row.subject || t('queue.noSubject')}</span>
                <span className="admin-muted">{row.from}</span>
              </td>
              <td>{row.to.join(', ')}</td>
              <td className="admin-table__nowrap">{formatFullDate(row.sentAt)}</td>
              <td>
                <Chip tone={deliveryTone(row.lastEvent)}>{eventName(row.lastEvent)}</Chip>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function WebhookDialog({
  onClose,
  onCreated
}: {
  onClose: () => void
  onCreated: () => void
}): React.JSX.Element {
  const [endpoint, setEndpoint] = useState('')
  const [events, setEvents] = useState<string[]>(['email.delivered', 'email.bounced'])
  const [created, setCreated] = useState<ResendWebhookCreated | null>(null)
  const create = useAction(async () => {
    setCreated(await api.invoke('webhooks:create', { endpoint: endpoint.trim(), events }))
    onCreated()
  })

  if (created) {
    return (
      <Dialog
        title={t('admin.webhooks.createdTitle')}
        description={t('admin.webhooks.createdDescription')}
        onClose={onClose}
        footer={
          <button type="button" className="button-primary" onClick={onClose}>
            {t('admin.common.done')}
          </button>
        }
      >
        <span className="admin-muted">{created.endpoint}</span>
        <div className="field">
          <label>{t('admin.webhooks.secret')}</label>
          <span className="admin-secret">
            <code>{created.signingSecret ?? t('admin.webhooks.noSecret')}</code>
            {created.signingSecret ? (
              <CopyButton value={created.signingSecret} label={t('admin.webhooks.copySecret')} />
            ) : null}
          </span>
        </div>
      </Dialog>
    )
  }

  return (
    <Dialog
      title={t('admin.webhooks.createTitle')}
      description={t('admin.webhooks.createDescription')}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="button-secondary" onClick={onClose}>
            {t('admin.common.cancel')}
          </button>
          <button
            type="button"
            className="button-primary"
            aria-busy={create.busy}
            disabled={create.busy || !endpoint.trim() || events.length === 0}
            onClick={() => void create.run()}
          >
            {t('admin.webhooks.create')}
          </button>
        </>
      }
    >
      <div className="field">
        <label htmlFor="webhook-endpoint">{t('admin.webhooks.endpoint')}</label>
        <input
          id="webhook-endpoint"
          type="url"
          value={endpoint}
          placeholder={t('admin.webhooks.endpointPlaceholder')}
          onChange={(event) => setEndpoint(event.target.value)}
        />
      </div>
      <fieldset className="admin-events">
        <legend>{t('admin.webhooks.events')}</legend>
        {RESEND_WEBHOOK_EVENTS.map((name) => (
          <label key={name} className="admin-check">
            <input
              type="checkbox"
              className="checkbox"
              checked={events.includes(name)}
              onChange={(event) =>
                setEvents((current) =>
                  event.target.checked
                    ? [...current, name]
                    : current.filter((entry) => entry !== name)
                )
              }
            />
            <span className="admin-mono">{name}</span>
          </label>
        ))}
      </fieldset>
      <InlineError message={create.error} />
    </Dialog>
  )
}

function WebhookRow({
  hook,
  onRemoved
}: {
  hook: ResendWebhook
  onRemoved: () => void
}): React.JSX.Element {
  const remove = useAction(async () => {
    if (!window.confirm(t('admin.webhooks.confirmRemove', { endpoint: hook.endpoint }))) return
    await api.invoke('webhooks:remove', hook.id)
    onRemoved()
  })
  return (
    <li className="admin-row">
      <span className="admin-row__main">
        <span className="admin-row__title admin-mono">{hook.endpoint}</span>
        <span className="admin-chips">
          {hook.events.map((name) => (
            <Chip key={name} tone="info" icon={false}>
              {name}
            </Chip>
          ))}
        </span>
        <InlineError message={remove.error} />
      </span>
      {hook.status ? (
        <Chip tone={hook.status === 'enabled' ? 'success' : 'neutral'}>
          {hook.status === 'enabled' ? t('admin.webhooks.enabled') : hook.status}
        </Chip>
      ) : null}
      <button
        type="button"
        className="icon-button admin-icon-button admin-icon-button--danger"
        aria-label={t('admin.common.deleteName', { name: hook.endpoint })}
        disabled={remove.busy}
        onClick={() => void remove.run()}
      >
        <DeleteIcon size={15} />
      </button>
    </li>
  )
}

export function DeliveryPage(): React.JSX.Element {
  const [status, setStatus] = useState<string | null>(null)
  const [domain, setDomain] = useState<string | null>(null)
  const [limit, setLimit] = useState(PAGE)
  const summary = useLoaded(() => api.invoke('delivery:summary', { sinceDays: null }))
  const rows = useLoaded(() =>
    api.invoke('delivery:list', { status: status === 'unknown' ? null : status, domain, limit })
  )
  const hooks = useLoaded(() => api.invoke('webhooks:list'))
  const [creating, setCreating] = useState(false)
  const domains = [...new Set((rows.data ?? []).map((row) => row.domain))].sort()
  // Mail without any event yet has no status Resend could filter by.
  const visible =
    status === 'unknown'
      ? (rows.data ?? []).filter((row) => row.lastEvent === null)
      : (rows.data ?? [])
  const byStatus = summary.data?.byStatus ?? {}
  const statuses = [
    ...SUMMARY_ORDER.filter((key) => (byStatus[key] ?? 0) > 0),
    ...Object.keys(byStatus).filter((key) => !SUMMARY_ORDER.includes(key) && byStatus[key]! > 0)
  ]

  const filter = (next: { status?: string | null; domain?: string | null }): void => {
    if (next.status !== undefined) setStatus(next.status)
    if (next.domain !== undefined) setDomain(next.domain)
    setLimit(PAGE)
    rows.reload()
  }

  return (
    <>
      <PageHeader
        title={t('admin.nav.delivery')}
        description={t('admin.delivery.description')}
        action={<AddButton label={t('admin.webhooks.add')} onClick={() => setCreating(true)} />}
      />
      <Card
        title={t('admin.delivery.summaryTitle')}
        action={
          <span className="admin-muted">
            {t('admin.delivery.total', { count: summary.data?.total ?? 0 })}
          </span>
        }
      >
        <InlineError message={summary.error} />
        <div className="admin-chips admin-chips--filters">
          {statuses.length === 0 ? (
            <span className="admin-muted">{t('admin.delivery.none')}</span>
          ) : (
            statuses.map((key) => (
              <button
                key={key}
                type="button"
                className={status === key ? 'admin-filter is-active' : 'admin-filter'}
                aria-pressed={status === key}
                onClick={() => filter({ status: status === key ? null : key })}
              >
                <Chip tone={deliveryTone(key)}>
                  {eventName(key)} · {byStatus[key]}
                </Chip>
              </button>
            ))
          )}
        </div>
      </Card>
      <Card
        title={t('admin.delivery.listTitle')}
        action={
          <span className="admin-filters">
            <select
              aria-label={t('admin.delivery.filterStatus')}
              value={status ?? ''}
              onChange={(event) => filter({ status: event.target.value || null })}
            >
              <option value="">{t('admin.delivery.allStatuses')}</option>
              {statuses.map((key) => (
                <option key={key} value={key}>
                  {eventName(key)}
                </option>
              ))}
            </select>
            <select
              aria-label={t('admin.delivery.filterDomain')}
              value={domain ?? ''}
              onChange={(event) => filter({ domain: event.target.value || null })}
            >
              <option value="">{t('admin.delivery.allDomains')}</option>
              {[...new Set([...domains, ...(domain ? [domain] : [])])].map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </span>
        }
      >
        <InlineError message={rows.error} />
        {rows.data && visible.length === 0 ? (
          <p className="admin-empty">{t('admin.delivery.empty')}</p>
        ) : (
          <DeliveryTable rows={visible} />
        )}
        {rows.data && rows.data.length >= limit ? (
          <button
            type="button"
            className="button-secondary admin-more"
            onClick={() => {
              setLimit(limit + PAGE)
              rows.reload()
            }}
          >
            {t('admin.common.more')}
          </button>
        ) : null}
      </Card>
      <Card title={t('admin.webhooks.title')} description={t('admin.webhooks.description')}>
        <InlineError message={hooks.error} />
        {hooks.data && hooks.data.length === 0 ? (
          <p className="admin-empty">{t('admin.webhooks.empty')}</p>
        ) : (
          <ul className="admin-list">
            {(hooks.data ?? []).map((hook) => (
              <WebhookRow key={hook.id} hook={hook} onRemoved={hooks.reload} />
            ))}
          </ul>
        )}
      </Card>
      {creating ? (
        <WebhookDialog onClose={() => setCreating(false)} onCreated={hooks.reload} />
      ) : null}
    </>
  )
}
