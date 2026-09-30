// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { OutboxDraft } from '@shared/types'
import { SYSTEM_LABELS } from '@shared/types'
import { App } from '@renderer/App'
import { UniboxProvider } from '@renderer/state'
import { createTestApp } from '../helpers/app'
import { installBridge } from '../helpers/fake-bridge'
import { openAdmin } from '../helpers/admin'

let harness: ReturnType<typeof createTestApp>
let bridge: ReturnType<typeof installBridge>

function setOnline(value: boolean): void {
  Object.defineProperty(window.navigator, 'onLine', { configurable: true, value })
  act(() => {
    window.dispatchEvent(new Event(value ? 'online' : 'offline'))
  })
}

async function seedResendInbox(): Promise<string> {
  await harness.app.api['settings:set']({ onboardingComplete: true })
  harness.resend.addDomain('beispielweb.ch', true)
  harness.resend.mx.set('beispielweb.ch', [
    { exchange: 'inbound-smtp.eu-west-1.amazonaws.com', priority: 10 }
  ])
  await harness.app.api['resend:setKey']('re_test')
  await harness.app.api['resend:enableReceiving']('dom_beispielweb_ch')
  const account = harness.app.store.accounts.findByEmail('resend', 'beispielweb.ch')!
  harness.app.store.messages.upsert({
    id: `${account.id}:r1`,
    accountId: account.id,
    threadId: `${account.id}:t:r1`,
    remoteId: 'r1',
    subject: 'Website-Relaunch',
    from: { name: 'Sandra Keller', email: 's.keller@keller-farben.ch' },
    to: [{ name: null, email: 'kontakt@beispielweb.ch' }],
    date: Date.parse('2026-08-18T09:42:00.000Z'),
    labelRemoteIds: [SYSTEM_LABELS.inbox],
    body: { html: null, text: 'Wir möchten unsere Website erneuern lassen' }
  })
  return account.id
}

function draft(accountId: string): OutboxDraft {
  return {
    accountId,
    identityName: 'Max Muster',
    identityEmail: 'kontakt@beispielweb.ch',
    to: [{ name: null, email: 's.keller@keller-farben.ch' }],
    cc: [],
    bcc: [],
    subject: 'Offerte Relaunch',
    html: '<p>Anbei</p>',
    text: 'Anbei',
    attachments: [],
    replyToMessageId: null
  }
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
  setOnline(true)
  cleanup()
  bridge.uninstall()
  harness.dispose()
})

describe('offline', () => {
  it('stays usable, says it is offline and counts what is waiting', async () => {
    const accountId = await seedResendInbox()
    await harness.app.api['compose:send'](draft(accountId))
    const user = userEvent.setup()
    renderApp()

    const list = await screen.findByRole('listbox')
    await waitFor(() => expect(within(list).getAllByRole('option')).toHaveLength(1))
    expect(screen.queryByText(/Keine Internetverbindung/)).not.toBeInTheDocument()

    setOnline(false)
    expect(
      await screen.findByText(/Keine Internetverbindung — Unibox arbeitet mit den lokalen Daten/)
    ).toBeInTheDocument()
    expect(screen.getByText('1 Aktion wartet auf die Verbindung.')).toBeInTheDocument()

    // The local store still answers: reading a conversation works offline.
    await user.click(within(list).getAllByRole('option')[0]!)
    expect(await screen.findByRole('heading', { name: 'Website-Relaunch' })).toBeTruthy()
  })

  it('flushes what piled up as soon as the connection returns', async () => {
    await seedResendInbox()
    renderApp()
    await screen.findByRole('listbox')

    setOnline(false)
    const before = bridge.calls.filter((call) => call.channel === 'sync:now').length
    setOnline(true)

    await waitFor(() =>
      expect(bridge.calls.filter((call) => call.channel === 'sync:now').length).toBe(before + 1)
    )
  })
})

describe('recovery from the settings window', () => {
  it('lists a failed mail with its cause and sends it on retry', async () => {
    const accountId = await seedResendInbox()
    const item = await harness.app.api['compose:send'](draft(accountId))
    harness.app.store.outbox.setState(item.id, 'failed', {
      lastError: 'Resend 422: domain is not verified'
    })
    const user = userEvent.setup()
    renderApp()

    await screen.findByRole('listbox')
    const dialog = await openAdmin(user, 'Warteschlange')

    expect(await within(dialog).findByText('Offerte Relaunch')).toBeInTheDocument()
    expect(within(dialog).getByText('Resend 422: domain is not verified')).toBeInTheDocument()

    await user.click(within(dialog).getAllByRole('button', { name: 'Erneut versuchen' })[0]!)
    await waitFor(() => expect(harness.resend.sends).toHaveLength(1))
    await waitFor(() =>
      expect(within(dialog).queryByText('Offerte Relaunch')).not.toBeInTheDocument()
    )
  })

  it('drops a failed mail when it is discarded', async () => {
    const accountId = await seedResendInbox()
    const item = await harness.app.api['compose:send'](draft(accountId))
    harness.app.store.outbox.setState(item.id, 'failed', { lastError: 'Netzwerkfehler' })
    const user = userEvent.setup()
    renderApp()

    await screen.findByRole('listbox')
    const dialog = await openAdmin(user, 'Warteschlange')
    await within(dialog).findByText('Offerte Relaunch')

    await user.click(within(dialog).getAllByRole('button', { name: 'Verwerfen' })[0]!)
    await waitFor(() =>
      expect(within(dialog).queryByText('Offerte Relaunch')).not.toBeInTheDocument()
    )
    expect(harness.resend.sends).toHaveLength(0)
  })
})
