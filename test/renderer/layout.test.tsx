// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SYSTEM_LABELS } from '@shared/types'
import { App } from '@renderer/App'
import { UniboxProvider } from '@renderer/state'
import { applyTheme, resolveTheme } from '@renderer/lib/theme'
import { createTestApp } from '../helpers/app'
import { installBridge } from '../helpers/fake-bridge'
import { openAdmin } from '../helpers/admin'

let harness: ReturnType<typeof createTestApp>
let bridge: ReturnType<typeof installBridge>

const SUBJECTS = ['Offerte A', 'Offerte B', 'Offerte C']

async function seedThreads(): Promise<void> {
  await harness.app.api['settings:set']({ onboardingComplete: true })
  const account = harness.app.store.accounts.upsert({
    kind: 'google',
    email: 'max@muster-it.ch',
    displayName: 'max@muster-it.ch'
  })
  harness.app.store.labels.ensureSystemLabels(account.id)
  const base = Date.parse('2026-08-18T10:00:00.000Z')
  SUBJECTS.forEach((subject, index) => {
    harness.app.store.messages.upsert({
      id: `${account.id}:g${index}`,
      accountId: account.id,
      threadId: `${account.id}:t:g${index}`,
      remoteId: `g${index}`,
      subject,
      from: { name: `Absender ${index}`, email: `sender${index}@example.com` },
      to: [{ name: null, email: 'max@muster-it.ch' }],
      date: base - index * 60_000,
      labelRemoteIds: [SYSTEM_LABELS.inbox, SYSTEM_LABELS.unread],
      body: { html: null, text: `Inhalt ${subject}` }
    })
  })
}

function renderApp(): void {
  render(
    <UniboxProvider>
      <App />
    </UniboxProvider>
  )
}

async function rows(count = SUBJECTS.length): Promise<HTMLElement[]> {
  const list = await screen.findByRole('listbox')
  await waitFor(() => expect(within(list).getAllByRole('option')).toHaveLength(count))
  return within(list).getAllByRole('option')
}

beforeEach(() => {
  window.localStorage.clear()
  delete document.documentElement.dataset.theme
  harness = createTestApp()
  bridge = installBridge(harness.app)
})

afterEach(() => {
  cleanup()
  bridge.uninstall()
  harness.dispose()
})

describe('theme', () => {
  it('resolves "system" through the OS preference and keeps explicit choices', () => {
    expect(resolveTheme('system', true)).toBe('dark')
    expect(resolveTheme('system', false)).toBe('light')
    expect(resolveTheme('dark', false)).toBe('dark')
    expect(resolveTheme('light', true)).toBe('light')
  })

  it('puts the theme on the root element and remembers it for the next start', () => {
    applyTheme('dark')
    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(window.localStorage.getItem('unibox.theme')).toBe('dark')
  })

  it('switches to dark from the general settings and stores the choice', async () => {
    await seedThreads()
    const user = userEvent.setup()
    renderApp()
    await rows()
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe('light'))

    const dialog = await openAdmin(user, 'Allgemein')
    await user.selectOptions(within(dialog).getByLabelText('Darstellung'), 'dark')

    await waitFor(() => expect(document.documentElement.dataset.theme).toBe('dark'))
    expect((await harness.app.api['settings:get']()).theme).toBe('dark')
  })
})

describe('sidebar', () => {
  it('folds to an icon rail and stays folded after a restart', async () => {
    await seedThreads()
    const user = userEvent.setup()
    renderApp()
    await rows()

    await user.click(screen.getByRole('button', { name: 'Menü einklappen' }))
    expect(document.querySelector('.sidebar--rail')).not.toBeNull()
    // Names survive as labels, so the rail is still usable by name.
    expect(screen.getByRole('button', { name: 'Alle Eingänge' })).toBeInTheDocument()

    cleanup()
    renderApp()
    await rows()
    expect(document.querySelector('.sidebar--rail')).not.toBeNull()
    await user.click(screen.getByRole('button', { name: 'Menü ausklappen' }))
    expect(document.querySelector('.sidebar--rail')).toBeNull()
  })

  it('resizes from the keyboard within its bounds and remembers the width', async () => {
    await seedThreads()
    renderApp()
    await rows()

    const handle = screen.getByRole('separator', { name: 'Breite der Seitenleiste' })
    fireEvent.keyDown(handle, { key: 'ArrowRight' })
    expect(handle).toHaveAttribute('aria-valuenow', '272')
    expect(window.localStorage.getItem('unibox.layout.sidebarWidth')).toBe('272')

    for (let step = 0; step < 20; step += 1) fireEvent.keyDown(handle, { key: 'ArrowRight' })
    expect(handle).toHaveAttribute('aria-valuenow', '360')
  })

  it('opens a new mail from the compose button', async () => {
    await seedThreads()
    const user = userEvent.setup()
    renderApp()
    await rows()

    await user.click(screen.getByRole('button', { name: 'Schreiben' }))
    expect(await screen.findByRole('dialog', { name: 'Neue E-Mail' })).toBeInTheDocument()
  })
})

describe('message list', () => {
  it('ticks every row with the header checkbox and clears them again', async () => {
    await seedThreads()
    const user = userEvent.setup()
    renderApp()
    const all = await rows()

    await user.click(screen.getByRole('checkbox', { name: 'Alle auswählen' }))
    await waitFor(() => expect(screen.getByText('3 ausgewählt')).toBeInTheDocument())
    expect(all.every((row) => row.getAttribute('aria-selected') === 'true')).toBe(true)
    // Picking is not reading: nothing was marked read on the way.
    expect(screen.getByText('3 Konversationen ausgewählt')).toBeInTheDocument()

    await user.click(screen.getByRole('checkbox', { name: 'Alle auswählen' }))
    await waitFor(async () =>
      expect((await rows()).filter((row) => row.getAttribute('aria-selected') === 'true')).toHaveLength(0)
    )
  })

  it('adds a row to the selection with its own checkbox', async () => {
    await seedThreads()
    const user = userEvent.setup()
    renderApp()
    const all = await rows()

    await user.click(all[0]!)
    await user.click(within(all[2]!).getByRole('checkbox', { name: 'Auswählen' }))
    await waitFor(() => expect(screen.getByText('2 ausgewählt')).toBeInTheDocument())
  })

  it('archives only the hovered row from its hover buttons', async () => {
    await seedThreads()
    const user = userEvent.setup()
    renderApp()
    const all = await rows()

    // Another row is open; the hover button must not touch it.
    await user.click(all[0]!)
    // Plain events: user-event's pointer moves leave out `relatedTarget`, which
    // React reads as the pointer leaving the row — a real browser sets it.
    fireEvent.mouseEnter(all[1]!)
    fireEvent.click(within(all[1]!).getByRole('button', { name: 'Archivieren' }))

    const left = await rows(2)
    expect(left.map((row) => row.textContent)).toEqual([
      expect.stringContaining('Offerte A'),
      expect.stringContaining('Offerte C')
    ])
    expect(left[0]).toHaveAttribute('aria-current', 'true')
  })

  it('marks just the hovered row read without opening it', async () => {
    await seedThreads()
    renderApp()
    const all = await rows()

    fireEvent.mouseEnter(all[2]!)
    fireEvent.click(within(all[2]!).getByRole('button', { name: 'Als gelesen markieren' }))

    await waitFor(async () => {
      const current = await rows()
      expect(current[2]).not.toHaveClass('list__row--unread')
      expect(current[0]).toHaveClass('list__row--unread')
    })
    expect(screen.getByText('Keine Nachricht ausgewählt')).toBeInTheDocument()
  })
})

describe('search shortcut', () => {
  it('jumps into the search field with /; ⌘K is the command palette', async () => {
    await seedThreads()
    const user = userEvent.setup()
    renderApp()
    await rows()

    await user.keyboard('/')
    expect(screen.getByRole('combobox')).toHaveFocus()
    ;(document.activeElement as HTMLElement).blur()
    await user.keyboard('{Meta>}k{/Meta}')
    expect(screen.getByRole('dialog', { name: 'Befehlspalette' })).toBeInTheDocument()
  })
})
