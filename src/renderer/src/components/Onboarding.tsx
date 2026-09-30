import { useState } from 'react'
import { t } from '../i18n'
import { api } from '../lib/bridge'
import { useAction } from '../lib/useAction'
import { ResendDomainList } from './ResendDomains'
import { useUnibox } from '../state'
import { CheckIcon } from './Icons'
import { InlineError } from './InlineError'

type Step = 'google' | 'resend' | 'domains' | 'done'

const STEPS: Step[] = ['google', 'resend', 'domains', 'done']

function StepRail({ current }: { current: Step }): React.JSX.Element {
  const index = STEPS.indexOf(current)
  return (
    <div className="onboarding__rail">
      {STEPS.map((step, position) => (
        <div
          key={step}
          className={`onboarding__step${position === index ? ' onboarding__step--active' : ''}`}
        >
          <span
            className={`onboarding__bullet${position < index ? ' onboarding__bullet--done' : ''}`}
          >
            {position < index ? <CheckIcon /> : position + 1}
          </span>
          <span>{t(`onboarding.steps.${step}`)}</span>
        </div>
      ))}
    </div>
  )
}

export function Onboarding(): React.JSX.Element {
  const { accounts, refresh, saveSettings } = useUnibox()
  const [step, setStep] = useState<Step>('google')
  const [apiKey, setApiKey] = useState('')

  const connectGoogle = useAction(async () => {
    await api.invoke('google:connect')
    await refresh()
  })

  // Whatever Resend said goes next to the field — a toast at the window edge
  // is too easy to miss behind the wizard.
  const saveKey = useAction(async () => {
    await api.invoke('resend:setKey', apiKey)
    setStep('domains')
  })

  const finish = async (): Promise<void> => {
    await saveSettings({ onboardingComplete: true })
    await refresh()
  }

  const index = STEPS.indexOf(step)

  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label={t('onboarding.title')}>
      <div className="window onboarding">
        <div className="window__titlebar">
          <span className="window__title">{t('onboarding.title')}</span>
        </div>
        <div className="onboarding__body">
          <StepRail current={step} />
          <div className="onboarding__content">
            {step === 'google' ? (
              <>
                <h2 className="onboarding__heading">{t('onboarding.google.heading')}</h2>
                <p className="onboarding__description">{t('onboarding.google.description')}</p>
                {accounts
                  .filter((account) => account.kind === 'google')
                  .map((account) => (
                    <div key={account.id} className="settings__row">
                      <span className="settings__row-label">{account.email}</span>
                      <span className="settings__row-sub">{t('onboarding.google.connected')}</span>
                    </div>
                  ))}
                <button
                  type="button"
                  className="button-primary"
                  aria-busy={connectGoogle.busy}
                  disabled={connectGoogle.busy}
                  style={{ alignSelf: 'flex-start' }}
                  onClick={() => void connectGoogle.run()}
                >
                  {t('onboarding.google.connect')}
                </button>
                <InlineError message={connectGoogle.error} />
              </>
            ) : null}

            {step === 'resend' ? (
              <>
                <h2 className="onboarding__heading">{t('onboarding.resend.heading')}</h2>
                <p className="onboarding__description">{t('onboarding.resend.description')}</p>
                <div className="field">
                  <label htmlFor="resend-key">{t('onboarding.resend.heading')}</label>
                  <input
                    id="resend-key"
                    type="password"
                    value={apiKey}
                    placeholder={t('onboarding.resend.placeholder')}
                    onChange={(event) => setApiKey(event.target.value)}
                  />
                </div>
                <button
                  type="button"
                  className="button-primary"
                  aria-busy={saveKey.busy}
                  disabled={saveKey.busy || apiKey.trim().length === 0}
                  style={{ alignSelf: 'flex-start' }}
                  onClick={() => void saveKey.run()}
                >
                  {saveKey.busy ? t('onboarding.resend.checking') : t('onboarding.resend.save')}
                </button>
                {saveKey.error ? (
                  <div className="field">
                    <InlineError
                      message={t('onboarding.resend.invalid', { message: saveKey.error })}
                    />
                    <span className="settings__row-sub">
                      {t('onboarding.resend.restrictedHint')}
                    </span>
                  </div>
                ) : null}
              </>
            ) : null}

            {step === 'domains' ? (
              <>
                <h2 className="onboarding__heading">{t('onboarding.domains.heading')}</h2>
                <p className="onboarding__description">{t('onboarding.domains.description')}</p>
                <ResendDomainList pollMs={15_000} />
              </>
            ) : null}

            {step === 'done' ? (
              <>
                <h2 className="onboarding__heading">{t('onboarding.done.heading')}</h2>
                <p className="onboarding__description">{t('onboarding.done.description')}</p>
              </>
            ) : null}
          </div>
        </div>
        <div className="onboarding__footer">
          <button
            type="button"
            className="button-secondary"
            disabled={index === 0}
            onClick={() => setStep(STEPS[Math.max(0, index - 1)]!)}
          >
            {t('onboarding.back')}
          </button>
          {step === 'done' ? (
            <button type="button" className="button-primary" onClick={() => void finish()}>
              {t('onboarding.done.finish')}
            </button>
          ) : (
            <button
              type="button"
              className="button-primary"
              onClick={() => setStep(STEPS[Math.min(STEPS.length - 1, index + 1)]!)}
            >
              {t('onboarding.next')}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
