/**
 * The one list of keyboard shortcuts. The key handler, the overview behind `?`
 * and the hints in the command palette all read from here, so a key can only
 * mean one thing and the overview can never drift from what the keys do.
 */

export type ShortcutGroup = 'general' | 'navigation' | 'list' | 'message' | 'compose'

export const SHORTCUT_GROUPS: readonly ShortcutGroup[] = [
  'general',
  'navigation',
  'list',
  'message',
  'compose'
]

export type ShortcutId =
  | 'palette'
  | 'help'
  | 'search'
  | 'escape'
  | 'goInbox'
  | 'goStarred'
  | 'goSent'
  | 'goDrafts'
  | 'goSnoozed'
  | 'goArchive'
  | 'goSpam'
  | 'goTrash'
  | 'goAdmin'
  | 'next'
  | 'previous'
  | 'extendNext'
  | 'extendPrevious'
  | 'toggleSelect'
  | 'open'
  | 'archive'
  | 'snooze'
  | 'trash'
  | 'spam'
  | 'toggleRead'
  | 'settle'
  | 'compose'
  | 'reply'
  | 'forward'

export interface ShortcutDefinition {
  id: ShortcutId
  /**
   * Bindings in the handler's notation: a key (`j`, `#`, `enter`), a chord
   * (`shift+j`, `mod+k` — mod is ⌘ or Ctrl), or a sequence of those separated
   * by a space (`g i`). The first binding is the one hints show.
   */
  keys: readonly string[]
  group: ShortcutGroup
  /** i18n key of what the shortcut does. */
  label: string
}

export const SHORTCUTS: readonly ShortcutDefinition[] = [
  { id: 'palette', keys: ['mod+k'], group: 'general', label: 'shortcuts.palette' },
  { id: 'help', keys: ['?'], group: 'general', label: 'shortcuts.help' },
  { id: 'search', keys: ['/'], group: 'general', label: 'shortcuts.search' },
  { id: 'escape', keys: ['escape'], group: 'general', label: 'shortcuts.escape' },

  { id: 'goInbox', keys: ['g i'], group: 'navigation', label: 'shortcuts.goInbox' },
  { id: 'goStarred', keys: ['g s'], group: 'navigation', label: 'shortcuts.goStarred' },
  { id: 'goSent', keys: ['g t'], group: 'navigation', label: 'shortcuts.goSent' },
  { id: 'goDrafts', keys: ['g d'], group: 'navigation', label: 'shortcuts.goDrafts' },
  { id: 'goSnoozed', keys: ['g z'], group: 'navigation', label: 'shortcuts.goSnoozed' },
  { id: 'goArchive', keys: ['g a'], group: 'navigation', label: 'shortcuts.goArchive' },
  { id: 'goSpam', keys: ['g !'], group: 'navigation', label: 'shortcuts.goSpam' },
  { id: 'goTrash', keys: ['g #'], group: 'navigation', label: 'shortcuts.goTrash' },
  { id: 'goAdmin', keys: ['g v'], group: 'navigation', label: 'shortcuts.goAdmin' },

  { id: 'next', keys: ['j'], group: 'list', label: 'shortcuts.next' },
  { id: 'previous', keys: ['k'], group: 'list', label: 'shortcuts.previous' },
  { id: 'extendNext', keys: ['shift+j'], group: 'list', label: 'shortcuts.extendNext' },
  { id: 'extendPrevious', keys: ['shift+k'], group: 'list', label: 'shortcuts.extendPrevious' },
  { id: 'toggleSelect', keys: ['x'], group: 'list', label: 'shortcuts.toggleSelect' },
  { id: 'open', keys: ['enter'], group: 'list', label: 'shortcuts.open' },

  { id: 'archive', keys: ['e'], group: 'message', label: 'shortcuts.archive' },
  { id: 'snooze', keys: ['b'], group: 'message', label: 'shortcuts.snooze' },
  { id: 'trash', keys: ['#'], group: 'message', label: 'shortcuts.trash' },
  { id: 'spam', keys: ['!'], group: 'message', label: 'shortcuts.spam' },
  { id: 'toggleRead', keys: ['i', 'u'], group: 'message', label: 'shortcuts.toggleRead' },
  { id: 'settle', keys: ['s'], group: 'message', label: 'shortcuts.settle' },

  { id: 'compose', keys: ['c', 'mod+n'], group: 'compose', label: 'shortcuts.compose' },
  { id: 'reply', keys: ['r'], group: 'compose', label: 'shortcuts.reply' },
  { id: 'forward', keys: ['f'], group: 'compose', label: 'shortcuts.forward' }
]

/** How long a started sequence (`g …`) waits for its second key. */
export const SEQUENCE_TIMEOUT_MS = 1000

const BY_BINDING = new Map<string, ShortcutId>(
  SHORTCUTS.flatMap((shortcut) => shortcut.keys.map((key) => [key, shortcut.id] as const))
)

/** First keys of the sequences — `g` on its own does nothing but wait. */
const PREFIXES = new Set(
  SHORTCUTS.flatMap((shortcut) =>
    shortcut.keys.filter((key) => key.includes(' ')).map((key) => key.split(' ')[0]!)
  )
)

export function shortcutFor(binding: string): ShortcutId | null {
  return BY_BINDING.get(binding) ?? null
}

export function isSequencePrefix(token: string): boolean {
  return PREFIXES.has(token)
}

/**
 * A chord with ⌘/Ctrl or Esc can't be typed by accident, so those keep working
 * when single-key shortcuts are switched off.
 */
export function isAlwaysOn(binding: string): boolean {
  return binding.startsWith('mod+') || binding === 'escape'
}

/**
 * The event in registry notation, or `null` when no binding could match.
 * Letters carry their shift; `#`, `!`, `?` and `/` are matched on the
 * character itself, since which modifiers produce them depends on the layout
 * (on a Swiss Mac `#` is ⌥3).
 */
export function eventBinding(event: KeyboardEvent): string | null {
  const { key } = event
  if (key === 'Escape') return 'escape'
  if (key === 'Enter') return event.metaKey || event.ctrlKey || event.altKey ? null : 'enter'
  if (key.length !== 1) return null
  const lower = key.toLowerCase()
  const letter = lower !== key.toUpperCase()
  if (event.metaKey || event.ctrlKey) return letter ? `mod+${lower}` : null
  if (!letter) return key
  if (event.altKey) return null
  return event.shiftKey ? `shift+${lower}` : lower
}

const KEY_NAMES: Record<string, string> = {
  mod: '⌘',
  shift: '⇧',
  enter: '⏎',
  escape: 'Esc'
}

/**
 * One binding split into the caps a `<kbd>` row shows: `g i` → `['g', 'i']`,
 * `mod+k` → `['⌘K']`. A bare letter stays lower case, the way it is typed.
 */
export function bindingCaps(binding: string): string[] {
  return binding.split(' ').map((step) => {
    const parts = step.split('+')
    const chord = parts.length > 1
    return parts
      .map((part) => KEY_NAMES[part] ?? (chord ? part.toUpperCase() : part))
      .join('')
  })
}

export function shortcutById(id: ShortcutId): ShortcutDefinition {
  // The registry is total over ShortcutId; the test suite checks it.
  return SHORTCUTS.find((shortcut) => shortcut.id === id)!
}
