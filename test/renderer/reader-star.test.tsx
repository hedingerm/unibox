// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SYSTEM_LABELS } from '@shared/types'
import { App } from '@renderer/App'
import { UniboxProvider } from '@renderer/state'
import { labelKey } from '@main/db/ids'
import { createTestApp } from '../helpers/app'
import { installBridge } from '../helpers/fake-bridge'

let harness: ReturnType<typeof createTestApp>
let bridge: ReturnType<typeof installBridge>
let accountId = ''

async function boot(): Promise<void> {
  harness = createTestApp()
  bridge = installBridge(harness.app)
  harness.onEmit((name, payload) => {
    act(() => {
      bridge.emit(name, payload as never)
    })
  })
  await harness.app.api['settings:set']({ onboardingComplete: true })
  const account = harness.app.store.accounts.upsert({
    kind: 'google',
    email: 'max@muster-it.ch',
    displayName: 'max@muster-it.ch'
  })
  accountId = account.id
  harness.app.store.labels.ensureSystemLabels(account.id)
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
    body: {
      html:
        '<div>Passt, danke!</div><div class="gmail_quote"><div class="gmail_attr">Am Mo. schrieb Max:</div>' +
        '<blockquote>Wann können Sie starten?</blockquote></div>',
      text: null
    }
  })
  render(
    <UniboxProvider>
      <App />
    </UniboxProvider>
  )
}

afterEach(() => {
  cleanup()
  bridge.uninstall()
  harness.dispose()
})

describe('starring', () => {
  it('stars from the list row, lists it under Markiert, and unstars from the header', async () => {
    await boot()
    const user = userEvent.setup()
    const list = await screen.findByRole('listbox')
    const row = await within(list).findByRole('option', { name: /Offerte Onlineshop/ })

    await user.click(within(row).getByRole('button', { name: 'Markieren' }))
    await waitFor(() =>
      expect(harness.app.store.messages.labelIdsOf(`${accountId}:g1`)).toContain(
        labelKey(accountId, SYSTEM_LABELS.starred)
      )
    )
    expect(
      within(row).getByRole('button', { name: 'Markierung entfernen' }).getAttribute('aria-pressed')
    ).toBe('true')

    await user.click(screen.getByRole('button', { name: 'Markiert' }))
    const starred = await screen.findByRole('listbox')
    const entry = await within(starred).findByRole('option', { name: /Offerte Onlineshop/ })
    await user.click(entry)
    await screen.findByRole('heading', { name: 'Offerte Onlineshop' })

    const header = document.querySelector('.reading__title') as HTMLElement
    await user.click(within(header).getByRole('button', { name: 'Markierung entfernen' }))
    await waitFor(() =>
      expect(harness.app.store.messages.labelIdsOf(`${accountId}:g1`)).not.toContain(
        labelKey(accountId, SYSTEM_LABELS.starred)
      )
    )
    await waitFor(() => expect(screen.getByText('Keine markierten Konversationen')).toBeTruthy())
  })
})

describe('reading a conversation', () => {
  it('folds the quoted history behind a pill and shows the inbox chip', async () => {
    await boot()
    const user = userEvent.setup()
    const list = await screen.findByRole('listbox')
    await user.click(await within(list).findByRole('option', { name: /Offerte Onlineshop/ }))
    await screen.findByRole('heading', { name: 'Offerte Onlineshop' })

    const body = document.querySelector('.message__body') as HTMLElement
    expect(body.textContent).toContain('Passt, danke!')
    expect(body.textContent).not.toContain('Wann können Sie starten?')
    expect(screen.getByRole('button', { name: '«Eingang» entfernen' })).toBeTruthy()

    await user.click(within(body).getByRole('button', { name: 'Zitierten Text anzeigen' }))
    expect(body.textContent).toContain('Wann können Sie starten?')
  })

  it('shows the original source from the message menu', async () => {
    await boot()
    const user = userEvent.setup()
    const list = await screen.findByRole('listbox')
    await user.click(await within(list).findByRole('option', { name: /Offerte Onlineshop/ }))
    await screen.findByRole('heading', { name: 'Offerte Onlineshop' })

    await user.click(screen.getByRole('button', { name: 'Aktionen zu dieser Nachricht' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Original anzeigen' }))
    const dialog = await screen.findByRole('dialog', { name: 'Original der Nachricht' })
    // No Gmail connection in the harness, so the copy is rebuilt from the store.
    await waitFor(() => expect(dialog.textContent).toContain('Subject: Offerte Onlineshop'))
    expect(dialog.textContent).toContain('rekonstruiert')
  })

  it('opens the recipient details from "an mich"', async () => {
    await boot()
    const user = userEvent.setup()
    const list = await screen.findByRole('listbox')
    await user.click(await within(list).findByRole('option', { name: /Offerte Onlineshop/ }))
    await screen.findByRole('heading', { name: 'Offerte Onlineshop' })

    const toggle = screen.getByRole('button', { name: /an mich/ })
    await user.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(document.querySelector('.message__details')?.textContent).toContain(
      'max@muster-it.ch'
    )
  })
})

describe('the floating composer', () => {
  it('folds to its title bar, keeps the draft, and grows to a large window', async () => {
    await boot()
    const user = userEvent.setup()
    await screen.findByRole('listbox')
    await user.keyboard('{Meta>}n{/Meta}')
    const dialog = await screen.findByRole('dialog', { name: 'Neue E-Mail' })
    expect(dialog.getAttribute('aria-modal')).toBe('false')

    await user.type(within(dialog).getByLabelText('Betreff:'), 'Offerte')
    await user.click(within(dialog).getByRole('button', { name: 'Minimieren' }))
    expect(dialog.querySelector('.compose__content')?.hasAttribute('hidden')).toBe(true)
    // The folded bar names the mail by its subject.
    expect(within(dialog).getByRole('button', { name: 'Offerte' })).toBeTruthy()

    await user.click(within(dialog).getByRole('button', { name: 'Aufklappen' }))
    expect(within(dialog).getByLabelText('Betreff:')).toHaveValue('Offerte')

    await user.click(within(dialog).getByRole('button', { name: 'Vergrössern' }))
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(dialog.classList.contains('compose-float--max')).toBe(true)
  })

  it('opens the schedule options from the send button', async () => {
    await boot()
    const user = userEvent.setup()
    await screen.findByRole('listbox')
    await user.keyboard('{Meta>}n{/Meta}')
    const dialog = await screen.findByRole('dialog', { name: 'Neue E-Mail' })

    await user.click(within(dialog).getByRole('button', { name: 'Sendeoptionen' }))
    expect(within(dialog).getByRole('group', { name: 'Später senden' })).toBeTruthy()
    expect(within(dialog).getByLabelText('Sendezeitpunkt')).toBeTruthy()

    await user.click(within(dialog).getByRole('button', { name: 'Bcc' }))
    expect(within(dialog).getByLabelText('Blindkopie:')).toBeTruthy()
  })
})
