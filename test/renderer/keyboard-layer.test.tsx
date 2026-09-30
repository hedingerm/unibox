// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SYSTEM_LABELS } from '@shared/types'
import { App } from '@renderer/App'
import { UniboxProvider } from '@renderer/state'
import { createTestApp } from '../helpers/app'
import { installBridge } from '../helpers/fake-bridge'

let harness: ReturnType<typeof createTestApp>
let bridge: ReturnType<typeof installBridge>

async function seed(settings: { shortcutsEnabled?: boolean } = {}): Promise<void> {
  await harness.app.api['settings:set']({ onboardingComplete: true, ...settings })
  const account = harness.app.store.accounts.upsert({
    kind: 'google',
    email: 'max@muster-it.ch',
    displayName: 'max@muster-it.ch'
  })
  harness.app.store.labels.ensureSystemLabels(account.id)
  harness.app.store.messages.upsert({
    id: `${account.id}:g0`,
    accountId: account.id,
    threadId: `${account.id}:t:g0`,
    remoteId: 'g0',
    subject: 'Offerte A',
    from: { name: 'Absender', email: 'sender@example.com' },
    to: [{ name: null, email: 'max@muster-it.ch' }],
    date: Date.parse('2026-08-18T10:00:00.000Z'),
    labelRemoteIds: [SYSTEM_LABELS.inbox],
    body: { html: null, text: 'Inhalt' }
  })
}

async function renderApp(): Promise<void> {
  render(
    <UniboxProvider>
      <App />
    </UniboxProvider>
  )
  const list = await screen.findByRole('listbox')
  await waitFor(() => expect(within(list).getAllByRole('option')).toHaveLength(1))
}

function sidebarItem(name: string): HTMLElement {
  const label = screen
    .getAllByText(name)
    .find((element) => element.classList.contains('sidebar__item-label'))
  return label!.closest('button')!
}

beforeEach(() => {
  harness = createTestApp()
  bridge = installBridge(harness.app)
})

afterEach(() => {
  cleanup()
  bridge.uninstall()
  harness.dispose()
})

describe('shortcut overview', () => {
  it('opens on ? with every group, and Esc closes it', async () => {
    await seed()
    const user = userEvent.setup()
    await renderApp()

    await user.keyboard('?')
    const dialog = screen.getByRole('dialog', { name: 'Tastenkürzel' })
    for (const group of ['Allgemein', 'Navigation', 'Liste', 'Nachricht', 'Schreiben']) {
      expect(within(dialog).getByRole('heading', { name: group })).toBeInTheDocument()
    }
    expect(within(dialog).getByText('Archivieren')).toBeInTheDocument()

    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog', { name: 'Tastenkürzel' })).not.toBeInTheDocument()
  })

  it('opens from the sidebar row too', async () => {
    await seed()
    const user = userEvent.setup()
    await renderApp()
    await user.click(screen.getByRole('button', { name: /Tastenkürzel/ }))
    expect(screen.getByRole('dialog', { name: 'Tastenkürzel' })).toBeInTheDocument()
  })
})

describe('go-to sequences', () => {
  it('g t opens the sent mail and shows the pending g meanwhile', async () => {
    await seed()
    const user = userEvent.setup()
    await renderApp()

    await user.keyboard('g')
    expect(screen.getByText('Weiter mit …')).toBeInTheDocument()
    await user.keyboard('t')
    await waitFor(() => expect(sidebarItem('Gesendet')).toHaveClass('sidebar__item--active'))

    await user.keyboard('gi')
    await waitFor(() => expect(sidebarItem('Alle Eingänge')).toHaveClass('sidebar__item--active'))
  })
})

describe('command palette', () => {
  it('filters and runs a navigation command', async () => {
    await seed()
    const user = userEvent.setup()
    await renderApp()

    await user.keyboard('{Meta>}k{/Meta}')
    const dialog = screen.getByRole('dialog', { name: 'Befehlspalette' })
    await user.keyboard('entwürfe')
    const options = within(dialog).getAllByRole('option')
    expect(options[0]).toHaveTextContent('Gehe zu: Entwürfe')
    expect(options[0]).toHaveAttribute('aria-selected', 'true')
    expect(options[0]).toHaveTextContent('g')

    await user.keyboard('{Enter}')
    expect(screen.queryByRole('dialog', { name: 'Befehlspalette' })).not.toBeInTheDocument()
    await waitFor(() => expect(sidebarItem('Entwürfe')).toHaveClass('sidebar__item--active'))
  })

  it('switches the theme', async () => {
    await seed()
    const user = userEvent.setup()
    await renderApp()

    await user.keyboard('{Meta>}k{/Meta}')
    await user.keyboard('dunkel{Enter}')
    await waitFor(() => expect(harness.app.store.settings.get().theme).toBe('dark'))
  })

  it('falls back to searching the mail for what was typed', async () => {
    await seed()
    const user = userEvent.setup()
    await renderApp()

    await user.keyboard('{Meta>}k{/Meta}')
    await user.keyboard('Offerte')
    const options = within(screen.getByRole('dialog', { name: 'Befehlspalette' })).getAllByRole(
      'option'
    )
    expect(options.at(-1)).toHaveTextContent('Suche nach «Offerte»')
    await user.keyboard('{ArrowUp}{Enter}')
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: /Suchen/ })).toHaveValue('Offerte')
    )
  })

  it('closes on Esc without doing anything', async () => {
    await seed()
    const user = userEvent.setup()
    await renderApp()
    await user.keyboard('{Meta>}k{/Meta}')
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog', { name: 'Befehlspalette' })).not.toBeInTheDocument()
  })
})

describe('shortcuts switched off', () => {
  it('ignores ? and c but still opens the palette', async () => {
    await seed({ shortcutsEnabled: false })
    const user = userEvent.setup()
    await renderApp()

    await user.keyboard('?c')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await user.keyboard('{Meta>}k{/Meta}')
    expect(screen.getByRole('dialog', { name: 'Befehlspalette' })).toBeInTheDocument()
  })
})
