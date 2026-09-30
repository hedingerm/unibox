import { t } from '../i18n'
import { useUnibox } from '../state'
import { SettingsIcon } from './Icons'
import { SearchBox } from './SearchBox'

/**
 * The bar across the top of the working area: the search as a wide pill and
 * the way into the Verwaltung. It doubles as the window's drag handle — the
 * title bar is hidden — so only its controls opt out of dragging.
 */
export function TopBar(): React.JSX.Element {
  const { openAdmin } = useUnibox()
  return (
    <header className="topbar">
      <SearchBox />
      <button
        type="button"
        className="topbar__icon"
        data-tip={t('sidebar.settings')}
        aria-label={t('sidebar.settings')}
        onClick={() => openAdmin('overview')}
      >
        <SettingsIcon size={20} />
      </button>
    </header>
  )
}
