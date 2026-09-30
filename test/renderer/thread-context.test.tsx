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

/** One conversation of two mails, so the panel has something to fold away. */
async function seedThread(): Promise<void> {
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
    to: [{ name: null, email: 'max@muster-it.ch' }],
    date: Date.parse('2026-08-18T10:12:00.000Z'),
    labelRemoteIds: [SYSTEM_LABELS.inbox],
    body: { html: '<p>Wie sieht der Zeitplan aus?</p>', text: null }
  })
  harness.app.store.messages.upsert({
    id: `${account.id}:g2`,
    accountId: account.id,
    threadId: `${account.id}:t:g1`,
    remoteId: 'g2',
    subject: 'Re: Offerte Onlineshop',
    from: { name: 'Sandra Keller', email: 's.keller@keller-farben.ch' },
    to: [{ name: null, email: 'max@muster-it.ch' }],
    date: Date.parse('2026-08-19T09:00:00.000Z'),
    labelRemoteIds: [SYSTEM_LABELS.inbox],
    body: { html: '<p>Wann können Sie starten?</p>', text: null }
  })
}

async function startReply(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
  render(
    <UniboxProvider>
      <App />
    </UniboxProvider>
  )
  const list = await screen.findByRole('listbox')
  await waitFor(() => expect(within(list).getAllByRole('option')).toHaveLength(1))
  await user.click(within(list).getAllByRole('option')[0]!)
  await user.click(await screen.findByRole('button', { name: /Antworten als/ }))
  return screen.findByRole('dialog', { name: 'Antworten' })
}

/** What the editor holds — the reading pane shows the same mails behind it. */
function draft(dialog: HTMLElement): string {
  return (dialog.querySelector('.compose__editor') as HTMLElement).textContent ?? ''
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

describe('the conversation inside the composer', () => {
  it('folds the thread open on request and keeps it out of the draft', async () => {
    await seedThread()
    const user = userEvent.setup()
    const reply = await startReply(user)

    const toggle = within(reply).getByRole('button', { name: 'Verlauf (2)' })
    expect(screen.queryByRole('region', { name: 'Verlauf der Konversation' })).toBeNull()

    await user.click(toggle)
    const panel = await screen.findByRole('region', { name: 'Verlauf der Konversation' })
    // The newest mail is open, the older one folded down to its header.
    const heads = within(panel).getAllByRole('button', { name: /Sandra Keller/ })
    expect(heads.map((head) => head.getAttribute('aria-expanded'))).toEqual(['false', 'true'])
    expect(panel.querySelectorAll('.message__body')).toHaveLength(1)
    expect(panel.textContent).toContain('Wann können Sie starten?')

    await user.click(heads[0]!)
    await waitFor(() => expect(panel.querySelectorAll('.message__body')).toHaveLength(2))
    // Looking something up leaves no trace in what gets sent.
    expect(draft(reply)).not.toContain('Wann können Sie starten?')
  })

  it('quotes the answered mail into the draft and sends it along', async () => {
    await seedThread()
    const user = userEvent.setup()
    const reply = await startReply(user)

    await user.click(within(reply).getByRole('button', { name: 'Original zitieren' }))
    await waitFor(() => expect(draft(reply)).toContain('Wann können Sie starten?'))
    expect(draft(reply)).toContain('schrieb Sandra Keller')

    await user.click(within(reply).getByRole('button', { name: 'Senden' }))
    await waitFor(() => expect(harness.app.store.outbox.list()).toHaveLength(1))
    const [item] = harness.app.store.outbox.list()
    expect(item!.html).toContain('Wann können Sie starten?')
    expect(item!.to).toEqual([{ name: null, email: 's.keller@keller-farben.ch' }])
  })

  it('takes the quote back out when it is switched off again', async () => {
    await seedThread()
    const user = userEvent.setup()
    const reply = await startReply(user)

    const quote = within(reply).getByRole('button', { name: 'Original zitieren' })
    await user.click(quote)
    await waitFor(() => expect(draft(reply)).toContain('Wann können Sie starten?'))
    await user.click(quote)
    await waitFor(() => expect(draft(reply)).not.toContain('Wann können Sie starten?'))
  })

  it('follows the draft into its own window, where the pane is hidden', async () => {
    await seedThread()
    const user = userEvent.setup()
    const reply = await startReply(user)

    await user.click(within(reply).getByRole('button', { name: 'In eigenem Fenster öffnen' }))
    await waitFor(() => expect(document.querySelector('.compose-float')).not.toBeNull())

    const dialog = await screen.findByRole('dialog', { name: 'Antworten' })
    await user.click(within(dialog).getByRole('button', { name: 'Verlauf (2)' }))
    const panel = await screen.findByRole('region', { name: 'Verlauf der Konversation' })
    expect(panel.textContent).toContain('Wann können Sie starten?')
  })
})
