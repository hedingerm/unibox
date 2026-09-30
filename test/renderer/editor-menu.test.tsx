// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SYSTEM_LABELS } from '@shared/types'
import type { AiRequest } from '@shared/types'
import { App } from '@renderer/App'
import { UniboxProvider } from '@renderer/state'
import type { ClaudeRunner } from '@main/claude'
import { createTestApp } from '../helpers/app'
import { installBridge } from '../helpers/fake-bridge'

let harness: ReturnType<typeof createTestApp>
let bridge: ReturnType<typeof installBridge>

function boot(runClaude?: ClaudeRunner): void {
  harness = createTestApp(runClaude ? { runClaude } : {})
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
  harness.app.store.labels.replaceAll(account.id, [
    { remoteId: SYSTEM_LABELS.inbox, name: 'INBOX', type: 'system' },
    { remoteId: SYSTEM_LABELS.sent, name: 'SENT', type: 'system' },
    { remoteId: SYSTEM_LABELS.unread, name: 'UNREAD', type: 'system' },
    { remoteId: SYSTEM_LABELS.trash, name: 'TRASH', type: 'system' },
    { remoteId: SYSTEM_LABELS.spam, name: 'SPAM', type: 'system' }
  ])
  harness.app.store.identities.create({
    accountId: account.id,
    name: 'Max Muster',
    email: account.email,
    isDefault: true,
    signatureHtml: null
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

function body(dialog: HTMLElement): HTMLElement {
  const surface = dialog.querySelector('.ProseMirror') as HTMLElement
  surface.focus()
  return surface
}

/** jsdom has no layout, so the menu is opened on the surface itself. */
function rightClick(surface: HTMLElement): void {
  fireEvent.contextMenu(surface, { clientX: 40, clientY: 60 })
}

afterEach(() => {
  cleanup()
  bridge.uninstall()
  harness.dispose()
})

describe('the composer’s context menu', () => {
  it('offers formatting, clipboard and a link on the place it was opened at', async () => {
    boot()
    await seedAccount()
    const user = userEvent.setup()
    const dialog = await openCompose(user)
    const surface = body(dialog)
    await user.keyboard('Passt nicht.')

    rightClick(surface)

    const menu = await screen.findByRole('menu', { name: 'Text bearbeiten' })
    expect(menu).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'Einfügen' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'Link hinzufügen…' })).toBeInTheDocument()
    expect(screen.getByRole('menuitemcheckbox', { name: 'Fett' })).toBeInTheDocument()
  })

  it('applies formatting to the draft and closes', async () => {
    boot()
    await seedAccount()
    const user = userEvent.setup()
    const dialog = await openCompose(user)
    const surface = body(dialog)
    await user.keyboard('Passt.')

    rightClick(surface)
    await user.click(await screen.findByRole('menuitemcheckbox', { name: 'Fett' }))
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())

    // The state the next typed word lands in is what the menu changed; the
    // menu is where it can be read back.
    rightClick(surface)
    await waitFor(() =>
      expect(screen.getByRole('menuitemcheckbox', { name: 'Fett' })).toHaveAttribute(
        'aria-checked',
        'true'
      )
    )
  })

  it('pastes the system clipboard as plain text', async () => {
    boot()
    await seedAccount()
    harness.clipboard.text = 'Aus der Zwischenablage.'
    const user = userEvent.setup()
    const dialog = await openCompose(user)
    const surface = body(dialog)

    rightClick(surface)
    await user.click(await screen.findByRole('menuitem', { name: 'Einfügen' }))

    await waitFor(() => expect(surface.textContent).toContain('Aus der Zwischenablage.'))
  })

  it('asks Claude for the gap the caret sits in and writes only there', async () => {
    const requests: AiRequest['context'][] = []
    boot(async ({ prompt }) => {
      expect(prompt).toContain('<stelle></stelle>')
      return 'nächste Woche'
    })
    await seedAccount()
    const user = userEvent.setup()
    const dialog = await openCompose(user)
    const surface = body(dialog)
    await user.keyboard('Ich melde mich ')

    rightClick(surface)
    const field = await screen.findByPlaceholderText('Was soll hier stehen? Enter startet.')
    await user.type(field, 'sag nächste Woche{Enter}')

    // Nothing was replaced, so there is nothing to review — it lands directly.
    await waitFor(() => expect(surface.textContent).toContain('Ich melde mich nächste Woche'))
    expect(screen.queryByText(/Änderungen/)).toBeNull()
    expect(requests).toHaveLength(0)
  })

  it('keeps the assistant out of the menu while one of its jobs is running', async () => {
    let release: (() => void) | null = null
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    boot(async () => {
      await held
      return 'nächste Woche'
    })
    await seedAccount()
    const user = userEvent.setup()
    const dialog = await openCompose(user)
    const surface = body(dialog)
    await user.keyboard('Ich melde mich ')

    rightClick(surface)
    await user.type(
      await screen.findByPlaceholderText('Was soll hier stehen? Enter startet.'),
      'sag nächste Woche{Enter}'
    )
    await screen.findByRole('status')

    // A second job would race the first into the same range.
    rightClick(surface)
    await screen.findByRole('menu', { name: 'Text bearbeiten' })
    expect(screen.queryByPlaceholderText('Was soll hier stehen? Enter startet.')).toBeNull()

    act(() => release?.())
    await waitFor(() => expect(surface.textContent).toContain('Ich melde mich nächste Woche'))
  })
})
