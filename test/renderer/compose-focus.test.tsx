// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { App } from '@renderer/App'
import { UniboxProvider } from '@renderer/state'
import { createTestApp } from '../helpers/app'
import { installBridge } from '../helpers/fake-bridge'

let harness: ReturnType<typeof createTestApp>
let bridge: ReturnType<typeof installBridge>

async function openCompose(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
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
  harness.app.store.labels.ensureSystemLabels(account.id)
  harness.app.store.identities.create({
    accountId: account.id,
    name: 'Max Muster',
    email: account.email,
    isDefault: true
  })
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
  harness?.dispose()
})

describe('the compose window and the keyboard', () => {
  it('starts in the address field and keeps Tab inside the window', async () => {
    const user = userEvent.setup()
    const dialog = await openCompose(user)

    expect(document.activeElement).toBe(dialog.querySelector('#compose-to'))

    // Backwards out of the first field used to leave the window and land in the
    // message list behind it.
    await user.tab({ shift: true })
    expect(dialog.contains(document.activeElement)).toBe(true)

    for (let step = 0; step < 40; step += 1) {
      await user.tab()
      expect(dialog.contains(document.activeElement)).toBe(true)
    }
  })
})
