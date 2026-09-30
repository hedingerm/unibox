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

async function openIdentities(
  user: ReturnType<typeof userEvent.setup>
): Promise<HTMLElement> {
  render(
    <UniboxProvider>
      <App />
    </UniboxProvider>
  )
  await screen.findByRole('listbox')
  return openAdmin(user, 'Identitäten & Signaturen')
}

afterEach(() => {
  cleanup()
  bridge?.uninstall()
  harness?.dispose()
})

describe('signature library in the settings', () => {
  it('writes a signature once and hands it to an address', async () => {
    boot()
    await seedAccount()
    const user = userEvent.setup()
    const dialog = await openIdentities(user)

    await user.click(within(dialog).getByRole('button', { name: 'Signatur hinzufügen' }))
    await user.clear(await within(dialog).findByLabelText('Name'))
    await user.type(within(dialog).getByLabelText('Name'), 'Lang')
    await user.type(within(dialog).getByLabelText('Text (HTML)'), '<p>Muster IT</p>')
    await user.click(within(dialog).getByRole('button', { name: 'Speichern' }))

    await waitFor(async () =>
      expect(await harness.app.api['signatures:list']()).toMatchObject([{ name: 'Lang' }])
    )

    // The address is pointed at the entry, not given a copy of the text.
    await user.click(within(dialog).getAllByRole('button', { name: 'Signatur' })[0]!)
    await user.selectOptions(await within(dialog).findByLabelText('Signatur'), 'Lang')
    await user.click(within(dialog).getByRole('button', { name: 'Speichern' }))

    await waitFor(async () => {
      const [identity] = await harness.app.api['identities:list']()
      expect(identity!.signatureHtml).toBe('<p>Muster IT</p>')
      expect(identity!.signatureId).toBe((await harness.app.api['signatures:list']())[0]!.id)
    })
  })
})
