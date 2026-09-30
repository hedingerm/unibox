import type { Account, LabelWithCounts } from '@shared/types'
import { SYSTEM_LABELS } from '@shared/types'
import { labelName, t } from '../i18n'
import { api } from '../lib/bridge'
import { ContextMenu, MenuDivider, MenuItem } from './ContextMenu'
import {
  DraftIcon,
  InboxIcon,
  LabelIcon,
  RefreshIcon,
  SearchIcon,
  TrashIcon,
  SettingsIcon
} from './Icons'

export interface SidebarTarget {
  x: number
  y: number
  account: Account
  /** The label the pointer was over, or `null` for the account header itself. */
  label: LabelWithCounts | null
}

interface SidebarMenuProps extends SidebarTarget {
  onClose: () => void
  onRename: (label: LabelWithCounts) => void
  onCreate: (accountId: string) => void
  onSearch: (query: string) => void
  /** Runs a call that can fail, so the sidebar can show the reason. */
  onRun: (action: () => Promise<void>) => void
}

/**
 * The right-click menu on a sidebar row. Labels are Gmail's own, so creating,
 * renaming and deleting one goes through the account before it shows up here.
 */
export function SidebarMenu({
  x,
  y,
  account,
  label,
  onClose,
  onRename,
  onCreate,
  onSearch,
  onRun
}: SidebarMenuProps): React.JSX.Element {
  const isUserLabel = label?.type === 'user'
  const isTrash = label?.remoteId === SYSTEM_LABELS.trash
  const isSpam = label?.remoteId === SYSTEM_LABELS.spam
  const title = label ? labelName(label.remoteId, label.name) : account.email

  const close = (run: () => void): void => {
    onClose()
    run()
  }

  const confirmRemoveLabel = (): void => {
    if (!label) return
    if (!window.confirm(t('sidebar.confirmDeleteLabel', { name: label.name }))) return
    close(() => onRun(() => api.invoke('labels:remove', label.id)))
  }

  const confirmEmpty = (): void => {
    if (!label) return
    if (!window.confirm(t('sidebar.confirmEmpty', { name: labelName(label.remoteId, label.name) })))
      return
    close(() => onRun(() => api.invoke('labels:empty', label.id)))
  }

  const confirmRemoveAccount = (): void => {
    if (!window.confirm(t('sidebar.confirmRemoveAccount', { email: account.email }))) return
    close(() => onRun(() => api.invoke('accounts:remove', account.id)))
  }

  return (
    <ContextMenu x={x} y={y} label={title} onClose={onClose}>
      {label ? (
        <>
          <MenuItem
            label={t('sidebar.markAllRead')}
            icon={<InboxIcon size={14} />}
            disabled={label.unread === 0}
            onClick={() => close(() => onRun(() => api.invoke('labels:markAllRead', label.id)))}
          />
          <MenuItem
            label={t('sidebar.searchLabel')}
            icon={<SearchIcon size={14} />}
            onClick={() => close(() => onSearch(`label:"${label.name}"`))}
          />
          {isUserLabel ? (
            <>
              <MenuDivider />
              <MenuItem
                label={t('sidebar.renameLabel')}
                icon={<LabelIcon size={13} />}
                onClick={() => close(() => onRename(label))}
              />
              <MenuItem
                label={t('sidebar.deleteLabel')}
                icon={<TrashIcon size={14} />}
                danger
                onClick={confirmRemoveLabel}
              />
            </>
          ) : null}
          {isTrash || isSpam ? (
            <>
              <MenuDivider />
              <MenuItem
                label={t('sidebar.emptyMailbox')}
                icon={<TrashIcon size={14} />}
                danger
                onClick={confirmEmpty}
              />
            </>
          ) : null}
          <MenuDivider />
        </>
      ) : null}
      <MenuItem
        label={t('sidebar.newLabel')}
        icon={<DraftIcon size={14} />}
        onClick={() => close(() => onCreate(account.id))}
      />
      <MenuItem
        label={t('toolbar.refresh')}
        icon={<RefreshIcon size={14} />}
        onClick={() => close(() => onRun(() => api.invoke('sync:now')))}
      />
      {account.kind === 'google' ? (
        <MenuItem
          label={t('sidebar.reconnect')}
          icon={<SettingsIcon size={14} />}
          onClick={() =>
            close(() =>
              onRun(async () => {
                await api.invoke('google:reconnect', account.id)
              })
            )
          }
        />
      ) : null}
      <MenuItem
        label={t('sidebar.removeAccount')}
        icon={<TrashIcon size={14} />}
        danger
        onClick={confirmRemoveAccount}
      />
    </ContextMenu>
  )
}
