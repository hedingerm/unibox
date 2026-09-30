// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, renderHook } from '@testing-library/react'
import { t } from '@renderer/i18n'
import { useShortcuts, type ShortcutHandlers } from '@renderer/hooks/useShortcuts'
import { filterCommands, type PaletteCommand } from '@renderer/lib/palette'
import {
  SEQUENCE_TIMEOUT_MS,
  SHORTCUTS,
  SHORTCUT_GROUPS,
  bindingCaps,
  eventBinding,
  shortcutFor
} from '@renderer/lib/shortcuts'

function spies(): ShortcutHandlers {
  return Object.fromEntries(SHORTCUTS.map((shortcut) => [shortcut.id, vi.fn()])) as unknown as ShortcutHandlers
}

function press(key: string, init: KeyboardEventInit = {}, target: Element | Window = window): void {
  fireEvent.keyDown(target, { key, ...init })
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  document.body.innerHTML = ''
})

describe('shortcut registry', () => {
  it('gives every id and every binding exactly one meaning', () => {
    const ids = SHORTCUTS.map((shortcut) => shortcut.id)
    expect(new Set(ids).size).toBe(ids.length)
    const bindings = SHORTCUTS.flatMap((shortcut) => shortcut.keys)
    expect(new Set(bindings).size).toBe(bindings.length)
  })

  it('has a German label and a known group for every entry', () => {
    for (const shortcut of SHORTCUTS) {
      expect(t(shortcut.label)).not.toBe(shortcut.label)
      expect(SHORTCUT_GROUPS).toContain(shortcut.group)
    }
    for (const group of SHORTCUT_GROUPS) {
      expect(SHORTCUTS.some((shortcut) => shortcut.group === group)).toBe(true)
    }
  })

  it('keeps the Gmail bindings the app always had', () => {
    const expected: Record<string, string> = {
      j: 'next',
      k: 'previous',
      'shift+j': 'extendNext',
      'shift+k': 'extendPrevious',
      x: 'toggleSelect',
      e: 'archive',
      '#': 'trash',
      '!': 'spam',
      i: 'toggleRead',
      u: 'toggleRead',
      r: 'reply',
      f: 'forward',
      s: 'settle',
      b: 'snooze',
      enter: 'open',
      'mod+n': 'compose',
      c: 'compose',
      '/': 'search',
      '?': 'help',
      'mod+k': 'palette'
    }
    for (const [binding, id] of Object.entries(expected)) expect(shortcutFor(binding)).toBe(id)
  })

  it('reads events in registry notation', () => {
    const event = (key: string, init: KeyboardEventInit = {}): KeyboardEvent =>
      new KeyboardEvent('keydown', { key, ...init })
    expect(eventBinding(event('J', { shiftKey: true }))).toBe('shift+j')
    expect(eventBinding(event('k', { metaKey: true }))).toBe('mod+k')
    expect(eventBinding(event('k', { ctrlKey: true }))).toBe('mod+k')
    expect(eventBinding(event('?', { shiftKey: true }))).toBe('?')
    // ⌥3 types `#` on a Swiss Mac.
    expect(eventBinding(event('#', { altKey: true }))).toBe('#')
    expect(eventBinding(event('e', { altKey: true }))).toBeNull()
    expect(eventBinding(event('Escape'))).toBe('escape')
    expect(eventBinding(event('ArrowDown'))).toBeNull()
  })

  it('draws bindings as key caps', () => {
    expect(bindingCaps('g i')).toEqual(['g', 'i'])
    expect(bindingCaps('mod+k')).toEqual(['⌘K'])
    expect(bindingCaps('shift+j')).toEqual(['⇧J'])
  })
})

describe('key handler', () => {
  it('runs a sequence when the second key follows in time, and shows it waiting', () => {
    const handlers = spies()
    const { result } = renderHook(() => useShortcuts(handlers, { active: true, enabled: true }))

    act(() => press('g'))
    expect(result.current).toBe('g')
    act(() => press('i'))
    expect(handlers.goInbox).toHaveBeenCalledOnce()
    expect(handlers.toggleRead).not.toHaveBeenCalled()
    expect(result.current).toBeNull()

    act(() => press('g'))
    act(() => press('!', { shiftKey: true }))
    expect(handlers.goSpam).toHaveBeenCalledOnce()
    expect(handlers.spam).not.toHaveBeenCalled()
  })

  it('drops a started sequence after a second', () => {
    vi.useFakeTimers()
    const handlers = spies()
    const { result } = renderHook(() => useShortcuts(handlers, { active: true, enabled: true }))

    act(() => press('g'))
    act(() => vi.advanceTimersByTime(SEQUENCE_TIMEOUT_MS + 1))
    expect(result.current).toBeNull()
    act(() => press('i'))
    expect(handlers.goInbox).not.toHaveBeenCalled()
    expect(handlers.toggleRead).toHaveBeenCalledOnce()
  })

  it('swallows an unknown second key instead of acting on it', () => {
    const handlers = spies()
    renderHook(() => useShortcuts(handlers, { active: true, enabled: true }))
    act(() => press('g'))
    act(() => press('e'))
    expect(handlers.archive).not.toHaveBeenCalled()
  })

  it('leaves single keys alone while typing, in fields and in the editor', () => {
    const handlers = spies()
    renderHook(() => useShortcuts(handlers, { active: true, enabled: true }))
    const input = document.createElement('input')
    const editor = document.createElement('div')
    editor.contentEditable = 'true'
    // jsdom does not derive isContentEditable from the attribute.
    Object.defineProperty(editor, 'isContentEditable', { value: true })
    document.body.append(input, editor)

    for (const target of [input, editor]) {
      for (const key of ['c', 'g', 'i', '?', '/', 'j', '#']) press(key, {}, target)
    }
    for (const handler of Object.values(handlers)) expect(handler).not.toHaveBeenCalled()

    // A chord still works from a field.
    press('k', { metaKey: true }, input)
    expect(handlers.palette).toHaveBeenCalledOnce()
  })

  it('keeps only ⌘ chords and Esc when single keys are switched off', () => {
    const handlers = spies()
    renderHook(() => useShortcuts(handlers, { active: true, enabled: false }))
    for (const key of ['j', 'c', '?', '/', 'e']) press(key)
    press('g')
    press('i')
    for (const handler of Object.values(handlers)) expect(handler).not.toHaveBeenCalled()

    press('k', { metaKey: true })
    press('Escape')
    expect(handlers.palette).toHaveBeenCalledOnce()
    expect(handlers.escape).toHaveBeenCalledOnce()
  })

  it('does nothing at all while a window owns the keys', () => {
    const handlers = spies()
    renderHook(() => useShortcuts(handlers, { active: false, enabled: true }))
    press('j')
    press('k', { metaKey: true })
    for (const handler of Object.values(handlers)) expect(handler).not.toHaveBeenCalled()
  })

  it('leaves Esc to an open menu', () => {
    const handlers = spies()
    renderHook(() => useShortcuts(handlers, { active: true, enabled: true }))
    const menu = document.createElement('div')
    menu.setAttribute('role', 'menu')
    document.body.append(menu)
    press('Escape')
    expect(handlers.escape).not.toHaveBeenCalled()
    menu.remove()
    press('Escape')
    expect(handlers.escape).toHaveBeenCalledOnce()
  })
})

describe('palette filter', () => {
  const command = (title: string, keywords?: string[]): PaletteCommand => ({
    id: title,
    title,
    section: 'x',
    keywords,
    run: () => undefined
  })
  const commands = [
    command('Gehe zu: Gesendet'),
    command('Gehe zu: Entwürfe'),
    command('Neue E-Mail'),
    command('Gehe zu: max@muster-it.ch', ['Max Muster'])
  ]

  it('keeps everything for an empty query', () => {
    expect(filterCommands(commands, ' ')).toHaveLength(commands.length)
  })

  it('matches substrings, letters in order and keywords', () => {
    expect(filterCommands(commands, 'gesendet').map((entry) => entry.title)).toEqual([
      'Gehe zu: Gesendet'
    ])
    expect(filterCommands(commands, 'nml')[0]?.title).toBe('Neue E-Mail')
    expect(filterCommands(commands, 'muster max')[0]?.title).toBe(
      'Gehe zu: max@muster-it.ch'
    )
    expect(filterCommands(commands, 'qqq')).toEqual([])
  })

  it('puts a plain substring ahead of a scattered match', () => {
    const ranked = filterCommands([command('Entwurf spam'), command('Spam')], 'spam')
    expect(ranked[0]?.title).toBe('Spam')
  })
})
