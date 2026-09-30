// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { App } from '@renderer/App'
import { UniboxProvider } from '@renderer/state'
import { createTestApp } from '../helpers/app'
import { installBridge } from '../helpers/fake-bridge'
import { openAdmin } from '../helpers/admin'

let harness: ReturnType<typeof createTestApp>
let bridge: ReturnType<typeof installBridge>

async function openGeneralSettings(page = 'Allgemein'): Promise<HTMLElement> {
  const user = userEvent.setup()
  await screen.findByRole('listbox')
  return openAdmin(user, page)
}

function renderApp(): void {
  render(
    <UniboxProvider>
      <App />
    </UniboxProvider>
  )
}

beforeEach(async () => {
  harness = createTestApp()
  bridge = installBridge(harness.app)
  await harness.app.api['settings:set']({ onboardingComplete: true })
})

afterEach(() => {
  cleanup()
  bridge.uninstall()
  harness.dispose()
})

describe('attachment cache in the settings', () => {
  it('shows its size and offers to clear it', async () => {
    renderApp()
    const dialog = await openGeneralSettings()

    expect(await within(dialog).findByText(/0 B in 0 Dateien/)).toBeInTheDocument()
    // Nothing to reclaim means nothing to press.
    expect(within(dialog).getByRole('button', { name: 'Cache leeren' })).toBeDisabled()
    expect(within(dialog).getByText(/Mails und die Resend-Anhänge bleiben/)).toBeInTheDocument()
  })

  it('reports what the main process could not measure instead of pretending', async () => {
    bridge.failures.set('attachments:cacheInfo', 'EACCES')
    renderApp()
    const dialog = await openGeneralSettings()

    expect(await within(dialog).findByText('Grösse wird ermittelt…')).toBeInTheDocument()
  })
})

describe('database backup from the settings', () => {
  it('names the file it wrote', async () => {
    harness.saveTarget.path = '/tmp/unibox-copy.db'
    const user = userEvent.setup()
    renderApp()
    const dialog = await openGeneralSettings('Backups')

    await user.click(within(dialog).getByRole('button', { name: 'Sicherung erstellen' }))
    expect(
      await within(dialog).findByText('Gesichert nach /tmp/unibox-copy.db')
    ).toBeInTheDocument()
  })

  it('shows the real cause when the copy cannot be written', async () => {
    bridge.failures.set('db:backup', 'ENOSPC: no space left on device')
    const user = userEvent.setup()
    renderApp()
    const dialog = await openGeneralSettings('Backups')

    await user.click(within(dialog).getByRole('button', { name: 'Sicherung erstellen' }))
    await waitFor(() =>
      expect(within(dialog).getByText('ENOSPC: no space left on device')).toBeInTheDocument()
    )
  })
})
