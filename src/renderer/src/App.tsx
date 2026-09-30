import { useCallback, useEffect, useMemo, useState } from 'react'
import { Admin } from './components/admin/Admin'
import { CommandPalette } from './components/CommandPalette'
import { Compose } from './components/Compose'
import { ListHeader } from './components/ListHeader'
import { MessageList } from './components/MessageList'
import { OfflineBanner } from './components/OfflineBanner'
import { Onboarding } from './components/Onboarding'
import { ReadingPane } from './components/ReadingPane'
import { ReconnectBanner } from './components/ReconnectBanner'
import { ResizeHandle } from './components/ResizeHandle'
import { SEARCH_INPUT_ID } from './components/SearchBox'
import { SequenceHint, ShortcutsHelp } from './components/ShortcutsHelp'
import { SettleSheet } from './components/SettleSheet'
import { Sidebar } from './components/Sidebar'
import { Toasts } from './components/Toasts'
import { ActionStatus } from './components/Toolbar'
import { TopBar } from './components/TopBar'
import { useGoTo } from './hooks/useGoTo'
import { useShortcuts, type ShortcutHandlers } from './hooks/useShortcuts'
import { t } from './i18n'
import { useStoredSize } from './lib/layout'
import { defaultSnoozeAt } from './lib/snooze'
import { applyTheme } from './lib/theme'
import { draftIdOfRow, useUnibox } from './state'

const LIST_WIDTH_KEY = 'unibox.layout.listWidth'
const LIST_MIN = 280
const LIST_MAX = 900
const LIST_DEFAULT = 400

function focusSearch(): void {
  const input = document.getElementById(SEARCH_INPUT_ID)
  if (input instanceof HTMLInputElement) {
    input.focus()
    input.select()
  }
}

/**
 * The white panel on the tinted ground: list and reader side by side, the
 * border between them draggable. The list keeps its width across restarts;
 * the reader takes whatever is left.
 */
function Workspace(): React.JSX.Element {
  const [listWidth, setListWidth] = useStoredSize(LIST_WIDTH_KEY, LIST_DEFAULT, LIST_MIN, LIST_MAX)
  return (
    <div className="panel">
      <OfflineBanner />
      <ReconnectBanner />
      <ActionStatus />
      <div className="split">
        <div className="list-pane" style={{ width: listWidth }}>
          <ListHeader />
          <MessageList />
        </div>
        <ResizeHandle
          value={listWidth}
          min={LIST_MIN}
          max={LIST_MAX}
          label={t('list.resize')}
          onChange={setListWidth}
        />
        <ReadingPane />
      </div>
    </div>
  )
}

export function App(): React.JSX.Element {
  const {
    settings,
    compose,
    settingsOpen,
    settleOpen,
    selectedThreadIds,
    selectedThreadId,
    selectThread,
    loading,
    moveSelection,
    toggleSelected,
    archiveSelected,
    snoozeSelected,
    unsnoozeSelected,
    selection,
    trashSelected,
    spamSelected,
    toggleReadSelected,
    openReply,
    openForward,
    openCompose,
    openDraft,
    openSettle,
    settleOne
  } = useUnibox()

  // The keyboard layer's own dialogs: the overview behind `?` and the palette.
  const [overlay, setOverlay] = useState<'help' | 'palette' | null>(null)
  const goTo = useGoTo()

  const handlers = useMemo<ShortcutHandlers>(
    () => ({
      ...goTo,
      palette: () => setOverlay('palette'),
      help: () => setOverlay('help'),
      // Menus and dialogs close themselves; what is left for Esc is the list.
      escape: () => selectThread(null),
      next: () => moveSelection(1),
      previous: () => moveSelection(-1),
      extendNext: () => moveSelection(1, true),
      extendPrevious: () => moveSelection(-1, true),
      toggleSelect: toggleSelected,
      archive: () => void archiveSelected(),
      // In the snooze list the same key means the opposite: the conversation
      // is already put aside, so `b` is the way to take it back.
      snooze: () =>
        void (selection.view === 'snoozed'
          ? unsnoozeSelected()
          : snoozeSelected(defaultSnoozeAt())),
      trash: () => void trashSelected(),
      spam: () => void spamSelected(),
      toggleRead: () => void toggleReadSelected(),
      reply: () => void openReply(),
      forward: () => void openForward(),
      // Same deal as the toolbar button: one conversation settles on the spot
      // with an undoable toast, anything else goes through the review sheet.
      // A settle already running is no reason to wait — the next one queues.
      settle: () => {
        if (selectedThreadIds.length === 1) {
          void settleOne(selectedThreadIds[0]!)
          return
        }
        openSettle(true)
      },
      compose: () => void openCompose(),
      search: focusSearch,
      // Only draft rows have something behind ⏎; a conversation is already
      // shown by the reading pane as soon as it is focused.
      open: () => {
        const draftId = selectedThreadId ? draftIdOfRow(selectedThreadId) : null
        if (draftId) void openDraft(draftId)
      }
    }),
    [
      goTo,
      selectThread,
      moveSelection,
      toggleSelected,
      archiveSelected,
      snoozeSelected,
      unsnoozeSelected,
      selection.view,
      trashSelected,
      spamSelected,
      toggleReadSelected,
      openReply,
      openForward,
      openCompose,
      openDraft,
      openSettle,
      settleOne,
      selectedThreadIds,
      selectedThreadId
    ]
  )
  const pendingSequence = useShortcuts(handlers, {
    active: !compose && !settingsOpen && !settleOpen && !overlay,
    enabled: settings.shortcutsEnabled !== false
  })
  const closeOverlay = useCallback(() => setOverlay(null), [])
  // A palette command runs after the palette has gone and handed focus back,
  // or "Suche fokussieren" would lose the caret to the restored element.
  const runAfterClose = useCallback((run: () => void) => void setTimeout(run, 0), [])

  // Undefined until the settings have loaded; main.tsx already put the last
  // known theme on, so there is nothing to do before then.
  const theme = settings.theme
  useEffect(() => (theme ? applyTheme(theme) : undefined), [theme])

  const showShortcuts = useCallback(() => setOverlay('help'), [])

  // The wizard stays open across its own steps, even once the first account exists.
  const needsOnboarding = !loading && !settings.onboardingComplete

  return (
    <div className="app">
      {/* The Verwaltung takes the mailbox's place instead of covering it. */}
      {settingsOpen ? (
        <Admin />
      ) : (
        <>
          <Sidebar onShowShortcuts={showShortcuts} />
          <div className="main">
            <TopBar />
            <Workspace />
          </div>
        </>
      )}
      {/* The inline reply lives in the reading pane; only the floating
        composer belongs to the app shell. */}
      {compose?.mode === 'window' ? <Compose key={compose.seq} /> : null}
      {settleOpen ? <SettleSheet /> : null}
      {needsOnboarding ? <Onboarding /> : null}
      {overlay === 'help' ? (
        <ShortcutsHelp onClose={closeOverlay} disabled={settings.shortcutsEnabled === false} />
      ) : null}
      {overlay === 'palette' ? (
        <CommandPalette handlers={handlers} onClose={closeOverlay} onRun={runAfterClose} />
      ) : null}
      {pendingSequence ? <SequenceHint prefix={pendingSequence} /> : null}
      <Toasts />
    </div>
  )
}
