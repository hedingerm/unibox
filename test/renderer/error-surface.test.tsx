// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SYSTEM_LABELS } from '@shared/types'
import { App } from '@renderer/App'
import { UniboxProvider } from '@renderer/state'
import { createTestApp } from '../helpers/app'
import { installBridge } from '../helpers/fake-bridge'
import { openAdmin } from '../helpers/admin'

let harness: ReturnType<typeof createTestApp>
let bridge: ReturnType<typeof installBridge>

async function seedInbox(): Promise<void> {
  await harness.app.api['settings:set']({ onboardingComplete: true })
  const account = harness.app.store.accounts.upsert({
    kind: 'google',
    email: 'max@muster-it.ch',
    displayName: 'max@muster-it.ch'
  })
  harness.app.store.labels.ensureSystemLabels(account.id)
  harness.app.store.identities.create({
    accountId: account.id,
    name: 'Max Muster',
    email: 'max@muster-it.ch',
    signatureHtml: null,
    isDefault: true
  })
  harness.app.store.messages.upsert({
    id: `${account.id}:g1`,
    accountId: account.id,
    threadId: `${account.id}:t:g1`,
    remoteId: 'g1',
    subject: 'Offerte Onlineshop',
    from: { name: 'Marco Bianchi', email: 'marco@example.com' },
    to: [{ name: null, email: 'max@muster-it.ch' }],
    date: Date.parse('2026-08-18T10:12:00.000Z'),
    labelRemoteIds: [SYSTEM_LABELS.inbox, SYSTEM_LABELS.unread],
    body: { html: null, text: 'Anbei die Offerte' }
  })
}

function renderApp(): void {
  render(
    <UniboxProvider>
      <App />
    </UniboxProvider>
  )
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

describe('failed actions name their cause where they were triggered', () => {
  it('shows an archive failure in the toolbar, not only at the window edge', async () => {
    await seedInbox()
    const user = userEvent.setup()
    renderApp()

    const list = await screen.findByRole('listbox')
    await waitFor(() => expect(within(list).getAllByRole('option')).toHaveLength(1))
    await user.click(within(list).getAllByRole('option')[0]!)
    await screen.findByRole('heading', { name: 'Offerte Onlineshop' })

    bridge.failures.set('messages:archive', 'Gmail hat die Aktion abgelehnt (403)')
    // The hovered row offers its own archive button; this is the toolbar's.
    await user.click(within(screen.getByRole('toolbar')).getByRole('button', { name: 'Archivieren' }))

    const status = await waitFor(() => {
      const element = document.querySelector('.toolbar__status')
      expect(element).not.toBeNull()
      return element as HTMLElement
    })
    expect(status).toHaveTextContent('Gmail hat die Aktion abgelehnt (403)')
    // The conversation stays open: nothing was archived.
    expect(screen.getByRole('heading', { name: 'Offerte Onlineshop' })).toBeTruthy()

    await user.click(within(status).getByRole('button', { name: 'Ausblenden' }))
    await waitFor(() => expect(document.querySelector('.toolbar__status')).toBeNull())
  })

  it('shows a send failure inside the compose window', async () => {
    await seedInbox()
    const user = userEvent.setup()
    renderApp()

    const list = await screen.findByRole('listbox')
    await waitFor(() => expect(within(list).getAllByRole('option')).toHaveLength(1))
    await user.click(within(list).getAllByRole('option')[0]!)
    await user.click(await screen.findByRole('button', { name: /Antworten als/ }))

    const dialog = await screen.findByRole('dialog', { name: 'Antworten' })
    bridge.failures.set('compose:send', 'Kein Resend-API-Key hinterlegt')
    await user.click(within(dialog).getByRole('button', { name: 'Senden' }))

    await waitFor(() =>
      expect(dialog).toHaveTextContent(
        'Die E-Mail konnte nicht gesendet werden: Kein Resend-API-Key hinterlegt'
      )
    )
    // A failed send never discards the draft.
    expect(screen.getByRole('dialog', { name: 'Antworten' })).toBeTruthy()
  })

  it('shows a failed reconnect inside the settings window', async () => {
    await seedInbox()
    harness.app.store.accounts.update(
      harness.app.store.accounts.findByEmail('google', 'max@muster-it.ch')!.id,
      { status: 'reconnect_required', lastError: 'invalid_grant' }
    )
    const user = userEvent.setup()
    renderApp()

    await screen.findByRole('listbox')
    const dialog = await openAdmin(user, 'Konten')

    bridge.failures.set('google:reconnect', 'Der Browser hat den Vorgang abgebrochen')
    await user.click(await within(dialog).findByRole('button', { name: 'Neu verbinden' }))

    await waitFor(() =>
      expect(dialog).toHaveTextContent('Der Browser hat den Vorgang abgebrochen')
    )
  })
})

describe('account status names the cause', () => {
  it('shows the last error next to the account in the sidebar', async () => {
    await seedInbox()
    const account = harness.app.store.accounts.findByEmail(
      'google',
      'max@muster-it.ch'
    )!
    harness.app.store.accounts.update(account.id, {
      status: 'error',
      lastError: 'Gmail API 503: Backend Error'
    })
    renderApp()

    await screen.findByRole('listbox')
    expect(await screen.findByText('Synchronisation fehlgeschlagen')).toBeInTheDocument()
    expect(screen.getByText('Gmail API 503: Backend Error')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Erneut versuchen' })).toBeTruthy()
  })

  it('distinguishes an expired connection from a failing sync', async () => {
    await seedInbox()
    const account = harness.app.store.accounts.findByEmail(
      'google',
      'max@muster-it.ch'
    )!
    harness.app.store.accounts.update(account.id, {
      status: 'reconnect_required',
      lastError: 'invalid_grant: Token has been expired or revoked.'
    })
    renderApp()

    await screen.findByRole('listbox')
    expect(await screen.findByText('Verbindung abgelaufen')).toBeInTheDocument()
    expect(
      screen.getByText('invalid_grant: Token has been expired or revoked.')
    ).toBeInTheDocument()
    expect(screen.queryByText('Synchronisation fehlgeschlagen')).not.toBeInTheDocument()
  })
})
