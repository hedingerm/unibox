// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
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

/** One address, two signatures in the library — the long one is its default. */
async function seedAccount(): Promise<void> {
  await harness.app.api['settings:set']({ onboardingComplete: true })
  const account = harness.app.store.accounts.upsert({
    kind: 'google',
    email: 'max@muster-it.ch',
    displayName: 'max@muster-it.ch'
  })
  harness.app.store.labels.ensureSystemLabels(account.id)
  const long = harness.app.store.signatures.create({
    name: 'Lang',
    html: '<p>Max Muster, Muster IT</p>'
  })
  harness.app.store.signatures.create({ name: 'Kurz', html: '<p>Max</p>' })
  harness.app.store.identities.create({
    accountId: account.id,
    name: 'Max Muster',
    email: account.email,
    isDefault: true,
    signatureId: long.id
  })
}

async function openCompose(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
  render(
    <UniboxProvider>
      <App />
    </UniboxProvider>
  )
  await screen.findByRole('listbox')
  await user.keyboard('{Meta>}n{/Meta}')
  return screen.findByRole('dialog', { name: 'Neue E-Mail' })
}

afterEach(() => {
  cleanup()
  bridge?.uninstall()
  harness?.dispose()
})

describe('signature picker in the composer', () => {
  it('starts with the address default and swaps it for another', async () => {
    boot()
    await seedAccount()
    const user = userEvent.setup()
    const dialog = await openCompose(user)
    const surface = dialog.querySelector('.ProseMirror') as HTMLElement

    await waitFor(() => expect(surface.textContent).toContain('Muster IT'))
    await user.selectOptions(screen.getByLabelText('Signatur:'), 'Kurz')

    await waitFor(() => expect(surface.textContent).not.toContain('Muster IT'))
    expect(surface.textContent).toContain('Max')
  })

  it('takes the signature back out when none is picked', async () => {
    boot()
    await seedAccount()
    const user = userEvent.setup()
    const dialog = await openCompose(user)
    const surface = dialog.querySelector('.ProseMirror') as HTMLElement

    await waitFor(() => expect(surface.textContent).toContain('Muster IT'))
    await user.selectOptions(screen.getByLabelText('Signatur:'), 'Keine')

    await waitFor(() => expect(surface.textContent).not.toContain('Muster'))
  })
})
