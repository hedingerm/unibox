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

const PDF = Buffer.from('OFFERTE-PDF')

async function seedThread(): Promise<string> {
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
  harness.files.set('/cache/offerte.pdf', PDF)
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
    body: { html: '<p>Wann können Sie starten?</p>', text: null },
    attachments: [
      {
        id: `${account.id}:g1:att-1`,
        filename: 'offerte.pdf',
        mimeType: 'application/pdf',
        size: PDF.byteLength,
        filePath: '/cache/offerte.pdf',
        downloaded: true
      }
    ]
  })
  return account.id
}

async function openThread(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  render(
    <UniboxProvider>
      <App />
    </UniboxProvider>
  )
  const list = await screen.findByRole('listbox')
  await waitFor(() => expect(within(list).getAllByRole('option').length).toBe(1))
  await user.click(within(list).getAllByRole('option')[0]!)
  await waitFor(() => expect(screen.getAllByRole('button', { name: 'Weiterleiten' })).toHaveLength(2))
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

describe('forwarding a mail', () => {
  it('opens a window with the quoted original and its attachment, and sends it on', async () => {
    const accountId = await seedThread()
    const user = userEvent.setup()
    await openThread(user)

    // The one in the reading pane, below the reply line.
    await user.click(screen.getAllByRole('button', { name: 'Weiterleiten' })[1]!)
    const dialog = await screen.findByRole('dialog', { name: 'Weiterleiten' })

    expect(screen.getByLabelText('Betreff:')).toHaveValue('Fwd: Offerte Onlineshop')
    // Who it goes to is exactly what a forward cannot guess.
    expect(screen.getByLabelText('An:')).toHaveValue('')
    expect(dialog.textContent).toContain('Weitergeleitete Nachricht')
    expect(dialog.textContent).toContain('s.keller@keller-farben.ch')
    expect(dialog.textContent).toContain('Wann können Sie starten?')
    await waitFor(() => expect(within(dialog).getByText('offerte.pdf')).toBeInTheDocument())

    await user.type(screen.getByLabelText('An:'), 'kollege@example.com')
    await user.click(screen.getByRole('button', { name: 'Senden' }))

    await waitFor(() => expect(harness.app.store.outbox.list()).toHaveLength(1))
    const [item] = harness.app.store.outbox.list()
    expect(item!.subject).toBe('Fwd: Offerte Onlineshop')
    expect(item!.to).toEqual([{ name: null, email: 'kollege@example.com' }])
    expect(item!.attachments).toHaveLength(1)
    expect(item!.attachments[0]!.content).toBe(PDF.toString('base64'))
    // The forward stays in the conversation it was sent out of.
    expect(item!.replyToMessageId).toBe(`${accountId}:g1`)
  })
})
