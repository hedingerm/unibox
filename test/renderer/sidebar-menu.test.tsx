// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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
  harness.app.vault.setGoogleTokens(account.id, {
    accessToken: 'test-access',
    refreshToken: 'test-refresh',
    expiresAt: Date.now() + 3_600_000,
    scope: 'gmail.modify',
    tokenType: 'Bearer'
  })
  // The label exists in Gmail too, the way a synced label always does.
  harness.gmail.addUserLabel('Label_1', 'Kunden')
  harness.app.store.labels.upsert(account.id, { remoteId: 'Label_1', name: 'Kunden', type: 'user' })
  harness.app.store.messages.upsert({
    id: `${account.id}:g1`,
    accountId: account.id,
    threadId: `${account.id}:t:g1`,
    remoteId: 'g1',
    subject: 'Offerte',
    from: { name: 'Sandra Keller', email: 's.keller@keller-farben.ch' },
    to: [{ name: null, email: account.email }],
    date: Date.parse('2026-08-18T10:00:00.000Z'),
    labelRemoteIds: [SYSTEM_LABELS.inbox, SYSTEM_LABELS.unread, 'Label_1'],
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

async function labelRow(name: string): Promise<HTMLElement> {
  return await screen.findByText(name)
}

beforeEach(() => {
  harness = createTestApp({ googleOAuth: true })
  bridge = installBridge(harness.app)
})

afterEach(() => {
  cleanup()
  bridge.uninstall()
  harness.dispose()
  vi.restoreAllMocks()
})

describe('right-clicking a sidebar label', () => {
  it('offers rename and delete on a user label only', async () => {
    await seed()
    renderApp()

    fireEvent.contextMenu(await labelRow('Kunden'), { clientX: 40, clientY: 200 })
    const menu = await screen.findByRole('menu', { name: 'Kunden' })
    expect(within(menu).getByText('Umbenennen')).toBeInTheDocument()
    expect(within(menu).getByText('Label löschen')).toBeInTheDocument()

    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument())

    fireEvent.contextMenu(await labelRow('Eingang'), { clientX: 40, clientY: 100 })
    const inboxMenu = await screen.findByRole('menu', { name: 'Eingang' })
    expect(within(inboxMenu).queryByText('Umbenennen')).not.toBeInTheDocument()
    expect(within(inboxMenu).getByText('Alle als gelesen markieren')).toBeInTheDocument()
  })

  it('renames a label inline', async () => {
    const accountId = await seed()
    renderApp()

    fireEvent.contextMenu(await labelRow('Kunden'), { clientX: 40, clientY: 200 })
    fireEvent.click(
      within(await screen.findByRole('menu', { name: 'Kunden' })).getByText('Umbenennen')
    )

    const input = await screen.findByLabelText('Labelname')
    fireEvent.change(input, { target: { value: 'Kunden/Aktiv' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() =>
      expect(harness.app.store.labels.byId(`${accountId}:l:Label_1`)?.name).toBe('Kunden/Aktiv')
    )
    expect(harness.gmail.labels.find((label) => label.id === 'Label_1')?.name).toBe('Kunden/Aktiv')
  })

  it('creates a label from the account header', async () => {
    const accountId = await seed()
    renderApp()

    const header = await screen.findByText('max@muster-it.ch')
    fireEvent.contextMenu(header, { clientX: 40, clientY: 60 })
    fireEvent.click(
      within(await screen.findByRole('menu', { name: 'max@muster-it.ch' })).getByText(
        'Neues Label'
      )
    )

    const input = await screen.findByLabelText('Labelname')
    fireEvent.change(input, { target: { value: 'Lieferanten' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() =>
      expect(
        harness.app.store.labels.list(accountId).some((label) => label.name === 'Lieferanten')
      ).toBe(true)
    )
  })

  it('deletes a label after confirmation', async () => {
    const accountId = await seed()
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    renderApp()

    fireEvent.contextMenu(await labelRow('Kunden'), { clientX: 40, clientY: 200 })
    fireEvent.click(
      within(await screen.findByRole('menu', { name: 'Kunden' })).getByText('Label löschen')
    )

    await waitFor(() => expect(harness.app.store.labels.byId(`${accountId}:l:Label_1`)).toBeNull())
    // The mail itself survives losing its label.
    expect(harness.app.store.messages.get(`${accountId}:g1`)).not.toBeNull()
  })

  it('marks a whole mailbox read', async () => {
    const accountId = await seed()
    renderApp()

    fireEvent.contextMenu(await labelRow('Eingang'), { clientX: 40, clientY: 100 })
    fireEvent.click(
      within(await screen.findByRole('menu', { name: 'Eingang' })).getByText(
        'Alle als gelesen markieren'
      )
    )

    await waitFor(() =>
      expect(harness.app.store.messages.get(`${accountId}:g1`)?.labelIds).not.toContain(
        `${accountId}:l:UNREAD`
      )
    )
  })
})
