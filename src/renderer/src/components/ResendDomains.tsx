import { useCallback, useEffect, useState } from 'react'
import type { ResendDomainInfo } from '@shared/types'
import { t } from '../i18n'
import { api } from '../lib/bridge'
import type { Action } from '../lib/useAction'
import { useAction } from '../lib/useAction'
import { useUnibox } from '../state'
import { InlineError } from './InlineError'
import { Switch } from './admin/ui'

/**
 * Switching receiving on or off. Turning it on while foreign MX hosts are set
 * would take the domain's mail away from them, so that first asks — the
 * caller shows `MxConflictConfirm` while `confirming` is set.
 */
export function useReceivingToggle(
  domain: ResendDomainInfo,
  onChanged: () => Promise<void> | void
): { toggle: Action<[boolean]>; confirming: boolean; cancel: () => void } {
  const [confirming, setConfirming] = useState(false)
  const toggle = useAction(async (acknowledge: boolean) => {
    if (domain.receivingEnabled) {
      await api.invoke('resend:disableReceiving', domain.id)
    } else if (domain.conflictingMx.length > 0 && !acknowledge) {
      setConfirming(true)
      return
    } else {
      await api.invoke('resend:enableReceiving', domain.id, acknowledge)
    }
    setConfirming(false)
    await onChanged()
  })
  return { toggle, confirming, cancel: () => setConfirming(false) }
}

/** The mandatory warning before receiving replaces a domain's current mail host. */
export function MxConflictConfirm({
  domain,
  toggle,
  onCancel
}: {
  domain: ResendDomainInfo
  toggle: Action<[boolean]>
  onCancel: () => void
}): React.JSX.Element {
  return (
    <div className="domain-card__detail domain-card__warning">
      <strong>{t('onboarding.domains.conflictTitle')}</strong>
      <span>
        {t('onboarding.domains.conflictWarning', { hosts: domain.conflictingMx.join(', ') })}
      </span>
      <div style={{ display: 'flex', gap: 8 }}>
        <button
          type="button"
          className="button-secondary"
          disabled={toggle.busy}
          onClick={() => void toggle.run(true)}
        >
          {t('onboarding.domains.conflictConfirm')}
        </button>
        <button type="button" className="button-secondary" onClick={onCancel}>
          {t('compose.cancel')}
        </button>
      </div>
    </div>
  )
}

export function DomainRow({
  domain,
  onChanged
}: {
  domain: ResendDomainInfo
  onChanged: () => Promise<void>
}): React.JSX.Element {
  const { toggle, confirming, cancel } = useReceivingToggle(domain, onChanged)

  const showDetail = !domain.receivingEnabled || !domain.mxVerified || confirming
  return (
    <div className="domain-card">
      <div className="domain-card__row">
        <span
          className="sidebar__dot"
          style={{ background: domain.mxVerified ? 'var(--success)' : 'var(--warning)' }}
        />
        <span className="domain-card__name">{domain.name}</span>
        <span className="settings__row-sub">
          {domain.mxVerified
            ? t('onboarding.domains.mxVerified')
            : t('onboarding.domains.mxPending')}
        </span>
        <Switch
          on={domain.receivingEnabled}
          label={domain.name}
          busy={toggle.busy}
          onToggle={() => void toggle.run(false)}
        />
      </div>
      <InlineError message={toggle.error} />
      {confirming ? (
        <MxConflictConfirm domain={domain} toggle={toggle} onCancel={cancel} />
      ) : showDetail ? (
        <div
          className={`domain-card__detail${domain.conflictingMx.length > 0 ? ' domain-card__warning' : ''}`}
        >
          {domain.conflictingMx.length > 0 ? (
            <span>
              {t('onboarding.domains.conflictWarning', { hosts: domain.conflictingMx.join(', ') })}
            </span>
          ) : (
            <>
              <span>{t('onboarding.domains.mxInstruction')}</span>
              <code>{domain.requiredMxRecord}</code>
              <span>{t('onboarding.domains.mxAutoCheck')}</span>
            </>
          )}
        </div>
      ) : null}
    </div>
  )
}

/**
 * The domain list as the onboarding shows it, re-polling while the user is
 * waiting for a DNS change to propagate. The Verwaltung has its own, fuller
 * cards (admin/DomainsPage) built on the same receiving toggle.
 */
export function ResendDomainList({ pollMs }: { pollMs?: number }): React.JSX.Element {
  const { refresh } = useUnibox()
  const [domains, setDomains] = useState<ResendDomainInfo[]>([])
  const [error, setLoadError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setDomains(await api.invoke('resend:listDomains'))
      setLoadError(null)
    } catch (cause) {
      // Swallowing this is what made the section look simply empty before.
      setLoadError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [])

  const reload = useCallback(async () => {
    await load()
    await refresh()
  }, [load, refresh])

  useEffect(() => {
    let cancelled = false
    const tick = async (): Promise<void> => {
      if (cancelled) return
      await load()
    }
    void tick()
    const handle = pollMs ? setInterval(() => void tick(), pollMs) : null
    return () => {
      cancelled = true
      if (handle) clearInterval(handle)
    }
  }, [load, pollMs])

  return (
    <>
      {error ? <span className="error-text">{error}</span> : null}
      {!error && domains.length === 0 ? (
        <span className="settings__row-sub">{t('settings.accounts.noDomains')}</span>
      ) : null}
      <div className="domain-list">
        {domains.map((domain) => (
          <DomainRow key={domain.id} domain={domain} onChanged={reload} />
        ))}
      </div>
      <button
        type="button"
        className="button-secondary"
        style={{ alignSelf: 'flex-start' }}
        onClick={() => void reload()}
      >
        {t('onboarding.domains.recheck')}
      </button>
    </>
  )
}
