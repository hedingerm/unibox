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

async function seedMessageWithAttachments(): Promise<void> {
  await harness.app.api['settings:set']({ onboardingComplete: true })
  const account = harness.app.store.accounts.upsert({
    kind: 'google',
    email: 'max@muster-it.ch',
    displayName: 'max@muster-it.ch'
  })
  harness.app.store.labels.ensureSystemLabels(account.id)
  harness.files.set('/cache/notiz.txt', Buffer.from('Zahlbar innert 30 Tagen', 'utf8'))
  harness.files.set('/cache/archiv.zip', Buffer.from('PK', 'binary'))
  harness.app.store.messages.upsert({
    id: `${account.id}:g1`,
    accountId: account.id,
    threadId: `${account.id}:t:g1`,
    remoteId: 'g1',
    subject: 'Rechnung August',
    from: { name: 'Marco Bianchi', email: 'marco@example.com' },
    to: [{ name: null, email: 'max@muster-it.ch' }],
    date: Date.parse('2026-08-18T10:12:00.000Z'),
    labelRemoteIds: [SYSTEM_LABELS.inbox],
    body: { html: null, text: 'Anbei die Rechnung' },
    attachments: [
      {
        id: 'att-text',
        filename: 'notiz.txt',
        mimeType: 'text/plain',
        size: 23,
        filePath: '/cache/notiz.txt',
        downloaded: true
      },
      {
        id: 'att-zip',
        filename: 'archiv.zip',
        mimeType: 'application/zip',
        size: 4096,
        filePath: '/cache/archiv.zip',
        downloaded: true
      }
    ]
  })
}

async function openPreview(): Promise<ReturnType<typeof userEvent.setup>> {
  const user = userEvent.setup()
  render(
    <UniboxProvider>
      <App />
    </UniboxProvider>
  )
  const list = await screen.findByRole('listbox')
  await waitFor(() => expect(within(list).getAllByRole('option')).toHaveLength(1))
  await user.click(within(list).getAllByRole('option')[0]!)
  await screen.findByRole('heading', { name: 'Rechnung August' })
  await user.click(await screen.findByRole('button', { name: /notiz\.txt/ }))
  return user
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

describe('attachment preview', () => {
  it('shows the content of a previewable attachment in the client', async () => {
    await seedMessageWithAttachments()
    await openPreview()

    const dialog = await screen.findByRole('dialog', { name: 'notiz.txt' })
    await waitFor(() => expect(dialog).toHaveTextContent('Zahlbar innert 30 Tagen'))
  })

  it('offers open and save instead of a preview for an unsupported type', async () => {
    await seedMessageWithAttachments()
    const user = await openPreview()

    const dialog = await screen.findByRole('dialog', { name: 'notiz.txt' })
    await user.click(within(dialog).getByRole('button', { name: 'Nächster Anhang' }))

    const zip = await screen.findByRole('dialog', { name: 'archiv.zip' })
    expect(zip).toHaveTextContent('keine Vorschau')

    harness.saveTarget.path = '/downloads/archiv.zip'
    await user.click(within(zip).getByRole('button', { name: 'Speichern unter…' }))
    await waitFor(() => expect(harness.files.has('/downloads/archiv.zip')).toBe(true))

    await user.click(within(zip).getByRole('button', { name: 'Im Programm öffnen' }))
    await waitFor(() => expect(harness.openedPaths).toContain('/cache/archiv.zip'))
  })

  it('closes on Escape', async () => {
    await seedMessageWithAttachments()
    const user = await openPreview()

    await screen.findByRole('dialog', { name: 'notiz.txt' })
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'notiz.txt' })).toBeNull())
  })
})
