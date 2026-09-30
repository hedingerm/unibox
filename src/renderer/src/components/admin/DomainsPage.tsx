import { useState } from 'react'
import type { DomainDetails, DomainRecordCheck, DomainRegion } from '@shared/admin'
import { DOMAIN_REGIONS, normalizeDomainName } from '@shared/admin'
import { t } from '../../i18n'
import { api } from '../../lib/bridge'
import { useAction } from '../../lib/useAction'
import { useUnibox } from '../../state'
import { ChevronIcon } from '../Icons'
import { InlineError } from '../InlineError'
import { MxConflictConfirm, useReceivingToggle } from '../ResendDomains'
import { AlertIcon, CheckCircleIcon, CircleIcon, GlobeIcon, MinusCircleIcon } from './icons'
import type { Tone } from './ui'
import { AddButton, Card, Chip, CopyButton, Dialog, PageHeader, Switch, useLoaded } from './ui'

function recordTone(record: DomainRecordCheck): Tone {
  if (record.status === 'found') return 'success'
  if (record.status === 'pending') return 'warning'
  // DMARC and, before receiving is on, the inbound MX are advice only.
  return record.required ? 'danger' : 'neutral'
}

function RecordIcon({ tone }: { tone: Tone }): React.JSX.Element {
  if (tone === 'success') return <CheckCircleIcon size={20} />
  if (tone === 'warning') return <CircleIcon size={20} />
  if (tone === 'danger') return <AlertIcon size={20} />
  return <MinusCircleIcon size={20} />
}

function RecordRow({ record }: { record: DomainRecordCheck }): React.JSX.Element {
  const tone = recordTone(record)
  const value = record.priority !== null ? `${record.priority} ${record.value}` : record.value
  return (
    <li className={`admin-record admin-record--${tone}`}>
      <span className="admin-record__icon">
        <RecordIcon tone={tone} />
      </span>
      <span className="admin-record__what">
        <span className="admin-record__title">{t(`admin.domains.records.${record.kind}`)}</span>
        <span className="admin-record__purpose">{t(`admin.domains.purpose.${record.kind}`)}</span>
      </span>
      <span className="admin-record__value">
        <span className="admin-record__host">
          {record.type} · {record.name}
        </span>
        <span className="admin-record__code">
          <code>{value}</code>
          <CopyButton value={record.value} label={t('admin.domains.copyValue')} />
        </span>
      </span>
      <span className="admin-record__status">
        {t(
          `admin.domains.status.${record.status === 'missing' && !record.required ? 'recommended' : record.status}`
        )}
      </span>
    </li>
  )
}

function DomainCard({
  domain,
  expanded,
  onExpand,
  onUpdated,
  onChanged
}: {
  domain: DomainDetails
  expanded: boolean
  onExpand: () => void
  onUpdated: (domain: DomainDetails) => void
  onChanged: () => Promise<void>
}): React.JSX.Element {
  const verify = useAction(async () => {
    onUpdated(await api.invoke('domains:verify', domain.id))
  })
  const { toggle, confirming, cancel } = useReceivingToggle(domain, onChanged)
  const receivingTone: Tone = !domain.receivingEnabled
    ? 'neutral'
    : domain.mxVerified
      ? 'success'
      : 'warning'

  return (
    <section className="admin-card admin-domain" aria-label={domain.name}>
      <div className="admin-domain__row">
        <span className="admin-domain__globe">
          <GlobeIcon size={20} />
        </span>
        <div className="admin-domain__main">
          <span className="admin-domain__name">{domain.name}</span>
          <span className="admin-chips">
            <Chip tone={domain.verified ? 'success' : 'warning'}>
              {domain.verified ? t('admin.domains.verified') : t('admin.domains.pending')}
            </Chip>
            <Chip tone={receivingTone}>
              {!domain.receivingEnabled
                ? t('admin.domains.receivingOff')
                : domain.mxVerified
                  ? t('admin.domains.receiving')
                  : t('admin.domains.receivingPending')}
            </Chip>
            <Chip tone={domain.sendingEnabled ? 'success' : 'neutral'}>
              {domain.sendingEnabled ? t('admin.domains.sending') : t('admin.domains.sendingOff')}
            </Chip>
          </span>
        </div>
        <div className="admin-domain__actions">
          <span className="admin-domain__switch">
            <span className="admin-muted">{t('admin.domains.receivingLabel')}</span>
            <Switch
              on={domain.receivingEnabled}
              label={t('admin.domains.receivingSwitch', { name: domain.name })}
              busy={toggle.busy}
              onToggle={() => void toggle.run(false)}
            />
          </span>
          <button
            type="button"
            className="button-secondary"
            aria-busy={verify.busy}
            disabled={verify.busy}
            onClick={() => void verify.run()}
          >
            {verify.busy ? t('admin.domains.checking') : t('admin.domains.verify')}
          </button>
          <button
            type="button"
            className="admin-link"
            aria-expanded={expanded}
            onClick={onExpand}
          >
            {expanded ? t('admin.domains.hideDetails') : t('admin.domains.showDetails')}
            <ChevronIcon open={expanded} />
          </button>
        </div>
      </div>
      <InlineError message={toggle.error ?? verify.error} />
      {confirming ? <MxConflictConfirm domain={domain} toggle={toggle} onCancel={cancel} /> : null}
      {!confirming && domain.conflictingMx.length > 0 ? (
        <div className="domain-card__detail domain-card__warning">
          <span>
            {t('onboarding.domains.conflictWarning', { hosts: domain.conflictingMx.join(', ') })}
          </span>
        </div>
      ) : null}
      {expanded ? (
        <div className="admin-domain__auth">
          <h3 className="admin-domain__auth-title">{t('admin.domains.authTitle')}</h3>
          <p className="admin-card__desc">{t('admin.domains.authDescription')}</p>
          <ul className="admin-records">
            {domain.records.map((record) => (
              <RecordRow key={`${record.kind}:${record.type}:${record.name}`} record={record} />
            ))}
          </ul>
          {domain.dmarc.status === 'missing' ? (
            <p className="admin-muted">{t('admin.domains.dmarcHint')}</p>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}

/** Adds a domain at Resend; its records then have to go into the DNS zone. */
function CreateDomainDialog({
  onClose,
  onCreated
}: {
  onClose: () => void
  onCreated: (domain: DomainDetails) => void
}): React.JSX.Element {
  const [name, setName] = useState('')
  const [region, setRegion] = useState<DomainRegion>('eu-west-1')
  const valid = normalizeDomainName(name) !== null
  const create = useAction(async () => {
    onCreated(await api.invoke('domains:create', { name, region }))
  })
  return (
    <Dialog
      title={t('admin.domains.createTitle')}
      description={t('admin.domains.createDescription')}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="button-secondary" onClick={onClose}>
            {t('admin.common.cancel')}
          </button>
          <button
            type="submit"
            form="domain-create"
            className="button-primary"
            aria-busy={create.busy}
            disabled={create.busy || !valid}
          >
            {create.busy ? t('admin.domains.creating') : t('admin.domains.create')}
          </button>
        </>
      }
    >
      <form
        id="domain-create"
        onSubmit={(event) => {
          event.preventDefault()
          if (valid) void create.run()
        }}
      >
        <div className="field">
          <label htmlFor="domain-name">{t('admin.domains.name')}</label>
          <input
            id="domain-name"
            value={name}
            placeholder={t('admin.domains.namePlaceholder')}
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="domain-region">{t('admin.domains.region')}</label>
          <select
            id="domain-region"
            value={region}
            onChange={(event) => setRegion(event.target.value as DomainRegion)}
          >
            {DOMAIN_REGIONS.map((entry) => (
              <option key={entry} value={entry}>
                {t(`admin.domains.regions.${entry}`)}
              </option>
            ))}
          </select>
          <span className="admin-muted">{t('admin.domains.regionHint')}</span>
        </div>
      </form>
      <InlineError message={create.error} />
    </Dialog>
  )
}

/** Where the key comes from: the onboarding's field, kept reachable afterwards. */
function ApiKeyCard({ onSaved }: { onSaved: () => void }): React.JSX.Element {
  const hasKey = useLoaded(() => api.invoke('resend:hasKey'))
  const [key, setKey] = useState('')
  const save = useAction(async () => {
    await api.invoke('resend:setKey', key)
    setKey('')
    hasKey.reload()
    onSaved()
  })
  return (
    <Card
      title={t('admin.domains.keyTitle')}
      description={hasKey.data ? t('admin.domains.keySet') : t('admin.domains.keyMissing')}
    >
      <form
        className="admin-inline-form"
        onSubmit={(event) => {
          event.preventDefault()
          void save.run()
        }}
      >
        <input
          type="password"
          className="admin-input"
          aria-label={t('admin.domains.keyTitle')}
          placeholder={t('onboarding.resend.placeholder')}
          value={key}
          onChange={(event) => setKey(event.target.value)}
        />
        <button
          type="submit"
          className="button-primary"
          aria-busy={save.busy}
          disabled={save.busy || key.trim().length === 0}
        >
          {save.busy ? t('onboarding.resend.checking') : t('onboarding.resend.save')}
        </button>
      </form>
      {save.error ? (
        <>
          <InlineError message={t('onboarding.resend.invalid', { message: save.error })} />
          <span className="admin-muted">{t('onboarding.resend.restrictedHint')}</span>
        </>
      ) : null}
    </Card>
  )
}

function ReceivingSummary({ domains }: { domains: DomainDetails[] }): React.JSX.Element {
  const { openAdmin } = useUnibox()
  const receiving = domains.filter((domain) => domain.receivingEnabled)
  const working = receiving.filter((domain) => domain.mxVerified)
  const tone: 'success' | 'warning' | 'neutral' =
    receiving.length === 0 ? 'neutral' : working.length === receiving.length ? 'success' : 'warning'
  return (
    <Card
      title={t('admin.domains.summaryTitle')}
      action={
        <span className="admin-muted">
          {t('admin.domains.summaryCount', { count: receiving.length, total: domains.length })}
        </span>
      }
    >
      <div className={`admin-banner admin-banner--${tone}`}>
        <span className="admin-banner__icon">
          <RecordIcon tone={tone} />
        </span>
        <span className="admin-banner__text">
          <strong>{t(`admin.domains.summary.${tone}.title`)}</strong>
          <span>
            {t(`admin.domains.summary.${tone}.text`, {
              count: receiving.length - working.length
            })}
          </span>
        </span>
        <button type="button" className="button-secondary" onClick={() => openAdmin('routing')}>
          {t('admin.domains.toRouting')}
        </button>
      </div>
    </Card>
  )
}

export function DomainsPage(): React.JSX.Element {
  const { refresh } = useUnibox()
  const domains = useLoaded(() => api.invoke('domains:list'))
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [creating, setCreating] = useState(false)
  const list = domains.data ?? []

  const onChanged = async (): Promise<void> => {
    domains.reload()
    await refresh()
  }

  return (
    <>
      <PageHeader
        title={t('admin.nav.domains')}
        description={t('admin.domains.description')}
        action={
          <AddButton label={t('admin.domains.add')} onClick={() => setCreating(true)} />
        }
      />
      {creating ? (
        <CreateDomainDialog
          onClose={() => setCreating(false)}
          onCreated={(domain) => {
            setCreating(false)
            // Straight to what has to go into the DNS zone next.
            domains.setData([...list.filter((entry) => entry.id !== domain.id), domain])
            setExpanded((current) => new Set(current).add(domain.id))
          }}
        />
      ) : null}
      {domains.error ? <InlineError message={domains.error} /> : null}
      {domains.data && list.length === 0 ? (
        <Card>
          <p className="admin-empty">{t('settings.accounts.noDomains')}</p>
        </Card>
      ) : null}
      {list.map((domain) => (
        <DomainCard
          key={domain.id}
          domain={domain}
          expanded={expanded.has(domain.id)}
          onExpand={() =>
            setExpanded((current) => {
              const next = new Set(current)
              if (next.has(domain.id)) next.delete(domain.id)
              else next.add(domain.id)
              return next
            })
          }
          onUpdated={(updated) =>
            domains.setData(list.map((entry) => (entry.id === updated.id ? updated : entry)))
          }
          onChanged={onChanged}
        />
      ))}
      {list.length > 0 ? <ReceivingSummary domains={list} /> : null}
      <ApiKeyCard onSaved={() => void onChanged()} />
    </>
  )
}
