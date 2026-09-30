import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import type {
  AiComposeContext,
  AiMode,
  AiSpot,
  Identity,
  OutboxAttachment,
  Template
} from '@shared/types'
import { t } from '../i18n'
import { api } from '../lib/bridge'
import {
  buildReplyQuoteHtml,
  extractInlineImages,
  hasQuote,
  isValidRecipientList,
  parseRecipients,
  stripQuote,
  stripSignature,
  withSignature
} from '../lib/compose'
import { AI_TRIGGER, aiInstruction, draftText, modeForDraft, splitDraft, textToHtml } from '../lib/ai'
import { recipientOf, templateForLine } from '../lib/templates'
import {
  autoValues,
  hasPlaceholders,
  openVariables,
  renderSubject,
  renderTemplate
} from '@shared/template-vars'
import { dueInWorkingDays } from '../lib/followup'
import { applyChanges, diffWords } from '../lib/diff'
import { applyChangesToHtml } from '../lib/inplace'
import { errorMessage } from '../lib/errors'
import { formatFullDate, formatTime } from '../lib/format'
import { loadInlineImages } from '../lib/inline-images'
import { collectAttachments, hasFiles } from '../lib/attachments'
import { htmlToPlainText } from '../lib/text'
import { useAction } from '../lib/useAction'
import { FOLLOW_UP_DAY_CHOICES, isFollowUpCandidate } from '@shared/followup'
import { MAX_ATTACHMENT_MB } from '@shared/attachments'
import { useFocusTrap } from '../hooks/useFocusTrap'
import { useUnibox } from '../state'
import { AiReview, AiRunning } from './AiPanel'
import {
  AttachIcon,
  ChevronIcon,
  ClockIcon,
  CloseIcon,
  ExpandIcon,
  MaximizeIcon,
  MinimizeIcon,
  MoreIcon,
  ProofreadIcon,
  ReplyIcon,
  RestoreIcon,
  SparkleIcon,
  TrashIcon
} from './Icons'
import { InlineError } from './InlineError'
import { usePrompt } from './PromptDialog'
import { useTemplateFill } from './TemplateFill'
import { QuoteIcon } from './EditorIcons'
import { RecipientInput } from './RecipientInput'
import { ThreadPanel } from './ThreadPanel'
import { EditorSurface, EditorToolbar, useRichTextEditor } from './Editor'
import { EditorMenu } from './EditorMenu'
import { ContextMenu, MenuItem, type MenuPosition } from './ContextMenu'
import type { SpotRange } from '../lib/spot'
import { posAt, resolveSpot } from '../lib/spot'
import { useOpenLink } from '../lib/links'

/** How long the window waits for a pause in the typing before it saves. */
const AUTOSAVE_MS = 1_500

function IdentityPicker({
  identities,
  current,
  onPick,
  onCustom
}: {
  identities: Identity[]
  current: Identity | null
  onPick: (identity: Identity) => void
  onCustom: () => void
}): React.JSX.Element {
  const { accounts } = useUnibox()
  const [open, setOpen] = useState(false)
  const accountsById = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts])
  const google = identities.filter((i) => accountsById.get(i.accountId)?.kind === 'google')
  const resend = identities.filter((i) => accountsById.get(i.accountId)?.kind === 'resend')

  return (
    <>
      <button
        type="button"
        className="identity-trigger"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span
          className="sidebar__dot"
          style={{ background: accountsById.get(current?.accountId ?? '')?.color ?? 'var(--text-faint)' }}
        />
        <span className="identity-trigger__label">
          {current ? `${current.name} <${current.email}>` : t('compose.from')}
        </span>
        <ChevronIcon size={12} open />
      </button>
      {open ? (
        <div className="identity-popover" role="listbox">
          {google.length > 0 ? (
            <div className="identity-popover__group">{t('sidebar.googleAccounts')}</div>
          ) : null}
          {google.map((identity) => (
            <button
              key={identity.id}
              type="button"
              className="identity-popover__item"
              onClick={() => {
                onPick(identity)
                setOpen(false)
              }}
            >
              <span
                className="sidebar__dot"
                style={{ background: accountsById.get(identity.accountId)?.color }}
              />
              <span>{identity.email}</span>
              {identity.email !== accountsById.get(identity.accountId)?.email ? (
                <span
                  className="badge"
                  style={{ color: 'var(--text-muted)', background: 'var(--hover)' }}
                >
                  {t('compose.alias')}
                </span>
              ) : null}
            </button>
          ))}
          {resend.length > 0 ? (
            <>
              <div className="identity-popover__divider" />
              <div className="identity-popover__group">{t('sidebar.resendDomains')}</div>
            </>
          ) : null}
          {resend.map((identity) => (
            <button
              key={identity.id}
              type="button"
              className="identity-popover__item"
              onClick={() => {
                onPick(identity)
                setOpen(false)
              }}
            >
              <span
                className="sidebar__dot"
                style={{ background: accountsById.get(identity.accountId)?.color }}
              />
              <span>{`${identity.name} <${identity.email}>`}</span>
            </button>
          ))}
          <div className="identity-popover__divider" />
          <button
            type="button"
            className="identity-popover__item"
            onClick={() => {
              onCustom()
              setOpen(false)
            }}
          >
            {t('compose.customAddress')}
          </button>
        </div>
      ) : null}
    </>
  )
}

export function Compose(): React.JSX.Element | null {
  const {
    compose,
    thread,
    closeCompose,
    identities,
    accounts,
    settings,
    reloadOutbox,
    aiJobs,
    startAi,
    dismissAi,
    saveDraft,
    discardDraft,
    popOutCompose,
    signatures,
    templates
  } = useUnibox()
  const { ask, dialog: promptDialog } = usePrompt()
  const { fill, dialog: fillDialog } = useTemplateFill()
  const [identity, setIdentity] = useState<Identity | null>(compose?.identity ?? null)
  // The signature is the draft's, not the address's: the address only says
  // which one a draft starts with.
  const [signatureId, setSignatureId] = useState<string | null>(
    compose?.identity?.signatureId ?? null
  )
  const [to, setTo] = useState(compose?.to ?? '')
  const [cc, setCc] = useState(compose?.cc ?? '')
  const [bcc, setBcc] = useState(compose?.bcc ?? '')
  // Copy rows stay out of the way until asked for, the way the recipient row
  // offers them — except when the draft already has somebody in them.
  const [showCc, setShowCc] = useState((compose?.cc ?? '') !== '')
  const [showBcc, setShowBcc] = useState((compose?.bcc ?? '') !== '')
  /**
   * How much room the floating window takes: docked in the corner, folded to
   * its title bar so the mailbox behind it is usable, or large and centred for
   * a long mail. The inline strip ignores it.
   */
  const [size, setSize] = useState<'docked' | 'minimized' | 'max'>('docked')
  // Formatting is one click away in the bottom bar; hiding it gives a narrow
  // docked window its width back.
  const [formatting, setFormatting] = useState(true)
  const [moreMenu, setMoreMenu] = useState<MenuPosition | null>(null)
  const [subject, setSubject] = useState(compose?.subject ?? '')
  const [attachments, setAttachments] = useState<OutboxAttachment[]>(compose?.attachments ?? [])
  const [scheduleOpen, setScheduleOpen] = useState(false)
  // The inline strip is meant for the quick answer, so it starts with nothing
  // but the editor; a reply already knows who it goes to and about what.
  const [fieldsOpen, setFieldsOpen] = useState(compose?.mode !== 'inline')
  const [scheduleAt, setScheduleAt] = useState('')
  /**
   * What the user decided about the reminder, or `null` while they have not
   * touched it. Kept apart from the suggestion so that typing another recipient
   * cannot silently undo a choice they already made.
   */
  const [followUpChoice, setFollowUpChoice] = useState<boolean | null>(null)
  const [followUpDays, setFollowUpDays] = useState(settings.followUpDays)
  // The conversation is a lookup, not the main view here, so the panel opens
  // only when it is asked for.
  const [threadOpen, setThreadOpen] = useState(false)
  const [quoting, setQuoting] = useState(false)
  const [validationError, setValidationError] = useState<string | null>(null)
  /** Whether a file is currently hovering over the composer. */
  const [dragging, setDragging] = useState(false)
  // `dragenter`/`dragleave` fire again for every child the pointer crosses;
  // counting them is what keeps the hint from flickering as the file travels
  // over the address fields on its way to the body.
  const dragDepth = useRef(0)
  const [aiJobId, setAiJobId] = useState<string | null>(compose?.aiJobId ?? null)
  const [aiError, setAiError] = useState<string | null>(null)
  // The identity carries its own text as well, which is what the draft falls
  // back on while the library is still loading — otherwise the first render
  // would take the signature back out of a draft that opened with it.
  const signatureHtml =
    signatures.find((entry) => entry.id === signatureId)?.html ??
    (signatureId !== null && signatureId === identity?.signatureId
      ? identity.signatureHtml
      : null)
  const initialHtml = withSignature(compose?.html ?? '', compose?.identity?.signatureHtml ?? null)
  const htmlRef = useRef(initialHtml)
  // The draft itself lives in a ref, which never re-renders anything; whether
  // it is empty decides what the assistant can be asked for, so that much is
  // kept in state.
  const [hasBody, setHasBody] = useState(() => draftText(initialHtml).trim() !== '')
  /** Whether the quoted original is currently part of the draft. */
  const [quoted, setQuoted] = useState(() => hasQuote(initialHtml))
  // A machine address will never write back, and a mail to a dozen people is
  // an announcement — neither is worth a reminder, so neither is offered one.
  const followUpPossible = isFollowUpCandidate(
    parseRecipients([to, cc, bcc].filter(Boolean).join(','))
  )
  const followUpOn =
    followUpPossible && (followUpChoice ?? settings.followUpEnabled)
  const followUpDayOptions = [...new Set([...FOLLOW_UP_DAY_CHOICES, followUpDays])].sort(
    (a, b) => a - b
  )
  const [savedAt, setSavedAt] = useState<number | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const draftId = useRef<string | null>(compose?.draftId ?? null)
  /**
   * What the window opened with. A reply arrives with recipients and a subject
   * already filled in — without this baseline, opening one and closing it again
   * would leave behind a draft nobody wrote.
   */
  const baseline = useRef({
    to: compose?.to ?? '',
    cc: compose?.cc ?? '',
    bcc: compose?.bcc ?? '',
    subject: compose?.subject ?? '',
    html: initialHtml,
    attachments: compose?.attachments.length ?? 0
  })
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const persistRef = useRef<() => Promise<void>>(async () => undefined)
  /** Tail of the running save, so two autosaves cannot both create the draft. */
  const saving = useRef<Promise<void>>(Promise.resolve())
  /** Set once the mail was sent or thrown away, so no pending timer revives it. */
  const finished = useRef(false)
  const overlay = useRef<HTMLDivElement | null>(null)
  useFocusTrap(overlay)
  // A new mail has nobody to go to yet, so the window opens on the address
  // field. With a recipient the editor already took the caret while it was
  // built — asking for it from here would reach an instance StrictMode has
  // torn down again.
  useEffect(() => {
    if ((compose?.to ?? '') !== '') return
    overlay.current?.querySelector<HTMLInputElement>('#compose-to')?.focus()
    // Only ever on the way in: later renders must not pull the caret back out
    // of the draft.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** Restarts the pause the autosave waits for; every edit goes through here. */
  const scheduleSave = useCallback(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => {
      saveTimer.current = null
      void persistRef.current()
    }, AUTOSAVE_MS)
  }, [])

  /**
   * The editor's Enter handler is built once and reads the insert through a
   * ref, the same way the autosave does — the function it would otherwise
   * close over is new on every render and needs the editor, which does not
   * exist yet when the handler is built.
   */
  const insertTemplate = useRef<(template: Template) => void>(() => undefined)

  /**
   * Where a running spot job is meant to land. Kept out of state on purpose:
   * it changes with every keystroke in the draft and nothing renders from it.
   */
  const spotRange = useRef<SpotRange | null>(null)
  const [menu, setMenu] = useState<MenuPosition | null>(null)
  const openLink = useOpenLink()

  const aiContext = (): AiComposeContext => ({
    accountId: identity?.accountId ?? compose?.accountId ?? '',
    identityId: identity?.id ?? null,
    to,
    cc,
    subject,
    replyToMessageId: compose?.replyToMessageId ?? null,
    html: stripSignature(splitDraft(htmlRef.current).body)
  })

  const runAi = async (mode: AiMode, instruction: string, spot?: AiSpot): Promise<void> => {
    setAiError(null)
    try {
      const job = await startAi({ mode, instruction, context: { ...aiContext(), spot } })
      setAiJobId(job.id)
    } catch (cause) {
      setAiError(errorMessage(cause))
    }
  }

  const editor = useRichTextEditor(
    initialHtml,
    (html) => {
      htmlRef.current = html
      setHasBody(draftText(html).trim() !== '')
      scheduleSave()
    },
    // `@ai <Anweisung>` plus Enter is the whole interface: the line is a
    // command, never mail text, so it leaves the draft before the job starts.
    // `/kürzel` is the same gesture for a template, and it is asked first
    // because the two triggers cannot collide — one starts with a slash, the
    // other with an at-sign.
    (line) => {
      const template = templateForLine(line, templates)
      if (template) return () => insertTemplate.current(template)
      const instruction = aiInstruction(line)
      if (!instruction || aiJobId) return null
      return () => void runAi(modeForDraft(htmlRef.current), instruction)
    },
    // The strip takes the place of the line the user just clicked, so the caret
    // starts where the answer goes — clicking twice to write is what it spares.
    // A window that opens with a recipient — a reply, a forward — is the same
    // case; a new mail starts in the address field instead (see below).
    compose?.mode === 'inline' || (compose?.to ?? '') !== '',
    (href) => openLink(href)
  )

  /** Puts a generated body into the draft, keeping the signature block intact. */
  const applyBody = useCallback(
    (body: string) => {
      if (!editor) return
      // A forwarded original stays where it is; only the part above it is the
      // draft the assistant worked on.
      const { quote } = splitDraft(htmlRef.current)
      const next = withSignature(`${body}${quote}`, signatureHtml)
      htmlRef.current = next
      setHasBody(draftText(next).trim() !== '')
      editor.commands.setContent(next, { emitUpdate: false })
    },
    [editor, signatureHtml]
  )

  const applyText = useCallback((text: string) => applyBody(textToHtml(text)), [applyBody])

  /**
   * Puts a template into the draft. What the composer already knows — who the
   * mail goes to, who sends it, today's date — is filled in without asking;
   * everything else is asked for once, in one dialog, before a single word
   * lands in the draft. Cancelling it inserts nothing.
   */
  const applyTemplate = async (template: Template): Promise<void> => {
    if (!editor) return
    const recipient = await recipientOf(to)
    const values = autoValues({
      recipientName: recipient?.name ?? null,
      recipientEmail: recipient?.email ?? null,
      senderName: identity?.name ?? null,
      senderEmail: identity?.email ?? null,
      subject,
      date: formatFullDate(Date.now())
    })
    // A subject that is already there was written on purpose — a reply keeps
    // its `Re:` — so the template only ever fills an empty one.
    const takeSubject = subject.trim() === '' && template.subject.trim() !== ''
    const open = openVariables(
      takeSubject ? `${template.subject}\n${template.html}` : template.html,
      values
    )
    if (open.length > 0) {
      const answered = await fill({ templateName: template.name, variables: open })
      if (!answered) return
      Object.assign(values, answered)
    }
    // The template joins what is already written, above signature and quote —
    // the same three-part draft every other insert respects.
    const { body, quote } = splitDraft(htmlRef.current)
    const written = stripSignature(body)
    const filled = renderTemplate(template.html, values)
    const combined = draftText(written).trim() === '' ? filled : `${written}${filled}`
    const next = withSignature(`${combined}${quote}`, signatureHtml)
    htmlRef.current = next
    setHasBody(draftText(next).trim() !== '')
    editor.commands.setContent(next, { emitUpdate: false })
    if (takeSubject) setSubject(renderSubject(template.subject, values))
    scheduleSave()
  }

  useEffect(() => {
    insertTemplate.current = (template) => void applyTemplate(template)
  })

  // A job outlives this window, so its state is read out of the shared list
  // rather than awaited here — the same path whether the window stayed open or
  // was reopened from the toast.
  const job = aiJobId ? (aiJobs.find((entry) => entry.id === aiJobId) ?? null) : null
  // A review needs two sides. Writing from scratch has none, and neither does a
  // spot the user merely pointed at — there the answer fills a gap, and a diff
  // against nothing would ask about every word it contains.
  const proposal = useMemo(
    () =>
      job?.state === 'done' && job.result && job.mode !== 'draft' && job.source.trim() !== ''
        ? diffWords(job.source, job.result)
        : null,
    [job]
  )

  /**
   * Writes an answer back into the one place it was asked for. Everything
   * around it stays as it is — that is the whole difference to the other
   * modes, which rebuild the body from text and flatten its markup on the way.
   *
   * Returns false when the place is gone: the draft moved on far enough that
   * the marked words are no longer in it, and there is no honest second guess
   * about where the sentence was supposed to go.
   */
  const applySpot = useCallback(
    (text: string): boolean => {
      const spot = job?.context.spot
      if (!editor || !spot) return false
      const range = resolveSpot(editor, spotRange.current, spot)
      if (!range) return false
      const answer = text.trim()
      // A phrase goes back inside the sentence it was cut from; only an answer
      // that is itself several paragraphs brings blocks of its own.
      const content = answer.includes('\n\n') ? textToHtml(answer) : answer.replace(/\n/g, ' ')
      editor.chain().focus().insertContentAt(range, content).run()
      spotRange.current = null
      return true
    },
    [editor, job]
  )

  // A mail written from scratch has nothing to compare against, so it skips the
  // review and goes straight into the editor. This has to be derived from the
  // shared job list rather than from the `ai:job` event: a fast job is already
  // done before the window knows its id, and the event would be long gone.
  // Writing into the editor is what an effect is for; releasing the binding in
  // the same step is what keeps it from running twice.
  /* eslint-disable react-hooks/set-state-in-effect -- see above */
  useEffect(() => {
    if (!editor || job?.state !== 'done' || !job.result || proposal) return
    if (job.context.spot) {
      // Nowhere left to put it. The job stays, so the message stands next to
      // the draft instead of the answer disappearing without a word.
      if (!applySpot(job.result)) {
        setAiError(t('ai.spotGone'))
        return
      }
    } else if (job.mode === 'draft') {
      applyText(job.result)
    } else {
      return
    }
    dismissAi(job.id)
    setAiJobId(null)
  }, [editor, job, proposal, applyText, applySpot, dismissAi])
  /* eslint-enable react-hooks/set-state-in-effect */

  /** Ends the job: `body` non-null takes the result over, null throws it away. */
  const finishAi = (body: string | null): void => {
    if (body !== null) applyBody(body)
    if (job) dismissAi(job.id)
    setAiJobId(null)
  }

  /**
   * Takes the decisions of the review over. A correction may only fix language,
   * so the draft keeps what it is made of: the accepted wordings are written
   * into the markup that is already there. Rebuilding the body from text is
   * what the other modes do — and what flattens a link into the words it reads
   * as — so it stays the fallback for a draft the changes no longer fit.
   */
  const applyProposal = (accepted: ReadonlySet<number>): void => {
    if (!job || !proposal) return
    // A spot job never touches the body: the decisions go back into the one
    // range they came from, and the rest of the draft is none of its business.
    if (job.context.spot) {
      if (!applySpot(applyChanges(proposal, accepted))) {
        setAiError(t('ai.spotGone'))
        return
      }
      dismissAi(job.id)
      setAiJobId(null)
      return
    }
    const inPlace =
      job.mode === 'correct' ? applyChangesToHtml(job.context.html, proposal, accepted) : null
    finishAi(inPlace ?? textToHtml(applyChanges(proposal, accepted)))
  }

  // Switching sender takes its signature along — the one that was picked by
  // hand belonged to the address it was picked under.
  /* eslint-disable react-hooks/set-state-in-effect -- see above */
  useEffect(() => {
    if (identity) setSignatureId(identity.signatureId)
  }, [identity])
  /* eslint-enable react-hooks/set-state-in-effect */

  useEffect(() => {
    if (!editor || !identity) return
    const next = withSignature(htmlRef.current, signatureHtml)
    if (next !== htmlRef.current) {
      htmlRef.current = next
      editor.commands.setContent(next, { emitUpdate: false })
    }
  }, [editor, identity, signatureHtml])

  const buildDraft = (): Parameters<typeof api.invoke<'compose:send'>>[1] | null => {
    if (!identity || !isValidRecipientList(to)) {
      setValidationError(t('compose.recipientsRequired'))
      return null
    }
    const { html, attachments: inline } = extractInlineImages(htmlRef.current)
    // An inserted template that was never finished must not leave the house:
    // `{{betrag}}` in a sent mail is worse than a mail that was not sent. Only
    // what the user wrote is checked — a quoted original with braces in it is
    // somebody else's text.
    if (hasPlaceholders(splitDraft(html).body) || hasPlaceholders(subject)) {
      setValidationError(t('templates.unfilled'))
      return null
    }
    return {
      accountId: identity.accountId,
      identityName: identity.name,
      identityEmail: identity.email,
      to: parseRecipients(to),
      cc: parseRecipients(cc),
      bcc: parseRecipients(bcc),
      subject,
      html,
      text: htmlToPlainText(html),
      attachments: [...attachments, ...inline],
      replyToMessageId: compose?.replyToMessageId ?? null,
      followUpDays: followUpOn ? followUpDays : null
    }
  }

  /**
   * Writes what is in the window to the database. Unsent mail is editing state,
   * so it is stored as typed — half-written recipients included — rather than
   * as a send payload.
   */
  const write = async (): Promise<void> => {
    if (finished.current) return
    const accountId = identity?.accountId ?? compose?.accountId ?? ''
    if (!accountId) return
    const base = baseline.current
    const changed =
      to !== base.to ||
      cc !== base.cc ||
      bcc !== base.bcc ||
      subject !== base.subject ||
      htmlRef.current !== base.html ||
      attachments.length !== base.attachments
    // Nothing was typed and nothing was stored before: an opened and closed
    // window leaves no trace.
    if (!changed && !draftId.current) return
    try {
      const draft = await saveDraft({
        id: draftId.current,
        accountId,
        kind: compose?.kind ?? 'new',
        // A custom address belongs to no identity; its name and mail carry it.
        identityId: identity && !identity.id.startsWith('custom:') ? identity.id : null,
        identityName: identity?.name ?? '',
        identityEmail: identity?.email ?? '',
        to,
        cc,
        bcc,
        subject,
        html: htmlRef.current,
        attachments,
        replyToMessageId: compose?.replyToMessageId ?? null
      })
      draftId.current = draft.id
      setSavedAt(draft.updatedAt)
      setSaveError(null)
    } catch (cause) {
      // Autosave runs unasked, so a failure is reported where the save status
      // sits rather than thrown at whatever the user was doing.
      setSaveError(errorMessage(cause))
    }
  }
  /**
   * Saves run one after another. The first one is what mints the draft id, and
   * a second starting before it returned would still carry `id: null` — which
   * stored a second draft locally and created a second one at Gmail.
   */
  const persist = (): Promise<void> => {
    const next = saving.current.catch(() => undefined).then(() => write())
    saving.current = next.catch(() => undefined)
    return next
  }

  // The timer fires long after the render that scheduled it, so it reads the
  // save through a ref rather than closing over a stale set of fields.
  useEffect(() => {
    persistRef.current = persist
  })

  // Header fields restart the timer the same way the body does.
  useEffect(() => {
    scheduleSave()
  }, [to, cc, bcc, subject, attachments, identity, scheduleSave])

  // Closing the window is not a decision to throw anything away, so whatever
  // the last pause did not cover is written on the way out.
  useEffect(
    () => () => {
      if (saveTimer.current) clearTimeout(saveTimer.current)
      void persistRef.current()
    },
    []
  )

  /** Ends the window for good: no autosave may bring the draft back. */
  const stopSaving = (): void => {
    finished.current = true
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = null
  }

  // Sending is the one action where losing the cause also loses the message —
  // the failure is reported in the footer, next to the button that triggered it.
  const send = useAction(async () => {
    const draft = buildDraft()
    if (!draft) return
    await api.invoke('compose:send', draft)
    stopSaving()
    if (draftId.current) await discardDraft(draftId.current)
    await reloadOutbox()
    closeCompose()
  })

  const schedule = useAction(async () => {
    const draft = buildDraft()
    if (!draft) return
    const timestamp = Date.parse(scheduleAt)
    if (!Number.isFinite(timestamp)) return
    await api.invoke('compose:schedule', draft, timestamp)
    stopSaving()
    if (draftId.current) await discardDraft(draftId.current)
    await reloadOutbox()
    closeCompose()
  })

  /** Throws the draft away — the only path that loses text, so it asks first. */
  const discard = (): void => {
    const written =
      to.trim() !== '' ||
      subject.trim() !== '' ||
      draftText(htmlRef.current).trim() !== '' ||
      attachments.length > 0
    if (written && !window.confirm(t('compose.confirmDiscard'))) return
    stopSaving()
    const id = draftId.current
    draftId.current = null
    if (id) void discardDraft(id)
    closeCompose()
  }

  if (!compose) return null

  const inline = compose.mode === 'inline'
  const account = accounts.find((item) => item.id === (identity?.accountId ?? compose.accountId))
  const title =
    compose.kind === 'forward'
      ? t('compose.forwardTitle')
      : compose.kind === 'reply'
        ? t('compose.replyTitle')
        : t('compose.title')
  const aiRunning = job !== null && job.state === 'running'
  // A Gmail alias awaiting verification exists locally but cannot be sent from.
  const availableIdentities = identities.filter((entry) => entry.verified)

  // The conversation the draft belongs to. A draft reopened while another
  // thread is selected finds no match here, and then there is nothing to show:
  // the store only ever holds the thread that is open.
  const source =
    (compose.replyToMessageId
      ? thread?.messages.find((message) => message.id === compose.replyToMessageId)
      : null) ?? null
  const conversation = source ? thread : null
  // A forward already carries its original in the body, and it is built with a
  // forward's header — only a reply gets to switch its quote on and off.
  const quotable = source && compose.kind === 'reply' ? source : null

  /**
   * Puts the quoted original into the draft or takes it back out. It is part of
   * the body, so it goes out with the mail — the panel above only shows the
   * conversation, this decides what the recipient reads.
   */
  const toggleQuote = async (): Promise<void> => {
    if (!editor || !quotable) return
    const body = stripQuote(htmlRef.current)
    let next: string
    if (quoted) {
      next = withSignature(body, signatureHtml)
    } else {
      setQuoting(true)
      try {
        const images = await loadInlineImages(quotable.attachments)
        next = withSignature(`${body}${buildReplyQuoteHtml(quotable, images)}`, signatureHtml)
      } finally {
        setQuoting(false)
      }
    }
    htmlRef.current = next
    editor.commands.setContent(next, { emitUpdate: false })
    setQuoted(!quoted)
    scheduleSave()
  }

  const insertImage = async (): Promise<void> => {
    try {
      const files = await api.invoke('attachments:pick')
      for (const file of files) {
        if (file.mimeType.startsWith('image/')) {
          editor
            ?.chain()
            .focus()
            .setImage({ src: `data:${file.mimeType};base64,${file.content}` })
            .run()
        } else {
          setAttachments((current) => [...current, { ...file }])
        }
      }
    } catch (cause) {
      setValidationError(errorMessage(cause))
    }
  }

  const addAttachment = async (): Promise<void> => {
    try {
      const files = await api.invoke('attachments:pick')
      setAttachments((current) => [...current, ...files.map((file) => ({ ...file }))])
    } catch (cause) {
      // A file over the size limit is refused by the main process; the hint
      // line is where the composer says so.
      setValidationError(errorMessage(cause))
    }
  }

  /**
   * Files dragged in from the Finder. What the draft already carries counts
   * against the budget, because the limit is per mail rather than per file —
   * three 10-MB files fail on the third instead of all three passing.
   */
  const takeFiles = async (files: File[]): Promise<void> => {
    if (files.length === 0) return
    const { added, rejected } = await collectAttachments(files, attachments)
    if (added.length > 0) setAttachments((current) => [...current, ...added])
    setValidationError(
      rejected.length === 0
        ? null
        : rejected
            .map((file) =>
              file.reason === 'tooLarge'
                ? t('compose.attachTooLarge', {
                    filename: file.filename,
                    limit: MAX_ATTACHMENT_MB
                  })
                : t('compose.attachUnreadable', { filename: file.filename })
            )
            .join(' ')
    )
  }

  /**
   * The composer is the drop target as a whole, not just the body: a file aimed
   * at the recipient row is still meant as an attachment. tiptap declines file
   * drops (see `handleDrop` in Editor), so a drop into the body arrives here
   * too, and the window-wide guard in `main.tsx` catches everything else.
   */
  const dropZone = {
    onDragEnter: (event: DragEvent<HTMLElement>) => {
      if (!hasFiles(event.dataTransfer)) return
      dragDepth.current += 1
      setDragging(true)
    },
    onDragOver: (event: DragEvent<HTMLElement>) => {
      if (!hasFiles(event.dataTransfer)) return
      // Without this the drop never happens: an element is not a drop target
      // until it says so on every dragover.
      event.preventDefault()
      event.dataTransfer.dropEffect = 'copy'
    },
    onDragLeave: (event: DragEvent<HTMLElement>) => {
      if (!hasFiles(event.dataTransfer)) return
      dragDepth.current = Math.max(0, dragDepth.current - 1)
      if (dragDepth.current === 0) setDragging(false)
    },
    onDrop: (event: DragEvent<HTMLElement>) => {
      if (!hasFiles(event.dataTransfer)) return
      event.preventDefault()
      dragDepth.current = 0
      setDragging(false)
      void takeFiles(Array.from(event.dataTransfer.files))
    }
  }

  const dropHint = dragging ? (
    <div className="compose__drop" aria-hidden="true">
      <AttachIcon size={18} />
      <span>{t('compose.dropHint')}</span>
    </div>
  ) : null

  /**
   * Hands the draft over to the floating window. The strip is written out
   * first, so the window continues the same draft instead of starting a second
   * one when its own autosave comes round.
   */
  const popOut = async (): Promise<void> => {
    await persist()
    stopSaving()
    popOutCompose({
      identity,
      to,
      cc,
      bcc,
      subject,
      html: htmlRef.current,
      attachments,
      draftId: draftId.current,
      aiJobId: aiJobId ?? undefined
    })
  }

  // Closing keeps the draft, so both shapes say when it was last written
  // rather than asking on the way out.
  const savedStatus = saveError ? (
    <span className="compose__saved error-text" role="status" title={saveError}>
      {t('compose.saveFailed')}
    </span>
  ) : savedAt ? (
    <span className="compose__saved" role="status">
      {t('compose.savedAt', { time: formatTime(savedAt) })}
    </span>
  ) : null

  const identityRow = (
    <div className="compose__row compose__row--from">
      <span className="compose__label">{t('compose.from')}</span>
      <IdentityPicker
        identities={availableIdentities}
        current={identity}
        onPick={setIdentity}
        onCustom={async () => {
          const address = await ask({
            label: t('compose.customAddressPrompt'),
            initial: identity?.email ?? ''
          })
          if (!address) return
          setIdentity({
            id: `custom:${address}`,
            accountId: identity?.accountId ?? compose.accountId,
            name: identity?.name ?? '',
            email: address,
            signatureId: identity?.signatureId ?? null,
            signatureHtml: identity?.signatureHtml ?? null,
            isDefault: false,
            source: 'user',
            verified: true
          })
        }}
      />
    </div>
  )

  const addressRows = (
    <>
      {identityRow}
      <div className="compose__row">
        <label className="compose__label" htmlFor="compose-to">
          {t('compose.to')}
        </label>
        <RecipientInput id="compose-to" value={to} onChange={setTo} />
        {/* The copy rows are offered where the recipients are, not up front:
            most mail has neither, and two empty rows are two stops for Tab. */}
        {!showCc || !showBcc ? (
          <span className="compose__copy-toggles">
            {showCc ? null : (
              <button type="button" tabIndex={-1} onClick={() => setShowCc(true)}>
                {t('compose.addCc')}
              </button>
            )}
            {showBcc ? null : (
              <button type="button" tabIndex={-1} onClick={() => setShowBcc(true)}>
                {t('compose.addBcc')}
              </button>
            )}
          </span>
        ) : null}
      </div>
      {showCc ? (
        <div className="compose__row">
          <label className="compose__label" htmlFor="compose-cc">
            {t('compose.cc')}
          </label>
          <RecipientInput id="compose-cc" value={cc} onChange={setCc} />
        </div>
      ) : null}
      {showBcc ? (
        <div className="compose__row">
          <label className="compose__label" htmlFor="compose-bcc">
            {t('compose.bcc')}
          </label>
          <RecipientInput id="compose-bcc" value={bcc} onChange={setBcc} />
        </div>
      ) : null}
      <div className="compose__row">
        <input
          id="compose-subject"
          aria-label={t('compose.subject')}
          placeholder={t('compose.subjectPlaceholder')}
          value={subject}
          onChange={(event) => setSubject(event.target.value)}
        />
      </div>
    </>
  )

  // Both shapes hide the conversation while the draft is being written — the
  // window covers the reading pane, the strip pushes the thread out of view —
  // so the composer keeps its own way back to it.
  const contextBar = conversation ? (
    <div className="compose__context">
      <button
        type="button"
        className="compose__context-toggle"
        aria-expanded={threadOpen}
        onClick={() => setThreadOpen((value) => !value)}
      >
        <ChevronIcon size={11} open={threadOpen} />
        <span>{t('compose.showThread', { count: conversation.messages.length })}</span>
      </button>
      {quotable ? (
        <button
          type="button"
          className="compose__context-toggle"
          aria-pressed={quoted}
          disabled={quoting}
          onClick={() => void toggleQuote()}
        >
          <QuoteIcon size={13} />
          <span>{t('compose.quoteOriginal')}</span>
        </button>
      ) : null}
    </div>
  ) : null

  const editorBlock = (
    <>
      {contextBar}
      {threadOpen && conversation ? <ThreadPanel thread={conversation} /> : null}
      {job?.state === 'running' ? <AiRunning /> : null}
      {aiError || job?.state === 'error' ? (
        <div className="ai-bar ai-bar--error">
          <InlineError message={aiError ?? job?.error ?? t('ai.empty')} />
          {job ? (
            <button type="button" className="button-secondary" onClick={() => finishAi(null)}>
              {t('settings.close')}
            </button>
          ) : null}
        </div>
      ) : null}
      {proposal ? (
        <AiReview
          key={job?.id}
          parts={proposal}
          onApply={(accepted) => applyProposal(accepted)}
          onDiscard={() => finishAi(null)}
        />
      ) : null}
      <EditorSurface
        editor={editor}
        hidden={proposal !== null}
        // The menu acts on the place it was opened at, so the click has to put
        // the caret there first — right-clicking in a browser does not move it.
        onContextMenu={(event) => {
          if (!editor) return
          event.preventDefault()
          const at = posAt(editor, event.clientX, event.clientY)
          // Only outside any current selection: right-clicking a selection to
          // act on it is the gesture, and collapsing it would undo the point.
          const { from, to } = editor.state.selection
          if (at !== null && (at < from || at > to)) editor.commands.setTextSelection(at)
          setMenu({ x: event.clientX, y: event.clientY })
        }}
        onKeyDown={(event) => {
          if (event.key !== 'k' || !(event.metaKey || event.ctrlKey) || !editor) return
          event.preventDefault()
          void (async () => {
            const url = await ask({
              label: t('compose.toolbar.linkPrompt'),
              initial: (editor.getAttributes('link').href as string | undefined) ?? 'https://'
            })
            if (url === null) return
            if (url === '') editor.chain().focus().unsetLink().run()
            else editor.chain().focus().setLink({ href: url }).run()
          })()
        }}
      />
      {menu && editor ? (
        <EditorMenu
          editor={editor}
          x={menu.x}
          y={menu.y}
          askLink={(initial) => ask({ label: t('compose.toolbar.linkPrompt'), initial })}
          onAi={
            aiJobId
              ? null
              : (instruction, spot) => {
                  const { from, to } = editor.state.selection
                  spotRange.current = { from, to }
                  void runAi('spot', instruction, spot)
                }
          }
          onClose={() => setMenu(null)}
        />
      ) : null}

      {attachments.length > 0 ? (
        <div className="compose__attachments">
          {attachments.map((attachment, index) => (
            <button
              key={`${attachment.filename}-${index}`}
              type="button"
              className="attachment-chip"
              onClick={() =>
                setAttachments((current) => current.filter((_, position) => position !== index))
              }
            >
              <AttachIcon size={13} />
              <span>{attachment.filename}</span>
              <CloseIcon size={10} color="var(--text-faint)" />
            </button>
          ))}
        </div>
      ) : null}

      {/* Everything the draft is sent *with*, on one hairline row above the
          bar: the sign-off, a template to drop in, and the promise to chase an
          answer. The reminder is ticked by default because the case this
          exists for is the mail the user meant to chase and forgot — an offer
          they have to remember to accept would be the same trap one step on. */}
      <div className="compose__options">
        {signatures.length > 0 ? (
          <span className="compose__option">
            <label className="compose__label" htmlFor="compose-signature">
              {t('compose.signature')}
            </label>
            {/* Like the toolbar: on the way from the address fields into the
                text, the signature is not a stop — it is picked once, with the
                mouse, and rarely at that. */}
            <select
              id="compose-signature"
              value={signatureId ?? ''}
              tabIndex={-1}
              onChange={(event) => setSignatureId(event.target.value || null)}
            >
              <option value="">{t('compose.noSignature')}</option>
              {signatures.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.name}
                </option>
              ))}
            </select>
          </span>
        ) : null}
        {templates.length > 0 ? (
          <span className="compose__option">
            <label className="compose__label" htmlFor="compose-template">
              {t('compose.template')}
            </label>
            {/* The picker is an action, not a setting: it never shows what was
                chosen, because after the insert the draft is the answer.
                Whoever inserts templates often types `/kürzel` instead. */}
            <select
              id="compose-template"
              value=""
              tabIndex={-1}
              onChange={(event) => {
                const picked = templates.find((entry) => entry.id === event.target.value)
                if (picked) void applyTemplate(picked)
              }}
            >
              <option value="">{t('compose.pickTemplate')}</option>
              {templates.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.shortcut ? `${entry.name}  /${entry.shortcut}` : entry.name}
                </option>
              ))}
            </select>
          </span>
        ) : null}
        <span className="compose__option compose__followup">
          <label className="compose__followup-toggle">
            <input
              type="checkbox"
              checked={followUpOn}
              disabled={!followUpPossible}
              onChange={(event) => setFollowUpChoice(event.target.checked)}
            />
            <span>{t('followup.expectIn')}</span>
          </label>
          <select
            aria-label={t('followup.expectIn')}
            value={followUpDays}
            disabled={!followUpOn}
            onChange={(event) => setFollowUpDays(Number(event.target.value))}
          >
            {followUpDayOptions.map((days) => (
              <option key={days} value={days}>
                {days === 1 ? t('followup.oneWorkingDay') : t('followup.workingDays', { count: days })}
              </option>
            ))}
          </select>
          {followUpOn ? (
            <span className="compose__followup-due">
              {t('followup.dueOn', { date: formatFullDate(dueInWorkingDays(followUpDays)) })}
            </span>
          ) : null}
        </span>
        {/* Which account carries the mail — the one thing about sending that is
            not obvious from the sender address when domains share a key. */}
        <span className="compose__via">
          {account?.kind === 'resend'
            ? t('compose.sendsViaResend', { domain: account.email })
            : t('compose.sendsViaGmail', { account: account?.email ?? '' })}
        </span>
      </div>
    </>
  )

  // Only a problem earns a line of its own; where the mail goes is on the
  // sender row already.
  const problem =
    send.error || schedule.error ? (
      <InlineError
        message={t('errors.sendFailed', { message: send.error ?? schedule.error ?? '' })}
      />
    ) : validationError ? (
      <span className="error-text">{validationError}</span>
    ) : null

  const bottomBar = (
    <div className="compose__bottom">
      <div className="compose__send">
        <button
          type="button"
          className="compose__send-main"
          aria-busy={send.busy}
          disabled={send.busy}
          onClick={() => void send.run()}
        >
          {t('compose.send')}
        </button>
        <button
          type="button"
          className="compose__send-more"
          aria-label={t('compose.sendOptions')}
          title={t('compose.sendLater')}
          aria-expanded={scheduleOpen}
          onClick={() => setScheduleOpen((value) => !value)}
        >
          <ChevronIcon size={12} open color="currentColor" />
        </button>
        {/* Sending later is the other way to press the button, so it hangs
            off the button rather than sitting among the formatting. */}
        {scheduleOpen ? (
          <div className="compose__schedule" role="group" aria-label={t('compose.scheduleTitle')}>
            <label className="compose__label" htmlFor="compose-schedule">
              {t('compose.scheduleAt')}
            </label>
            <input
              id="compose-schedule"
              type="datetime-local"
              value={scheduleAt}
              onChange={(event) => setScheduleAt(event.target.value)}
            />
            <button
              type="button"
              className="button-primary"
              aria-busy={schedule.busy}
              disabled={schedule.busy}
              onClick={() => void schedule.run()}
            >
              {t('compose.scheduleConfirm')}
            </button>
            <p className="compose__schedule-hint">{t('compose.scheduleHint')}</p>
          </div>
        ) : null}
      </div>
      {formatting ? (
        <EditorToolbar editor={editor} onInsertImage={() => void insertImage()} />
      ) : (
        <span className="compose__bottom-spacer" />
      )}
      <button
        type="button"
        className="icon-button"
        title={t('compose.attach')}
        aria-label={t('compose.attach')}
        onClick={() => void addAttachment()}
      >
        <AttachIcon />
      </button>
      <button
        type="button"
        className="icon-button"
        title={t('ai.assist')}
        aria-label={t('ai.assist')}
        disabled={aiRunning}
        onClick={() => {
          setAiError(null)
          editor?.chain().focus().insertContent(`${AI_TRIGGER} `).run()
        }}
      >
        <SparkleIcon />
      </button>
      <button
        type="button"
        className="icon-button"
        title={t('ai.correct')}
        aria-label={t('ai.correct')}
        disabled={aiRunning || !hasBody}
        onClick={() => void runAi('correct', '')}
      >
        <ProofreadIcon />
      </button>
      <button
        type="button"
        className="icon-button"
        title={t('compose.more')}
        aria-label={t('compose.more')}
        aria-haspopup="menu"
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect()
          setMoreMenu({ x: rect.left, y: rect.top - 4 })
        }}
      >
        <MoreIcon />
      </button>
      <button
        type="button"
        className="icon-button compose__discard"
        title={t('compose.discard')}
        aria-label={t('compose.discard')}
        onClick={discard}
      >
        <TrashIcon size={15} color="var(--text-faint)" />
      </button>
      {moreMenu ? (
        <ContextMenu
          x={moreMenu.x}
          y={moreMenu.y}
          label={t('compose.more')}
          onClose={() => setMoreMenu(null)}
        >
          <MenuItem
            label={t('compose.sendLater')}
            icon={<ClockIcon size={14} />}
            onClick={() => {
              setMoreMenu(null)
              setScheduleOpen(true)
            }}
          />
          <MenuItem
            label={t('compose.formatting')}
            checked={formatting}
            onClick={() => {
              setMoreMenu(null)
              setFormatting((value) => !value)
            }}
          />
          {inline ? (
            <MenuItem
              label={t('compose.popOut')}
              icon={<ExpandIcon size={14} />}
              onClick={() => {
                setMoreMenu(null)
                void popOut()
              }}
            />
          ) : null}
        </ContextMenu>
      ) : null}
    </div>
  )

  const footer = (
    <>
      {problem ? <div className="compose__problem">{problem}</div> : null}
      {bottomBar}
    </>
  )

  // The inline strip is the same composer without the window around it: it
  // takes the place of the reply line and grows upwards into the conversation.
  if (inline) {
    return (
      <section className="reply-inline" role="dialog" aria-label={title} {...dropZone}>
        {dropHint}
        <div className="reply-inline__head">
          <ReplyIcon size={14} color="var(--text-faint)" />
          <button
            type="button"
            className="reply-inline__summary"
            aria-expanded={fieldsOpen}
            title={t('compose.editFields')}
            onClick={() => setFieldsOpen((value) => !value)}
          >
            <span>{t('compose.replyingTo', { recipients: to })}</span>
            <ChevronIcon size={11} open={fieldsOpen} />
          </button>
          {savedStatus}
          <button
            type="button"
            className="icon-button"
            title={t('compose.popOut')}
            aria-label={t('compose.popOut')}
            onClick={() => void popOut()}
          >
            <ExpandIcon />
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label={t('compose.close')}
            onClick={closeCompose}
          >
            <CloseIcon />
          </button>
        </div>
        {fieldsOpen ? addressRows : null}
        {editorBlock}
        {footer}
        {promptDialog}
        {fillDialog}
      </section>
    )
  }

  const minimized = size === 'minimized'
  // What the bar says once there is something to say: the subject names the
  // mail far better than "Neue E-Mail" does, and a folded window is only its bar.
  const barTitle = subject.trim() || title

  return (
    <div
      ref={overlay}
      className={`compose-float compose-float--${size}`}
      role="dialog"
      // Docked or folded, the mailbox behind stays usable; only the large
      // window takes the app over, and says so.
      aria-modal={size === 'max'}
      aria-label={title}
    >
      {size === 'max' ? (
        <div
          className="compose-float__scrim"
          aria-hidden="true"
          onMouseDown={() => setSize('docked')}
        />
      ) : null}
      <div className="compose compose--float" {...dropZone}>
        {dropHint}
        <div
          className="compose__bar"
          onClick={(event) => {
            // A folded window opens again from anywhere on its bar.
            if (minimized && event.target === event.currentTarget) setSize('docked')
          }}
        >
          <button
            type="button"
            className="compose__bar-title"
            tabIndex={minimized ? 0 : -1}
            onClick={() => setSize(minimized ? 'docked' : 'minimized')}
          >
            {barTitle}
          </button>
          {minimized ? null : savedStatus}
          <button
            type="button"
            className="compose__bar-button"
            title={minimized ? t('compose.unminimize') : t('compose.minimize')}
            aria-label={minimized ? t('compose.unminimize') : t('compose.minimize')}
            onClick={() => setSize(minimized ? 'docked' : 'minimized')}
          >
            <MinimizeIcon />
          </button>
          <button
            type="button"
            className="compose__bar-button"
            title={size === 'max' ? t('compose.restore') : t('compose.maximize')}
            aria-label={size === 'max' ? t('compose.restore') : t('compose.maximize')}
            onClick={() => setSize(size === 'max' ? 'docked' : 'max')}
          >
            {size === 'max' ? <RestoreIcon /> : <MaximizeIcon />}
          </button>
          <button
            type="button"
            className="compose__bar-button"
            title={t('compose.close')}
            aria-label={t('compose.close')}
            onClick={closeCompose}
          >
            <CloseIcon size={14} />
          </button>
        </div>
        {/* Folding hides the draft rather than unmounting it: the editor holds
            the undo history and the autosave its timer. */}
        <div className="compose__content" hidden={minimized}>
          {addressRows}
          {editorBlock}
          {footer}
        </div>
      </div>
      {promptDialog}
      {fillDialog}
    </div>
  )
}
