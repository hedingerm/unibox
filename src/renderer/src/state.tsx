import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react'
import type { QueuedMutationView, SearchResult } from '@shared/ipc'
import type { SearchFilter } from '@shared/search-query'
import { parseSearchQuery } from '@shared/search-query'
import type {
  Account,
  AiJob,
  AiRequest,
  AppSettings,
  Draft,
  DraftInput,
  DraftKind,
  DraftSummary,
  SettleDecision,
  SyncStatus,
  Identity,
  LabelWithCounts,
  MailboxSelection,
  OutboxAttachment,
  OutboxItem,
  Signature,
  Template,
  ThreadDetail,
  ThreadSummary
} from '@shared/types'
import { SYSTEM_LABELS } from '@shared/types'
import { DEFAULT_FOLLOW_UP_DAYS } from '@shared/followup'
import { parseMailto } from '@shared/mailto'
import { t } from './i18n'
import { api } from './lib/bridge'
import { buildForwardHtml, forwardSubject } from './lib/compose'
import { plainTextToHtml } from './lib/sanitize'
import { errorMessage } from './lib/errors'
import type { AdminPage } from './lib/admin-pages'

/** Which multi-select gesture a click carried. */
export interface SelectModifiers {
  /** ⇧: select everything between the anchor and this row. */
  range?: boolean
  /** ⌘/Ctrl: add or remove this row on its own. */
  toggle?: boolean
}

/**
 * The outcome of a settle that ran without a review step. It carries what it
 * takes to undo itself, so acting autonomously stays reversible.
 */
export interface SettleNotice {
  id: string
  subject: string
  /** Where it went, ready to render; `null` when the mail stayed put. */
  target: string | null
  reason: string
  /** The move to reverse on undo; `null` when nothing was moved. */
  decision: SettleDecision | null
  expiresAt: number
}

/** How long a settle notice offers its undo before it fades. */
export const SETTLE_NOTICE_MS = 12_000

/**
 * How many conversations may be classified at the same time. Every settle is
 * its own Claude Code process, so the rest waits in a queue rather than
 * fanning out — clicking is never blocked, only the machine is spared.
 */
export const SETTLE_CONCURRENCY = 3

/** The settle queue's moving parts, held in a ref so they survive re-renders. */
interface SettleQueue {
  /** Conversations waiting for a slot, oldest first. */
  waiting: string[]
  /** Conversations being classified right now. */
  running: Set<string>
  run: (threadId: string) => Promise<void>
  /** Mirrors the two collections into state so the list can draw them. */
  onChange: () => void
}

/**
 * Starts as many waiting conversations as there are free slots, and again
 * whenever one finishes. Kept out of the component so it can call itself
 * without a ref dance; everything it touches comes in through `queue`.
 */
function pumpSettleQueue(queue: SettleQueue): void {
  while (queue.running.size < SETTLE_CONCURRENCY && queue.waiting.length > 0) {
    const threadId = queue.waiting.shift()!
    queue.running.add(threadId)
    queue.onChange()
    void queue.run(threadId).finally(() => {
      queue.running.delete(threadId)
      queue.onChange()
      pumpSettleQueue(queue)
    })
  }
}

/** Which of the three windows this is — decides the title and the seeded body. */
export type ComposeKind = DraftKind

export interface ComposeSeed {
  /**
   * Counts the times a composer was opened. It is the editor's React key: the
   * window keeps its own copy of the draft in state and in the editor, and
   * without a new key a second `openCompose` would leave both showing the
   * previous mail — which is what a `mailto:` clicked while a draft is open
   * would otherwise do. A new key unmounts the old window, and unmounting is
   * what writes its draft away.
   */
  seq: number
  kind: ComposeKind
  /**
   * Where the draft is edited: `inline` is the strip that grows out of the
   * reading pane's reply line, `window` the composer that floats over the app.
   */
  mode: 'inline' | 'window'
  accountId: string
  identity: Identity | null
  to: string
  cc: string
  /** Blind copies; optional because only a stored draft or a link brings any. */
  bcc?: string
  subject: string
  html: string
  /** Files the window starts with — a forward carries the original's. */
  attachments: OutboxAttachment[]
  replyToMessageId: string | null
  /** Stored draft this window continues; `null` until the first autosave. */
  draftId: string | null
  /** Job whose result this window should pick up when it opens. */
  aiJobId?: string
}

/**
 * A draft is not a conversation, but it shares a row with them in the Entwürfe
 * folder. The prefix is what tells the two apart wherever a row id travels.
 */
export const DRAFT_ROW_PREFIX = 'draft:'

export function draftIdOfRow(threadId: string): string | null {
  return threadId.startsWith(DRAFT_ROW_PREFIX) ? threadId.slice(DRAFT_ROW_PREFIX.length) : null
}

/** Dresses a draft as a list row: recipients stand in for the sender. */
function draftRow(draft: DraftSummary): ThreadSummary {
  const to = draft.to.trim()
  return {
    threadId: `${DRAFT_ROW_PREFIX}${draft.id}`,
    accountId: draft.accountId,
    subject: draft.subject || t('list.noSubject'),
    snippet: draft.snippet,
    lastMessageAt: draft.updatedAt,
    messageCount: 1,
    unread: false,
    starred: false,
    hasAttachments: draft.hasAttachments,
    participants: [],
    lastFrom: { name: to || t('list.noRecipients'), email: to },
    lastDirection: 'outgoing',
    // The row *is* the draft; a marker next to its own text would say it twice.
    draft: null,
    snoozedUntil: null,
    followUp: null
  }
}

/** What the hover buttons on a list row can do to that row alone. */
export type RowAction = 'archive' | 'trash' | 'read' | 'unread' | 'snooze' | 'unsnooze'

interface UniboxState {
  accounts: Account[]
  labels: Record<string, LabelWithCounts[]>
  counts: Record<string, number>
  selection: MailboxSelection
  threads: ThreadSummary[]
  /** Whether older conversations are still waiting behind the loaded ones. */
  hasMore: boolean
  loadingMore: boolean
  searchResults: SearchResult[] | null
  searchText: string
  /** The operators the current search text carries, for the toolbar to show. */
  searchFilters: SearchFilter[]
  selectedThreadId: string | null
  /** Every conversation an action applies to; always contains the focused one. */
  selectedThreadIds: string[]
  thread: ThreadDetail | null
  identities: Identity[]
  signatures: Signature[]
  templates: Template[]
  outbox: OutboxItem[]
  /** Write-backs still owed to the servers, failed ones included. */
  queue: QueuedMutationView[]
  /** How much work is waiting — the number the offline banner reports. */
  pending: { mutations: number; outbox: number }
  /** Whether this machine currently has a network. */
  online: boolean
  syncStatus: Record<string, SyncStatus>
  settings: AppSettings
  compose: ComposeSeed | null
  /** Every stored draft, newest first — the Entwürfe folders read from this. */
  drafts: DraftSummary[]
  /**
   * Every conversation still waiting for an answer, most urgent first. Kept
   * whole rather than filtered per mailbox: the reading pane has to know the
   * state of the conversation it shows even when that mailbox is elsewhere.
   */
  followUps: ThreadSummary[]
  /** Results of settles that ran without confirmation, newest last. */
  settleNotices: SettleNotice[]
  /** Writing jobs still running or waiting to be picked up, oldest first. */
  aiJobs: AiJob[]
  /** Conversations currently being settled in the background. */
  settling: string[]
  /** Conversations waiting for a free settle slot, in the order they were asked for. */
  settleQueued: string[]
  /** Whether the Verwaltung workspace stands in for the mailbox. */
  settingsOpen: boolean
  /** The Verwaltung page on screen, `null` while the mailbox is shown. */
  adminPage: AdminPage | null
  /** Whether the Settle review sheet is on screen. */
  settleOpen: boolean
  error: string | null
  /** Failure of the last mailbox action, shown in the toolbar that owns it. */
  actionError: string | null
  /** Key of the mailbox action currently running, for its own spinner. */
  actionBusy: string | null
  loading: boolean
}

interface UniboxActions {
  select: (selection: MailboxSelection) => void
  selectThread: (threadId: string | null, modifiers?: SelectModifiers) => void
  moveSelection: (delta: number, extend?: boolean) => void
  /** Adds or removes the focused conversation from the selection. */
  toggleSelected: () => void
  /** Picks every conversation the list currently holds. */
  selectAll: () => void
  /**
   * One action on one row, whatever else is selected — the hover buttons of a
   * list row. `wakeAt` is required for `snooze`.
   */
  actOnThread: (threadId: string, action: RowAction, wakeAt?: number) => Promise<void>
  /**
   * Stars or unstars one conversation. The row flips at once: a star is a
   * glance-and-click gesture, and waiting for the round trip would read as a
   * missed click. Clicking again is its undo.
   */
  toggleStar: (threadId: string, starred: boolean) => Promise<void>
  loadMore: () => Promise<void>
  setSearchText: (text: string) => void
  refresh: () => Promise<void>
  archiveSelected: () => Promise<void>
  trashSelected: () => Promise<void>
  untrashSelected: () => Promise<void>
  deleteSelected: () => Promise<void>
  spamSelected: () => Promise<void>
  unspamSelected: () => Promise<void>
  toggleReadSelected: () => Promise<void>
  /** Archives the selection and has it return to the inbox at `wakeAt`. */
  snoozeSelected: (wakeAt: number) => Promise<void>
  /** Brings a put-aside selection back right away. */
  unsnoozeSelected: () => Promise<void>
  /** Starts waiting for an answer on the focused conversation, or moves the wait. */
  expectReply: (threadId: string, dueAt: number) => Promise<void>
  /** Ends a wait: the matter is settled, no answer is owed. */
  clearFollowUp: (threadId: string) => Promise<void>
  changeLabelsSelected: (addLabelIds: string[], removeLabelIds: string[]) => Promise<void>
  openCompose: (seed?: Partial<ComposeSeed>) => Promise<void>
  /** Moves the inline reply into the floating window, text and all. */
  popOutCompose: (patch: Partial<ComposeSeed>) => void
  openReply: (messageId?: string) => Promise<void>
  /** Opens a forward of the given message, or of the thread's last one. */
  openForward: (messageId?: string) => Promise<void>
  /** Reopens a stored draft in the compose window it was written in. */
  openDraft: (draftId: string) => Promise<void>
  /** Writes the draft and returns it, so the window learns its id. */
  saveDraft: (input: DraftInput) => Promise<Draft>
  discardDraft: (draftId: string) => Promise<void>
  closeCompose: () => void
  /** Opens the Verwaltung on its general page, or goes back to the mail. */
  openSettings: (open: boolean) => void
  /** Opens one Verwaltung page; `null` returns to the mailbox. */
  openAdmin: (page: AdminPage | null) => void
  openSettle: (open: boolean) => void
  /** Settles one conversation straight away and announces where it went. */
  settleOne: (threadId: string) => Promise<void>
  undoSettle: (noticeId: string) => Promise<void>
  dismissSettleNotice: (noticeId: string) => void
  /** Hands a writing job to the main process; resolves once it is registered. */
  startAi: (request: AiRequest) => Promise<AiJob>
  /** Forgets a job, whether its result was taken over or thrown away. */
  dismissAi: (jobId: string) => void
  /** Reopens the compose window a finished job belongs to. */
  openAiJob: (jobId: string) => Promise<void>
  reloadOutbox: () => Promise<void>
  reloadQueue: () => Promise<void>
  setError: (message: string | null) => void
  clearActionError: () => void
  saveSettings: (patch: Partial<AppSettings>) => Promise<void>
  /** Pins the current search text to the sidebar under `name`. */
  saveSearch: (name: string, query: string) => Promise<void>
  removeSavedSearch: (name: string) => Promise<void>
  reloadIdentities: () => Promise<void>
  reloadSignatures: () => Promise<void>
  reloadTemplates: () => Promise<void>
}

export type UniboxContextValue = UniboxState & UniboxActions

const UniboxContext = createContext<UniboxContextValue | null>(null)

/** Conversations fetched per page; the list pulls more as the user scrolls. */
export const THREAD_PAGE_SIZE = 100

const DEFAULT_SETTINGS: AppSettings = {
  undoSendSeconds: 10,
  pollIntervalSeconds: 90,
  notificationsEnabled: true,
  onboardingComplete: false,
  settleModel: 'sonnet',
  settleBatchSize: 12,
  claudePath: null,
  aiModel: 'sonnet',
  aiStylePrompt: '',
  savedSearches: [],
  followUpEnabled: true,
  followUpDays: DEFAULT_FOLLOW_UP_DAYS
}

/**
 * Settings from before the theme existed carry none; filling in the default
 * here keeps "not loaded yet" (no theme, see DEFAULT_SETTINGS) distinguishable
 * from "follow the system".
 */
function withTheme(settings: AppSettings): AppSettings {
  return { ...settings, theme: settings.theme ?? 'system' }
}

export function UniboxProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [accounts, setAccounts] = useState<Account[]>([])
  const [labels, setLabels] = useState<Record<string, LabelWithCounts[]>>({})
  const [counts, setCounts] = useState<Record<string, number>>({})
  const [selection, setSelection] = useState<MailboxSelection>({ accountId: null, labelId: null })
  const [threads, setThreads] = useState<ThreadSummary[]>([])
  const [hasMore, setHasMore] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  // How many rows the current view holds, so a refresh reloads the same window
  // instead of snapping back to the first page.
  const loadedCount = useRef(THREAD_PAGE_SIZE)
  const [searchResults, setSearchResults] = useState<SearchResult[] | null>(null)
  const [searchText, setSearchTextState] = useState('')
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null)
  const [selectedThreadIds, setSelectedThreadIds] = useState<string[]>([])
  // Where a ⇧-click measures from; the last row picked without ⇧.
  const anchor = useRef<string | null>(null)
  // Which conversation is being read, as last set — what tells a move between
  // conversations apart from re-picking the one already open.
  const focused = useRef<string | null>(null)

  const [thread, setThread] = useState<ThreadDetail | null>(null)
  const [identities, setIdentities] = useState<Identity[]>([])
  const [signatures, setSignatures] = useState<Signature[]>([])
  const [templates, setTemplates] = useState<Template[]>([])
  const [outbox, setOutbox] = useState<OutboxItem[]>([])
  const [queue, setQueue] = useState<QueuedMutationView[]>([])
  const [pending, setPending] = useState({ mutations: 0, outbox: 0 })
  const [online, setOnline] = useState(() => navigator.onLine)
  const [syncStatus, setSyncStatus] = useState<Record<string, SyncStatus>>({})
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS)
  const [compose, setCompose] = useState<ComposeSeed | null>(null)
  const [drafts, setDrafts] = useState<DraftSummary[]>([])
  const [followUps, setFollowUps] = useState<ThreadSummary[]>([])
  const [adminPage, setAdminPage] = useState<AdminPage | null>(null)
  const settingsOpen = adminPage !== null
  const [settleOpen, setSettleOpen] = useState(false)
  const [settleNotices, setSettleNotices] = useState<SettleNotice[]>([])
  const [settling, setSettling] = useState<string[]>([])
  const [settleQueued, setSettleQueued] = useState<string[]>([])
  const [aiJobs, setAiJobs] = useState<AiJob[]>([])
  const [error, setError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [actionBusy, setActionBusy] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const closeInlineCompose = useCallback(() => {
    setCompose((current) => (current?.mode === 'inline' ? null : current))
  }, [])

  /**
   * Focuses a conversation. An inline reply is part of the one it answers, so
   * leaving that conversation closes it — the strip writes its draft on the way
   * out, and no invisible compose is left holding down the shortcuts.
   */
  const focusThread = useCallback(
    (threadId: string | null) => {
      const left = focused.current !== null && focused.current !== threadId
      focused.current = threadId
      setSelectedThreadId(threadId)
      if (left) closeInlineCompose()
    },
    [closeInlineCompose]
  )

  // The Entwürfe folder lists drafts, not conversations: what Gmail holds is
  // pulled into the same local drafts, so its DRAFT messages would only be a
  // second, unopenable copy of every row here.
  const draftLabelIds = useMemo(
    () =>
      new Set(
        Object.values(labels)
          .flat()
          .filter((label) => label.remoteId === SYSTEM_LABELS.drafts)
          .map((label) => label.id)
      ),
    [labels]
  )
  const showingDrafts = selection.labelId !== null && draftLabelIds.has(selection.labelId)
  const mergedThreads = useMemo(() => {
    if (!showingDrafts) return threads
    return drafts
      .filter((draft) => !selection.accountId || draft.accountId === selection.accountId)
      .map(draftRow)
  }, [showingDrafts, drafts, selection.accountId, threads])
  const visibleThreads = searchResults ?? mergedThreads

  const loadAccountsAndLabels = useCallback(async () => {
    const list = await api.invoke('accounts:list')
    setAccounts(list)
    const entries = await Promise.all(
      list.map(async (account) => [account.id, await api.invoke('labels:list', account.id)] as const)
    )
    setLabels(Object.fromEntries(entries))
    setCounts(await api.invoke('mailbox:counts'))
  }, [])

  /** Fetches one row more than asked for; that extra row *is* the "more" flag. */
  const loadThreads = useCallback(async (target: MailboxSelection, count: number) => {
    const list = await api.invoke('threads:list', { ...target, limit: count + 1, offset: 0 })
    setHasMore(list.length > count)
    setThreads(list.slice(0, count))
    loadedCount.current = count
  }, [])

  const refresh = useCallback(async () => {
    try {
      await loadAccountsAndLabels()
      await loadThreads(selection, loadedCount.current)
      // The open conversation is re-read too: a sync can fill in a body that
      // was still missing when the thread was opened.
      if (selectedThreadId) setThread(await api.invoke('threads:get', selectedThreadId))
      setOutbox(await api.invoke('outbox:list'))
      setDrafts(await api.invoke('drafts:list'))
      setFollowUps(await api.invoke('followups:list'))
      setQueue(await api.invoke('queue:list'))
      setPending(await api.invoke('queue:pending'))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
  }, [loadAccountsAndLabels, loadThreads, selection, selectedThreadId])

  const reloadIdentities = useCallback(async () => {
    setIdentities(await api.invoke('identities:list'))
  }, [])

  const reloadSignatures = useCallback(async () => {
    setSignatures(await api.invoke('signatures:list'))
  }, [])

  const reloadTemplates = useCallback(async () => {
    setTemplates(await api.invoke('templates:list'))
  }, [])

  const reloadOutbox = useCallback(async () => {
    setOutbox(await api.invoke('outbox:list'))
  }, [])

  const reloadDrafts = useCallback(async () => {
    setDrafts(await api.invoke('drafts:list'))
  }, [])

  const reloadQueue = useCallback(async () => {
    setQueue(await api.invoke('queue:list'))
    setPending(await api.invoke('queue:pending'))
  }, [])

  useEffect(() => {
    void (async () => {
      setSettings(withTheme(await api.invoke('settings:get')))
      await reloadIdentities()
      await reloadSignatures()
      await reloadTemplates()
      // Catch up on a backfill that started before this window opened.
      const statuses = await api.invoke('sync:status')
      setSyncStatus(Object.fromEntries(statuses.map((status) => [status.accountId, status])))
    })()
  }, [reloadIdentities, reloadSignatures, reloadTemplates])

  // `refresh` closes over the selection, so switching mailbox reloads the list.
  useEffect(() => {
    void (async () => {
      await refresh()
    })()
  }, [refresh])

  useEffect(() => {
    const offData = api.on('data:changed', () => void refresh())
    const offProgress = api.on('sync:progress', (status) =>
      setSyncStatus((current) => ({ ...current, [status.accountId]: status }))
    )
    const offOutbox = api.on('outbox:changed', ({ items }) => setOutbox(items))
    const offStatus = api.on('account:status', () => void loadAccountsAndLabels())
    // A job outlives the window that started it, so its result arrives here
    // and not in the compose component.
    const offAi = api.on('ai:job', (job) =>
      setAiJobs((current) => {
        const known = current.some((entry) => entry.id === job.id)
        return known ? current.map((entry) => (entry.id === job.id ? job : entry)) : [...current, job]
      })
    )
    const offOpen = api.onOpenThread((threadId) => {
      focusThread(threadId)
      setSelectedThreadIds([threadId])
      anchor.current = threadId
    })
    return () => {
      offData()
      offProgress()
      offOutbox()
      offStatus()
      offAi()
      offOpen()
    }
  }, [refresh, loadAccountsAndLabels, focusThread])

  /**
   * Offline is a normal state for a mail client, not an error: the app keeps
   * working from the local store, says so, and flushes what piled up as soon
   * as the network is back.
   */
  useEffect(() => {
    const goOnline = (): void => {
      setOnline(true)
      void api.invoke('sync:now').catch(() => undefined)
    }
    const goOffline = (): void => setOnline(false)
    window.addEventListener('online', goOnline)
    window.addEventListener('offline', goOffline)
    return () => {
      window.removeEventListener('online', goOnline)
      window.removeEventListener('offline', goOffline)
    }
  }, [])

  // Parsing on every keystroke is cheap and keeps the toolbar chips, the
  // scoping rule and the main-process query reading the same text.
  const searchFilters = useMemo(() => parseSearchQuery(searchText).filters, [searchText])

  // Search runs debounced against the local FTS index.
  useEffect(() => {
    let cancelled = false
    const handle = setTimeout(() => {
      if (cancelled) return
      // Operators are a query on their own — `is:unread` must run — but a
      // single stray letter should not hit the index while typing.
      if (searchFilters.length === 0 && searchText.trim().length < 2) {
        setSearchResults(null)
        return
      }
      void api
        .invoke('search:query', {
          text: searchText,
          accountId: selection.accountId,
          // An operator query searches the whole account, the way Gmail does;
          // staying inside the opened label would answer `is:unread` with the
          // confusing empty result of "unread, but only here".
          labelId: searchFilters.length > 0 ? null : selection.labelId
        })
        .then((results) => {
          if (!cancelled) setSearchResults(results)
        })
        .catch(() => {
          if (!cancelled) setSearchResults([])
        })
    }, 150)
    return () => {
      cancelled = true
      clearTimeout(handle)
    }
  }, [searchText, searchFilters, selection.accountId, selection.labelId])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      if (!selectedThreadId) {
        if (!cancelled) setThread(null)
        return
      }
      // A draft row has no conversation behind it — the compose window is what
      // opens for it, so there is nothing to fetch or mark read.
      if (draftIdOfRow(selectedThreadId)) {
        if (!cancelled) setThread(null)
        return
      }
      const detail = await api.invoke('threads:get', selectedThreadId)
      if (cancelled) return
      setThread(detail)
      // Only *reading* a conversation marks it read — picking several for a
      // bulk action must not silently clear their unread state.
      if (selectedThreadIds.length > 1) return
      const unread = detail?.messages.filter((message) =>
        message.labelIds.some((id) => id.endsWith(':l:UNREAD'))
      )
      if (!unread || unread.length === 0) return
      await api.invoke('messages:mark', { messageIds: unread.map((m) => m.id), read: true })
      await loadAccountsAndLabels()
      const refreshed = await api.invoke('threads:get', selectedThreadId)
      if (cancelled) return
      setThread(refreshed)
      setThreads((previous) =>
        previous.map((item) =>
          item.threadId === selectedThreadId ? { ...item, unread: false } : item
        )
      )
    })()
    return () => {
      cancelled = true
    }
  }, [selectedThreadId, selectedThreadIds.length, loadAccountsAndLabels])

  const clearActionError = useCallback(() => setActionError(null), [])

  /**
   * Appends the next page. Only the new slice is fetched, so scrolling through
   * a large mailbox stays cheap and the rows already on screen do not move.
   */
  const loadMore = useCallback(async () => {
    if (!hasMore || loadingMore || searchResults) return
    setLoadingMore(true)
    try {
      const offset = threads.length
      const page = await api.invoke('threads:list', {
        ...selection,
        limit: THREAD_PAGE_SIZE + 1,
        offset
      })
      setHasMore(page.length > THREAD_PAGE_SIZE)
      const fresh = page.slice(0, THREAD_PAGE_SIZE)
      setThreads((previous) => {
        const known = new Set(previous.map((item) => item.threadId))
        const next = [...previous, ...fresh.filter((item) => !known.has(item.threadId))]
        loadedCount.current = next.length
        return next
      })
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setLoadingMore(false)
    }
  }, [hasMore, loadingMore, searchResults, threads.length, selection])

  const select = useCallback((next: MailboxSelection) => {
    setSelection(next)
    focusThread(null)
    setSelectedThreadIds([])
    anchor.current = null
    setSearchTextState('')
    setSearchResults(null)
    setActionError(null)
    loadedCount.current = THREAD_PAGE_SIZE
  }, [focusThread])

  /** The rows between two conversations, in the order the list shows them. */
  const rangeBetween = useCallback(
    (from: string | null, to: string): string[] => {
      const end = visibleThreads.findIndex((item) => item.threadId === to)
      if (end < 0) return [to]
      const start = from ? visibleThreads.findIndex((item) => item.threadId === from) : end
      if (start < 0) return [to]
      const [low, high] = start <= end ? [start, end] : [end, start]
      return visibleThreads.slice(low, high + 1).map((item) => item.threadId)
    },
    [visibleThreads]
  )

  const selectThread = useCallback(
    (threadId: string | null, modifiers?: SelectModifiers) => {
      if (threadId === null) {
        focusThread(null)
        setSelectedThreadIds([])
        anchor.current = null
        return
      }
      setActionError(null)
      if (modifiers?.range) {
        setSelectedThreadIds(rangeBetween(anchor.current, threadId))
        focusThread(threadId)
        return
      }
      if (modifiers?.toggle) {
        // Picking conversations for a bulk action is not reading one of them:
        // whatever was being written inline goes back to the drafts.
        closeInlineCompose()
        focused.current = null
        setSelectedThreadIds((previous) => {
          const next = previous.includes(threadId)
            ? previous.filter((id) => id !== threadId)
            : [...previous, threadId]
          setSelectedThreadId(next.includes(threadId) ? threadId : (next.at(-1) ?? null))
          return next
        })
        anchor.current = threadId
        return
      }
      setSelectedThreadIds([threadId])
      focusThread(threadId)
      anchor.current = threadId
    },
    [rangeBetween, focusThread, closeInlineCompose]
  )

  const moveSelection = useCallback(
    (delta: number, extend = false) => {
      if (visibleThreads.length === 0) return
      const index = visibleThreads.findIndex((item) => item.threadId === selectedThreadId)
      const next = Math.min(
        Math.max(index === -1 ? (delta > 0 ? 0 : visibleThreads.length - 1) : index + delta, 0),
        visibleThreads.length - 1
      )
      const threadId = visibleThreads[next]?.threadId ?? null
      if (!threadId) return
      selectThread(threadId, extend ? { range: true } : undefined)
    },
    [visibleThreads, selectedThreadId, selectThread]
  )

  const toggleSelected = useCallback(() => {
    if (!selectedThreadId) return
    selectThread(selectedThreadId, { toggle: true })
  }, [selectedThreadId, selectThread])

  const selectAll = useCallback(() => {
    const ids = visibleThreads.map((item) => item.threadId)
    if (ids.length === 0) return
    // Picking for a bulk action, like ⌘-click: not reading any one of them.
    closeInlineCompose()
    setActionError(null)
    focused.current = null
    setSelectedThreadIds(ids)
    setSelectedThreadId((current) => (current && ids.includes(current) ? current : ids[0]!))
    anchor.current = ids[0]!
  }, [visibleThreads, closeInlineCompose])

  /**
   * Actions run on message ids, so the selected conversations are resolved in
   * one call rather than by opening each of them.
   */
  const currentMessageIds = useCallback(async (): Promise<string[]> => {
    if (selectedThreadIds.length === 0) return thread?.messages.map((message) => message.id) ?? []
    return api.invoke('threads:messageIds', selectedThreadIds)
  }, [selectedThreadIds, thread])

  /**
   * Mailbox actions all report the same way: a spinner on the control that
   * started them and the real cause next to it when they fail. Whether the
   * action came from the toolbar or from a keyboard shortcut, the toolbar is
   * where it is announced.
   */
  const runAction = useCallback(
    async (key: string, action: () => Promise<void>, keepSelection = false) => {
      setActionBusy(key)
      setActionError(null)
      try {
        await action()
        // The acted-on conversations have left this mailbox; keeping their ids
        // would aim the next action at rows that are no longer there.
        if (!keepSelection) {
          focusThread(null)
          setSelectedThreadIds([])
          anchor.current = null
        }
        await refresh()
      } catch (cause) {
        setActionError(errorMessage(cause))
      } finally {
        setActionBusy(null)
      }
    },
    [refresh, focusThread]
  )

  /**
   * Settles one conversation without asking first. The result arrives as a
   * notice — with one mail there is nothing to review that a toast plus undo
   * does not cover. Called by the queue below, never directly.
   */
  const runSettle = useCallback(
    async (threadId: string) => {
      setActionError(null)
      try {
        const report = await api.invoke('settle:analyze', [threadId])
        const suggestion = report.suggestions[0]
        const subject = suggestion?.subject ?? ''
        const notice = (
          target: string | null,
          reason: string,
          decision: SettleDecision | null
        ): void => {
          setSettleNotices((current) => [
            ...current,
            {
              id: `${threadId}:${Date.now()}`,
              subject,
              target,
              reason,
              decision,
              expiresAt: Date.now() + SETTLE_NOTICE_MS
            }
          ])
        }

        if (!suggestion || suggestion.action === 'keep') {
          notice(null, suggestion?.reason ?? t('settle.noSuggestion'), null)
          return
        }

        const decision: SettleDecision = {
          threadId,
          action: suggestion.action,
          labelName: suggestion.labelName,
          labelId: suggestion.labelId,
          archive: true
        }
        const result = await api.invoke('settle:apply', [decision])
        const failure = result.failed[0]
        if (failure) throw new Error(failure.message)
        const target =
          suggestion.action === 'trash'
            ? t('labels.TRASH')
            : suggestion.action === 'spam'
              ? t('labels.SPAM')
              : (suggestion.labelName ?? '')
        notice(target, suggestion.reason, decision)
        // The mail has left this mailbox; keeping it selected would aim the
        // next toolbar action at a row that is no longer there. Only this
        // conversation is dropped — while a settle runs the user goes on
        // picking other rows, and those selections stay theirs.
        setSelectedThreadId((current) => (current === threadId ? null : current))
        setSelectedThreadIds((current) => current.filter((id) => id !== threadId))
        if (anchor.current === threadId) anchor.current = null
        await refresh()
      } catch (cause) {
        setActionError(errorMessage(cause))
      }
    },
    [refresh]
  )

  // `runSettle` is rebuilt whenever the mailbox view changes, but the queue
  // that drives it must not be: it outlives any single render.
  const runSettleRef = useRef(runSettle)
  useEffect(() => {
    runSettleRef.current = runSettle
  }, [runSettle])
  // The queue lives in a ref: a click has to see what the click before it
  // enqueued, and state updates are not visible until the next render.
  const settleQueue = useRef<SettleQueue>({
    waiting: [],
    running: new Set(),
    run: (threadId) => runSettleRef.current(threadId),
    onChange: () => {
      setSettling([...settleQueue.current.running])
      setSettleQueued([...settleQueue.current.waiting])
    }
  })

  /**
   * Puts a conversation in line to be settled. Clicking never waits: a settle
   * already running is left alone and the new mail starts as soon as a slot
   * frees up, so the user can work down the inbox at their own speed.
   */
  const settleOne = useCallback(async (threadId: string) => {
    const queue = settleQueue.current
    if (queue.running.has(threadId) || queue.waiting.includes(threadId)) return
    queue.waiting.push(threadId)
    pumpSettleQueue(queue)
  }, [])

  const dismissSettleNotice = useCallback((noticeId: string) => {
    setSettleNotices((current) => current.filter((notice) => notice.id !== noticeId))
  }, [])

  const undoSettle = useCallback(
    async (noticeId: string) => {
      const notice = settleNotices.find((entry) => entry.id === noticeId)
      setSettleNotices((current) => current.filter((entry) => entry.id !== noticeId))
      if (!notice?.decision) return
      try {
        await api.invoke('settle:undo', [notice.decision])
        await refresh()
      } catch (cause) {
        setActionError(errorMessage(cause))
      }
    },
    [refresh, settleNotices]
  )

  const archiveSelected = useCallback(async () => {
    await runAction('archive', async () => {
      const ids = await currentMessageIds()
      if (ids.length > 0) await api.invoke('messages:archive', ids)
    })
  }, [currentMessageIds, runAction])

  const trashSelected = useCallback(async () => {
    await runAction('trash', async () => {
      const ids = await currentMessageIds()
      if (ids.length > 0) await api.invoke('messages:trash', ids)
    })
  }, [currentMessageIds, runAction])

  const spamSelected = useCallback(async () => {
    await runAction('spam', async () => {
      const ids = await currentMessageIds()
      if (ids.length > 0) await api.invoke('messages:spam', ids)
    })
  }, [currentMessageIds, runAction])

  const unspamSelected = useCallback(async () => {
    await runAction('unspam', async () => {
      const ids = await currentMessageIds()
      if (ids.length > 0) await api.invoke('messages:unspam', ids)
    })
  }, [currentMessageIds, runAction])

  /**
   * Conversations the next action applies to. Snoozing works on whole threads
   * rather than on messages, and a draft row stands for no conversation at all.
   */
  const currentThreadIds = useCallback((): string[] => {
    const ids = selectedThreadIds.length > 0 ? selectedThreadIds : thread ? [thread.threadId] : []
    return ids.filter((id) => draftIdOfRow(id) === null)
  }, [selectedThreadIds, thread])

  const snoozeSelected = useCallback(
    async (wakeAt: number) => {
      await runAction('snooze', async () => {
        const ids = currentThreadIds()
        if (ids.length > 0) await api.invoke('snooze:set', ids, wakeAt)
      })
    },
    [currentThreadIds, runAction]
  )

  const unsnoozeSelected = useCallback(async () => {
    await runAction('unsnooze', async () => {
      const ids = currentThreadIds()
      if (ids.length > 0) await api.invoke('snooze:cancel', ids)
    })
  }, [currentThreadIds, runAction])

  // A wait belongs to one conversation, so unlike the bulk actions these take
  // the thread they act on — the reading pane and the row menu both name it.
  const expectReply = useCallback(
    async (threadId: string, dueAt: number) => {
      await runAction(
        'followup',
        async () => {
          await api.invoke('followups:set', threadId, dueAt)
        },
        true
      )
    },
    [runAction]
  )

  const clearFollowUp = useCallback(
    async (threadId: string) => {
      await runAction(
        'followup',
        async () => {
          await api.invoke('followups:clear', threadId)
        },
        true
      )
    },
    [runAction]
  )

  /** Irreversible, so the caller must have asked the user first. */
  const deleteSelected = useCallback(async () => {
    await runAction('delete', async () => {
      const ids = await currentMessageIds()
      if (ids.length > 0) await api.invoke('messages:delete', ids)
    })
  }, [currentMessageIds, runAction])

  const untrashSelected = useCallback(async () => {
    await runAction('untrash', async () => {
      const ids = await currentMessageIds()
      if (ids.length > 0) await api.invoke('messages:untrash', ids)
    })
  }, [currentMessageIds, runAction])

  /** Unread wins: a mixed selection is marked read, matching every mail client. */
  const toggleReadSelected = useCallback(async () => {
    const chosen = new Set(selectedThreadIds)
    const scope = visibleThreads.filter((item) =>
      chosen.size > 0 ? chosen.has(item.threadId) : item.threadId === selectedThreadId
    )
    const read = scope.some((item) => item.unread)
    await runAction(
      'read',
      async () => {
        const ids = await currentMessageIds()
        if (ids.length > 0) await api.invoke('messages:mark', { messageIds: ids, read })
      },
      true
    )
  }, [currentMessageIds, visibleThreads, selectedThreadIds, selectedThreadId, runAction])

  const actOnThread = useCallback(
    async (threadId: string, action: RowAction, wakeAt?: number) => {
      await runAction(
        action,
        async () => {
          if (action === 'snooze') {
            if (wakeAt === undefined) return
            await api.invoke('snooze:set', [threadId], wakeAt)
          } else if (action === 'unsnooze') {
            await api.invoke('snooze:cancel', [threadId])
          } else {
            const ids = await api.invoke('threads:messageIds', [threadId])
            if (ids.length === 0) return
            if (action === 'archive') await api.invoke('messages:archive', ids)
            else if (action === 'trash') await api.invoke('messages:trash', ids)
            else await api.invoke('messages:mark', { messageIds: ids, read: action === 'read' })
          }
          if (action === 'read' || action === 'unread') return
          // The row has left this mailbox. Only it leaves the selection — the
          // rest was picked on purpose and stays picked.
          setSelectedThreadIds((current) => current.filter((id) => id !== threadId))
          if (focused.current === threadId) focusThread(null)
          else setSelectedThreadId((current) => (current === threadId ? null : current))
          if (anchor.current === threadId) anchor.current = null
        },
        true
      )
    },
    [runAction, focusThread]
  )

  const toggleStar = useCallback(
    async (threadId: string, starred: boolean) => {
      const flip = <T extends ThreadSummary>(list: T[]): T[] =>
        list.map((item) => (item.threadId === threadId ? { ...item, starred } : item))
      setThreads(flip)
      setSearchResults((current) => (current ? flip(current) : current))
      setActionError(null)
      try {
        await api.invoke('threads:star', [threadId], starred)
      } catch (cause) {
        setActionError(errorMessage(cause))
      }
      await refresh()
    },
    [refresh]
  )

  const changeLabelsSelected = useCallback(
    async (addLabelIds: string[], removeLabelIds: string[]) => {
      await runAction(
        'labels',
        async () => {
          const ids = await currentMessageIds()
          if (ids.length > 0) {
            await api.invoke('messages:changeLabels', {
              messageIds: ids,
              addLabelIds,
              removeLabelIds
            })
          }
        },
        true
      )
    },
    [currentMessageIds, runAction]
  )

  const openCompose = useCallback(
    async (seed?: Partial<ComposeSeed>) => {
      const list = identities.length > 0 ? identities : await api.invoke('identities:list')
      if (identities.length === 0) setIdentities(list)
      const fallback = list[0] ?? null
      setCompose((current) => ({
        seq: (current?.seq ?? 0) + 1,
        kind: seed?.kind ?? 'new',
        mode: seed?.mode ?? 'window',
        accountId: seed?.accountId ?? fallback?.accountId ?? accounts[0]?.id ?? '',
        identity: seed?.identity ?? fallback,
        to: seed?.to ?? '',
        cc: seed?.cc ?? '',
        bcc: seed?.bcc ?? '',
        subject: seed?.subject ?? '',
        html: seed?.html ?? '',
        attachments: seed?.attachments ?? [],
        replyToMessageId: seed?.replyToMessageId ?? null,
        draftId: seed?.draftId ?? null,
        aiJobId: seed?.aiJobId
      }))
    },
    [identities, accounts]
  )

  /**
   * A `mailto:` link the user clicked in a message. It opens a composer here
   * rather than going to the OS, which would hand the answer to whatever other
   * mail client is installed and leave no trace of it in this inbox. Its own
   * effect, because it is the one subscription that needs `openCompose`.
   */
  useEffect(() => {
    return api.onMailto((url) => {
      const link = parseMailto(url)
      if (!link) return
      void openCompose({
        to: link.to,
        cc: link.cc,
        bcc: link.bcc,
        subject: link.subject,
        html: link.body ? plainTextToHtml(link.body) : ''
      })
    })
  }, [openCompose])

  const saveDraft = useCallback(
    async (input: DraftInput): Promise<Draft> => {
      const draft = await api.invoke('drafts:save', input)
      await reloadDrafts()
      return draft
    },
    [reloadDrafts]
  )

  const discardDraft = useCallback(
    async (draftId: string) => {
      await api.invoke('drafts:remove', draftId)
      await reloadDrafts()
      // The row is gone; keeping it focused would aim the next action at it.
      setSelectedThreadId((current) =>
        current === `${DRAFT_ROW_PREFIX}${draftId}` ? null : current
      )
      setSelectedThreadIds((current) =>
        current.filter((id) => id !== `${DRAFT_ROW_PREFIX}${draftId}`)
      )
    },
    [reloadDrafts]
  )

  const openDraft = useCallback(
    async (draftId: string) => {
      const draft = await api.invoke('drafts:get', draftId)
      if (!draft) return
      const list = identities.length > 0 ? identities : await api.invoke('identities:list')
      // The identity may have been removed or was a custom address to begin
      // with; the draft carries enough to rebuild it either way.
      const identity =
        list.find((entry) => entry.id === draft.identityId) ??
        (draft.identityEmail
          ? {
              id: `custom:${draft.identityEmail}`,
              accountId: draft.accountId,
              name: draft.identityName,
              email: draft.identityEmail,
              signatureId: null,
              signatureHtml: null,
              isDefault: false,
              source: 'user' as const,
              verified: true
            }
          : null)
      await openCompose({
        kind: draft.kind,
        accountId: draft.accountId,
        identity,
        to: draft.to,
        cc: draft.cc,
        bcc: draft.bcc,
        subject: draft.subject,
        html: draft.html,
        attachments: draft.attachments,
        replyToMessageId: draft.replyToMessageId,
        draftId: draft.id
      })
    },
    [identities, openCompose]
  )

  const openReply = useCallback(
    async (messageId?: string) => {
      const target = messageId
        ? thread?.messages.find((message) => message.id === messageId)
        : thread?.messages[thread.messages.length - 1]
      if (!target) return
      const identity = await api.invoke('identities:forReply', target.id)
      const recipients =
        target.direction === 'outgoing'
          ? target.to
          : target.replyTo.length > 0
            ? target.replyTo
            : [target.from]
      await openCompose({
        kind: 'reply',
        // A reply belongs to the conversation it answers, so it opens in it.
        mode: 'inline',
        accountId: target.accountId,
        identity,
        to: recipients.map((address) => address.email).join(', '),
        subject: target.subject.startsWith('Re: ') ? target.subject : `Re: ${target.subject}`,
        replyToMessageId: target.id
      })
    },
    [thread, openCompose]
  )

  const openForward = useCallback(
    async (messageId?: string) => {
      const target = messageId
        ? thread?.messages.find((message) => message.id === messageId)
        : thread?.messages[thread.messages.length - 1]
      if (!target) return
      const identity = await api.invoke('identities:forReply', target.id)
      // A forward carries the original's files, so every attachment is pulled
      // through the cache first — for Gmail that is where the download happens.
      const loaded = await Promise.all(
        target.attachments.map(async (attachment) => {
          try {
            return { attachment, content: await api.invoke('attachments:open', attachment.id) }
          } catch {
            // A file that cannot be fetched must not block the forward itself.
            return null
          }
        })
      )
      const inlineImages: Record<string, string> = {}
      const attachments: OutboxAttachment[] = []
      for (const entry of loaded) {
        if (!entry) continue
        const { attachment, content } = entry
        if (attachment.inline && attachment.contentId) {
          // Embedded images go back into the body as data URIs; the send path
          // turns them into CID parts again.
          inlineImages[attachment.contentId] = `data:${content.mimeType};base64,${content.content}`
        } else {
          attachments.push({
            filename: attachment.filename,
            mimeType: attachment.mimeType,
            content: content.content
          })
        }
      }
      await openCompose({
        kind: 'forward',
        accountId: target.accountId,
        identity,
        subject: forwardSubject(target.subject),
        html: buildForwardHtml(target, inlineImages),
        attachments,
        // Keeps the forward in the conversation it came from, the way Gmail
        // threads a forward sent out of an open thread.
        replyToMessageId: target.id
      })
    },
    [thread, openCompose]
  )

  const startAi = useCallback(async (request: AiRequest): Promise<AiJob> => {
    const job = await api.invoke('ai:start', request)
    // A job short enough to finish before this resolves has already announced
    // itself over `ai:job`; adding it again would shadow the finished one.
    setAiJobs((current) =>
      current.some((entry) => entry.id === job.id) ? current : [...current, job]
    )
    return job
  }, [])

  const dismissAi = useCallback((jobId: string) => {
    setAiJobs((current) => current.filter((job) => job.id !== jobId))
    void api.invoke('ai:dismiss', jobId).catch(() => undefined)
  }, [])

  const openAiJob = useCallback(
    async (jobId: string) => {
      const job = aiJobs.find((entry) => entry.id === jobId)
      if (!job) return
      const identity =
        identities.find((entry) => entry.id === job.context.identityId) ??
        identities.find((entry) => entry.accountId === job.context.accountId) ??
        null
      await openCompose({
        ...job.context,
        kind: job.context.replyToMessageId ? 'reply' : 'new',
        identity,
        aiJobId: job.id
      })
    },
    [aiJobs, identities, openCompose]
  )

  const saveSettings = useCallback(async (patch: Partial<AppSettings>) => {
    setSettings(withTheme(await api.invoke('settings:set', patch)))
  }, [])

  const saveSearch = useCallback(
    async (name: string, query: string) => {
      // Re-saving under an existing name replaces it, so a pinned search can be
      // corrected without first deleting it.
      const rest = settings.savedSearches.filter((entry) => entry.name !== name)
      await saveSettings({ savedSearches: [...rest, { name, query }] })
    },
    [settings.savedSearches, saveSettings]
  )

  const removeSavedSearch = useCallback(
    async (name: string) => {
      await saveSettings({
        savedSearches: settings.savedSearches.filter((entry) => entry.name !== name)
      })
    },
    [settings.savedSearches, saveSettings]
  )

  const value = useMemo<UniboxContextValue>(
    () => ({
      accounts,
      labels,
      counts,
      selection,
      threads: visibleThreads,
      hasMore: searchResults ? false : hasMore,
      loadingMore,
      searchResults,
      searchText,
      searchFilters,
      selectedThreadId,
      selectedThreadIds,
      thread,
      identities,
      signatures,
      templates,
      outbox,
      queue,
      pending,
      online,
      syncStatus,
      settings,
      compose,
      drafts,
      followUps,
      settleNotices,
      aiJobs,
      settling,
      settleQueued,
      settingsOpen,
      adminPage,
      settleOpen,
      error,
      actionError,
      actionBusy,
      loading,
      select,
      selectThread,
      moveSelection,
      toggleSelected,
      selectAll,
      actOnThread,
      toggleStar,
      loadMore,
      setSearchText: setSearchTextState,
      refresh,
      archiveSelected,
      snoozeSelected,
      unsnoozeSelected,
      expectReply,
      clearFollowUp,
      trashSelected,
      untrashSelected,
      deleteSelected,
      spamSelected,
      unspamSelected,
      toggleReadSelected,
      changeLabelsSelected,
      openCompose,
      openReply,
      openForward,
      openDraft,
      saveDraft,
      discardDraft,
      closeCompose: () => setCompose(null),
      popOutCompose: (patch: Partial<ComposeSeed>) =>
        setCompose((current) => (current ? { ...current, ...patch, mode: 'window' } : current)),
      openSettings: (open: boolean) => setAdminPage(open ? 'general' : null),
      openAdmin: setAdminPage,
      openSettle: setSettleOpen,
      settleOne,
      undoSettle,
      dismissSettleNotice,
      startAi,
      dismissAi,
      openAiJob,
      reloadOutbox,
      reloadQueue,
      setError,
      clearActionError,
      saveSettings,
      saveSearch,
      removeSavedSearch,
      reloadIdentities,
      reloadSignatures,
      reloadTemplates
    }),
    [
      accounts,
      labels,
      counts,
      selection,
      visibleThreads,
      hasMore,
      loadingMore,
      searchResults,
      searchText,
      searchFilters,
      selectedThreadId,
      selectedThreadIds,
      thread,
      identities,
      signatures,
      templates,
      outbox,
      queue,
      pending,
      online,
      syncStatus,
      settings,
      compose,
      drafts,
      followUps,
      settleNotices,
      aiJobs,
      settling,
      settleQueued,
      settingsOpen,
      adminPage,
      settleOpen,
      error,
      actionError,
      actionBusy,
      loading,
      select,
      selectThread,
      moveSelection,
      toggleSelected,
      selectAll,
      actOnThread,
      toggleStar,
      loadMore,
      refresh,
      archiveSelected,
      snoozeSelected,
      unsnoozeSelected,
      expectReply,
      clearFollowUp,
      trashSelected,
      untrashSelected,
      deleteSelected,
      spamSelected,
      unspamSelected,
      toggleReadSelected,
      changeLabelsSelected,
      openCompose,
      openReply,
      openForward,
      openDraft,
      saveDraft,
      discardDraft,
      reloadOutbox,
      reloadQueue,
      settleOne,
      undoSettle,
      dismissSettleNotice,
      startAi,
      dismissAi,
      openAiJob,
      clearActionError,
      saveSettings,
      saveSearch,
      removeSavedSearch,
      reloadIdentities,
      reloadSignatures,
      reloadTemplates
    ]
  )

  return <UniboxContext.Provider value={value}>{children}</UniboxContext.Provider>
}

export function useUnibox(): UniboxContextValue {
  const value = useContext(UniboxContext)
  if (!value) throw new Error('UniboxProvider fehlt')
  return value
}
