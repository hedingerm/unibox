import { Fragment } from 'react'
import { t } from '../i18n'
import { dueInWorkingDays } from '../lib/followup'
import { buildLabelTree, useMailboxKind, useThreadLabels, type LabelNode } from '../lib/mailbox'
import { useUnibox } from '../state'
import { ContextMenu, MenuDivider, MenuItem, Submenu } from './ContextMenu'
import { SnoozeOptions } from './SnoozeMenu'
import {
  ArchiveIcon,
  CheckIcon,
  ClockIcon,
  HourglassIcon,
  ForwardIcon,
  InboxIcon,
  LabelIcon,
  ReplyIcon,
  SpamIcon,
  TrashIcon,
  InboxIcon as RestoreIcon
} from './Icons'

interface ThreadMenuProps {
  x: number
  y: number
  onClose: () => void
}

/**
 * The right-click menu on a conversation row. It runs on the whole selection,
 * exactly like the toolbar and the keyboard shortcuts do — right-clicking a row
 * outside the selection has already reduced the selection to that row.
 */
export function ThreadMenu({ x, y, onClose }: ThreadMenuProps): React.JSX.Element {
  const {
    thread,
    threads,
    selectedThreadIds,
    archiveSelected,
    trashSelected,
    untrashSelected,
    deleteSelected,
    spamSelected,
    unspamSelected,
    toggleReadSelected,
    changeLabelsSelected,
    snoozeSelected,
    unsnoozeSelected,
    expectReply,
    clearFollowUp,
    settings,
    followUps,
    openReply,
    openForward
  } = useUnibox()
  const { available, applied, inboxLabelId, currentLabelId } = useThreadLabels()
  const { inTrash, inSpam, inSnoozed } = useMailboxKind()
  // Only a single conversation can be told to expect an answer, so the row
  // needs the one it applies to — and whether it is already waiting.
  const only = selectedThreadIds.length === 1 ? (selectedThreadIds[0] ?? null) : null
  const waiting = only
    ? followUps.some((entry) => entry.threadId === only)
    : false

  const count = selectedThreadIds.length
  const chosen = new Set(selectedThreadIds)
  // Unread wins in a mixed selection, so the item offers "mark read".
  const unread = threads.some((item) => chosen.has(item.threadId) && item.unread)

  const run = (action: () => Promise<void>): void => {
    onClose()
    void action()
  }

  const confirmDelete = (): void => {
    if (!window.confirm(t('toolbar.confirmDeleteForever', { count }))) return
    run(deleteSelected)
  }

  /** A move is Gmail's own: apply the label and leave the mailbox behind. */
  const moveTo = (labelId: string): void => {
    const remove = [inboxLabelId, currentLabelId].filter(
      (id): id is string => Boolean(id) && id !== labelId
    )
    run(() => changeLabelsSelected([labelId], remove))
  }

  const toggleLabel = (labelId: string, isApplied: boolean): void => {
    // Labelling is not a move, so the menu stays open for a second label.
    void changeLabelsSelected(isApplied ? [] : [labelId], isApplied ? [labelId] : [])
  }

  /**
   * `Kunden/Offerten` is one Gmail label, but two rows here. A branch that is a
   * label in its own right leads its own flyout, above the children it holds.
   */
  const renderNodes = (nodes: LabelNode[], mode: 'labels' | 'move'): React.ReactNode =>
    nodes.map((node) => {
      const own = node.label
      const icon = <LabelIcon size={13} color={own?.color ?? 'var(--text-faint)'} />
      const isApplied = Boolean(own && applied.has(own.id))
      const row = own ? (
        <MenuItem
          label={node.name}
          icon={icon}
          checked={mode === 'labels' ? isApplied : undefined}
          onClick={() => (mode === 'labels' ? toggleLabel(own.id, isApplied) : moveTo(own.id))}
        />
      ) : null

      if (node.children.length === 0) return row ? <Fragment key={node.path}>{row}</Fragment> : null

      return (
        <Submenu
          key={node.path}
          label={node.name}
          icon={icon}
          checked={mode === 'labels' ? isApplied : undefined}
        >
          {row ? (
            <>
              {row}
              <MenuDivider />
            </>
          ) : null}
          {renderNodes(node.children, mode)}
        </Submenu>
      )
    })

  const tree = buildLabelTree(available)

  return (
    <ContextMenu x={x} y={y} label={t('menu.thread')} onClose={onClose}>
      <MenuItem
        label={t('toolbar.reply')}
        icon={<ReplyIcon size={14} />}
        disabled={count !== 1 || !thread}
        onClick={() => run(openReply)}
      />
      <MenuItem
        label={t('toolbar.forward')}
        icon={<ForwardIcon size={14} />}
        disabled={count !== 1 || !thread}
        onClick={() => run(openForward)}
      />
      <MenuItem
        label={unread ? t('toolbar.markRead') : t('toolbar.markUnread')}
        icon={<InboxIcon size={14} />}
        onClick={() => run(toggleReadSelected)}
      />
      <MenuDivider />
      {inTrash || inSpam ? (
        <MenuItem
          label={t('toolbar.restore')}
          icon={<RestoreIcon size={14} />}
          onClick={() => run(inTrash ? untrashSelected : unspamSelected)}
        />
      ) : (
        <MenuItem
          label={t('toolbar.archive')}
          icon={<ArchiveIcon size={14} />}
          onClick={() => run(archiveSelected)}
        />
      )}
      {inSnoozed ? (
        <MenuItem
          label={t('toolbar.unsnooze')}
          icon={<ClockIcon size={14} />}
          onClick={() => run(unsnoozeSelected)}
        />
      ) : null}
      {inTrash || inSpam ? null : (
        <Submenu label={t('snooze.title')} icon={<ClockIcon size={13} />}>
          <SnoozeOptions onPick={(wakeAt) => run(() => snoozeSelected(wakeAt))} />
        </Submenu>
      )}
      {/* A wait belongs to one conversation — there is no sensible bulk form of
          "I am expecting an answer to this", so it needs a single row. */}
      {count === 1 && only ? (
        waiting ? (
          <MenuItem
            label={t('followup.done')}
            icon={<CheckIcon size={12} color="var(--text-faint)" />}
            onClick={() => run(() => clearFollowUp(only))}
          />
        ) : (
          <MenuItem
            label={t('followup.remind')}
            icon={<HourglassIcon size={13} />}
            onClick={() => run(() => expectReply(only, dueInWorkingDays(settings.followUpDays)))}
          />
        )
      ) : null}
      {available.length > 0 ? (
        <>
          <Submenu label={t('menu.labels')} icon={<LabelIcon size={13} />}>
            {renderNodes(tree, 'labels')}
          </Submenu>
          <Submenu label={t('menu.moveTo')} icon={<LabelIcon size={13} />}>
            {renderNodes(tree, 'move')}
          </Submenu>
        </>
      ) : null}
      <MenuDivider />
      <MenuItem
        label={inSpam ? t('toolbar.notSpam') : t('toolbar.spam')}
        icon={<SpamIcon size={14} />}
        onClick={() => run(inSpam ? unspamSelected : spamSelected)}
      />
      {inTrash ? (
        <MenuItem
          label={t('toolbar.deleteForever')}
          icon={<TrashIcon size={14} />}
          danger
          onClick={confirmDelete}
        />
      ) : (
        <MenuItem
          label={t('toolbar.delete')}
          icon={<TrashIcon size={14} />}
          danger
          onClick={() => run(trashSelected)}
        />
      )}
    </ContextMenu>
  )
}
