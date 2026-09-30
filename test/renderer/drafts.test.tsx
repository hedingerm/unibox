// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { App } from '@renderer/App'
import { UniboxProvider } from '@renderer/state'
import { createTestApp } from '../helpers/app'
import { installBridge } from '../helpers/fake-bridge'

/** Comfortably past the compose window's autosave pause. */
const AUTOSAVE_WAIT_MS = 2_000

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

async function seedAccount(signatureHtml: string | null = null): Promise<void> {
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
    signatureHtml
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

/** Writes a half-finished mail and closes the window on it. */
async function writeAndClose(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  const dialog = await openCompose(user)
  await user.type(screen.getByLabelText('An:'), 's.keller@keller-farben.ch')
  await user.type(screen.getByLabelText('Betreff:'), 'Offerte Onlineshop')
  body(dialog)
  await user.keyboard('Hoi Sandra, ich melde mich morgen.')
  await user.click(screen.getByRole('button', { name: 'Schliessen' }))
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Neue E-Mail' })).toBeNull())
}

afterEach(() => {
  cleanup()
  bridge.uninstall()
  harness.dispose()
})

describe('drafts', () => {
  it('keeps a half-written mail when the window is closed and opens it again', async () => {
    boot()
    await seedAccount()
    const user = userEvent.setup()
    await writeAndClose(user)

    await user.click(await screen.findByRole('button', { name: /Entwürfe/ }))
    const list = await screen.findByRole('listbox')
    const row = await within(list).findByText('Offerte Onlineshop')
    await user.click(row)

    const reopened = await screen.findByRole('dialog', { name: 'Neue E-Mail' })
    expect(reopened.querySelector('.recipient-chip')).toHaveTextContent(
      's.keller@keller-farben.ch'
    )
    expect(screen.getByLabelText('Betreff:')).toHaveValue('Offerte Onlineshop')
    expect(reopened.querySelector('.ProseMirror')?.textContent).toContain(
      'ich melde mich morgen.'
    )
  })

  it('counts the drafts in the sidebar and drops one when it is thrown away', async () => {
    boot()
    await seedAccount()
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const user = userEvent.setup()
    await writeAndClose(user)

    const folder = await screen.findByRole('button', { name: /Entwürfe/ })
    await waitFor(() => expect(folder.textContent).toContain('1'))

    await user.click(folder)
    await user.click(await screen.findByText('Offerte Onlineshop'))
    await screen.findByRole('dialog', { name: 'Neue E-Mail' })
    await user.click(screen.getByRole('button', { name: 'Entwurf verwerfen' }))

    expect(confirm).toHaveBeenCalled()
    await waitFor(() => expect(screen.queryByText('Offerte Onlineshop')).toBeNull())
    confirm.mockRestore()
  })

  it('leaves no draft behind when nothing was typed', async () => {
    boot()
    await seedAccount()
    const user = userEvent.setup()
    await openCompose(user)
    await user.click(screen.getByRole('button', { name: 'Schliessen' }))

    await waitFor(async () =>
      expect(await harness.app.api['drafts:list']()).toHaveLength(0)
    )
  })

  // The signature is written into the window before a single key is pressed,
  // and the editor reports its own markup back the moment the caret lands in
  // the draft — neither is the user writing a mail.
  it('leaves no draft behind when the window holds nothing but the signature', async () => {
    boot()
    await seedAccount('<p>Max Muster</p>')
    const user = userEvent.setup()
    const dialog = await openCompose(user)
    body(dialog)
    await new Promise((resolve) => setTimeout(resolve, AUTOSAVE_WAIT_MS))
    await user.click(screen.getByRole('button', { name: 'Schliessen' }))

    await waitFor(async () => expect(await harness.app.api['drafts:list']()).toHaveLength(0))
  })

  // The first save is what mints the draft id. While it was still travelling,
  // the next autosave used to start with no id at all — and stored, then
  // mirrored to Gmail, a second draft of the same mail.
  it('stores one draft when a second autosave starts before the first returns', async () => {
    boot()
    await seedAccount()
    let release = (): void => undefined
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    let calls = 0
    const unibox = window.unibox!
    const invoke = unibox.invoke
    unibox.invoke = ((channel: string, ...args: unknown[]) => {
      const call = (): unknown => (invoke as (...rest: unknown[]) => unknown)(channel, ...args)
      if (channel !== 'drafts:save') return call()
      calls += 1
      // Only the first save is held up, the way a slow connection would.
      return calls === 1 ? held.then(call) : call()
    }) as typeof unibox.invoke

    const user = userEvent.setup()
    await openCompose(user)
    await user.type(screen.getByLabelText('An:'), 's.keller@keller-farben.ch')
    await new Promise((resolve) => setTimeout(resolve, AUTOSAVE_WAIT_MS))
    // The first save is now in flight; typing on schedules the next one.
    await user.type(screen.getByLabelText('Betreff:'), 'Offerte')
    await new Promise((resolve) => setTimeout(resolve, AUTOSAVE_WAIT_MS))
    release()

    await waitFor(async () => {
      const drafts = await harness.app.api['drafts:list']()
      expect({ calls, drafts: drafts.length }).toEqual({ calls: 2, drafts: 1 })
      expect(drafts[0]?.subject).toBe('Offerte')
    })
  }, 20_000)

  it('gives a Resend domain the same Entwürfe folder', async () => {
    boot()
    await harness.app.api['settings:set']({ onboardingComplete: true })
    const domain = harness.app.store.accounts.upsert({
      kind: 'resend',
      email: 'beispielweb.ch',
      displayName: 'beispielweb.ch'
    })
    harness.app.store.labels.ensureSystemLabels(domain.id)
    render(
      <UniboxProvider>
        <App />
      </UniboxProvider>
    )

    // Resend has no server-side drafts, but local ones make the folder real.
    expect(await screen.findByRole('button', { name: /Entwürfe/ })).toBeInTheDocument()
  })
})
