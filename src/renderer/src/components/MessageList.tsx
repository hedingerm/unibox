import React, { useCallback, useEffect, useRef, useState } from 'react'
import type { Account, ThreadSummary } from '@shared/types'
import { t } from '../i18n'
import { displayName, formatListDate, formatSnoozeUntil, listSection } from '../lib/format'
import { formatFollowUpDue, isOverdue } from '../lib/followup'
import { useMailboxKind } from '../lib/mailbox'
import { draftIdOfRow, useUnibox } from '../state'
import { ArchiveIcon, ClockIcon, MailIcon, MailOpenIcon, StarIcon, TrashIcon } from './Icons'
import { ContextMenu } from './ContextMenu'
import { SnoozeOptions } from './SnoozeMenu'
import { ThreadMenu } from './ThreadMenu'

/**
 * Rows are a fixed height by construction — every line is a single ellipsised
 * run — which is what lets the list be windowed without measuring anything.
 * Keep in sync with `--list-row-height` in styles.css.
 */
export const ROW_HEIGHT = 88

/**
 * Height of a section divider. Like the row height it is fixed by construction,
 * so the windowing maths stays arithmetic. Keep in sync with `.list__section`.
 */
export const SECTION_HEIGHT = 28

/** Rows drawn above and below the viewport so a fast scroll shows no gaps. */
const OVERSCAN = 8

/** jsdom and a not-yet-measured container report no height; assume a window. */
const ASSUMED_VIEWPORT = 900

/** How close to the end the user must scroll before the next page is pulled. */
const LOAD_MORE_THRESHOLD = ROW_HEIGHT * 6

/**
 * The account badge is the one badge whose colour is data, so it is written
 * inline: the account colour on a wash of itself.
 */
function badgeStyle(color: string): React.CSSProperties {
  return { color, background: `${color}1f` }
}

function accountBadge(account: Account | undefined): string {
  if (!account) return ''
  if (account.kind === 'resend') return account.email
  const domain = account.email.split('@')[1] ?? account.email
  return domain === 'gmail.com' ? 'gmail' : domain
}

/** Where a conversation stands in the settle queue, or null for the usual case. */
type SettleState = 'settling' | 'queued' | null

/**
 * The buttons that take the date's place while the pointer is on a row. They
 * act on that row alone — reaching past the selection is the point of them.
 * Only the hovered row renders them, so a list of thousands carries none.
 */
function RowActions({
  summary,
  onSnooze
}: {
  summary: ThreadSummary
  onSnooze: (anchor: DOMRect) => void
}): React.JSX.Element {
  const { actOnThread, actionBusy } = useUnibox()
  const { inTrash, inSpam, inSnoozed } = useMailboxKind()
  const busy = actionBusy !== null
  const id = summary.threadId
  // The row's own click selects it; a button inside must not do that too.
  const act = (event: React.MouseEvent, run: () => void): void => {
    event.stopPropagation()
    run()
  }
  return (
    <div className="list__actions">
      {inTrash || inSpam ? null : (
        <button
          type="button"
          className="list__action"
          title={t('toolbar.archive')}
          aria-label={t('toolbar.archive')}
          disabled={busy}
          onClick={(event) => act(event, () => void actOnThread(id, 'archive'))}
        >
          <ArchiveIcon size={16} />
        </button>
      )}
      {inTrash ? null : (
        <button
          type="button"
          className="list__action"
          title={t('toolbar.delete')}
          aria-label={t('toolbar.delete')}
          disabled={busy}
          onClick={(event) => act(event, () => void actOnThread(id, 'trash'))}
        >
          <TrashIcon size={16} />
        </button>
      )}
      <button
        type="button"
        className="list__action"
        title={summary.unread ? t('toolbar.markRead') : t('toolbar.markUnread')}
        aria-label={summary.unread ? t('toolbar.markRead') : t('toolbar.markUnread')}
        disabled={busy}
        onClick={(event) =>
          act(event, () => void actOnThread(id, summary.unread ? 'read' : 'unread'))
        }
      >
        {summary.unread ? <MailOpenIcon size={16} /> : <MailIcon size={16} />}
      </button>
      {inSnoozed ? (
        <button
          type="button"
          className="list__action"
          title={t('toolbar.unsnooze')}
          aria-label={t('toolbar.unsnooze')}
          disabled={busy}
          onClick={(event) => act(event, () => void actOnThread(id, 'unsnooze'))}
        >
          <ClockIcon size={16} />
        </button>
      ) : inTrash || inSpam ? null : (
        <button
          type="button"
          className="list__action"
          title={t('toolbar.snooze')}
          aria-label={t('toolbar.snooze')}
          disabled={busy}
          onClick={(event) =>
            act(event, () => onSnooze(event.currentTarget.getBoundingClientRect()))
          }
        >
          <ClockIcon size={16} />
        </button>
      )}
    </div>
  )
}

interface RowProps {
  summary: ThreadSummary
  account: Account | undefined
  /** In the set an action would apply to. */
  selected: boolean
  /** The one row the reading pane and keyboard navigation follow. */
  focused: boolean
  /** Several rows are picked, so every row shows its checkbox. */
  picking: boolean
  hovered: boolean
  /** Being classified right now, or waiting for a free slot. */
  settle: SettleState
  onSelect: (event: React.MouseEvent) => void
  onCheck: () => void
  onContextMenu: (event: React.MouseEvent) => void
  onHover: (hovered: boolean) => void
  onSnooze: (anchor: DOMRect) => void
  onStar: () => void
}

function Row({
  summary,
  account,
  selected,
  focused,
  picking,
  hovered,
  settle,
  onSelect,
  onCheck,
  onContextMenu,
  onHover,
  onSnooze,
  onStar
}: RowProps): React.JSX.Element {
  // An unfinished reply is what the row is really about: it shows the draft's
  // text under its own marker, so nobody mistakes it for an answer already out.
  const draft = summary.draft
  const isDraftRow = draftIdOfRow(summary.threadId) !== null
  const prefix = !draft && summary.lastDirection === 'outgoing' ? `${t('list.you')}: ` : ''
  return (
    <div
      role="option"
      tabIndex={0}
      className={[
        'list__row',
        summary.unread ? 'list__row--unread' : '',
        selected ? 'list__row--selected' : '',
        focused ? 'list__row--focused' : '',
        picking ? 'list__row--picking' : '',
        settle ? `list__row--${settle}` : ''
      ]
        .filter(Boolean)
        .join(' ')}
      aria-selected={selected}
      aria-current={focused}
      aria-busy={settle !== null}
      // The wave alone says "something is happening"; this says what. A plain
      // title, not the app's own hint: the row clips its overflow, so a hint
      // drawn inside it would be cut off.
      title={settle ? t(settle === 'settling' ? 'settle.settling' : 'settle.queued') : undefined}
      onClick={onSelect}
      onContextMenu={onContextMenu}
      onMouseEnter={() => onHover(true)}
      onMouseLeave={() => onHover(false)}
    >
      <span className="list__lead">
        <input
          type="checkbox"
          className="checkbox list__check"
          aria-label={t('list.select')}
          checked={selected}
          tabIndex={-1}
          onClick={(event) => event.stopPropagation()}
          onChange={onCheck}
        />
        {/* A draft row stands for no conversation, so there is nothing to star. */}
        {isDraftRow ? null : (
          <button
            type="button"
            className={summary.starred ? 'list__star list__star--on' : 'list__star'}
            aria-label={summary.starred ? t('star.remove') : t('star.add')}
            aria-pressed={summary.starred}
            title={summary.starred ? t('star.remove') : t('star.add')}
            tabIndex={-1}
            onClick={(event) => {
              event.stopPropagation()
              onStar()
            }}
          >
            <StarIcon size={16} filled={summary.starred} />
          </button>
        )}
      </span>
      <span className="list__main">
        <span className="list__row-top">
          <span className="list__sender">{displayName(summary.lastFrom)}</span>
          {hovered && !isDraftRow ? (
            <RowActions summary={summary} onSnooze={onSnooze} />
          ) : (
            <span className="list__date">{formatListDate(summary.lastMessageAt)}</span>
          )}
        </span>
        <span className="list__subject-line">
          <span className="list__subject">{summary.subject}</span>
          {summary.unread ? <span className="list__unread-dot" /> : null}
        </span>
        <span className="list__bottom">
          <span className="list__snippet">
            {draft ? <span className="list__draft">{t('list.draft')}</span> : null}
            {prefix}
            {draft ? draft.snippet : summary.snippet}
          </span>
          {/* The answer this conversation is still owed. It rides on every row,
              not just in its own mailbox: seeing it in the inbox is what stops
              the mail being forgotten in the first place. */}
          {summary.followUp ? (
            <span
              className={
                isOverdue(summary.followUp.dueAt)
                  ? 'badge badge--followup badge--followup-overdue'
                  : 'badge badge--followup'
              }
            >
              {formatFollowUpDue(summary.followUp.dueAt)}
            </span>
          ) : null}
          {/* Where the row's date says when it last moved, this says when it comes
              back — the only thing about a snoozed row that is still ahead. */}
          {summary.snoozedUntil !== null ? (
            <span className="badge badge--snoozed">
              {t('snooze.badge', { when: formatSnoozeUntil(summary.snoozedUntil) })}
            </span>
          ) : null}
          {account ? (
            <span className="badge" style={badgeStyle(account.color)}>
              {accountBadge(account)}
            </span>
          ) : null}
        </span>
      </span>
    </div>
  )
}

interface Placed {
  summary: ThreadSummary
  /** Offset of the row itself; a section label sits in the SECTION_HEIGHT above. */
  top: number
  /** The label opening a new section here, or null to continue the current one. */
  section: string | null
  /** The section this row belongs to, whether or not it opens one. */
  label: string
}

/**
 * Walks the (date-sorted) list once, deciding where a section opens and what
 * each row's offset is. Search results come back ranked by relevance rather
 * than by date, so they are left ungrouped instead of repeating the same
 * label every few rows.
 */
function place(threads: ThreadSummary[], grouped: boolean): { rows: Placed[]; height: number } {
  let offset = 0
  let current = ''
  const rows = threads.map((summary) => {
    const label = grouped ? listSection(summary.lastMessageAt) : ''
    const section = label && label !== current ? label : null
    current = label
    if (section) offset += SECTION_HEIGHT
    const top = offset
    offset += ROW_HEIGHT
    return { summary, top, section, label }
  })
  return { rows, height: offset }
}

export function MessageList(): React.JSX.Element {
  const {
    threads,
    accounts,
    selectedThreadId,
    selectedThreadIds,
    selectThread,
    openDraft,
    loading,
    searchResults,
    hasMore,
    loadingMore,
    loadMore,
    selection,
    settling,
    settleQueued,
    actOnThread,
    toggleStar
  } = useUnibox()
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [hovered, setHovered] = useState<string | null>(null)
  // The snooze offers of a row's hover button. Kept here, not in the row: the
  // pointer leaves the row on its way into the menu, and the row's buttons go.
  const [snoozeMenu, setSnoozeMenu] = useState<{ x: number; y: number; threadId: string } | null>(
    null
  )
  const accountsById = new Map(accounts.map((account) => [account.id, account]))
  const chosen = new Set(selectedThreadIds)
  const running = new Set(settling)
  const waiting = new Set(settleQueued)
  const container = useRef<HTMLDivElement>(null)
  // `selection` is the selected thread the offset was last settled for; while
  // it lags behind the real selection the list is pulled to the new row.
  const [scroll, setScroll] = useState<{ top: number; selection: string | null }>({
    top: 0,
    selection: null
  })
  const [viewport, setViewport] = useState(0)

  useEffect(() => {
    const element = container.current
    if (!element) return
    const measure = (): void => setViewport(element.clientHeight)
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const height = viewport || ASSUMED_VIEWPORT
  const grouped = !searchResults
  const { rows, height: total } = place(threads, grouped)

  // Keyboard navigation must be able to reach rows outside the window, so a
  // selection the user cannot see pulls the list to it. The scroll position
  // remembers which selection it was last released by: scrolling releases the
  // anchor, so a selected row can be scrolled out of sight and stay there.
  const selectedIndex = threads.findIndex((item) => item.threadId === selectedThreadId)
  const placed = rows[selectedIndex]
  const anchor = selectedThreadId && selectedThreadId !== scroll.selection ? placed : undefined
  // A row scrolled to the top comes to rest under the pinned label rather than
  // behind it, which is also what keeps its own section label readable.
  const top = anchor ? Math.max(0, anchor.top - (grouped ? SECTION_HEIGHT : 0)) : 0
  const bottom = anchor ? anchor.top + ROW_HEIGHT : 0
  const position =
    !anchor
      ? scroll.top
      : top < scroll.top
        ? top
        : bottom > scroll.top + height
          ? bottom - height
          : scroll.top

  // The window is already at `position`; this only moves the real scrollbar to
  // match, which then feeds the offset back through `onScroll`.
  useEffect(() => {
    const element = container.current
    if (element && element.scrollTop !== position) element.scrollTo?.({ top: position })
  }, [position])

  // Right-clicking outside the selection aims at that row alone; right-clicking
  // inside it keeps the selection, so the menu acts on all chosen rows.
  const openMenu = (threadId: string, event: React.MouseEvent): void => {
    event.preventDefault()
    if (!chosen.has(threadId)) selectThread(threadId)
    setMenu({ x: event.clientX, y: event.clientY })
  }

  // Section labels make offsets non-uniform, so the window edges are found by
  // scanning the placements rather than dividing by a constant row height.
  const from = position - OVERSCAN * ROW_HEIGHT
  const to = position + height + OVERSCAN * ROW_HEIGHT
  let first = rows.findIndex((row) => row.top + ROW_HEIGHT > from)
  if (first < 0) first = Math.max(0, rows.length - 1)
  let last = first
  while (last < rows.length && rows[last]!.top < to) last += 1
  const head = rows[first]
  const windowTop = head ? head.top - (head.section ? SECTION_HEIGHT : 0) : 0

  // The label of the section at the top of the viewport is pinned there — being
  // windowed, the list usually does not have that section's own label in the
  // DOM any more. The next label pushes it off as it arrives.
  const topIndex = rows.findIndex((row) => row.top + ROW_HEIGHT > position)
  const pinned = topIndex < 0 ? null : (rows[topIndex]?.label ?? null)
  let push = 0
  for (let index = topIndex + 1; index >= 1 && index < rows.length; index += 1) {
    const label = rows[index]!.top - SECTION_HEIGHT
    if (label >= position + SECTION_HEIGHT) break
    if (rows[index]!.section) push = Math.min(0, label - position - SECTION_HEIGHT)
  }

  const onScroll = useCallback(
    (event: React.UIEvent<HTMLDivElement>) => {
      const element = event.currentTarget
      // Recording the selection here is what releases the anchor above.
      setScroll({ top: element.scrollTop, selection: selectedThreadId })
      const remaining = element.scrollHeight - element.scrollTop - element.clientHeight
      if (remaining < LOAD_MORE_THRESHOLD) void loadMore()
    },
    [loadMore, selectedThreadId]
  )

  if (loading) {
    return (
      <div className="list">
        <p className="list__empty">{t('list.loading')}</p>
      </div>
    )
  }

  if (threads.length === 0) {
    return (
      <div className="list" role="listbox" aria-label={t('sidebar.allInboxes')}>
        <p className="list__empty">
          {searchResults
            ? t('list.emptySearch')
            : selection.view === 'followups'
              ? t('followup.empty')
              : selection.view === 'starred'
                ? t('star.empty')
                : t('list.empty')}
        </p>
      </div>
    )
  }

  return (
    <>
      <div
        className="list"
        role="listbox"
        aria-multiselectable="true"
        aria-label={t('sidebar.allInboxes')}
        ref={container}
        onScroll={onScroll}
      >
        {/* A visual duplicate of the label already in the flow below, so it is
          hidden from assistive tech rather than announced twice. */}
        {pinned ? (
          <div
            className="list__section list__section--pinned"
            style={{ transform: `translateY(${push}px)` }}
            role="presentation"
            aria-hidden="true"
          >
            {pinned}
          </div>
        ) : null}
        {/* One tall spacer carries the real scroll height; only the rows in view
          are actually in the DOM, so a mailbox of thousands stays fluid. */}
        <div className="list__viewport" style={{ height: total }}>
          {/* Labels and rows are laid out in flow inside the window, which
            reproduces the placements exactly because both heights are fixed. */}
          <div className="list__window" style={{ transform: `translateY(${windowTop}px)` }}>
            {rows.slice(first, last).map(({ summary, section }) => (
              <React.Fragment key={summary.threadId}>
                {section ? (
                  <div className="list__section" role="presentation">
                    {section}
                  </div>
                ) : null}
                <Row
                  summary={summary}
                  account={accountsById.get(summary.accountId)}
                  selected={chosen.has(summary.threadId)}
                  focused={summary.threadId === selectedThreadId}
                  picking={chosen.size > 1}
                  hovered={hovered === summary.threadId}
                  onHover={(inside) =>
                    setHovered((current) =>
                      inside ? summary.threadId : current === summary.threadId ? null : current
                    )
                  }
                  onCheck={() => selectThread(summary.threadId, { toggle: true })}
                  onSnooze={(rect) =>
                    setSnoozeMenu({ x: rect.left, y: rect.bottom + 4, threadId: summary.threadId })
                  }
                  onStar={() => void toggleStar(summary.threadId, !summary.starred)}
                  settle={
                    running.has(summary.threadId)
                      ? 'settling'
                      : waiting.has(summary.threadId)
                        ? 'queued'
                        : null
                  }
                  onSelect={(event) => {
                    const draftId = draftIdOfRow(summary.threadId)
                    // A draft has nothing to read: opening the row *is* opening
                    // the window it was written in.
                    if (draftId && !event.shiftKey && !event.metaKey && !event.ctrlKey) {
                      selectThread(summary.threadId)
                      void openDraft(draftId)
                      return
                    }
                    selectThread(summary.threadId, {
                      range: event.shiftKey,
                      toggle: event.metaKey || event.ctrlKey
                    })
                  }}
                  onContextMenu={(event) => openMenu(summary.threadId, event)}
                />
              </React.Fragment>
            ))}
          </div>
        </div>
        {hasMore ? (
          <p className="list__more" aria-live="polite">
            {loadingMore ? t('list.loadingMore') : t('list.more')}
          </p>
        ) : null}
      </div>
      {menu ? <ThreadMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)} /> : null}
      {snoozeMenu ? (
        <ContextMenu
          x={snoozeMenu.x}
          y={snoozeMenu.y}
          label={t('snooze.title')}
          onClose={() => setSnoozeMenu(null)}
        >
          <SnoozeOptions
            onPick={(wakeAt) => {
              setSnoozeMenu(null)
              void actOnThread(snoozeMenu.threadId, 'snooze', wakeAt)
            }}
          />
        </ContextMenu>
      ) : null}
    </>
  )
}
