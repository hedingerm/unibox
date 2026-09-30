import { useEffect, useRef, useState } from 'react'
import type { ThreadDetail } from '@shared/types'
import { SYSTEM_LABELS } from '@shared/types'
import { labelName, t } from '../i18n'
import { dueInWorkingDays, formatFollowUpDue, isOverdue } from '../lib/followup'
import { avatarColors, displayName, formatListDate, initials } from '../lib/format'
import { useUnibox } from '../state'
import { Compose } from './Compose'
import { MessageView, type FullMessage } from './MessageView'
import { CheckIcon, CloseIcon, ForwardIcon, HourglassIcon, ReplyIcon, StarIcon } from './Icons'
import { ReaderToolbar } from './Toolbar'

/**
 * The bar that says a conversation is waiting for an answer, and the two ways
 * out of it: write again, or declare the matter settled. It sits in the header
 * rather than at the reply line because it is a fact about the conversation,
 * not an action on the draft.
 */
function FollowUpBar({ threadId }: { threadId: string }): React.JSX.Element | null {
  const { followUps, settings, expectReply, clearFollowUp, openReply } = useUnibox()
  const waiting = followUps.find((entry) => entry.threadId === threadId)?.followUp ?? null
  if (!waiting) return null
  const late = isOverdue(waiting.dueAt)
  return (
    <div className={late ? 'followup-bar followup-bar--overdue' : 'followup-bar'} role="status">
      <HourglassIcon size={14} color={late ? 'var(--danger)' : 'var(--text-faint)'} />
      <span className="followup-bar__label">{t('followup.title')}</span>
      <span className="followup-bar__due">{formatFollowUpDue(waiting.dueAt)}</span>
      {waiting.nudgeCount > 0 ? (
        <span className="followup-bar__nudges">
          {waiting.nudgeCount === 1
            ? t('followup.nudgedOnce')
            : t('followup.nudged', { count: waiting.nudgeCount })}
        </span>
      ) : null}
      <button type="button" className="followup-bar__action" onClick={() => void openReply()}>
        <ReplyIcon size={13} color="var(--accent)" />
        <span>{t('followup.nudge')}</span>
      </button>
      <button
        type="button"
        className="followup-bar__action"
        onClick={() => void expectReply(threadId, dueInWorkingDays(settings.followUpDays))}
      >
        <HourglassIcon size={13} color="var(--accent)" />
        <span>{t('followup.reschedule')}</span>
      </button>
      <button
        type="button"
        className="followup-bar__action"
        onClick={() => void clearFollowUp(threadId)}
      >
        <CheckIcon size={12} color="var(--accent)" />
        <span>{t('followup.done')}</span>
      </button>
    </div>
  )
}

/**
 * The labels the conversation sits in, as removable chips next to its subject.
 * Only the inbox and the user's own labels: the rest (UNREAD, SENT, categories)
 * are states or places, not something one takes a mail out of by hand.
 */
function LabelChips({ thread }: { thread: ThreadDetail }): React.JSX.Element | null {
  const { labels, changeLabelsSelected } = useUnibox()
  const present = new Set(thread.messages.flatMap((message) => message.labelIds))
  const chips = (labels[thread.accountId] ?? []).filter(
    (label) =>
      present.has(label.id) && (label.type === 'user' || label.remoteId === SYSTEM_LABELS.inbox)
  )
  if (chips.length === 0) return null
  return (
    <span className="reading__chips">
      {chips.map((label) => {
        const name = label.type === 'system' ? labelName(label.remoteId, label.name) : label.name
        return (
          <span
            key={label.id}
            className="label-chip"
            style={label.color ? { color: label.color, background: `${label.color}1f` } : undefined}
          >
            <span>{name}</span>
            <button
              type="button"
              className="label-chip__remove"
              aria-label={t('reading.removeLabel', { name })}
              title={t('reading.removeLabel', { name })}
              tabIndex={-1}
              onClick={() => void changeLabelsSelected([], [label.id])}
            >
              <CloseIcon size={9} />
            </button>
          </span>
        )
      })}
    </span>
  )
}

const isUnread = (message: FullMessage): boolean =>
  message.labelIds.some((id) => id.endsWith(':l:UNREAD'))

/** A message folded to one line: who wrote, the first words, when. */
function CollapsedMessage({
  message,
  onExpand
}: {
  message: FullMessage
  onExpand: () => void
}): React.JSX.Element {
  const colors = avatarColors(message.from)
  return (
    <button
      type="button"
      className={isUnread(message) ? 'message-folded message-folded--unread' : 'message-folded'}
      onClick={onExpand}
      title={t('reading.expandMessage')}
    >
      <span
        className="avatar avatar--small"
        style={{ background: colors.background, color: colors.color }}
      >
        {initials(message.from)}
      </span>
      <span className="message-folded__from">{displayName(message.from)}</span>
      <span className="message-folded__snippet">{message.snippet}</span>
      <span className="message-folded__date">{formatListDate(message.date)}</span>
    </button>
  )
}

/**
 * The conversation, opened on its newest message. Older ones fold to a line
 * each: a long thread rendered whole starts at its oldest mail, so what you
 * see on opening is the mail you already answered. Anything still unread stays
 * open — that is the part that hasn't been read yet. Mounted with the thread id
 * as `key`, so both decisions are made once per conversation and marking it
 * read a moment later does not fold the message you are looking at.
 */
function ThreadMessages({ messages }: { messages: FullMessage[] }): React.JSX.Element {
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    const open = new Set(messages.filter(isUnread).map((message) => message.id))
    const last = messages[messages.length - 1]
    if (last) open.add(last.id)
    return open
  })
  const newest = useRef<HTMLDivElement>(null)
  // The newest message is at the bottom; without this the pane opens scrolled
  // to the top of a conversation whose point is at the other end.
  useEffect(() => {
    newest.current?.scrollIntoView({ block: 'start' })
  }, [])

  const expand = (id: string): void =>
    setExpanded((previous) => new Set(previous).add(id))
  const folded = messages.filter((message) => !expanded.has(message.id))

  return (
    <div className="reading__messages">
      {folded.length > 1 ? (
        <button
          type="button"
          className="reading__expand-all"
          onClick={() => setExpanded(new Set(messages.map((message) => message.id)))}
        >
          {t('reading.expandAll', { count: folded.length })}
        </button>
      ) : null}
      {messages.map((message) => (
        <div key={message.id} ref={message.id === messages[messages.length - 1]?.id ? newest : null}>
          {expanded.has(message.id) ? (
            <MessageView message={message} />
          ) : (
            <CollapsedMessage message={message} onExpand={() => expand(message.id)} />
          )}
        </div>
      ))}
    </div>
  )
}

export function ReadingPane(): React.JSX.Element {
  const {
    thread,
    threads,
    accounts,
    openReply,
    openForward,
    identities,
    selectedThreadIds,
    compose,
    toggleStar
  } = useUnibox()

  // With several conversations picked the pane is a summary of the selection,
  // not a reader — opening one of them would clear its unread state.
  if (selectedThreadIds.length > 1) {
    return (
      <section className="reading">
        <ReaderToolbar />
        <p className="reading__empty">
          {t('reading.selectionCount', { count: selectedThreadIds.length })}
        </p>
      </section>
    )
  }

  if (!thread) {
    return (
      <section className="reading">
        <ReaderToolbar />
        <p className="reading__empty">{t('reading.noSelection')}</p>
      </section>
    )
  }

  const account = accounts.find((item) => item.id === thread.accountId)
  const last = thread.messages[thread.messages.length - 1]
  const replyIdentity =
    identities.find(
      (identity) =>
        identity.accountId === thread.accountId &&
        last?.to.some((address) => address.email.toLowerCase() === identity.email.toLowerCase())
    ) ??
    identities.find((identity) => identity.accountId === thread.accountId && identity.isDefault) ??
    identities.find((identity) => identity.accountId === thread.accountId)

  // The list row flips the moment the star is clicked; reading it from there
  // keeps the header in step instead of waiting for the thread to reload.
  const starred =
    threads.find((item) => item.threadId === thread.threadId)?.starred ??
    thread.messages.some((message) => message.labelIds.some((id) => id.endsWith(':l:STARRED')))

  const deliveredTo =
    last?.to.find((address) => address.email.split('@')[1] === account?.email)?.email ??
    replyIdentity?.email

  return (
    <section className="reading">
      <ReaderToolbar />
      <header className="reading__header">
        <div className="reading__title">
          <h1 className="reading__subject">{thread.subject}</h1>
          <LabelChips thread={thread} />
          <button
            type="button"
            className={starred ? 'reading__star reading__star--on' : 'reading__star'}
            aria-label={starred ? t('star.remove') : t('star.add')}
            aria-pressed={starred}
            title={starred ? t('star.remove') : t('star.add')}
            onClick={() => void toggleStar(thread.threadId, !starred)}
          >
            <StarIcon size={18} filled={starred} />
          </button>
        </div>
        <div className="reading__meta">
          <span>
            {thread.messages.length === 1
              ? t('list.singleMessage')
              : t('list.messageCount', { count: thread.messages.length })}
          </span>
          {deliveredTo && account ? (
            <span
              className="badge"
              style={{ color: account.color, background: `${account.color}1f` }}
            >
              {deliveredTo}
            </span>
          ) : null}
          <span className="badge badge--neutral">
            {account?.kind === 'resend' ? t('reading.viaResend') : t('reading.viaGmail')}
          </span>
        </div>
        <FollowUpBar threadId={thread.threadId} />
      </header>
      <ThreadMessages key={thread.threadId} messages={thread.messages} />
      {/* Writing an answer happens here, in the conversation: the reply line
        gives way to the editor and the thread above it scrolls up. */}
      {compose?.mode === 'inline' ? (
        <Compose key={compose.seq} />
      ) : (
        <footer className="reading__reply">
          <button type="button" className="reading__reply-button" onClick={() => void openReply()}>
            <ReplyIcon size={14} color="var(--text-faint)" />
            <span>
              {t('reading.replyPlaceholder', {
                identity: replyIdentity
                  ? `${replyIdentity.name} <${replyIdentity.email}>`
                  : (account?.email ?? '')
              })}
            </span>
          </button>
          <button
            type="button"
            className="reading__reply-button reading__reply-button--compact"
            onClick={() => void openForward()}
          >
            <ForwardIcon size={14} color="var(--text-faint)" />
            <span>{t('reading.forward')}</span>
          </button>
        </footer>
      )}
    </section>
  )
}
