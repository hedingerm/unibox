// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SYSTEM_LABELS } from '@shared/types'
import { App } from '@renderer/App'
import { UniboxProvider } from '@renderer/state'
import { createTestApp } from '../helpers/app'
import { installBridge } from '../helpers/fake-bridge'

let harness: ReturnType<typeof createTestApp>
let bridge: ReturnType<typeof installBridge>

async function seed(): Promise<string> {
  await harness.app.api['settings:set']({ onboardingComplete: true })
  const account = harness.app.store.accounts.upsert({
    kind: 'google',
    email: 'max@muster-it.ch',
    displayName: 'max@muster-it.ch'
  })
  harness.app.store.labels.ensureSystemLabels(account.id)
  harness.app.store.messages.upsert({
    id: `${account.id}:g1`,
    accountId: account.id,
    threadId: `${account.id}:t:g1`,
    remoteId: 'g1',
    subject: 'Versehentlich gelöscht',
    from: { name: 'Marco Bianchi', email: 'marco@example.com' },
    to: [{ name: null, email: 'max@muster-it.ch' }],
    date: Date.parse('2026-08-18T10:12:00.000Z'),
    labelRemoteIds: [SYSTEM_LABELS.trash],
    body: { html: null, text: 'Inhalt' }
  })
  harness.app.store.messages.upsert({
    id: `${account.id}:g2`,
    accountId: account.id,
    threadId: `${account.id}:t:g2`,
    remoteId: 'g2',
    subject: 'Falsch als Spam',
    from: { name: 'Newsletter', email: 'news@example.com' },
    to: [{ name: null, email: 'max@muster-it.ch' }],
    date: Date.parse('2026-08-18T09:12:00.000Z'),
    labelRemoteIds: [SYSTEM_LABELS.spam],
    body: { html: null, text: 'Inhalt' }
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

async function openFolder(name: string): Promise<HTMLElement> {
  const user = userEvent.setup()
  await screen.findByRole('listbox')
  await user.click(await screen.findByText(name))
  return screen.getByRole('listbox')
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

describe('trash and spam are reachable and reversible', () => {
  it('lists trashed conversations in their own folder', async () => {
    await seed()
    renderApp()
    const list = await openFolder('Papierkorb')
    await waitFor(() => expect(within(list).getAllByRole('option')).toHaveLength(1))
    expect(list).toHaveTextContent('Versehentlich gelöscht')
  })

  it('restores a conversation out of the trash', async () => {
    const accountId = await seed()
    const user = userEvent.setup()
    renderApp()
    const list = await openFolder('Papierkorb')
    await waitFor(() => expect(within(list).getAllByRole('option')).toHaveLength(1))
    await user.click(within(list).getAllByRole('option')[0]!)

    await user.click(screen.getByRole('button', { name: 'Wiederherstellen' }))

    const trash = harness.app.store.labels.get(accountId, SYSTEM_LABELS.trash)!
    const inbox = harness.app.store.labels.get(accountId, SYSTEM_LABELS.inbox)!
    await waitFor(() => {
      const message = harness.app.store.messages.get(`${accountId}:g1`)!
      expect(message.labelIds).not.toContain(trash.id)
      expect(message.labelIds).toContain(inbox.id)
    })
    await waitFor(() => expect(within(list).queryAllByRole('option')).toHaveLength(0))
  })

  it('takes a conversation back out of spam', async () => {
    const accountId = await seed()
    const user = userEvent.setup()
    renderApp()
    const list = await openFolder('Spam')
    await waitFor(() => expect(within(list).getAllByRole('option')).toHaveLength(1))
    await user.click(within(list).getAllByRole('option')[0]!)

    await user.click(screen.getByRole('button', { name: 'Wiederherstellen' }))

    const spam = harness.app.store.labels.get(accountId, SYSTEM_LABELS.spam)!
    await waitFor(() =>
      expect(harness.app.store.messages.get(`${accountId}:g2`)!.labelIds).not.toContain(spam.id)
    )
  })
})

describe('deleting for good asks first', () => {
  it('does nothing when the confirmation is declined', async () => {
    const accountId = await seed()
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const user = userEvent.setup()
    renderApp()
    const list = await openFolder('Papierkorb')
    await waitFor(() => expect(within(list).getAllByRole('option')).toHaveLength(1))
    await user.click(within(list).getAllByRole('option')[0]!)

    await user.click(screen.getByRole('button', { name: 'Endgültig löschen' }))

    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('endgültig löschen'))
    expect(harness.app.store.messages.get(`${accountId}:g1`)).not.toBeNull()
  })

  it('removes the conversation once the confirmation is accepted', async () => {
    const accountId = await seed()
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const user = userEvent.setup()
    renderApp()
    const list = await openFolder('Papierkorb')
    await waitFor(() => expect(within(list).getAllByRole('option')).toHaveLength(1))
    await user.click(within(list).getAllByRole('option')[0]!)

    await user.click(screen.getByRole('button', { name: 'Endgültig löschen' }))

    await waitFor(() => expect(harness.app.store.messages.get(`${accountId}:g1`)).toBeNull())
    await waitFor(() => expect(within(list).queryAllByRole('option')).toHaveLength(0))
  })
})
