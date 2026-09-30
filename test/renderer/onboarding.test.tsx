// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { App } from '@renderer/App'
import { UniboxProvider } from '@renderer/state'
import { createTestApp } from '../helpers/app'
import { installBridge } from '../helpers/fake-bridge'

let harness: ReturnType<typeof createTestApp>
let bridge: ReturnType<typeof installBridge>

beforeEach(() => {
  harness = createTestApp()
  bridge = installBridge(harness.app)
})

afterEach(() => {
  cleanup()
  bridge.uninstall()
  harness.dispose()
})

async function openDomainStep(): Promise<void> {
  const user = userEvent.setup()
  render(
    <UniboxProvider>
      <App />
    </UniboxProvider>
  )
  const dialog = await screen.findByRole('dialog', { name: 'Unibox einrichten' })
  await user.click(within(dialog).getByRole('button', { name: 'Weiter' }))
  await user.type(await screen.findByLabelText('Resend-API-Key'), 're_test')
  await user.click(screen.getByRole('button', { name: 'Key speichern' }))
  await screen.findByText('Empfang pro Domain aktivieren')
}

describe('onboarding wizard', () => {
  it('shows the required MX record for a domain that is not receiving yet', async () => {
    harness.resend.addDomain('nordwind.ch')
    harness.resend.mx.set('nordwind.ch', [])
    await openDomainStep()

    expect(await screen.findByText('nordwind.ch')).toBeInTheDocument()
    expect(screen.getByText('MX-Record ausstehend')).toBeInTheDocument()
    expect(
      screen.getByText(/nordwind\.ch\s+MX\s+10\s+inbound-smtp\.eu-west-1\.amazonaws\.com/)
    ).toBeInTheDocument()
  })

  it('warns before hijacking a domain that already has a foreign MX record', async () => {
    harness.resend.addDomain('muster-it.ch')
    harness.resend.mx.set('muster-it.ch', [
      { exchange: 'aspmx.l.google.com', priority: 1 }
    ])
    const user = userEvent.setup()
    await openDomainStep()

    await user.click(await screen.findByRole('switch', { name: 'muster-it.ch' }))

    const warning = await screen.findByText(/aspmx\.l\.google\.com/)
    expect(warning).toHaveTextContent('Mail-Zustellung dieser Domain zu Resend umgeleitet')
    expect(harness.resend.updates).toHaveLength(0)

    await user.click(screen.getByRole('button', { name: 'Trotzdem aktivieren' }))
    await waitFor(() => expect(harness.resend.updates).toHaveLength(1))
    expect(harness.resend.updates[0]).toEqual({
      id: 'dom_muster_it_ch',
      body: { capabilities: { receiving: 'enabled' } }
    })
    expect(harness.app.store.accounts.findByEmail('resend', 'muster-it.ch')).not.toBeNull()
  })

  it('activates a conflict-free domain straight away', async () => {
    harness.resend.addDomain('nordwind.ch')
    harness.resend.mx.set('nordwind.ch', [])
    const user = userEvent.setup()
    await openDomainStep()

    await user.click(await screen.findByRole('switch', { name: 'nordwind.ch' }))
    await waitFor(() => expect(harness.resend.updates).toHaveLength(1))
    expect(harness.app.store.accounts.findByEmail('resend', 'nordwind.ch')).not.toBeNull()
  })
})

describe('API key step', () => {
  it('shows what Resend said instead of swallowing the error', async () => {
    harness.resend.invalidKey = true
    const user = userEvent.setup()
    render(
      <UniboxProvider>
        <App />
      </UniboxProvider>
    )
    const dialog = await screen.findByRole('dialog', { name: 'Unibox einrichten' })
    await user.click(within(dialog).getByRole('button', { name: 'Weiter' }))
    await user.type(await screen.findByLabelText('Resend-API-Key'), 're_bogus')
    await user.click(screen.getByRole('button', { name: 'Key speichern' }))

    const message = await within(dialog).findByText(/Der Key wurde nicht akzeptiert/)
    expect(message).toHaveTextContent('Invalid API key')
    expect(within(dialog).getByText(/Sending access/)).toBeInTheDocument()
    // The step must not advance, and the key must not stay behind.
    expect(screen.getByRole('button', { name: 'Key speichern' })).toBeInTheDocument()
    expect(harness.secrets.get('resend:apiKey')).toBeNull()
  })
})
