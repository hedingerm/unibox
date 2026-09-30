// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { App } from '@renderer/App'
import { UniboxProvider } from '@renderer/state'
import { MAX_ATTACHMENT_BYTES } from '@shared/attachments'
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

/** The floating composer panel — the element that takes drops. */
function composer(dialog: HTMLElement): HTMLElement {
  return dialog.querySelector('.compose--float') as HTMLElement
}

/**
 * What a Finder drag looks like to the page — jsdom builds no DataTransfer of
 * its own. The files come with the path as text, which is the payload tiptap
 * would paste into the body if it did not decline file drops.
 */
function drag(files: File[]): { dataTransfer: unknown } {
  const paths = files.map((file) => `/Users/max/${file.name}`)
  const data: Record<string, string> = {
    'text/uri-list': paths.map((path) => `file://${path}`).join('\n'),
    'text/plain': paths.join('\n')
  }
  return {
    dataTransfer: {
      types: ['Files', 'text/uri-list', 'text/plain'],
      files,
      dropEffect: 'none',
      getData: (type: string) => data[type] ?? ''
    }
  }
}

function fileOf(name: string, bytes: number, type = ''): File {
  return new File([new Uint8Array(bytes)], name, { type })
}

afterEach(() => {
  cleanup()
  bridge.uninstall()
  harness.dispose()
})

describe('dropping files into the composer', () => {
  it('attaches a file dragged onto the window', async () => {
    boot()
    await seedAccount()
    const user = userEvent.setup()
    const dialog = await openCompose(user)

    fireEvent.drop(composer(dialog), drag([fileOf('offerte.pdf', 12, 'application/pdf')]))

    const chip = await screen.findByRole('button', { name: /offerte\.pdf/ })
    expect(chip).toBeTruthy()
  })

  it('shows the hint while a file hovers and takes it back afterwards', async () => {
    boot()
    await seedAccount()
    const user = userEvent.setup()
    const dialog = await openCompose(user)
    const window_ = composer(dialog)

    fireEvent.dragEnter(window_, drag([fileOf('bild.png', 4, 'image/png')]))
    expect(await screen.findByText('Dateien hier ablegen, um sie anzuhängen')).toBeTruthy()

    fireEvent.dragLeave(window_, drag([fileOf('bild.png', 4, 'image/png')]))
    await waitFor(() =>
      expect(screen.queryByText('Dateien hier ablegen, um sie anzuhängen')).toBeNull()
    )
  })

  it('refuses a file over the size limit and says which one', async () => {
    boot()
    await seedAccount()
    const user = userEvent.setup()
    const dialog = await openCompose(user)

    const huge = fileOf('video.mov', 8)
    // The bytes are never read for an oversized file, so the size is faked
    // rather than allocated.
    Object.defineProperty(huge, 'size', { value: MAX_ATTACHMENT_BYTES + 1 })
    fireEvent.drop(composer(dialog), drag([huge]))

    expect(
      await screen.findByText(/«video\.mov» ist grösser als 25 MB/)
    ).toBeTruthy()
    expect(screen.queryByRole('button', { name: /video\.mov/ })).toBeNull()
  })

  it('attaches a file dropped into the body exactly once', async () => {
    boot()
    await seedAccount()
    const user = userEvent.setup()
    const dialog = await openCompose(user)
    const surface = dialog.querySelector('.ProseMirror') as HTMLElement

    // ProseMirror works out the drop position before it asks its own
    // `handleDrop`, and jsdom has no hit testing — so the page gets just enough
    // of it for the real handler chain to run.
    Object.defineProperty(document, 'elementFromPoint', { value: () => surface, configurable: true })

    // tiptap declines the drop and the composer picks it up on the way out;
    // if both acted on it, the file would land twice.
    fireEvent.drop(surface, drag([fileOf('vertrag.pdf', 6, 'application/pdf')]))

    await screen.findByRole('button', { name: /vertrag\.pdf/ })
    await waitFor(() =>
      expect(screen.getAllByRole('button', { name: /vertrag\.pdf/ })).toHaveLength(1)
    )
    expect(surface.textContent).not.toContain('vertrag.pdf')
  })

  it('ignores a drag that carries no files, so the editor keeps its own', async () => {
    boot()
    await seedAccount()
    const user = userEvent.setup()
    const dialog = await openCompose(user)

    fireEvent.dragEnter(composer(dialog), {
      dataTransfer: { types: ['text/plain'], files: [] }
    })
    expect(screen.queryByText('Dateien hier ablegen, um sie anzuhängen')).toBeNull()
  })
})
