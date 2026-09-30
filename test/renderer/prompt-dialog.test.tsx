// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
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
    signatureId: null
  })
}

function mount(): void {
  render(
    <UniboxProvider>
      <App />
    </UniboxProvider>
  )
}

async function openCompose(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
  mount()
  await screen.findByRole('listbox')
  await user.keyboard('{Meta>}n{/Meta}')
  return screen.findByRole('dialog', { name: 'Neue E-Mail' })
}

// Electron's renderer does not implement `window.prompt`: it throws, and takes
// the rest of the click handler with it. Reproducing that here is the point of
// the file — any call site that reaches for it fails the test instead of
// failing silently in the packaged app.
beforeEach(() => {
  vi.stubGlobal('prompt', () => {
    throw new Error('prompt() is and will not be supported.')
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  cleanup()
  bridge?.uninstall()
  harness?.dispose()
})

describe('custom sender address', () => {
  it('takes the address from the dialog instead of window.prompt', async () => {
    boot()
    await seedAccount()
    const user = userEvent.setup()
    await openCompose(user)

    await user.click(screen.getByRole('button', { name: /Max Muster/ }))
    await user.click(screen.getByRole('button', { name: 'Benutzerdefinierte Adresse…' }))

    const prompt = await screen.findByRole('dialog', { name: 'Absenderadresse' })
    await user.clear(within(prompt).getByRole('textbox'))
    await user.type(within(prompt).getByRole('textbox'), 'kontakt@muster-it.ch')
    await user.click(within(prompt).getByRole('button', { name: 'OK' }))

    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /kontakt@muster-it\.ch/ })
      ).toBeInTheDocument()
    )
  })

  it('leaves the sender alone when the dialog is cancelled', async () => {
    boot()
    await seedAccount()
    const user = userEvent.setup()
    const compose = await openCompose(user)

    await user.click(screen.getByRole('button', { name: /Max Muster/ }))
    await user.click(screen.getByRole('button', { name: 'Benutzerdefinierte Adresse…' }))
    await screen.findByRole('dialog', { name: 'Absenderadresse' })
    await user.keyboard('{Escape}')

    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Absenderadresse' })).toBeNull()
    )
    // The compose window itself survives the Escape that closed the prompt.
    expect(screen.getByRole('dialog', { name: 'Neue E-Mail' })).toBeInTheDocument()
    expect(
      within(compose).getByRole('button', { name: /max@muster-it\.ch/ })
    ).toBeInTheDocument()
  })
})

describe('saving a search', () => {
  it('names the search through the dialog', async () => {
    boot()
    await seedAccount()
    const user = userEvent.setup()
    mount()
    await screen.findByRole('listbox')

    await user.type(screen.getByRole('combobox'), 'from:kunde')
    await user.click(screen.getByRole('button', { name: 'Suche merken' }))

    const prompt = await screen.findByRole('dialog', { name: 'Name für die gespeicherte Suche' })
    await user.clear(within(prompt).getByRole('textbox'))
    await user.type(within(prompt).getByRole('textbox'), 'Kunden')
    await user.click(within(prompt).getByRole('button', { name: 'Suche merken' }))

    await waitFor(async () => {
      const settings = await harness.app.api['settings:get']()
      expect(settings.savedSearches).toContainEqual({ name: 'Kunden', query: 'from:kunde' })
    })
  })
})
