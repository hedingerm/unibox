// @vitest-environment jsdom
import { StrictMode } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SYSTEM_LABELS } from '@shared/types'
import { App } from '@renderer/App'
import { UniboxProvider } from '@renderer/state'
import { createTestApp } from '../helpers/app'
import { installBridge } from '../helpers/fake-bridge'

let harness: ReturnType<typeof createTestApp>
let bridge: ReturnType<typeof installBridge>

function boot(): void {
  harness = createTestApp()
  bridge = installBridge(harness.app)
  harness.onEmit((name, payload) => {
    act(() => {
      bridge.emit(name, payload as never)
    })
  })
}

/** Two conversations: one to answer in, one to leave it for. */
async function seedInbox(): Promise<void> {
  await harness.app.api['settings:set']({ onboardingComplete: true })
  const account = harness.app.store.accounts.upsert({
    kind: 'google',
    email: 'max@muster-it.ch',
    displayName: 'max@muster-it.ch'
  })
  harness.app.store.labels.ensureSystemLabels(account.id)
  harness.app.store.labels.replaceAll(account.id, [
    { remoteId: SYSTEM_LABELS.inbox, name: 'INBOX', type: 'system' },
    { remoteId: SYSTEM_LABELS.sent, name: 'SENT', type: 'system' },
    { remoteId: SYSTEM_LABELS.unread, name: 'UNREAD', type: 'system' },
    { remoteId: SYSTEM_LABELS.trash, name: 'TRASH', type: 'system' },
    { remoteId: SYSTEM_LABELS.spam, name: 'SPAM', type: 'system' }
  ])
  harness.app.store.identities.create({
    accountId: account.id,
    name: 'Max Muster',
    email: account.email,
    isDefault: true,
    signatureHtml: null
  })
  harness.app.store.messages.upsert({
    id: `${account.id}:g1`,
    accountId: account.id,
    threadId: `${account.id}:t:g1`,
    remoteId: 'g1',
    subject: 'Offerte Onlineshop',
    from: { name: 'Sandra Keller', email: 's.keller@keller-farben.ch' },
    to: [{ name: null, email: account.email }],
    date: Date.parse('2026-08-18T10:12:00.000Z'),
    labelRemoteIds: [SYSTEM_LABELS.inbox],
    body: { html: null, text: 'Wann können Sie starten?' }
  })
  harness.app.store.messages.upsert({
    id: `${account.id}:g2`,
    accountId: account.id,
    threadId: `${account.id}:t:g2`,
    remoteId: 'g2',
    subject: 'Rechnung August',
    from: { name: 'Peter Frei', email: 'p.frei@treuhand.ch' },
    to: [{ name: null, email: account.email }],
    date: Date.parse('2026-08-19T08:00:00.000Z'),
    labelRemoteIds: [SYSTEM_LABELS.inbox],
    body: { html: null, text: 'Anbei die Rechnung.' }
  })
}

/** Opens the older conversation and starts an answer inside it. */
async function startReply(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
  render(
    <StrictMode>
      <UniboxProvider>
        <App />
      </UniboxProvider>
    </StrictMode>
  )
  const list = await screen.findByRole('listbox')
  await waitFor(() => expect(within(list).getAllByRole('option')).toHaveLength(2))
  await user.click(within(list).getAllByRole('option')[1]!)
  await user.click(await screen.findByRole('button', { name: /Antworten als/ }))
  return screen.findByRole('dialog', { name: 'Antworten' })
}

/** Focus rather than click: a click makes ProseMirror map screen coordinates. */
function body(dialog: HTMLElement): HTMLElement {
  const surface = dialog.querySelector('.ProseMirror') as HTMLElement
  surface.focus()
  return surface
}

afterEach(() => {
  cleanup()
  bridge.uninstall()
  harness.dispose()
})

describe('replying inside the conversation', () => {
  it('answers below the mail instead of over it', async () => {
    boot()
    await seedInbox()
    const user = userEvent.setup()
    const reply = await startReply(user)

    expect(reply.classList.contains('reply-inline')).toBe(true)
    // Nothing covers the app: the conversation stays readable while writing.
    expect(document.querySelector('.overlay')).toBeNull()
    expect(screen.getByRole('heading', { name: 'Offerte Onlineshop' })).toBeTruthy()
    expect(reply.textContent).toContain('s.keller@keller-farben.ch')
  })

  it('hands the written text to the window when it is popped out', async () => {
    boot()
    await seedInbox()
    const user = userEvent.setup()
    const reply = await startReply(user)

    body(reply)
    await user.keyboard('Hoi Sandra, nächste Woche passt.')
    await user.click(screen.getByRole('button', { name: 'In eigenem Fenster öffnen' }))

    const dialog = await screen.findByRole('dialog', { name: 'Antworten' })
    await waitFor(() => expect(document.querySelector('.compose-float')).not.toBeNull())
    expect(document.querySelector('.reply-inline')).toBeNull()
    expect(dialog.textContent).toContain('nächste Woche passt.')
    expect(screen.getByLabelText('An:')).toHaveValue('s.keller@keller-farben.ch')
    // The window continues the strip's draft rather than starting a second one.
    await waitFor(async () => expect(await harness.app.api['drafts:list']()).toHaveLength(1))
  })

  it('marks the conversation as holding a draft, with the draft’s own text', async () => {
    boot()
    await seedInbox()
    const user = userEvent.setup()
    const reply = await startReply(user)

    body(reply)
    await user.keyboard('Hoi Sandra, nächste Woche passt.')
    const list = screen.getByRole('listbox')
    await user.click(within(list).getAllByRole('option')[0]!)

    const row = await waitFor(() => {
      const found = within(screen.getByRole('listbox'))
        .getAllByRole('option')
        .find((entry) => entry.textContent?.includes('Entwurf'))
      expect(found).toBeTruthy()
      return found!
    })
    expect(row.textContent).toContain('Offerte Onlineshop')
    expect(row.textContent).toContain('nächste Woche passt.')
    // Not an answer that is out of the house.
    expect(row.textContent).not.toContain('Du:')
  })

  it('closes when the conversation is left, and keeps what was written', async () => {
    boot()
    await seedInbox()
    const user = userEvent.setup()
    const reply = await startReply(user)

    body(reply)
    await user.keyboard('Hoi Sandra, nächste Woche passt.')
    const list = screen.getByRole('listbox')
    await user.click(within(list).getAllByRole('option')[0]!)

    await waitFor(() => expect(document.querySelector('.reply-inline')).toBeNull())
    await waitFor(async () => expect(await harness.app.api['drafts:list']()).toHaveLength(1))
  })
})
