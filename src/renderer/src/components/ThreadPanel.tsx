import { useState } from 'react'
import type { ThreadDetail } from '@shared/types'
import { t } from '../i18n'
import { displayName, formatFullDate } from '../lib/format'
import { ChevronIcon } from './Icons'
import { AttachmentChips, MessageBodyView, type FullMessage } from './MessageView'

/**
 * One message of the conversation the draft answers. Everything but the newest
 * starts folded: the panel is there to look something up, not to re-read the
 * whole thread over the editor.
 */
function ThreadEntry({
  message,
  defaultOpen
}: {
  message: FullMessage
  defaultOpen: boolean
}): React.JSX.Element {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="compose__thread-entry">
      <button
        type="button"
        className="compose__thread-head"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <ChevronIcon size={10} open={open} />
        <span className="compose__thread-from">{displayName(message.from)}</span>
        <span className="compose__thread-snippet">{open ? '' : message.snippet}</span>
        <span className="compose__thread-date">{formatFullDate(message.date)}</span>
      </button>
      {open ? (
        <>
          <MessageBodyView message={message} />
          <AttachmentChips attachments={message.attachments} />
        </>
      ) : null}
    </div>
  )
}

/**
 * The conversation, read-only, inside the composer. The window shape covers the
 * reading pane entirely and even the inline strip pushes the thread out of view
 * as it grows, so the draft carries what it answers with it.
 */
export function ThreadPanel({ thread }: { thread: ThreadDetail }): React.JSX.Element {
  const last = thread.messages.length - 1
  return (
    <div className="compose__thread" role="region" aria-label={t('compose.threadPanel')}>
      {thread.messages.map((message, index) => (
        <ThreadEntry key={message.id} message={message} defaultOpen={index === last} />
      ))}
    </div>
  )
}
