import { t } from '../i18n'
import { api } from '../lib/bridge'
import { useUnibox } from '../state'

/** Keeps the seven-day testing-mode token expiry visible instead of silent. */
export function ReconnectBanner(): React.JSX.Element | null {
  const { accounts, refresh, setError } = useUnibox()
  const expired = accounts.filter((account) => account.status === 'reconnect_required')
  if (expired.length === 0) return null

  return (
    <>
      {expired.map((account) => (
        <div key={account.id} className="banner" role="alert">
          <span>{t('reconnect.banner', { account: account.email })}</span>
          <button
            type="button"
            onClick={() =>
              void api
                .invoke('google:reconnect', account.id)
                .then(refresh)
                .catch((cause: unknown) =>
                  setError(cause instanceof Error ? cause.message : String(cause))
                )
            }
          >
            {t('reconnect.action')}
          </button>
        </div>
      ))}
    </>
  )
}
