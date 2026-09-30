// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { App } from '@renderer/App'
import { UniboxProvider } from '@renderer/state'
import { formatFollowUpDue, isOverdue } from '@renderer/lib/followup'
import { threadKey } from '@main/db/ids'
import type { Account } from '@shared/types'
import { createTestApp } from '../helpers/app'
import { installBridge } from '../helpers/fake-bridge'
import { seedMessage } from '../helpers/store'

const DAY = 24 * 3600 * 1000

let harness: ReturnType<typeof createTestApp>

function boot(): void {
  harness = createTestApp()
  const bridge = installBridge(harness.app)
  harness.onEmit((name, payload) => {
    act(() => {
      bridge.emit(name, payload as never)
    })
  })
}

async function seedAccount(): Promise<Account> {
  await harness.app.api['settings:set']({ onboardingComplete: true })
  const account = harness.app.store.accounts.upsert({
    kind: 'google',
    email: 'max@muster-it.ch',
    displayName: 'max@muster-it.ch'
  })
  harness.app.store.labels.ensureSystemLabels(account.id)
  // No identity on purpose: none of this depends on who signs the mail, and a
  // composer without one still draws every control it owns.
  return account
}

afterEach(() => {
  cleanup()
  harness?.dispose()
})

describe('the countdown as it reads', () => {
  const now = new Date(2026, 7, 17, 9).getTime()

  it('counts down while there is still time', () => {
    expect(formatFollowUpDue(now + 3 * DAY, now)).toBe('in 3 Tagen')
    expect(formatFollowUpDue(now + DAY, now)).toBe('morgen fällig')
    expect(formatFollowUpDue(now + 3600_000, now)).toBe('heute fällig')
  })

  it('counts up once the answer is late', () => {
    expect(formatFollowUpDue(now - 3600_000, now)).toBe('seit heute überfällig')
    expect(formatFollowUpDue(now - DAY, now)).toBe('seit gestern überfällig')
    expect(formatFollowUpDue(now - 4 * DAY, now)).toBe('seit 4 Tagen überfällig')
  })

  it('calls a wait late exactly when its moment has passed', () => {
    expect(isOverdue(now + 1, now)).toBe(false)
    expect(isOverdue(now, now)).toBe(true)
  })
})

describe('the waiting mailbox in the app', () => {
  it('shows the row, its countdown and a way to end the wait', async () => {
    boot()
    const account = await seedAccount()
    seedMessage(harness.app.store, account, {
      remoteId: 'm1',
      subject: 'Offerte Website',
      direction: 'outgoing',
      from: { name: 'Max Muster', email: account.email },
      to: [{ name: null, email: 's.keller@keller-farben.ch' }]
    })
    const threadId = threadKey(account.id, 'm1')
    // Already late, so the row has something to be emphatic about.
    harness.app.followUps.arm(threadId, Date.now() - 2 * DAY)

    const user = userEvent.setup()
    render(
      <UniboxProvider>
        <App />
      </UniboxProvider>
    )
    await screen.findByRole('listbox')

    // The sidebar offers the mailbox only once something is in it.
    const entry = await screen.findByRole('button', { name: /Wartet auf Antwort/ })
    await user.click(entry)

    const list = screen.getByRole('listbox')
    const row = await within(list).findByRole('option', { name: /Offerte Website/ })
    expect(row.textContent).toContain('überfällig')

    await user.click(row)
    // Reading the conversation shows the same state, with the way out of it.
    const done = await screen.findByRole('button', { name: 'Erledigt' })
    await user.click(done)

    await waitFor(async () => {
      expect(await harness.app.api['followups:list']()).toHaveLength(0)
    })
  })

  it('offers the reminder in the composer and remembers it being turned off', async () => {
    boot()
    await seedAccount()

    const user = userEvent.setup()
    render(
      <UniboxProvider>
        <App />
      </UniboxProvider>
    )
    await screen.findByRole('listbox')
    await user.keyboard('{Meta>}n{/Meta}')
    const compose = await screen.findByRole('dialog', { name: 'Neue E-Mail' })

    const toggle = within(compose).getByRole('checkbox')
    // Nothing is addressed yet, so there is nobody who could answer.
    expect(toggle).toBeDisabled()

    await user.type(within(compose).getByLabelText('An:'), 's.keller@keller-farben.ch')
    await waitFor(() => expect(toggle).toBeEnabled())
    expect(toggle).toBeChecked()

    await user.click(toggle)
    expect(toggle).not.toBeChecked()
  })
})
