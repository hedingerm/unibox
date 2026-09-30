import { useRef, useState } from 'react'
import { t } from '../i18n'
import { useAction } from '../lib/useAction'
import { useThreadLabels, useMailboxKind } from '../lib/mailbox'
import { useUnibox } from '../state'
import { ContextMenu } from './ContextMenu'
import { InlineError } from './InlineError'
import { SnoozeOptions } from './SnoozeMenu'
import { ThreadMenu } from './ThreadMenu'
import {
  ArchiveIcon,
  CheckIcon,
  ClockIcon,
  ForwardIcon,
  LabelIcon,
  MailIcon,
  MailOpenIcon,
  MoreIcon,
  ReplyIcon,
  SettleIcon,
  SpamIcon,
  TrashIcon,
  InboxIcon as RestoreIcon
} from './Icons'

/**
 * Tooltip text with its keyboard shortcut appended. The shortcut only rides
 * along in the hint we draw ourselves — `aria-label` stays the bare action so
 * screen readers announce the shortcut through `aria-keyshortcuts` instead.
 */
function tip(label: string, shortcut: string): string {
  return `${label} · ${shortcut}`
}

function LabelMenu(): React.JSX.Element | null {
  const { changeLabelsSelected } = useUnibox()
  const { accountId, available, applied } = useThreadLabels()
  const [open, setOpen] = useState(false)
  const toggle = useAction(async (labelId: string, isApplied: boolean) => {
    await changeLabelsSelected(isApplied ? [] : [labelId], isApplied ? [labelId] : [])
  })

  // Labels are account-bound, so a selection spanning accounts has none to offer.
  if (!accountId) return null

  return (
    <div style={{ position: 'relative' }}>
      <button
        type="button"
        className="icon-button"
        data-tip={t('toolbar.labels')}
        aria-label={t('toolbar.labels')}
        aria-expanded={open}
        aria-busy={toggle.busy}
        disabled={available.length === 0 || toggle.busy}
        onClick={() => setOpen((value) => !value)}
      >
        <LabelIcon size={16} color="var(--text-muted)" />
      </button>
      {open ? (
        <div
          className="identity-popover"
          style={{ top: 40, left: 0, width: 240 }}
          role="menu"
        >
          {available.map((label) => (
            <button
              key={label.id}
              type="button"
              role="menuitemcheckbox"
              aria-checked={applied.has(label.id)}
              className="identity-popover__item"
              disabled={toggle.busy}
              onClick={() => void toggle.run(label.id, applied.has(label.id))}
            >
              <LabelIcon size={13} color={label.color ?? 'var(--text-faint)'} />
              <span style={{ flex: 1 }}>{label.name}</span>
              {applied.has(label.id) ? <CheckIcon color="var(--accent)" /> : null}
            </button>
          ))}
          <InlineError message={toggle.error} />
        </div>
      ) : null}
    </div>
  )
}

/**
 * Snoozing from the toolbar. It opens the very panel the right-click menu
 * opens, anchored under the button: one set of offers, one way they behave.
 */
function SnoozeButton(): React.JSX.Element {
  const { snoozeSelected, unsnoozeSelected, selectedThreadIds, actionBusy } = useUnibox()
  const { inTrash, inSpam, inSnoozed } = useMailboxKind()
  const button = useRef<HTMLButtonElement>(null)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const disabled = selectedThreadIds.length === 0 || actionBusy !== null

  if (inSnoozed) {
    return (
      <button
        type="button"
        className="icon-button"
        data-tip={t('toolbar.unsnooze')}
        aria-label={t('toolbar.unsnooze')}
        aria-busy={actionBusy === 'unsnooze'}
        disabled={disabled}
        onClick={() => void unsnoozeSelected()}
      >
        <ClockIcon size={16} />
      </button>
    )
  }

  return (
    <>
      <button
        ref={button}
        type="button"
        className="icon-button"
        data-tip={tip(t('toolbar.snooze'), 'B')}
        aria-label={t('toolbar.snooze')}
        aria-keyshortcuts="B"
        aria-expanded={menu !== null}
        aria-busy={actionBusy === 'snooze'}
        disabled={disabled || inTrash || inSpam}
        onClick={() => {
          const rect = button.current?.getBoundingClientRect()
          if (!rect) return
          setMenu({ x: rect.left, y: rect.bottom + 4 })
        }}
      >
        <ClockIcon size={16} />
      </button>
      {menu ? (
        <ContextMenu {...menu} label={t('snooze.title')} onClose={() => setMenu(null)}>
          <SnoozeOptions
            onPick={(wakeAt) => {
              setMenu(null)
              void snoozeSelected(wakeAt)
            }}
          />
        </ContextMenu>
      ) : null}
    </>
  )
}

/** The "more" button: the row's right-click menu, anchored under it. */
function MoreButton(): React.JSX.Element {
  const { selectedThreadIds } = useUnibox()
  const button = useRef<HTMLButtonElement>(null)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  return (
    <>
      <button
        ref={button}
        type="button"
        className="icon-button"
        data-tip={t('toolbar.more')}
        aria-label={t('toolbar.more')}
        aria-expanded={menu !== null}
        disabled={selectedThreadIds.length === 0}
        onClick={() => {
          const rect = button.current?.getBoundingClientRect()
          if (!rect) return
          // Right-aligned to the button, so the menu does not run off the window.
          setMenu({ x: Math.max(8, rect.right - 240), y: rect.bottom + 4 })
        }}
      >
        <MoreIcon />
      </button>
      {menu ? <ThreadMenu {...menu} onClose={() => setMenu(null)} /> : null}
    </>
  )
}

/**
 * The actions on the selection, above the reading pane — MailFlare's reader
 * bar. They act on every selected conversation, exactly like the keyboard
 * shortcuts and the row menu; with several picked, the pane below shows the
 * count while this bar stays where it is.
 */
export function ReaderToolbar(): React.JSX.Element {
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
    openReply,
    openForward,
    openSettle,
    settleOne,
    settling,
    actionBusy
  } = useUnibox()
  const { inTrash, inSpam } = useMailboxKind()
  const busy = actionBusy !== null
  const count = selectedThreadIds.length
  /** Exactly one conversation needs no review — it settles on the spot. */
  const settlesOne = count === 1
  const disabled = count === 0 || busy
  const chosen = new Set(selectedThreadIds)
  // Unread wins in a mixed selection, so the button offers "mark read".
  const unread = threads.some((item) => chosen.has(item.threadId) && item.unread)

  const confirmDelete = (): void => {
    if (!window.confirm(t('toolbar.confirmDeleteForever', { count }))) return
    void deleteSelected()
  }

  return (
    <div className="toolbar" role="toolbar" aria-label={t('toolbar.label')}>
      <button
        type="button"
        className="icon-button"
        data-tip={tip(t('toolbar.reply'), 'R')}
        aria-label={t('toolbar.reply')}
        aria-keyshortcuts="R"
        disabled={count !== 1 || !thread}
        onClick={() => void openReply()}
      >
        <ReplyIcon />
      </button>
      <button
        type="button"
        className="icon-button"
        data-tip={tip(t('toolbar.forward'), 'F')}
        aria-label={t('toolbar.forward')}
        aria-keyshortcuts="F"
        disabled={count !== 1 || !thread}
        onClick={() => void openForward()}
      >
        <ForwardIcon />
      </button>
      <span className="toolbar__divider" />
      {inTrash || inSpam ? (
        <button
          type="button"
          className="icon-button"
          data-tip={t('toolbar.restore')}
          aria-label={t('toolbar.restore')}
          aria-busy={actionBusy === 'untrash' || actionBusy === 'unspam'}
          disabled={disabled}
          onClick={() => void (inTrash ? untrashSelected() : unspamSelected())}
        >
          <RestoreIcon size={16} color="var(--text-muted)" />
        </button>
      ) : (
        <button
          type="button"
          className="icon-button"
          data-tip={tip(t('toolbar.archive'), 'E')}
          aria-label={t('toolbar.archive')}
          aria-keyshortcuts="E"
          aria-busy={actionBusy === 'archive'}
          disabled={disabled}
          onClick={() => void archiveSelected()}
        >
          <ArchiveIcon />
        </button>
      )}
      <button
        type="button"
        className="icon-button"
        data-tip={tip(inSpam ? t('toolbar.notSpam') : t('toolbar.spam'), '!')}
        aria-label={inSpam ? t('toolbar.notSpam') : t('toolbar.spam')}
        aria-keyshortcuts="Shift+1"
        aria-busy={actionBusy === 'spam' || actionBusy === 'unspam'}
        disabled={disabled}
        onClick={() => void (inSpam ? unspamSelected() : spamSelected())}
      >
        <SpamIcon />
      </button>
      {inTrash ? (
        <button
          type="button"
          className="icon-button"
          data-tip={t('toolbar.deleteForever')}
          aria-label={t('toolbar.deleteForever')}
          aria-busy={actionBusy === 'delete'}
          disabled={disabled}
          onClick={confirmDelete}
        >
          <TrashIcon />
        </button>
      ) : (
        <button
          type="button"
          className="icon-button"
          data-tip={tip(t('toolbar.delete'), '#')}
          aria-label={t('toolbar.delete')}
          aria-keyshortcuts="Shift+3"
          aria-busy={actionBusy === 'trash'}
          disabled={disabled}
          onClick={() => void trashSelected()}
        >
          <TrashIcon />
        </button>
      )}
      <button
        type="button"
        className="icon-button"
        data-tip={tip(unread ? t('toolbar.markRead') : t('toolbar.markUnread'), 'U')}
        aria-label={unread ? t('toolbar.markRead') : t('toolbar.markUnread')}
        aria-keyshortcuts="U"
        aria-busy={actionBusy === 'read'}
        disabled={disabled}
        onClick={() => void toggleReadSelected()}
      >
        {unread ? <MailOpenIcon /> : <MailIcon />}
      </button>
      <span className="toolbar__divider" />
      <SnoozeButton />
      <LabelMenu />
      <button
        type="button"
        className="icon-button"
        data-tip={tip(settlesOne ? t('toolbar.settleOne') : t('toolbar.settle'), 'S')}
        aria-label={settlesOne ? t('toolbar.settleOne') : t('toolbar.settle')}
        aria-keyshortcuts="S"
        aria-busy={settling.length > 0}
        disabled={busy}
        onClick={(event) => {
          // A single conversation is settled straight away; the toast and
          // its undo take the place of the review sheet. Holding ⌥ opens
          // the sheet anyway, which is the way back to the whole inbox.
          // Settles in flight do not block this — the mail joins the queue.
          if (settlesOne && !event.altKey) {
            void settleOne(selectedThreadIds[0]!)
            return
          }
          openSettle(true)
        }}
      >
        <SettleIcon />
      </button>
      <div className="toolbar__spacer" />
      <MoreButton />
    </div>
  )
}

/**
 * Actions announce themselves here — at the top of the panel they were
 * started in — instead of as a toast at the far window edge.
 */
export function ActionStatus(): React.JSX.Element | null {
  const { actionError, clearActionError } = useUnibox()
  if (!actionError) return null
  return (
    <div className="toolbar__status">
      <InlineError message={actionError} />
      <button type="button" className="toolbar__status-dismiss" onClick={clearActionError}>
        {t('errors.dismiss')}
      </button>
    </div>
  )
}
