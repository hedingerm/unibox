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

const SUBJECTS = ['Offerte Keller', 'Rechnung Muster']

async function seedInbox(): Promise<string> {
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
  return account.id
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
  await waitFor(() => expect(within(list).getAllByRole('option').length).toBe(count))
  return within(list).getAllByRole('option')
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

describe('putting a conversation aside', () => {
  it('takes it out of the inbox and into the snooze list', async () => {
    await seedInbox()
    renderApp()
    const all = await rows()
    fireEvent.click(all[0]!)

    // `b` is the shortcut for the one offer that needs no menu.
    fireEvent.keyDown(window, { key: 'b' })

    await waitFor(async () => expect(await rows(1)).toHaveLength(1))
    expect(screen.queryByText('Offerte Keller')).not.toBeInTheDocument()

    const snoozed = await screen.findByRole('button', { name: /Zurückgestellt/ })
    fireEvent.click(snoozed)
    await waitFor(() => expect(screen.getByText('Offerte Keller')).toBeInTheDocument())
  })

  it('says on the row when it comes back', async () => {
    await seedInbox()
    renderApp()
    fireEvent.click((await rows())[0]!)
    fireEvent.keyDown(window, { key: 'b' })

    fireEvent.click(await screen.findByRole('button', { name: /Zurückgestellt/ }))
    // "Morgen 08:00" — a badge that only said "zurückgestellt" would leave the
    // one thing the user needs to know unsaid.
    await waitFor(() => expect(screen.getByText(/bis Morgen 08:00/)).toBeInTheDocument())
  })

  it('offers to end the snooze from inside the snooze list', async () => {
    await seedInbox()
    renderApp()
    fireEvent.click((await rows())[0]!)
    fireEvent.keyDown(window, { key: 'b' })

    fireEvent.click(await screen.findByRole('button', { name: /Zurückgestellt/ }))
    fireEvent.click((await rows(1))[0]!)

    const undo = await screen.findByRole('button', { name: 'Zurückstellen aufheben' })
    fireEvent.click(undo)

    // The list empties, but the sidebar row stays while it is the open mailbox:
    // vanishing under the user would leave them standing nowhere.
    await waitFor(() => expect(screen.getByText('Keine Nachrichten')).toBeInTheDocument())
    expect(screen.getByRole('button', { name: /Zurückgestellt/ })).toBeInTheDocument()
    expect(harness.app.store.snoozes.count()).toBe(0)

    // And the conversation is back where it came from.
    fireEvent.click(screen.getByRole('button', { name: /Alle Eingänge/ }))
    await waitFor(async () => expect(await rows()).toHaveLength(SUBJECTS.length))
    expect(screen.getByText('Offerte Keller')).toBeInTheDocument()
  })

  it('picks a moment from the toolbar menu', async () => {
    const accountId = await seedInbox()
    renderApp()
    fireEvent.click((await rows())[0]!)

    fireEvent.click(await screen.findByRole('button', { name: 'Zurückstellen' }))
    const menu = await screen.findByRole('menu', { name: 'Zurückstellen bis…' })
    fireEvent.click(within(menu).getByRole('menuitem', { name: /Nächste Woche/ }))

    await waitFor(() => expect(harness.app.store.snoozes.count()).toBe(1))
    const [entry] = harness.app.store.snoozes.list()
    expect(entry!.accountId).toBe(accountId)
    expect(entry!.wakeAt).toBeGreaterThan(Date.now())
  })

  it('says what the snooze actually does, where the choice is made', async () => {
    await seedInbox()
    renderApp()
    fireEvent.click((await rows())[0]!)
    fireEvent.click(await screen.findByRole('button', { name: 'Zurückstellen' }))

    expect(await screen.findByText(/archiviert/)).toBeInTheDocument()
    expect(screen.getByText(/Unibox das nächste Mal läuft/)).toBeInTheDocument()
  })
})
