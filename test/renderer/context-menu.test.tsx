// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { SYSTEM_LABELS } from '@shared/types'
import { App } from '@renderer/App'
import { UniboxProvider } from '@renderer/state'
import { createTestApp } from '../helpers/app'
import { installBridge } from '../helpers/fake-bridge'

let harness: ReturnType<typeof createTestApp>
let bridge: ReturnType<typeof installBridge>

const SUBJECTS = ['Offerte A', 'Offerte B', 'Offerte C']

async function seedThreads(): Promise<string> {
  await harness.app.api['settings:set']({ onboardingComplete: true })
  const account = harness.app.store.accounts.upsert({
    kind: 'google',
    email: 'max@muster-it.ch',
    displayName: 'max@muster-it.ch'
  })
  harness.app.store.labels.ensureSystemLabels(account.id)
  harness.app.store.labels.upsert(account.id, { remoteId: 'Label_1', name: 'Kunden', type: 'user' })
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
  return account.id
}

function renderApp(): void {
  render(
    <UniboxProvider>
      <App />
    </UniboxProvider>
  )
}

async function rows(): Promise<HTMLElement[]> {
  const list = await screen.findByRole('listbox')
  await waitFor(() => expect(within(list).getAllByRole('option').length).toBe(SUBJECTS.length))
  return within(list).getAllByRole('option')
}

function menu(): HTMLElement {
  return screen.getByRole('menu', { name: 'Aktionen für die Auswahl' })
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

describe('right-clicking a conversation', () => {
  it('opens the menu on the clicked row and selects it', async () => {
    await seedThreads()
    renderApp()
    const all = await rows()

    fireEvent.contextMenu(all[1]!, { clientX: 120, clientY: 200 })

    await waitFor(() => expect(menu()).toBeInTheDocument())
    expect(within(menu()).getByText('Archivieren')).toBeInTheDocument()
    expect(within(menu()).getByText('Verschieben nach')).toBeInTheDocument()
    const list = await screen.findByRole('listbox')
    const selected = within(list)
      .getAllByRole('option')
      .filter((row) => row.getAttribute('aria-selected') === 'true')
    expect(selected).toHaveLength(1)
    expect(selected[0]!.textContent).toContain(SUBJECTS[1])
  })

  it('keeps a multi-selection when the clicked row is part of it', async () => {
    await seedThreads()
    renderApp()
    const all = await rows()

    fireEvent.click(all[0]!)
    fireEvent.click(all[1]!, { metaKey: true })
    await waitFor(() => expect(screen.getByText('2 ausgewählt')).toBeInTheDocument())

    fireEvent.contextMenu(all[1]!, { clientX: 120, clientY: 200 })

    await waitFor(() => expect(menu()).toBeInTheDocument())
    expect(screen.getByText('2 ausgewählt')).toBeInTheDocument()
  })

  it('archives the selection and closes', async () => {
    const accountId = await seedThreads()
    renderApp()
    const all = await rows()

    fireEvent.contextMenu(all[0]!, { clientX: 10, clientY: 10 })
    await waitFor(() => expect(menu()).toBeInTheDocument())
    fireEvent.click(within(menu()).getByText('Archivieren'))

    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument())
    await waitFor(() => {
      const message = harness.app.store.messages.get(`${accountId}:g0`)
      expect(message?.labelIds).not.toContain(`${accountId}:l:INBOX`)
    })
  })

  it('moves a conversation into a label, taking it out of the inbox', async () => {
    const accountId = await seedThreads()
    renderApp()
    const all = await rows()

    fireEvent.contextMenu(all[0]!, { clientX: 10, clientY: 10 })
    await waitFor(() => expect(menu()).toBeInTheDocument())
    fireEvent.click(within(menu()).getByText('Verschieben nach'))
    const submenu = await screen.findByRole('menu', { name: 'Verschieben nach' })
    fireEvent.click(within(submenu).getByText('Kunden'))

    await waitFor(() => {
      const message = harness.app.store.messages.get(`${accountId}:g0`)
      expect(message?.labelIds).toContain(`${accountId}:l:Label_1`)
      expect(message?.labelIds).not.toContain(`${accountId}:l:INBOX`)
    })
  })

  it('opens a submenu beside the row on hover and closes it on the next row', async () => {
    await seedThreads()
    renderApp()
    const all = await rows()

    fireEvent.contextMenu(all[0]!, { clientX: 10, clientY: 10 })
    await waitFor(() => expect(menu()).toBeInTheDocument())

    const trigger = within(menu()).getByRole('menuitem', { name: /Verschieben nach/ })
    fireEvent.mouseEnter(trigger)

    const submenu = await screen.findByRole('menu', { name: 'Verschieben nach' })
    // The root stays open beneath it — a flyout, not a replaced pane.
    expect(menu()).toBeInTheDocument()
    expect(within(submenu).getByText('Kunden')).toBeInTheDocument()
    expect(trigger).toHaveAttribute('aria-expanded', 'true')

    fireEvent.mouseEnter(within(menu()).getByRole('menuitem', { name: /Archivieren/ }))

    await waitFor(() =>
      expect(screen.queryByRole('menu', { name: 'Verschieben nach' })).not.toBeInTheDocument()
    )
  })

  it('swaps to the sibling submenu when the pointer moves onto it', async () => {
    await seedThreads()
    renderApp()
    const all = await rows()

    fireEvent.contextMenu(all[0]!, { clientX: 10, clientY: 10 })
    await waitFor(() => expect(menu()).toBeInTheDocument())

    fireEvent.mouseEnter(within(menu()).getByRole('menuitem', { name: /Verschieben nach/ }))
    await screen.findByRole('menu', { name: 'Verschieben nach' })
    fireEvent.mouseEnter(within(menu()).getByRole('menuitem', { name: /Label vergeben/ }))

    await screen.findByRole('menu', { name: 'Label vergeben' })
    expect(screen.queryByRole('menu', { name: 'Verschieben nach' })).not.toBeInTheDocument()
  })

  it('keeps the flyout open while the pointer is on one of its own rows', async () => {
    await seedThreads()
    renderApp()
    const all = await rows()

    fireEvent.contextMenu(all[0]!, { clientX: 10, clientY: 10 })
    await waitFor(() => expect(menu()).toBeInTheDocument())

    fireEvent.mouseEnter(within(menu()).getByRole('menuitem', { name: /Verschieben nach/ }))
    const submenu = await screen.findByRole('menu', { name: 'Verschieben nach' })
    fireEvent.mouseEnter(within(submenu).getByText('Kunden'))

    expect(screen.getByRole('menu', { name: 'Verschieben nach' })).toBeInTheDocument()
  })

  it('nests a Gmail sublabel under its parent instead of listing the full path', async () => {
    await seedThreads()
    const account = harness.app.store.accounts.list()[0]!
    harness.app.store.labels.upsert(account.id, {
      remoteId: 'Label_2',
      name: 'Kunden/Offerten',
      type: 'user'
    })
    harness.app.store.labels.upsert(account.id, {
      remoteId: 'Label_3',
      name: 'Kunden/Rechnungen',
      type: 'user'
    })
    renderApp()
    const all = await rows()

    fireEvent.contextMenu(all[0]!, { clientX: 10, clientY: 10 })
    await waitFor(() => expect(menu()).toBeInTheDocument())
    fireEvent.mouseEnter(within(menu()).getByRole('menuitem', { name: /Verschieben nach/ }))
    const moveTo = await screen.findByRole('menu', { name: 'Verschieben nach' })

    // The parent leads a flyout, and no row spells out the slash path.
    await waitFor(() =>
      expect(within(moveTo).getByRole('menuitem', { name: /Kunden/ })).toHaveAttribute(
        'aria-haspopup',
        'menu'
      )
    )
    expect(within(moveTo).queryByText('Kunden/Offerten')).not.toBeInTheDocument()

    fireEvent.mouseEnter(within(moveTo).getByRole('menuitem', { name: /Kunden/ }))
    const children = await screen.findByRole('menu', { name: 'Kunden' })
    expect(within(children).getByText('Offerten')).toBeInTheDocument()
    expect(within(children).getByText('Rechnungen')).toBeInTheDocument()
    // The parent is a real label too, so it stays reachable at the top.
    expect(within(children).getByText('Kunden')).toBeInTheDocument()
  })

  it('moves into a sublabel from the nested flyout', async () => {
    const accountId = await seedThreads()
    harness.app.store.labels.upsert(accountId, {
      remoteId: 'Label_2',
      name: 'Kunden/Offerten',
      type: 'user'
    })
    renderApp()
    const all = await rows()

    fireEvent.contextMenu(all[0]!, { clientX: 10, clientY: 10 })
    await waitFor(() => expect(menu()).toBeInTheDocument())
    fireEvent.mouseEnter(within(menu()).getByRole('menuitem', { name: /Verschieben nach/ }))
    const moveTo = await screen.findByRole('menu', { name: 'Verschieben nach' })
    fireEvent.mouseEnter(within(moveTo).getByRole('menuitem', { name: /Kunden/ }))
    const children = await screen.findByRole('menu', { name: 'Kunden' })
    fireEvent.click(within(children).getByText('Offerten'))

    await waitFor(() => {
      const message = harness.app.store.messages.get(`${accountId}:g0`)
      expect(message?.labelIds).toContain(`${accountId}:l:Label_2`)
      expect(message?.labelIds).not.toContain(`${accountId}:l:INBOX`)
    })
  })

  it('closes on Escape', async () => {
    await seedThreads()
    renderApp()
    const all = await rows()

    fireEvent.contextMenu(all[0]!, { clientX: 10, clientY: 10 })
    await waitFor(() => expect(menu()).toBeInTheDocument())
    fireEvent.keyDown(window, { key: 'Escape' })

    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument())
  })
})
