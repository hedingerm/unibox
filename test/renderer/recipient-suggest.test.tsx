// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { App } from '@renderer/App'
import { UniboxProvider } from '@renderer/state'
import { messageKey, threadKey } from '@main/db/ids'
import { SYSTEM_LABELS } from '@shared/types'
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

/** An account with one mail from a client, so there is someone to suggest. */
async function seedCorrespondence(): Promise<void> {
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
  harness.app.store.messages.upsert({
    id: messageKey(account.id, 'm1'),
    accountId: account.id,
    threadId: threadKey(account.id, 'm1'),
    remoteId: 'm1',
    messageIdHeader: '<m1@example.test>',
    inReplyTo: null,
    references: [],
    subject: 'Offerte',
    from: { name: 'Sandra Keller', email: 's.keller@keller-farben.ch' },
    to: [{ name: null, email: account.email }],
    cc: [],
    direction: 'incoming',
    attachments: [],
    date: Date.now(),
    labelRemoteIds: [SYSTEM_LABELS.inbox],
    body: { html: null, text: 'Hallo' }
  })
}

afterEach(() => {
  cleanup()
  bridge.uninstall()
  harness.dispose()
})

describe('recipient suggestions', () => {
  it('completes a known address from what is typed', async () => {
    boot()
    await seedCorrespondence()
    const user = userEvent.setup()
    render(
      <UniboxProvider>
        <App />
      </UniboxProvider>
    )
    await screen.findByRole('listbox')
    await user.keyboard('{Meta>}n{/Meta}')
    const dialog = await screen.findByRole('dialog', { name: 'Neue E-Mail' })

    const to = screen.getByLabelText('An:')
    await user.type(to, 'sandra')
    // List rows are options too; the suggestion is the one in the composer.
    const option = await within(dialog).findByRole('option', { name: /Sandra Keller/ })
    await user.click(option)

    // The picked address settles into a chip and the field is ready for the
    // next one.
    await waitFor(() =>
      expect(screen.getByTitle('Sandra Keller <s.keller@keller-farben.ch>')).toHaveTextContent(
        'Sandra Keller'
      )
    )
    expect(to).toHaveValue('')
  })

  it('offers nobody once the entry is complete', async () => {
    boot()
    await seedCorrespondence()
    const user = userEvent.setup()
    render(
      <UniboxProvider>
        <App />
      </UniboxProvider>
    )
    await screen.findByRole('listbox')
    await user.keyboard('{Meta>}n{/Meta}')
    const dialog = await screen.findByRole('dialog', { name: 'Neue E-Mail' })

    await user.type(screen.getByLabelText('An:'), 'Sandra Keller <s.keller@keller-farben.ch>')
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(within(dialog).queryByRole('option', { name: /Sandra Keller/ })).toBeNull()
  })

  it('picks a chip before it deletes it', async () => {
    boot()
    await seedCorrespondence()
    const user = userEvent.setup()
    render(
      <UniboxProvider>
        <App />
      </UniboxProvider>
    )
    await screen.findByRole('listbox')
    await user.keyboard('{Meta>}n{/Meta}')
    const dialog = await screen.findByRole('dialog', { name: 'Neue E-Mail' })
    const chips = (): HTMLElement[] => Array.from(dialog.querySelectorAll('.recipient-chip'))

    const to = screen.getByLabelText('An:')
    await user.type(to, 'a@b.ch, c@d.ch, ')
    expect(chips().map((chip) => chip.title)).toEqual(['a@b.ch', 'c@d.ch'])

    // The first Backspace only picks the last chip, the second removes it.
    await user.keyboard('{Backspace}')
    expect(document.activeElement).toBe(chips()[1])
    expect(chips()).toHaveLength(2)
    await user.keyboard('{Backspace}')
    expect(chips().map((chip) => chip.title)).toEqual(['a@b.ch'])

    // The × takes the rest and hands the field back to the input.
    await user.click(screen.getByRole('button', { name: 'Empfänger entfernen: a@b.ch' }))
    await waitFor(() => expect(chips()).toHaveLength(0))
    expect(document.activeElement).toBe(to)
  })
})
