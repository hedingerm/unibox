// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SYSTEM_LABELS } from '@shared/types'
import { App } from '@renderer/App'
import { UniboxProvider } from '@renderer/state'
import { createTestApp } from '../helpers/app'
import { installBridge } from '../helpers/fake-bridge'

let harness: ReturnType<typeof createTestApp>
let bridge: ReturnType<typeof installBridge>

const SUBJECTS = ['Offerte A', 'Offerte B', 'Offerte C', 'Offerte D', 'Offerte E']

async function seedThreads(labels: string[] = [SYSTEM_LABELS.inbox, SYSTEM_LABELS.unread]): Promise<string> {
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
      labelRemoteIds: labels,
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

beforeEach(() => {
  harness = createTestApp()
  bridge = installBridge(harness.app)
})

afterEach(() => {
  cleanup()
  bridge.uninstall()
  harness.dispose()
})

describe('selecting several conversations', () => {
  it('adds one with ⌘-click and shows how many are selected', async () => {
    await seedThreads()
    renderApp()
    const list = await screen.findByRole('listbox')
    const all = await rows()

    fireEvent.click(all[0]!)
    expect(within(list).getAllByRole('option').filter((row) => row.getAttribute('aria-selected') === 'true')).toHaveLength(1)

    fireEvent.click(all[2]!, { metaKey: true })
    await waitFor(() => expect(screen.getByText('2 ausgewählt')).toBeInTheDocument())
    const selected = within(list)
      .getAllByRole('option')
      .filter((row) => row.getAttribute('aria-selected') === 'true')
    expect(selected.map((row) => row.textContent)).toEqual([
      expect.stringContaining('Offerte A'),
      expect.stringContaining('Offerte C')
    ])

    // ⌘-clicking it again takes it back out.
    fireEvent.click(all[2]!, { metaKey: true })
    await waitFor(() => expect(screen.queryByText('2 ausgewählt')).not.toBeInTheDocument())
  })

  it('selects a whole range with ⇧-click', async () => {
    await seedThreads()
    renderApp()
    const list = await screen.findByRole('listbox')
    const all = await rows()

    fireEvent.click(all[1]!)
    fireEvent.click(all[3]!, { shiftKey: true })

    await waitFor(() => expect(screen.getByText('3 ausgewählt')).toBeInTheDocument())
    const selected = within(list)
      .getAllByRole('option')
      .filter((row) => row.getAttribute('aria-selected') === 'true')
    expect(selected).toHaveLength(3)
    expect(selected[0]).toHaveTextContent('Offerte B')
    expect(selected[2]).toHaveTextContent('Offerte D')
  })

  it('builds a selection from the keyboard alone', async () => {
    await seedThreads()
    const user = userEvent.setup()
    renderApp()
    await rows()

    await user.keyboard('j')
    await user.keyboard('{Shift>}j{/Shift}')
    await waitFor(() => expect(screen.getByText('2 ausgewählt')).toBeInTheDocument())

    // The reading pane summarises instead of opening one of them.
    expect(screen.getByText('2 Konversationen ausgewählt')).toBeInTheDocument()
  })
})

describe('actions apply to the whole selection', () => {
  it('archives every selected conversation, from the toolbar', async () => {
    const accountId = await seedThreads()
    renderApp()
    const all = await rows()

    fireEvent.click(all[0]!)
    fireEvent.click(all[1]!, { metaKey: true })
    fireEvent.click(all[2]!, { metaKey: true })
    await waitFor(() => expect(screen.getByText('3 ausgewählt')).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: 'Archivieren' }))

    const list = await screen.findByRole('listbox')
    await waitFor(() => expect(within(list).getAllByRole('option')).toHaveLength(2))
    const inbox = harness.app.store.labels.get(accountId, SYSTEM_LABELS.inbox)!
    for (const index of [0, 1, 2]) {
      const message = harness.app.store.messages.get(`${accountId}:g${index}`)!
      expect(message.labelIds).not.toContain(inbox.id)
    }
  })

  it('drops the selection once its conversations have moved', async () => {
    await seedThreads()
    renderApp()
    const all = await rows()

    fireEvent.click(all[0]!)
    fireEvent.click(all[1]!, { metaKey: true })
    await waitFor(() => expect(screen.getByText('2 ausgewählt')).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: 'Archivieren' }))

    // Keeping the old ids would aim the next action at rows that are gone.
    await waitFor(() => expect(screen.queryByText('2 ausgewählt')).not.toBeInTheDocument())
    expect(screen.queryByText('2 Konversationen ausgewählt')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Archivieren' })).toBeDisabled()
  })

  it('archives the selection from the keyboard too', async () => {
    const accountId = await seedThreads()
    const user = userEvent.setup()
    renderApp()
    await rows()

    await user.keyboard('j')
    await user.keyboard('{Shift>}j{/Shift}')
    await waitFor(() => expect(screen.getByText('2 ausgewählt')).toBeInTheDocument())
    await user.keyboard('e')

    const list = await screen.findByRole('listbox')
    await waitFor(() => expect(within(list).getAllByRole('option')).toHaveLength(3))
    const inbox = harness.app.store.labels.get(accountId, SYSTEM_LABELS.inbox)!
    expect(harness.app.store.messages.get(`${accountId}:g0`)!.labelIds).not.toContain(inbox.id)
    expect(harness.app.store.messages.get(`${accountId}:g1`)!.labelIds).not.toContain(inbox.id)
    expect(harness.app.store.messages.get(`${accountId}:g2`)!.labelIds).toContain(inbox.id)
  })

  it('trashes the selection with #', async () => {
    const accountId = await seedThreads()
    const user = userEvent.setup()
    renderApp()
    await rows()

    await user.keyboard('j')
    await user.keyboard('{Shift>}j{/Shift}')
    await user.keyboard('#')

    const list = await screen.findByRole('listbox')
    await waitFor(() => expect(within(list).getAllByRole('option')).toHaveLength(3))
    const trash = harness.app.store.labels.get(accountId, SYSTEM_LABELS.trash)!
    expect(harness.app.store.messages.get(`${accountId}:g0`)!.labelIds).toContain(trash.id)
    expect(harness.app.store.messages.get(`${accountId}:g1`)!.labelIds).toContain(trash.id)
  })

  it('marks the whole selection read', async () => {
    const accountId = await seedThreads()
    renderApp()
    const all = await rows()

    fireEvent.click(all[0]!)
    fireEvent.click(all[1]!, { metaKey: true })
    fireEvent.click(all[2]!, { metaKey: true })
    await waitFor(() => expect(screen.getByText('3 ausgewählt')).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: 'Als gelesen markieren' }))

    const unread = harness.app.store.labels.get(accountId, SYSTEM_LABELS.unread)!
    await waitFor(() => {
      for (const index of [0, 1, 2]) {
        expect(harness.app.store.messages.get(`${accountId}:g${index}`)!.labelIds).not.toContain(
          unread.id
        )
      }
    })
    // The untouched ones keep their unread state.
    expect(harness.app.store.messages.get(`${accountId}:g3`)!.labelIds).toContain(unread.id)
  })

  it('marks the selection spam with !', async () => {
    const accountId = await seedThreads()
    const user = userEvent.setup()
    renderApp()
    await rows()

    await user.keyboard('j')
    await user.keyboard('{Shift>}j{/Shift}')
    await user.keyboard('!')

    const list = await screen.findByRole('listbox')
    await waitFor(() => expect(within(list).getAllByRole('option')).toHaveLength(3))
    const spam = harness.app.store.labels.get(accountId, SYSTEM_LABELS.spam)!
    expect(harness.app.store.messages.get(`${accountId}:g0`)!.labelIds).toContain(spam.id)
    expect(harness.app.store.messages.get(`${accountId}:g1`)!.labelIds).toContain(spam.id)
  })

  it('applies a label to the whole selection', async () => {
    const accountId = await seedThreads()
    harness.app.store.labels.replaceAll(accountId, [
      { remoteId: SYSTEM_LABELS.inbox, name: 'INBOX', type: 'system' },
      { remoteId: SYSTEM_LABELS.sent, name: 'SENT', type: 'system' },
      { remoteId: SYSTEM_LABELS.unread, name: 'UNREAD', type: 'system' },
      { remoteId: SYSTEM_LABELS.trash, name: 'TRASH', type: 'system' },
      { remoteId: SYSTEM_LABELS.spam, name: 'SPAM', type: 'system' },
      { remoteId: 'Label_7', name: 'Kunden', type: 'user' }
    ])
    const user = userEvent.setup()
    renderApp()
    const all = await rows()

    fireEvent.click(all[0]!)
    fireEvent.click(all[1]!, { metaKey: true })
    await waitFor(() => expect(screen.getByText('2 ausgewählt')).toBeInTheDocument())

    await user.click(screen.getByRole('button', { name: 'Labels' }))
    await user.click(await screen.findByRole('menuitemcheckbox', { name: /Kunden/ }))

    const kunden = harness.app.store.labels.get(accountId, 'Label_7')!
    await waitFor(() => {
      expect(harness.app.store.messages.get(`${accountId}:g0`)!.labelIds).toContain(kunden.id)
      expect(harness.app.store.messages.get(`${accountId}:g1`)!.labelIds).toContain(kunden.id)
    })
    expect(harness.app.store.messages.get(`${accountId}:g2`)!.labelIds).not.toContain(kunden.id)
  })
})
