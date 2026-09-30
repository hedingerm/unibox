// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
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
  harness = createTestApp({ googleOAuth: true, runClaude })
  bridge = installBridge(harness.app)
}

async function seedInbox(): Promise<void> {
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
    { remoteId: SYSTEM_LABELS.spam, name: 'SPAM', type: 'system' },
    { remoteId: 'Label_7', name: 'Kunden', type: 'user' },
    { remoteId: 'Label_8', name: 'Newsletter', type: 'user' }
  ])
  const mails = [
    { remoteId: 'g1', subject: 'Offerte Onlineshop', from: 'Marco Bianchi' },
    { remoteId: 'g2', subject: 'Newsletter August', from: 'Versand' }
  ]
  for (const [index, mail] of mails.entries()) {
    harness.app.store.messages.upsert({
      id: `${account.id}:${mail.remoteId}`,
      accountId: account.id,
      threadId: `${account.id}:t:${mail.remoteId}`,
      remoteId: mail.remoteId,
      subject: mail.subject,
      from: { name: mail.from, email: `${mail.remoteId}@example.com` },
      to: [{ name: null, email: 'max@muster-it.ch' }],
      date: Date.parse('2026-08-18T10:12:00.000Z') - index * 60_000,
      labelRemoteIds: [SYSTEM_LABELS.inbox, SYSTEM_LABELS.unread],
      body: { html: null, text: `Inhalt ${mail.subject}` }
    })
  }
}

/** Answers with the same verdict for every mail the prompt carries. */
function answer(decision: Record<string, unknown>): ClaudeRunner {
  return async ({ prompt }) => {
    const refs = [...prompt.matchAll(/<mail ref="([^"]+)"/g)].map((match) => match[1])
    return JSON.stringify({ decisions: refs.map((ref) => ({ ref, ...decision })) })
  }
}

/** The settle toast, found by its text — other regions also announce as status. */
async function findToast(text: RegExp): Promise<HTMLElement> {
  const node = await screen.findByText(text)
  const toast = node.closest('.toast')
  if (!(toast instanceof HTMLElement)) throw new Error('Kein Toast gefunden')
  return toast
}

async function openSheet(): Promise<void> {
  const user = userEvent.setup()
  render(
    <UniboxProvider>
      <App />
    </UniboxProvider>
  )
  await screen.findByRole('listbox')
  await user.click(await screen.findByLabelText('Eingang aufräumen'))
}

afterEach(() => {
  cleanup()
  bridge.uninstall()
  harness.dispose()
})

describe('Settle review sheet', () => {
  beforeEach(() => {
    boot(
      answer({
        action: 'label',
        label: 'Kunden',
        new_label: false,
        confidence: 'high',
        reason: 'Anfrage einer Kundin'
      })
    )
  })

  it('proposes a label and only moves the mail once the user applies', async () => {
    await seedInbox()
    const user = userEvent.setup()
    await openSheet()

    const dialog = await screen.findByRole('dialog', { name: 'Eingang aufräumen' })
    await within(dialog).findByText('Offerte Onlineshop')
    expect(within(dialog).getAllByText('Anfrage einer Kundin')).not.toHaveLength(0)

    const account = harness.app.store.accounts.list()[0]!
    const inboxLabel = `${account.id}:l:${SYSTEM_LABELS.inbox}`
    // Reviewing alone must not have moved anything.
    expect(harness.app.store.messages.labelIdsOf(`${account.id}:g1`)).toContain(inboxLabel)

    await user.click(within(dialog).getByRole('button', { name: '2 übernehmen' }))

    await waitFor(() => {
      const labels = harness.app.store.messages.labelIdsOf(`${account.id}:g1`)
      expect(labels).toContain(`${account.id}:l:Label_7`)
      expect(labels).not.toContain(inboxLabel)
    })
  })

  it('leaves an unchecked row alone', async () => {
    await seedInbox()
    const user = userEvent.setup()
    await openSheet()

    const dialog = await screen.findByRole('dialog', { name: 'Eingang aufräumen' })
    await within(dialog).findByText('Offerte Onlineshop')
    const rows = within(dialog).getAllByRole('listitem')
    await user.click(within(rows[0]!).getByLabelText('Übernehmen'))

    await user.click(within(dialog).getByRole('button', { name: '1 übernehmen' }))

    const account = harness.app.store.accounts.list()[0]!
    const inboxLabel = `${account.id}:l:${SYSTEM_LABELS.inbox}`
    // The second row moved; the unchecked first one is untouched.
    await waitFor(() =>
      expect(harness.app.store.messages.labelIdsOf(`${account.id}:g2`)).not.toContain(inboxLabel)
    )
    expect(harness.app.store.messages.labelIdsOf(`${account.id}:g1`)).toContain(inboxLabel)
  })

  it('applies the label the user picked instead of the proposed one', async () => {
    await seedInbox()
    const user = userEvent.setup()
    await openSheet()

    const dialog = await screen.findByRole('dialog', { name: 'Eingang aufräumen' })
    await within(dialog).findByText('Offerte Onlineshop')
    const rows = within(dialog).getAllByRole('listitem')
    await user.selectOptions(within(rows[0]!).getByLabelText('Ziel ändern'), 'label:Newsletter')
    await user.click(within(dialog).getByRole('button', { name: '2 übernehmen' }))

    const account = harness.app.store.accounts.list()[0]!
    await waitFor(() =>
      expect(harness.app.store.messages.labelIdsOf(`${account.id}:g1`)).toContain(
        `${account.id}:l:Label_8`
      )
    )
    // The row that was left alone still gets the proposed label.
    expect(harness.app.store.messages.labelIdsOf(`${account.id}:g2`)).toContain(
      `${account.id}:l:Label_7`
    )
  })
})

describe('Settle scope', () => {
  beforeEach(() => {
    boot(
      answer({
        action: 'label',
        label: 'Kunden',
        new_label: false,
        confidence: 'high',
        reason: 'Kundenanfrage'
      })
    )
  })

  /** Opens the mailbox, focuses the first row and returns the click helper. */
  async function selectFirst(): Promise<ReturnType<typeof userEvent.setup>> {
    const user = userEvent.setup()
    render(
      <UniboxProvider>
        <App />
      </UniboxProvider>
    )
    const list = await screen.findByRole('listbox')
    await waitFor(() => expect(within(list).getAllByRole('option')).toHaveLength(2))
    await user.click(within(list).getAllByRole('option')[0]!)
    return user
  }

  it('settles a single conversation without asking and says where it went', async () => {
    await seedInbox()
    const user = await selectFirst()
    await user.click(screen.getByLabelText('Mail einsortieren (⌥ für die Prüfliste)'))

    const toast = await findToast(/Offerte Onlineshop.*Kunden/)
    expect(toast).toHaveTextContent('„Offerte Onlineshop" → Kunden')
    expect(toast).toHaveTextContent('Kundenanfrage')
    // No review step stood in the way.
    expect(screen.queryByRole('dialog', { name: 'Eingang aufräumen' })).toBeNull()

    const account = harness.app.store.accounts.list()[0]!
    await waitFor(() => {
      const labels = harness.app.store.messages.labelIdsOf(`${account.id}:g1`)
      expect(labels).toContain(`${account.id}:l:Label_7`)
      expect(labels).not.toContain(`${account.id}:l:${SYSTEM_LABELS.inbox}`)
    })
    // The other conversation was never in scope.
    expect(harness.app.store.messages.labelIdsOf(`${account.id}:g2`)).toContain(
      `${account.id}:l:${SYSTEM_LABELS.inbox}`
    )
  })

  it('puts the mail back when the toast is undone', async () => {
    await seedInbox()
    const user = await selectFirst()
    await user.click(screen.getByLabelText('Mail einsortieren (⌥ für die Prüfliste)'))

    const account = harness.app.store.accounts.list()[0]!
    const inbox = `${account.id}:l:${SYSTEM_LABELS.inbox}`
    await waitFor(() =>
      expect(harness.app.store.messages.labelIdsOf(`${account.id}:g1`)).not.toContain(inbox)
    )

    await user.click(await screen.findByRole('button', { name: 'Rückgängig' }))

    await waitFor(() => {
      const labels = harness.app.store.messages.labelIdsOf(`${account.id}:g1`)
      expect(labels).toContain(inbox)
      expect(labels).not.toContain(`${account.id}:l:Label_7`)
    })
  })

  it('opens the review sheet on ⌥-click instead of settling', async () => {
    await seedInbox()
    const user = await selectFirst()
    await user.keyboard('{Alt>}')
    await user.click(screen.getByLabelText('Mail einsortieren (⌥ für die Prüfliste)'))
    await user.keyboard('{/Alt}')

    const dialog = await screen.findByRole('dialog', { name: 'Eingang aufräumen' })
    await within(dialog).findByText('Offerte Onlineshop')
    expect(within(dialog).getByRole('button', { name: 'Auswahl (1)' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )

    await user.click(within(dialog).getByRole('button', { name: 'Ganzer Eingang' }))
    expect(await within(dialog).findByText('Newsletter August')).toBeTruthy()

    // Nothing moved: the sheet is still the confirming path.
    const account = harness.app.store.accounts.list()[0]!
    expect(harness.app.store.messages.labelIdsOf(`${account.id}:g1`)).toContain(
      `${account.id}:l:${SYSTEM_LABELS.inbox}`
    )
  })

  it('settles the focused conversation on the s key', async () => {
    await seedInbox()
    const user = await selectFirst()
    await user.keyboard('s')

    const toast = await findToast(/Offerte Onlineshop.*Kunden/)
    expect(toast).toHaveTextContent('Kundenanfrage')
    expect(screen.queryByRole('dialog', { name: 'Eingang aufräumen' })).toBeNull()

    const account = harness.app.store.accounts.list()[0]!
    await waitFor(() =>
      expect(harness.app.store.messages.labelIdsOf(`${account.id}:g1`)).toContain(
        `${account.id}:l:Label_7`
      )
    )
  })

  it('opens the review sheet on the s key when nothing is selected', async () => {
    await seedInbox()
    const user = userEvent.setup()
    render(
      <UniboxProvider>
        <App />
      </UniboxProvider>
    )
    await screen.findByRole('listbox')
    await user.keyboard('s')

    const dialog = await screen.findByRole('dialog', { name: 'Eingang aufräumen' })
    await within(dialog).findByText('Offerte Onlineshop')
  })

  it('offers no scope switch when nothing is selected', async () => {
    await seedInbox()
    await openSheet()
    const dialog = await screen.findByRole('dialog', { name: 'Eingang aufräumen' })
    await within(dialog).findByText('Offerte Onlineshop')
    expect(within(dialog).queryByRole('group', { name: 'Umfang' })).toBeNull()
  })
})

describe('Settle queue', () => {
  /** Releases the answer for one mail at a time, so a settle can be held open. */
  const gates = new Map<string, () => void>()

  beforeEach(() => {
    gates.clear()
    boot(async ({ prompt }) => {
      const subject = /^Betreff: (.*)$/m.exec(prompt)?.[1] ?? ''
      await new Promise<void>((resolve) => gates.set(subject, resolve))
      const refs = [...prompt.matchAll(/<mail ref="([^"]+)"/g)].map((match) => match[1])
      return JSON.stringify({
        decisions: refs.map((ref) => ({
          ref,
          action: 'label',
          label: 'Kunden',
          new_label: false,
          confidence: 'high',
          reason: 'Kundenanfrage'
        }))
      })
    })
  })

  /** Waits for a mail to reach the CLI, then lets its answer through. */
  async function release(subject: string): Promise<void> {
    await waitFor(() => expect(gates.has(subject)).toBe(true))
    gates.get(subject)!()
  }

  it('takes a second conversation while the first one is still running', async () => {
    await seedInbox()
    const user = userEvent.setup()
    render(
      <UniboxProvider>
        <App />
      </UniboxProvider>
    )
    const list = await screen.findByRole('listbox')
    await waitFor(() => expect(within(list).getAllByRole('option')).toHaveLength(2))
    await user.click(within(list).getAllByRole('option')[0]!)
    const settleButton = screen.getByLabelText('Mail einsortieren (⌥ für die Prüfliste)')
    await user.click(settleButton)
    // The first mail is held in the CLI: the row says so and the button stays live.
    await waitFor(() =>
      expect(within(list).getAllByRole('option')[0]!).toHaveAttribute('aria-busy', 'true')
    )
    expect(settleButton).not.toBeDisabled()

    await user.click(within(list).getAllByRole('option')[1]!)
    await user.click(settleButton)
    await waitFor(() =>
      expect(within(list).getAllByRole('option')[1]!).toHaveAttribute('aria-busy', 'true')
    )

    await release('Newsletter August')
    await release('Offerte Onlineshop')

    const account = harness.app.store.accounts.list()[0]!
    const inbox = `${account.id}:l:${SYSTEM_LABELS.inbox}`
    await waitFor(() => {
      expect(harness.app.store.messages.labelIdsOf(`${account.id}:g1`)).not.toContain(inbox)
      expect(harness.app.store.messages.labelIdsOf(`${account.id}:g2`)).not.toContain(inbox)
    })
  })
})

describe('Settle without a home for the mail', () => {
  beforeEach(() => {
    boot(answer({ action: 'keep', confidence: 'low', reason: 'Braucht eine Antwort' }))
  })

  it('leaves the mail alone and says why', async () => {
    await seedInbox()
    const user = userEvent.setup()
    render(
      <UniboxProvider>
        <App />
      </UniboxProvider>
    )
    const list = await screen.findByRole('listbox')
    await waitFor(() => expect(within(list).getAllByRole('option')).toHaveLength(2))
    await user.click(within(list).getAllByRole('option')[0]!)
    await user.click(screen.getByLabelText('Mail einsortieren (⌥ für die Prüfliste)'))

    const toast = await findToast(/bleibt im Eingang/)
    expect(toast).toHaveTextContent('„Offerte Onlineshop" bleibt im Eingang')
    expect(toast).toHaveTextContent('Braucht eine Antwort')
    // Nothing to undo, so the toast only offers to be dismissed.
    expect(within(toast).queryByRole('button', { name: 'Rückgängig' })).toBeNull()

    const account = harness.app.store.accounts.list()[0]!
    expect(harness.app.store.messages.labelIdsOf(`${account.id}:g1`)).toContain(
      `${account.id}:l:${SYSTEM_LABELS.inbox}`
    )
  })
})

describe('Settle review sheet without a proposal', () => {
  beforeEach(() => {
    boot(async () => JSON.stringify({ decisions: [] }))
  })

  it('says there is nothing to do', async () => {
    await seedInbox()
    await openSheet()
    const dialog = await screen.findByRole('dialog', { name: 'Eingang aufräumen' })
    expect(await within(dialog).findByText('Nichts zu tun — der Eingang ist sortiert.')).toBeTruthy()
  })
})
