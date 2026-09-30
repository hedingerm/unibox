// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SYSTEM_LABELS } from '@shared/types'
import { App } from '@renderer/App'
import { UniboxProvider } from '@renderer/state'
import { createTestApp } from '../helpers/app'
import { installBridge } from '../helpers/fake-bridge'

let harness: ReturnType<typeof createTestApp>
let bridge: ReturnType<typeof installBridge>

async function seed(html: string): Promise<void> {
  harness = createTestApp()
  bridge = installBridge(harness.app)
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
    email: 'max@muster-it.ch',
    isDefault: true,
    signatureHtml: null
  })
  harness.app.store.messages.upsert({
    id: `${account.id}:g1`,
    accountId: account.id,
    threadId: `${account.id}:t:g1`,
    remoteId: 'g1',
    subject: 'Newsletter',
    from: { name: 'Sandra Keller', email: 's.keller@keller-farben.ch' },
    to: [{ name: null, email: 'max@muster-it.ch' }],
    date: Date.parse('2026-08-18T10:12:00.000Z'),
    labelRemoteIds: [SYSTEM_LABELS.inbox],
    body: { html, text: null }
  })
}

/**
 * The link node as it stands right now. Opening a mail marks it read, which
 * comes back as a refresh and rebuilds the body html — a node kept from before
 * that is detached, and an event fired on it reaches nothing.
 */
function link(): HTMLElement {
  const found = document.querySelector('.message__body a') as HTMLElement | null
  if (!found) throw new Error('Der Link ist nicht da')
  return found
}

async function openMessage(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  render(
    <UniboxProvider>
      <App />
    </UniboxProvider>
  )
  const list = await screen.findByRole('listbox')
  await waitFor(() => expect(within(list).getAllByRole('option')).toHaveLength(1))
  await user.click(within(list).getAllByRole('option')[0]!)
  await waitFor(() => expect(link().isConnected).toBe(true))
}

afterEach(() => {
  cleanup()
  bridge.uninstall()
  harness.dispose()
})

describe('links in a message', () => {
  it('goes to the browser, and says where before it is followed', async () => {
    await seed('<p>Alles unter <a href="https://keller-farben.ch/shop">hier klicken</a>.</p>')
    const user = userEvent.setup()
    await openMessage(user)

    // The words and the address routinely disagree on purpose in mail.
    expect(link().textContent).toBe('hier klicken')
    fireEvent.mouseOver(link())
    expect(await screen.findByText('https://keller-farben.ch/shop')).toBeInTheDocument()

    fireEvent.contextMenu(link(), { clientX: 20, clientY: 20 })
    await user.click(await screen.findByRole('menuitem', { name: 'Link im Browser öffnen' }))
    await waitFor(() => expect(harness.openedUrls).toContain('https://keller-farben.ch/shop'))
  })

  it('copies the address instead of following it', async () => {
    await seed('<p><a href="https://keller-farben.ch/shop">hier klicken</a></p>')
    const user = userEvent.setup()
    await openMessage(user)

    fireEvent.contextMenu(link(), { clientX: 20, clientY: 20 })
    await user.click(await screen.findByRole('menuitem', { name: 'Link-Adresse kopieren' }))
    await waitFor(() => expect(harness.clipboard.text).toBe('https://keller-farben.ch/shop'))
    // Copying is not following.
    expect(harness.openedUrls).toHaveLength(0)
  })

  it('replaces an open draft window rather than leaving the old mail in it', async () => {
    await seed('<p>Fragen an <a href="mailto:info@keller-farben.ch?subject=Shop">uns</a>.</p>')
    const user = userEvent.setup()
    await openMessage(user)

    // A window composer is already open on something else.
    await user.keyboard('{Meta>}n{/Meta}')
    const first = await screen.findByRole('dialog', { name: 'Neue E-Mail' })
    await user.type(within(first).getByLabelText('Betreff:'), 'Etwas anderes')

    fireEvent.contextMenu(link(), { clientX: 20, clientY: 20 })
    await user.click(
      await screen.findByRole('menuitem', { name: 'Mail an info@keller-farben.ch schreiben' })
    )

    // The window is the same element; its contents have to be the new mail.
    await waitFor(() =>
      expect(
        within(screen.getByRole('dialog', { name: 'Neue E-Mail' })).getByLabelText('Betreff:')
      ).toHaveValue('Shop')
    )
    // And the one it replaced was written away, not thrown away.
    await waitFor(async () => {
      const drafts = await harness.app.api['drafts:list']()
      expect(drafts.map((entry) => entry.subject)).toContain('Etwas anderes')
    })
  })

  it('opens a composer for a mailto link rather than another mail client', async () => {
    await seed('<p>Fragen an <a href="mailto:info@keller-farben.ch?subject=Shop">uns</a>.</p>')
    const user = userEvent.setup()
    await openMessage(user)

    fireEvent.contextMenu(link(), { clientX: 20, clientY: 20 })
    await user.click(
      await screen.findByRole('menuitem', { name: 'Mail an info@keller-farben.ch schreiben' })
    )

    const dialog = await screen.findByRole('dialog', { name: 'Neue E-Mail' })
    expect(within(dialog).getByLabelText('Betreff:')).toHaveValue('Shop')
    // The address never went to the OS.
    expect(harness.openedUrls).toHaveLength(0)
  })
})
