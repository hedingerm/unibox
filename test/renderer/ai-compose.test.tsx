// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SYSTEM_LABELS } from '@shared/types'
import { App } from '@renderer/App'
import { UniboxProvider } from '@renderer/state'
import type { ClaudeRunner } from '@main/claude'
import { createTestApp } from '../helpers/app'
import { installBridge } from '../helpers/fake-bridge'

let harness: ReturnType<typeof createTestApp>
let bridge: ReturnType<typeof installBridge>

function boot(runClaude: ClaudeRunner): void {
  harness = createTestApp({ runClaude })
  bridge = installBridge(harness.app)
  // In production the preload forwards main events; here the harness has to.
  harness.onEmit((name, payload) => {
    act(() => {
      bridge.emit(name, payload as never)
    })
  })
}

async function seedAccount(signature: string | null = null): Promise<void> {
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
    signatureHtml: signature
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
    body: { html: null, text: 'Wann können Sie starten?' }
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

/** Focus rather than click: a click makes ProseMirror map screen coordinates. */
function body(dialog: HTMLElement): HTMLElement {
  const surface = dialog.querySelector('.ProseMirror') as HTMLElement
  surface.focus()
  return surface
}

afterEach(() => {
  cleanup()
  bridge.uninstall()
  harness.dispose()
})

describe('writing assistant in compose', () => {
  it('writes into an empty mail without asking, and drops the command line', async () => {
    boot(async () => 'Hoi Sandra\n\nGerne, nächste Woche passt.\n\nGruass\nMax')
    await seedAccount()
    const user = userEvent.setup()
    const dialog = await openCompose(user)

    const surface = body(dialog)
    await user.keyboard('@ai Sag zu{Enter}')

    await waitFor(() => expect(surface.textContent).toContain('Gerne, nächste Woche passt.'))
    // The command is an instruction, not mail text.
    expect(surface.textContent).not.toContain('@ai')
    // Nothing to review: there was no draft to compare against.
    expect(screen.queryByText(/Änderungen/)).toBeNull()
  })

  it('counts a mail that holds only the signature as empty', async () => {
    boot(async () => 'Hoi Sandra\n\nGerne.')
    await seedAccount('<p>Freundliche Grüsse<br>Max Muster</p>')
    const user = userEvent.setup()
    const dialog = await openCompose(user)

    const surface = body(dialog)
    await waitFor(() => expect(surface.textContent).toContain('Max Muster'))
    await user.keyboard('@ai Sag zu{Enter}')

    await waitFor(() => expect(surface.textContent).toContain('Gerne.'))
    // The signature is not a draft to compare against.
    expect(screen.queryByText(/Änderungen/)).toBeNull()
    // And it is still there exactly once, below the new text.
    expect(surface.textContent!.match(/Max Muster/g)).toHaveLength(1)
    expect(surface.textContent!.indexOf('Gerne.')).toBeLessThan(
      surface.textContent!.indexOf('Freundliche Grüsse')
    )
  })

  it('shows a rework as changes and only applies it on confirmation', async () => {
    boot(async () => 'Ich melde mich nächste Woche.')
    await seedAccount()
    const user = userEvent.setup()
    const dialog = await openCompose(user)

    const surface = body(dialog)
    await user.keyboard('Ich melde mich nächsti Woche.{Enter}@ai mach es korrekt{Enter}')

    expect(await screen.findByText('1 Änderungen')).toBeInTheDocument()
    // The draft is untouched while the proposal is on screen.
    expect(surface.textContent).toContain('nächsti Woche.')

    await user.click(screen.getByRole('button', { name: '1 übernehmen' }))
    await waitFor(() => expect(surface.textContent).toContain('nächste Woche.'))
  })

  it('leaves the draft alone when the proposal is discarded', async () => {
    boot(async () => 'Ein Text, den niemand wollte.')
    await seedAccount()
    const user = userEvent.setup()
    const dialog = await openCompose(user)

    const surface = body(dialog)
    await user.keyboard('Mein eigener Text.{Enter}@ai mach was{Enter}')
    await screen.findByText(/Änderungen/)

    await user.click(screen.getByRole('button', { name: 'Vorschlag verwerfen' }))
    await waitFor(() => expect(screen.queryByText(/Änderungen/)).toBeNull())
    expect(surface.textContent).toContain('Mein eigener Text.')
    expect(surface.textContent).not.toContain('Ein Text, den niemand wollte.')
  })

  it('leaves an @ai line that carries no instruction as ordinary text', async () => {
    boot(async () => 'Sollte nie laufen')
    await seedAccount()
    const user = userEvent.setup()
    const dialog = await openCompose(user)

    const surface = body(dialog)
    await user.keyboard('@ai{Enter}Zweite Zeile')

    expect(surface.textContent).toContain('@ai')
    expect(surface.textContent).toContain('Zweite Zeile')
    expect(screen.queryByText('Claude schreibt…')).toBeNull()
  })

  it('reports a failed job in the window instead of swallowing it', async () => {
    boot(async () => {
      throw new Error('Claude Code fehlgeschlagen: kein Zugang')
    })
    await seedAccount()
    const user = userEvent.setup()
    const dialog = await openCompose(user)

    body(dialog)
    await user.keyboard('@ai Sag zu{Enter}')

    expect(await screen.findByText(/kein Zugang/)).toBeInTheDocument()
  })

  it('keeps the job running when the window closes and hands it back by toast', async () => {
    let release: (text: string) => void = () => undefined
    boot(
      () =>
        new Promise<string>((resolve) => {
          release = resolve
        })
    )
    await seedAccount()
    const user = userEvent.setup()
    const dialog = await openCompose(user)

    body(dialog)
    await user.keyboard('@ai Sag zu{Enter}')
    await screen.findByText('Claude schreibt…')

    await user.click(screen.getByRole('button', { name: 'Schliessen' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Neue E-Mail' })).toBeNull())

    release('Hoi Sandra\n\nGerne.')
    expect(await screen.findByText('Entwurf ist bereit.')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Öffnen' }))
    const reopened = await screen.findByRole('dialog', { name: 'Neue E-Mail' })
    // A fresh draft is already in the mail when the window comes back.
    await waitFor(() => expect(reopened.textContent).toContain('Gerne.'))
  })

  it('corrects the draft and lets single changes be rejected', async () => {
    boot(async () => 'Ich melde mich nächste Woche bei Ihnen.')
    await seedAccount()
    const user = userEvent.setup()
    const dialog = await openCompose(user)

    const surface = body(dialog)
    await user.keyboard('Ich melde mich nächsti Woche bei dir.')

    await user.click(screen.getByRole('button', { name: 'Text korrigieren' }))
    expect(await screen.findByText('2 Änderungen')).toBeInTheDocument()

    // Reject the second change: the salutation stays as the user wrote it.
    const changes = screen.getAllByRole('button', { pressed: true })
    await user.click(changes[changes.length - 1]!)
    await user.click(screen.getByRole('button', { name: '1 übernehmen' }))

    await waitFor(() => expect(surface.textContent).toContain('nächste Woche bei dir.'))
  })
})
