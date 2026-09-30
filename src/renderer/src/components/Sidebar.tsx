import type { Account, LabelWithCounts } from '@shared/types'
import { SYSTEM_LABELS } from '@shared/types'
import { labelName, t } from '../i18n'
import { useUnibox } from '../state'
import {
  ChevronIcon,
  ClockIcon,
  DraftIcon,
  HourglassIcon,
  InboxIcon,
  KeyboardIcon,
  LabelIcon,
  LogoMark,
  MailIcon,
  MenuIcon,
  PenIcon,
  SearchIcon,
  SendIcon,
  SpamIcon,
  StarIcon,
  TrashIcon
} from './Icons'
import { version } from '../../../../package.json'
import { api } from '../lib/bridge'
import { errorMessage } from '../lib/errors'
import { useStoredFlag, useStoredSize } from '../lib/layout'
import { buildLabelTree, flattenLabelTree } from '../lib/mailbox'
import { useAction } from '../lib/useAction'
import { useMailboxes } from '../lib/useMailboxes'
import { InlineError } from './InlineError'
import { ResizeHandle } from './ResizeHandle'
import type { SidebarTarget } from './SidebarMenu'
import { SidebarMenu } from './SidebarMenu'
import { createContext, useContext, useState } from 'react'

// Trash and spam belong in the sidebar: without them there is no way back for
// a message that landed there.
const SYSTEM_ORDER = [
  SYSTEM_LABELS.inbox,
  SYSTEM_LABELS.sent,
  SYSTEM_LABELS.drafts,
  SYSTEM_LABELS.trash,
  SYSTEM_LABELS.spam
]
const COLLAPSE_KEY = 'unibox.sidebar.collapsedAccounts'
const WIDTH_KEY = 'unibox.layout.sidebarWidth'
const RAIL_KEY = 'unibox.layout.sidebarRail'
export const SIDEBAR_MIN = 200
export const SIDEBAR_MAX = 360
const SIDEBAR_DEFAULT = 256
// Die ausgewählte Mailbox trägt den Akzent bis ins Icon; Labels behalten ihre
// eigene Farbe, sie ist ihre Identität und nicht ihr Zustand.
const ICON_MUTED = 'var(--text-muted)'
const ICON_ACTIVE = 'var(--on-accent-soft)'
const ICON_OVERDUE = 'var(--danger)'

/** Whether the sidebar is folded to its icon rail. */
const RailContext = createContext(false)

/** Collapsed accounts persist across restarts; a broken entry just falls back to expanded. */
function readCollapsed(): Record<string, boolean> {
  try {
    const raw = window.localStorage.getItem(COLLAPSE_KEY)
    return raw ? (JSON.parse(raw) as Record<string, boolean>) : {}
  } catch {
    return {}
  }
}

function writeCollapsed(accountId: string, collapsed: boolean): void {
  try {
    window.localStorage.setItem(
      COLLAPSE_KEY,
      JSON.stringify({ ...readCollapsed(), [accountId]: collapsed })
    )
  } catch {
    // Storage unavailable — collapsing still works for this session.
  }
}

function systemIcon(remoteId: string, active: boolean): React.JSX.Element {
  const color = active ? ICON_ACTIVE : ICON_MUTED
  if (remoteId === SYSTEM_LABELS.sent) return <SendIcon size={17} color={color} />
  if (remoteId === SYSTEM_LABELS.drafts) return <DraftIcon size={17} color={color} />
  if (remoteId === SYSTEM_LABELS.trash) return <TrashIcon size={17} color={color} />
  if (remoteId === SYSTEM_LABELS.spam) return <SpamIcon size={17} color={color} />
  return <InboxIcon size={17} color={color} />
}

interface RowProps {
  label: string
  icon: React.JSX.Element
  count?: number
  /** Draws the count as a warning — something in this mailbox has run late. */
  overdue?: boolean
  active: boolean
  /** Nesting depth for mirrored Gmail label hierarchies. */
  depth?: number
  onSelect: () => void
  onContextMenu?: (event: React.MouseEvent) => void
}

function Row({
  label,
  icon,
  count,
  overdue = false,
  active,
  depth = 0,
  onSelect,
  onContextMenu
}: RowProps): React.JSX.Element {
  const rail = useContext(RailContext)
  return (
    <button
      type="button"
      className={['sidebar__item', active ? 'sidebar__item--active' : ''].filter(Boolean).join(' ')}
      style={depth > 0 && !rail ? { paddingLeft: 24 + depth * 16 } : undefined}
      // Folded to icons, the row's name only survives as its hint — a native
      // one, since the scrolling rail would clip a drawn one.
      title={rail ? label : undefined}
      aria-label={rail ? label : undefined}
      onClick={onSelect}
      onContextMenu={onContextMenu}
    >
      {icon}
      <span className="sidebar__item-label">{label}</span>
      {count && count > 0 ? (
        <span className={overdue ? 'sidebar__count sidebar__count--overdue' : 'sidebar__count'}>
          {count}
        </span>
      ) : null}
    </button>
  )
}

/**
 * Pinned queries. They set the search box rather than the mailbox selection —
 * a saved search is a query, not a folder, and stays editable once opened.
 */
function SavedSearches(): React.JSX.Element | null {
  const { settings, searchText, setSearchText, removeSavedSearch } = useUnibox()
  const rail = useContext(RailContext)
  const saved = settings.savedSearches
  if (saved.length === 0 || rail) return null
  return (
    <div className="sidebar__section">
      <div className="sidebar__section-header sidebar__section-header--static">
        <span className="sidebar__section-toggle" />
        <span className="sidebar__section-title sidebar__section-title--caps">
          {t('search.saved')}
        </span>
      </div>
      {saved.map((entry) => (
        <div key={entry.name} className="sidebar__saved">
          <button
            type="button"
            className={['sidebar__item', searchText === entry.query ? 'sidebar__item--active' : '']
              .filter(Boolean)
              .join(' ')}
            title={entry.query}
            onClick={() => setSearchText(entry.query)}
          >
            <SearchIcon size={16} color={searchText === entry.query ? ICON_ACTIVE : ICON_MUTED} />
            <span className="sidebar__item-label">{entry.name}</span>
          </button>
          <button
            type="button"
            className="sidebar__saved-remove"
            title={t('search.removeSaved')}
            aria-label={t('search.removeSaved')}
            onClick={() => void removeSavedSearch(entry.name)}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  )
}

/**
 * Renaming and creating happen where the label sits, not in a dialog: Electron
 * has no `prompt()`, and editing in place shows the hierarchy the name joins.
 */
function LabelInput({
  initial,
  depth,
  onSubmit,
  onCancel
}: {
  initial: string
  depth: number
  onSubmit: (name: string) => void
  onCancel: () => void
}): React.JSX.Element {
  const [value, setValue] = useState(initial)
  return (
    <input
      className="sidebar__label-input"
      style={depth > 0 ? { marginLeft: 8 + depth * 16 } : undefined}
      value={value}
      autoFocus
      aria-label={t('sidebar.labelName')}
      onChange={(event) => setValue(event.target.value)}
      onBlur={onCancel}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          const name = value.trim()
          if (name && name !== initial) onSubmit(name)
          else onCancel()
        }
        if (event.key === 'Escape') {
          event.preventDefault()
          onCancel()
        }
      }}
    />
  )
}

/**
 * The named addresses of a Resend domain, each a filtered view onto its
 * catch-all, and — while some mail reaches none of them — the rest.
 */
function MailboxRows({ account }: { account: Account }): React.JSX.Element | null {
  const { selection, select, counts } = useUnibox()
  const mailboxes = useMailboxes().filter((mailbox) => mailbox.accountId === account.id)
  if (mailboxes.length === 0) return null
  const unassigned = counts[`unassigned:${account.id}`] ?? 0
  const unassignedActive = selection.view === 'unassigned' && selection.accountId === account.id
  return (
    <>
      {mailboxes.map((mailbox) => {
        const active = selection.view === 'mailbox' && selection.mailboxId === mailbox.id
        return (
          <Row
            key={mailbox.id}
            depth={1}
            label={mailbox.displayName || mailbox.address}
            icon={<MailIcon size={16} color={active ? ICON_ACTIVE : ICON_MUTED} />}
            count={counts[`mailbox:${mailbox.id}`]}
            active={active}
            onSelect={() =>
              select({ accountId: account.id, labelId: null, view: 'mailbox', mailboxId: mailbox.id })
            }
          />
        )
      })}
      {unassigned > 0 || unassignedActive ? (
        <Row
          depth={1}
          label={t('sidebar.unassigned')}
          icon={<InboxIcon size={16} color={unassignedActive ? ICON_ACTIVE : ICON_MUTED} />}
          count={unassigned}
          active={unassignedActive}
          onSelect={() => select({ accountId: account.id, labelId: null, view: 'unassigned' })}
        />
      ) : null}
    </>
  )
}

interface AccountSectionProps {
  account: Account
  labels: LabelWithCounts[]
  onContextMenu: (label: LabelWithCounts | null, event: React.MouseEvent) => void
  /** Label id being renamed, `'new'` while a label is being added, else null. */
  editing: string | null
  onSubmitEdit: (name: string) => void
  onCancelEdit: () => void
}

function AccountSection({
  account,
  labels,
  onContextMenu,
  editing,
  onSubmitEdit,
  onCancelEdit
}: AccountSectionProps): React.JSX.Element {
  const { selection, select, refresh, syncStatus, drafts } = useUnibox()
  const rail = useContext(RailContext)
  const [collapsed, setCollapsed] = useState(() => readCollapsed()[account.id] ?? false)
  const status = syncStatus[account.id]
  // Every account has an Entwürfe folder, Resend included: drafts are written
  // locally, so the folder no longer depends on the server having one.
  const draftCount = drafts.filter((draft) => draft.accountId === account.id).length
  const system = SYSTEM_ORDER
    .map((remoteId) => labels.find((label) => label.remoteId === remoteId))
    .filter((label): label is LabelWithCounts => Boolean(label))
  const userLabels = flattenLabelTree(
    buildLabelTree(labels.filter((label) => label.type === 'user'))
  )

  const reconnect = useAction(async () => {
    await api.invoke('google:reconnect', account.id)
    await refresh()
  })

  const retry = useAction(async () => {
    await api.invoke('sync:now')
    await refresh()
  })

  const toggle = (): void => {
    setCollapsed((previous) => {
      writeCollapsed(account.id, !previous)
      return !previous
    })
  }

  // On the rail an account is one chip: its colour, its initial, its unread
  // count — a click opens its inbox, the right-click menu still works.
  if (rail) {
    const inbox = system.find((label) => label.remoteId === SYSTEM_LABELS.inbox)
    const active = selection.accountId === account.id
    return (
      <button
        type="button"
        className={active ? 'sidebar__account-chip is-active' : 'sidebar__account-chip'}
        title={account.email}
        aria-label={account.email}
        onClick={() => (inbox ? select({ accountId: account.id, labelId: inbox.id }) : undefined)}
        onContextMenu={(event) => onContextMenu(null, event)}
      >
        <span
          className={
            account.status === 'ok'
              ? 'sidebar__account-initial'
              : 'sidebar__account-initial sidebar__account-initial--error'
          }
          style={{ background: account.color }}
        >
          {account.email.charAt(0).toUpperCase()}
        </span>
        {inbox && inbox.unread > 0 ? <span className="sidebar__rail-count">{inbox.unread}</span> : null}
      </button>
    )
  }

  return (
    <div className="sidebar__section">
      <button
        type="button"
        className="sidebar__section-header"
        aria-expanded={!collapsed}
        onClick={toggle}
        onContextMenu={(event) => onContextMenu(null, event)}
      >
        <span className="sidebar__section-toggle">
          <ChevronIcon open={!collapsed} />
        </span>
        <span className="sidebar__section-title sidebar__section-title--caps" title={account.email}>
          {account.email}
        </span>
        <span className="sidebar__dot" style={{ background: account.color }} />
      </button>
      {status?.phase === 'initial' ? (
        <span className="sidebar__progress">
          {status.total
            ? t('sidebar.syncing', { processed: status.processed, total: status.total })
            : t('sidebar.syncingUnknown', { processed: status.processed })}
        </span>
      ) : null}
      {account.status !== 'ok' ? (
        <div
          className={`sidebar__account-error${
            account.status === 'reconnect_required' ? ' sidebar__account-error--reconnect' : ''
          }`}
          role="status"
        >
          <span className="sidebar__account-error-title">
            {account.status === 'reconnect_required'
              ? t('sidebar.reconnectRequired')
              : t('sidebar.syncFailed')}
          </span>
          {/* The cause verbatim — a coloured dot alone never explained anything. */}
          {account.lastError ? (
            <span className="sidebar__account-error-detail">{account.lastError}</span>
          ) : null}
          {account.status === 'reconnect_required' && account.kind === 'google' ? (
            <button
              type="button"
              className="sidebar__reconnect"
              aria-busy={reconnect.busy}
              disabled={reconnect.busy}
              onClick={() => void reconnect.run()}
            >
              {t('sidebar.reconnect')}
            </button>
          ) : (
            <button
              type="button"
              className="sidebar__reconnect"
              aria-busy={retry.busy}
              disabled={retry.busy}
              onClick={() => void retry.run()}
            >
              {t('sidebar.retrySync')}
            </button>
          )}
          <InlineError message={reconnect.error ?? retry.error} />
        </div>
      ) : null}
      {collapsed ? null : (
        <>
          {system.map((label) => (
            <Row
              key={label.id}
              label={labelName(label.remoteId, label.name)}
              icon={systemIcon(
                label.remoteId,
                selection.accountId === account.id && selection.labelId === label.id
              )}
              count={
                label.remoteId === SYSTEM_LABELS.inbox
                  ? label.unread
                  : label.remoteId === SYSTEM_LABELS.drafts
                    ? draftCount
                    : undefined
              }
              active={selection.accountId === account.id && selection.labelId === label.id}
              onSelect={() => select({ accountId: account.id, labelId: label.id })}
              onContextMenu={(event) => onContextMenu(label, event)}
            />
          ))}
          {account.kind === 'resend' ? <MailboxRows account={account} /> : null}
          {userLabels.map(({ label, name, depth }) =>
            editing === label.id ? (
              <LabelInput
                key={label.id}
                initial={label.name}
                depth={depth}
                onSubmit={onSubmitEdit}
                onCancel={onCancelEdit}
              />
            ) : (
              <Row
                key={label.id}
                depth={depth}
                label={name}
                icon={<LabelIcon color={label.color ?? account.color} />}
                count={label.unread}
                active={selection.accountId === account.id && selection.labelId === label.id}
                onSelect={() => select({ accountId: account.id, labelId: label.id })}
                onContextMenu={(event) => onContextMenu(label, event)}
              />
            )
          )}
          {editing === 'new' ? (
            <LabelInput initial="" depth={1} onSubmit={onSubmitEdit} onCancel={onCancelEdit} />
          ) : null}
        </>
      )}
    </div>
  )
}

interface SidebarProps {
  /** Opens the keyboard-shortcut overview; the footer row calls it. */
  onShowShortcuts?: () => void
}

export function Sidebar({ onShowShortcuts }: SidebarProps): React.JSX.Element {
  const { accounts, labels, selection, select, counts, refresh, setSearchText, openCompose } =
    useUnibox()
  const [width, setWidth] = useStoredSize(WIDTH_KEY, SIDEBAR_DEFAULT, SIDEBAR_MIN, SIDEBAR_MAX)
  const [rail, setRail] = useStoredFlag(RAIL_KEY, false)
  const [menu, setMenu] = useState<SidebarTarget | null>(null)
  /** Which account is editing a label, and which one — a label id or `'new'`. */
  const [editing, setEditing] = useState<{ accountId: string; target: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  // The row is hidden while nothing waits, so an empty mailbox stays out of a
  // sidebar that is already long.
  const snoozedCount = counts.snoozed ?? 0
  const followUpCount = counts.followups ?? 0
  const followUpOverdue = counts.followupsOverdue ?? 0
  const allActive = selection.accountId === null && selection.labelId === null && !selection.view

  // Label calls reach Gmail, so they fail in ways worth reading; the sidebar
  // shows the cause where the sync error already appears.
  const run = (action: () => Promise<void>): void => {
    setError(null)
    void action()
      .then(() => refresh())
      .catch((cause: unknown) => setError(errorMessage(cause)))
  }

  const submitEdit = (accountId: string, target: string, name: string): void => {
    setEditing(null)
    run(async () => {
      if (target === 'new') await api.invoke('labels:create', accountId, name)
      else await api.invoke('labels:rename', target, name)
    })
  }
  const googleAccounts = accounts.filter((account) => account.kind === 'google')
  const resendAccounts = accounts.filter((account) => account.kind === 'resend')

  return (
    <RailContext.Provider value={rail}>
      <aside
        className={rail ? 'sidebar sidebar--rail' : 'sidebar'}
        style={rail ? undefined : { width }}
      >
        {/* Doubles as the window's drag handle; the traffic lights sit in
            its left end, so the controls start past them. */}
        <div className="sidebar__head">
          <button
            type="button"
            className="sidebar__menu"
            data-tip={rail ? t('sidebar.expand') : t('sidebar.collapse')}
            data-tip-right=""
            aria-label={rail ? t('sidebar.expand') : t('sidebar.collapse')}
            aria-expanded={!rail}
            onClick={() => setRail(!rail)}
          >
            <MenuIcon />
          </button>
          {rail ? null : (
            <span className="sidebar__brand">
              <LogoMark />
              <span className="sidebar__brand-name">{t('sidebar.brand')}</span>
            </span>
          )}
        </div>
        <button
          type="button"
          className="sidebar__compose"
          data-tip={rail ? `${t('sidebar.compose')} · ⌘N` : undefined}
          data-tip-right=""
          aria-label={t('sidebar.compose')}
          aria-keyshortcuts="Meta+N"
          onClick={() => void openCompose()}
        >
          <PenIcon />
          {rail ? null : <span>{t('sidebar.compose')}</span>}
        </button>
        <div className="sidebar__scroll">
          <div className="sidebar__section">
            <Row
              label={t('sidebar.allInboxes')}
              icon={<InboxIcon color={allActive ? ICON_ACTIVE : ICON_MUTED} size={17} />}
              count={counts.all}
              active={allActive}
              onSelect={() => select({ accountId: null, labelId: null })}
            />
            {/* Starred is a label on every account; like the inbox above, one
                row lists it across all of them. Always there, as in Gmail —
                it is where one goes to find what was marked. */}
            <Row
              label={t('sidebar.starred')}
              icon={
                <StarIcon
                  size={17}
                  color={selection.view === 'starred' ? ICON_ACTIVE : ICON_MUTED}
                />
              }
              active={selection.view === 'starred'}
              onSelect={() => select({ accountId: null, labelId: null, view: 'starred' })}
            />
            {/* Not tied to an account: a snooze is a local reminder, and one list
                of everything waiting is the whole point of it. The count is how
                much is waiting, not how much of it is unread. */}
            {snoozedCount > 0 || selection.view === 'snoozed' ? (
              <Row
                label={t('sidebar.snoozed')}
                icon={
                  <ClockIcon
                    size={17}
                    color={selection.view === 'snoozed' ? ICON_ACTIVE : ICON_MUTED}
                  />
                }
                count={snoozedCount}
                active={selection.view === 'snoozed'}
                onSelect={() => select({ accountId: null, labelId: null, view: 'snoozed' })}
              />
            ) : null}
            {/* The outbound mirror of the inbox. The count is what is waiting;
                the row goes red once something in it is actually late, because
                a number alone never told anybody that they are overdue. */}
            {followUpCount > 0 || selection.view === 'followups' ? (
              <Row
                label={t('followup.sidebar')}
                icon={
                  <HourglassIcon
                    size={17}
                    color={
                      followUpOverdue > 0
                        ? ICON_OVERDUE
                        : selection.view === 'followups'
                          ? ICON_ACTIVE
                          : ICON_MUTED
                    }
                  />
                }
                count={followUpCount}
                overdue={followUpOverdue > 0}
                active={selection.view === 'followups'}
                onSelect={() => select({ accountId: null, labelId: null, view: 'followups' })}
              />
            ) : null}
          </div>
          <SavedSearches />
          {[...googleAccounts, ...resendAccounts].map((account) => (
            <AccountSection
              key={account.id}
              account={account}
              labels={labels[account.id] ?? []}
              editing={editing?.accountId === account.id ? editing.target : null}
              onSubmitEdit={(name) =>
                editing ? submitEdit(editing.accountId, editing.target, name) : undefined
              }
              onCancelEdit={() => setEditing(null)}
              onContextMenu={(label, event) => {
                event.preventDefault()
                setMenu({ x: event.clientX, y: event.clientY, account, label })
              }}
            />
          ))}
        </div>
        <InlineError message={error} />
        {rail ? null : (
          <div className="sidebar__footer">
            <button
              type="button"
              className="sidebar__shortcuts"
              aria-keyshortcuts="Shift+Slash"
              onClick={() => onShowShortcuts?.()}
            >
              <KeyboardIcon />
              <span className="sidebar__shortcuts-label">{t('sidebar.shortcuts')}</span>
              <kbd className="kbd">?</kbd>
            </button>
            <p className="sidebar__version">{t('sidebar.version', { version })}</p>
          </div>
        )}
        {rail ? null : (
          <ResizeHandle
            value={width}
            min={SIDEBAR_MIN}
            max={SIDEBAR_MAX}
            label={t('sidebar.resize')}
            onChange={setWidth}
          />
        )}
        {menu ? (
          <SidebarMenu
            {...menu}
            onClose={() => setMenu(null)}
            onRename={(label) => setEditing({ accountId: label.accountId, target: label.id })}
            onCreate={(accountId) => setEditing({ accountId, target: 'new' })}
            onSearch={setSearchText}
            onRun={run}
          />
        ) : null}
      </aside>
    </RailContext.Provider>
  )
}
