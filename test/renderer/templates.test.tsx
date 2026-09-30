// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SYSTEM_LABELS } from '@shared/types'
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

/**
 * One account, one template, and a mail from Sandra Keller — so the archive
 * knows the name behind the address the draft is written to.
 */
async function seed(): Promise<void> {
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
  harness.app.store.messages.upsert({
    id: `${account.id}:g1`,
    accountId: account.id,
    threadId: `${account.id}:t:g1`,
    remoteId: 'g1',
    subject: 'Offerte',
    from: { name: 'Sandra Keller', email: 's.keller@keller-farben.ch' },
    to: [{ name: null, email: account.email }],
    date: Date.parse('2026-08-18T10:12:00.000Z'),
    labelRemoteIds: [SYSTEM_LABELS.inbox],
    body: { html: null, text: 'Wann können Sie starten?' }
  })
  harness.app.store.templates.create({
    name: 'Offerte',
    shortcut: 'offerte',
    subject: 'Offerte {{Projekt}}',
    html: '<p>Hallo {{empfaenger.vorname}}</p><p>Anbei die Offerte für {{Projekt}}.</p>'
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
  const dialog = await screen.findByRole('dialog', { name: 'Neue E-Mail' })
  // The picker only appears once the library has arrived over the bridge.
  await waitFor(() => expect(within(dialog).getByLabelText('Vorlage:')).toBeTruthy())
  return dialog
}

/** Focus rather than click: a click makes ProseMirror map screen coordinates. */
function body(dialog: HTMLElement): HTMLElement {
  const surface = dialog.querySelector('.ProseMirror') as HTMLElement
  surface.focus()
  return surface
}

async function addressTo(
  user: ReturnType<typeof userEvent.setup>,
  dialog: HTMLElement
): Promise<void> {
  await user.type(within(dialog).getByLabelText('An:'), 's.keller@keller-farben.ch')
}

afterEach(() => {
  cleanup()
  bridge.uninstall()
  harness.dispose()
})

describe('mail templates in compose', () => {
  it('inserts on `/kürzel`, fills what it knows and asks for the rest', async () => {
    boot()
    await seed()
    const user = userEvent.setup()
    const dialog = await openCompose(user)
    await addressTo(user, dialog)

    const surface = body(dialog)
    await user.keyboard('/offerte{Enter}')

    // The name is not in the field — it comes out of the archive, the same
    // place the assistant's dossier reads it from.
    const fill = await screen.findByRole('dialog', { name: 'Vorlage «Offerte» ausfüllen' })
    expect(within(fill).queryByLabelText('empfaenger.vorname')).toBeNull()
    await user.type(within(fill).getByLabelText('Projekt'), 'Onlineshop')
    await user.click(within(fill).getByRole('button', { name: 'Einfügen' }))

    await waitFor(() => expect(surface.textContent).toContain('Hallo Sandra'))
    expect(surface.textContent).toContain('Anbei die Offerte für Onlineshop.')
    // The command line was an instruction, not mail text.
    expect(surface.textContent).not.toContain('/offerte')
    // An empty subject is the template's to fill.
    expect((within(dialog).getByLabelText('Betreff:') as HTMLInputElement).value).toBe(
      'Offerte Onlineshop'
    )
  })

  it('leaves a subject that was already written alone', async () => {
    boot()
    await seed()
    const user = userEvent.setup()
    const dialog = await openCompose(user)
    await addressTo(user, dialog)
    await user.type(within(dialog).getByLabelText('Betreff:'), 'Re: Offerte')

    body(dialog)
    await user.keyboard('/offerte{Enter}')
    const fill = await screen.findByRole('dialog', { name: 'Vorlage «Offerte» ausfüllen' })
    await user.type(within(fill).getByLabelText('Projekt'), 'Onlineshop')
    await user.click(within(fill).getByRole('button', { name: 'Einfügen' }))

    await waitFor(() =>
      expect((within(dialog).getByLabelText('Betreff:') as HTMLInputElement).value).toBe(
        'Re: Offerte'
      )
    )
  })

  it('inserts nothing when the fill dialog is cancelled', async () => {
    boot()
    await seed()
    const user = userEvent.setup()
    const dialog = await openCompose(user)
    await addressTo(user, dialog)

    const surface = body(dialog)
    await user.keyboard('/offerte{Enter}')
    const fill = await screen.findByRole('dialog', { name: 'Vorlage «Offerte» ausfüllen' })
    await user.click(within(fill).getByRole('button', { name: 'Abbrechen' }))

    await waitFor(() => expect(screen.queryByRole('dialog', { name: /Vorlage/ })).toBeNull())
    expect(surface.textContent).not.toContain('Hallo Sandra')
  })

  it('refuses to send a mail that still holds a placeholder', async () => {
    boot()
    await seed()
    const user = userEvent.setup()
    const dialog = await openCompose(user)
    await addressTo(user, dialog)

    body(dialog)
    await user.keyboard('/offerte{Enter}')
    const fill = await screen.findByRole('dialog', { name: 'Vorlage «Offerte» ausfüllen' })
    // Submitted with the field left blank: the placeholder stays visible.
    await user.click(within(fill).getByRole('button', { name: 'Einfügen' }))

    await waitFor(() =>
      expect(dialog.querySelector('.ProseMirror')!.textContent).toContain('{{Projekt}}')
    )
    await user.click(within(dialog).getByRole('button', { name: 'Senden' }))

    expect(await within(dialog).findByText(/offene Platzhalter/)).toBeTruthy()
    expect(await harness.app.api['outbox:list']()).toHaveLength(0)
  })

  it('inserts the same template from the picker', async () => {
    boot()
    await seed()
    const user = userEvent.setup()
    const dialog = await openCompose(user)
    await addressTo(user, dialog)

    await user.selectOptions(within(dialog).getByLabelText('Vorlage:'), [
      within(dialog).getByRole('option', { name: /Offerte/ })
    ])
    const fill = await screen.findByRole('dialog', { name: 'Vorlage «Offerte» ausfüllen' })
    await user.type(within(fill).getByLabelText('Projekt'), 'Onlineshop')
    await user.click(within(fill).getByRole('button', { name: 'Einfügen' }))

    await waitFor(() =>
      expect(dialog.querySelector('.ProseMirror')!.textContent).toContain('Hallo Sandra')
    )
  })
})
