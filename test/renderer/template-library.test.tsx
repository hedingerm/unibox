// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { App } from '@renderer/App'
import { UniboxProvider } from '@renderer/state'
import { createTestApp } from '../helpers/app'
import { installBridge } from '../helpers/fake-bridge'
import { openAdmin } from '../helpers/admin'

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

async function seedAccount(): Promise<void> {
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
    email: account.email,
    isDefault: true,
    source: 'gmail_sendas'
  })
}

async function openIdentities(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
  render(
    <UniboxProvider>
      <App />
    </UniboxProvider>
  )
  await screen.findByRole('listbox')
  return openAdmin(user, 'Vorlagen')
}

afterEach(() => {
  cleanup()
  bridge?.uninstall()
  harness?.dispose()
})

describe('template library in the settings', () => {
  it('stores a template and lists the placeholders it holds', async () => {
    boot()
    await seedAccount()
    const user = userEvent.setup()
    const dialog = await openIdentities(user)

    await user.click(within(dialog).getByRole('button', { name: 'Vorlage hinzufügen' }))
    await user.clear(await within(dialog).findByLabelText('Name'))
    await user.type(within(dialog).getByLabelText('Name'), 'Offerte')
    await user.type(within(dialog).getByLabelText('Kürzel'), '/offerte')
    // Pasted rather than typed: userEvent reads `{{` as an escaped brace.
    await user.click(within(dialog).getByLabelText('Betreff (optional)'))
    await user.paste('Offerte {{Projekt}}')
    await user.click(within(dialog).getByLabelText('Text (HTML)'))
    await user.paste('<p>Hallo {{empfaenger.vorname}}</p>')
    await user.click(within(dialog).getByRole('button', { name: 'Speichern' }))

    await waitFor(async () =>
      expect(await harness.app.api['templates:list']()).toMatchObject([
        {
          name: 'Offerte',
          // The slash is how it is typed, not how it is stored.
          shortcut: 'offerte',
          variables: ['Projekt', 'empfaenger.vorname']
        }
      ])
    )
    expect(await within(dialog).findByText(/Platzhalter: Projekt, empfaenger.vorname/)).toBeTruthy()
  })

  it('says which shortcut is taken instead of failing silently', async () => {
    boot()
    await seedAccount()
    harness.app.store.templates.create({
      name: 'Offerte',
      shortcut: 'offerte',
      subject: '',
      html: '<p>x</p>'
    })
    const user = userEvent.setup()
    const dialog = await openIdentities(user)

    await user.click(within(dialog).getByRole('button', { name: 'Vorlage hinzufügen' }))
    await user.type(await within(dialog).findByLabelText('Kürzel'), 'Offerte')
    await user.click(within(dialog).getByRole('button', { name: 'Speichern' }))

    expect(await within(dialog).findByText(/Kürzel «Offerte» ist bereits vergeben/)).toBeTruthy()
  })
})
