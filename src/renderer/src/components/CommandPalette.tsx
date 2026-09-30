import { useId, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ThemePreference } from '@shared/types'
import { SYSTEM_LABELS } from '@shared/types'
import { useFocusTrap } from '../hooks/useFocusTrap'
import type { ShortcutHandlers } from '../hooks/useShortcuts'
import { labelName, t } from '../i18n'
import { api } from '../lib/bridge'
import { filterCommands, type PaletteCommand } from '../lib/palette'
import { SHORTCUTS, bindingCaps, type ShortcutId } from '../lib/shortcuts'
import { useUnibox } from '../state'
import { SearchIcon } from './Icons'

/** Registry entries worth running from the palette; the rest act on a row. */
const PALETTE_SHORTCUTS: ReadonlySet<ShortcutId> = new Set([
  'compose',
  'search',
  'help',
  'goInbox',
  'goStarred',
  'goSent',
  'goDrafts',
  'goSnoozed',
  'goArchive',
  'goSpam',
  'goTrash',
  'goAdmin'
])

const PALETTE_LABELS = [
  SYSTEM_LABELS.inbox,
  SYSTEM_LABELS.sent,
  SYSTEM_LABELS.drafts,
  SYSTEM_LABELS.trash,
  SYSTEM_LABELS.spam
] as const

const THEMES: Array<[ThemePreference, string]> = [
  ['light', 'settings.general.themeLight'],
  ['dark', 'settings.general.themeDark'],
  ['system', 'settings.general.themeSystem']
]

/** Everything the palette offers: the registry plus what lives in state. */
function usePaletteCommands(handlers: ShortcutHandlers): PaletteCommand[] {
  const { accounts, labels, settings, select, setSearchText, saveSettings, refresh } = useUnibox()
  return useMemo(() => {
    const section = (key: string): string => t(`shortcuts.commands.sections.${key}`)
    const fromRegistry = SHORTCUTS.filter((shortcut) => PALETTE_SHORTCUTS.has(shortcut.id)).map(
      (shortcut): PaletteCommand => ({
        id: shortcut.id,
        title: shortcut.group === 'navigation'
          ? t('shortcuts.commands.goTo', { name: t(shortcut.label) })
          : t(shortcut.label),
        section: section(shortcut.group === 'navigation' ? 'navigation' : 'actions'),
        // "Gehe zu:" is the same for every destination; the name is what gets typed.
        keywords: [t(shortcut.label)],
        binding: shortcut.keys[0],
        run: handlers[shortcut.id]
      })
    )
    const sync: PaletteCommand = {
      id: 'sync',
      title: t('shortcuts.commands.syncNow'),
      section: section('actions'),
      run: () => void api.invoke('sync:now').then(refresh)
    }
    const accountCommands = accounts.map((account): PaletteCommand => {
      const inbox = (labels[account.id] ?? []).find(
        (label) => label.remoteId === SYSTEM_LABELS.inbox
      )
      return {
        id: `account:${account.id}`,
        title: t('shortcuts.commands.goTo', { name: account.email }),
        section: section(account.kind === 'google' ? 'accounts' : 'domains'),
        keywords: [account.email, account.displayName],
        run: () => (inbox ? select({ accountId: account.id, labelId: inbox.id }) : undefined)
      }
    })
    const labelCommands = accounts.flatMap((account) =>
      (labels[account.id] ?? [])
        .filter(
          (label) =>
            label.type === 'user' ||
            (PALETTE_LABELS as readonly string[]).includes(label.remoteId)
        )
        .map(
          (label): PaletteCommand => ({
            id: `label:${label.id}`,
            title: t('shortcuts.commands.labelIn', {
              label: labelName(label.remoteId, label.name),
              account: account.email
            }),
            section: section('labels'),
            run: () => select({ accountId: account.id, labelId: label.id })
          })
        )
    )
    const savedCommands = settings.savedSearches.map(
      (entry): PaletteCommand => ({
        id: `saved:${entry.name}`,
        title: entry.name,
        section: section('saved'),
        keywords: [entry.query],
        run: () => setSearchText(entry.query)
      })
    )
    const themeCommands = THEMES.map(
      ([value, key]): PaletteCommand => ({
        id: `theme:${value}`,
        title: t('shortcuts.commands.theme', { name: t(key) }),
        section: section('appearance'),
        run: () => void saveSettings({ theme: value })
      })
    )
    return [
      ...fromRegistry.filter((command) => command.section === section('actions')),
      sync,
      ...fromRegistry.filter((command) => command.section === section('navigation')),
      ...accountCommands,
      ...labelCommands,
      ...savedCommands,
      ...themeCommands
    ]
  }, [handlers, accounts, labels, settings.savedSearches, select, setSearchText, saveSettings, refresh])
}

interface CommandPaletteProps {
  handlers: ShortcutHandlers
  onClose: () => void
  /** Runs a command once the palette is gone, so focus lands where it sends it. */
  onRun: (run: () => void) => void
}

/**
 * ⌘K. Every destination and command in one filterable list; whatever matches
 * nothing can still be searched for as mail.
 */
export function CommandPalette({ handlers, onClose, onRun }: CommandPaletteProps): React.JSX.Element {
  const { setSearchText } = useUnibox()
  const commands = usePaletteCommands(handlers)
  const [query, setQuery] = useState('')
  const [highlighted, setHighlighted] = useState(0)
  const dialog = useRef<HTMLDivElement>(null)
  useFocusTrap(dialog)
  const listId = useId()

  const results = useMemo(() => {
    const matches = filterCommands(commands, query)
    const text = query.trim()
    if (text.length === 0) return matches
    return [
      ...matches,
      {
        id: 'search-fallback',
        title: t('shortcuts.commands.searchFor', { query: text }),
        section: t('shortcuts.commands.sections.search'),
        run: () => setSearchText(text)
      }
    ]
  }, [commands, query, setSearchText])

  const active = Math.min(highlighted, Math.max(results.length - 1, 0))
  const execute = (command: PaletteCommand | undefined): void => {
    if (!command) return
    onClose()
    onRun(command.run)
  }

  const onKeyDown = (event: React.KeyboardEvent): void => {
    // Nothing typed here may reach the global shortcuts underneath.
    event.stopPropagation()
    if (event.key === 'Escape' || (event.key === 'k' && (event.metaKey || event.ctrlKey))) {
      event.preventDefault()
      onClose()
    } else if (event.key === 'ArrowDown') {
      event.preventDefault()
      setHighlighted((active + 1) % Math.max(results.length, 1))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setHighlighted((active - 1 + results.length) % Math.max(results.length, 1))
    } else if (event.key === 'Enter') {
      event.preventDefault()
      execute(results[active])
    }
  }

  const grouped = query.trim().length === 0

  return createPortal(
    <div
      className="overlay overlay--palette"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        ref={dialog}
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label={t('shortcuts.commands.label')}
        onKeyDown={onKeyDown}
      >
        <div className="palette__field">
          <SearchIcon size={18} color="var(--text-muted)" />
          <input
            className="palette__input"
            autoFocus
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={results[active] ? `${listId}-${active}` : undefined}
            aria-label={t('shortcuts.commands.label')}
            placeholder={t('shortcuts.commands.placeholder')}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value)
              setHighlighted(0)
            }}
          />
          <kbd className="kbd">{bindingCaps('escape')[0]}</kbd>
        </div>
        <ul className="palette__list" id={listId} role="listbox">
          {results.length === 0 ? (
            <li className="palette__empty">{t('shortcuts.commands.empty')}</li>
          ) : null}
          {results.map((command, index) => {
            const heading =
              grouped && (index === 0 || results[index - 1]!.section !== command.section)
            return (
              <li key={command.id} role="presentation">
                {heading ? <div className="palette__section">{command.section}</div> : null}
                <div
                  id={`${listId}-${index}`}
                  role="option"
                  aria-selected={index === active}
                  className={index === active ? 'palette__item is-active' : 'palette__item'}
                  onMouseMove={() => (index === active ? undefined : setHighlighted(index))}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => execute(command)}
                >
                  <span className="palette__title">{command.title}</span>
                  {grouped ? null : <span className="palette__tag">{command.section}</span>}
                  {command.binding ? (
                    <span className="palette__keys">
                      {bindingCaps(command.binding).map((cap, capIndex) => (
                        <kbd key={capIndex} className="kbd">
                          {cap}
                        </kbd>
                      ))}
                    </span>
                  ) : null}
                </div>
              </li>
            )
          })}
        </ul>
        <div className="palette__footer">
          <span>
            <kbd className="kbd">↑</kbd>
            <kbd className="kbd">↓</kbd> {t('shortcuts.commands.navigate')}
          </span>
          <span>
            <kbd className="kbd">⏎</kbd> {t('shortcuts.commands.run')}
          </span>
        </div>
      </div>
    </div>,
    document.body
  )
}
