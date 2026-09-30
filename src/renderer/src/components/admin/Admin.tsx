import { t } from '../../i18n'
import type { AdminPage } from '../../lib/admin-pages'
import { ADMIN_NAV } from '../../lib/admin-pages'
import { useUnibox } from '../../state'
import { LogoMark } from '../Icons'
import { QueueTab } from '../QueueTab'
import { ActivityPage } from './ActivityPage'
import {
  AccountsPage,
  GeneralPage,
  IdentitiesPage,
  NotificationsPage,
  TemplatesPage
} from './AppPages'
import { BackupsPage } from './BackupsPage'
import { DeliveryPage } from './DeliveryPage'
import { DomainsPage } from './DomainsPage'
import {
  ArrowLeftIcon,
  BellIcon,
  DatabaseIcon,
  DeliveryIcon,
  GearIcon,
  GlobeIcon,
  HomeIcon,
  IdCardIcon,
  MailboxIcon,
  PulseIcon,
  QueueIcon,
  RouteIcon,
  TemplateIcon,
  UsersIcon
} from './icons'
import { MailboxesPage } from './MailboxesPage'
import { OverviewPage } from './OverviewPage'
import { RoutingPage } from './RoutingPage'

const ICONS: Record<AdminPage, (props: { size?: number }) => React.JSX.Element> = {
  overview: HomeIcon,
  domains: GlobeIcon,
  mailboxes: MailboxIcon,
  routing: RouteIcon,
  delivery: DeliveryIcon,
  accounts: UsersIcon,
  identities: IdCardIcon,
  templates: TemplateIcon,
  notifications: BellIcon,
  queue: QueueIcon,
  activity: PulseIcon,
  backups: DatabaseIcon,
  general: GearIcon
}

function Page({ page }: { page: AdminPage }): React.JSX.Element {
  switch (page) {
    case 'overview':
      return <OverviewPage />
    case 'domains':
      return <DomainsPage />
    case 'mailboxes':
      return <MailboxesPage />
    case 'routing':
      return <RoutingPage />
    case 'delivery':
      return <DeliveryPage />
    case 'accounts':
      return <AccountsPage />
    case 'identities':
      return <IdentitiesPage />
    case 'templates':
      return <TemplatesPage />
    case 'notifications':
      return <NotificationsPage />
    case 'queue':
      return <QueueTab />
    case 'activity':
      return <ActivityPage />
    case 'backups':
      return <BackupsPage />
    case 'general':
      return <GeneralPage />
  }
}

/**
 * The Verwaltung: a workspace of its own that takes the mailbox's place in the
 * window rather than floating over it, with its own navigation on the left.
 * Everything the old settings window held lives in one of its pages.
 */
export function Admin(): React.JSX.Element {
  const { adminPage, openAdmin } = useUnibox()
  const page = adminPage ?? 'overview'

  return (
    <div
      className="admin"
      role="region"
      aria-label={t('admin.title')}
      onKeyDown={(event) => {
        // A dialog handles its own Escape; anywhere else it leads back to the mail.
        if (event.key === 'Escape' && !event.defaultPrevented) {
          const target = event.target as HTMLElement
          if (!target.closest('[role="dialog"]')) openAdmin(null)
        }
      }}
    >
      <aside className="admin-nav">
        <div className="admin-nav__head">
          <LogoMark />
          <span className="admin-nav__brand">{t('admin.title')}</span>
        </div>
        <button type="button" className="admin-nav__back" onClick={() => openAdmin(null)}>
          <ArrowLeftIcon size={16} />
          <span>{t('admin.back')}</span>
        </button>
        <nav className="admin-nav__scroll" aria-label={t('admin.navLabel')}>
          {ADMIN_NAV.map(({ group, pages }) => (
            <div key={group} className="admin-nav__group">
              {group === 'main' ? null : (
                <span className="admin-nav__label">{t(`admin.groups.${group}`)}</span>
              )}
              {pages.map((entry) => {
                const Icon = ICONS[entry]
                const active = entry === page
                return (
                  <button
                    key={entry}
                    type="button"
                    className={active ? 'admin-nav__item is-active' : 'admin-nav__item'}
                    aria-current={active ? 'page' : undefined}
                    onClick={() => openAdmin(entry)}
                  >
                    <Icon size={18} />
                    <span>{t(`admin.nav.${entry}`)}</span>
                  </button>
                )
              })}
            </div>
          ))}
        </nav>
      </aside>
      <main className="admin-main">
        <div className="admin-page" key={page}>
          <Page page={page} />
        </div>
      </main>
    </div>
  )
}
