// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SYSTEM_LABELS } from '@shared/types'
import { App } from '@renderer/App'
import { UniboxProvider } from '@renderer/state'
import { createTestApp } from '../helpers/app'
import { installBridge } from '../helpers/fake-bridge'

let harness: ReturnType<typeof createTestApp>
let bridge: ReturnType<typeof installBridge>

const NOW = Date.parse('2026-08-20T10:00:00.000Z')
const DAY = 24 * 3600 * 1000

/** One conversation per section the list can produce, newest first. */
const AGES = [
  { subject: 'Heute-Mail', at: NOW - 3600 * 1000 },
  { subject: 'Zweite von heute', at: NOW - 5 * 3600 * 1000 },
  { subject: 'Gestern-Mail', at: NOW - 1 * DAY },
  { subject: 'Wochen-Mail', at: NOW - 3 * DAY },
  { subject: 'Vorwochen-Mail', at: NOW - 8 * DAY },
  { subject: 'Monats-Mail', at: NOW - 16 * DAY },
  { subject: 'Alte Mail', at: NOW - 60 * DAY }
]

async function seedThreads(): Promise<void> {
  await harness.app.api['settings:set']({ onboardingComplete: true })
  const account = harness.app.store.accounts.upsert({
    kind: 'google',
    email: 'max@muster-it.ch',
    displayName: 'max@muster-it.ch'
  })
  harness.app.store.labels.ensureSystemLabels(account.id)
  AGES.forEach(({ subject, at }, index) => {
    harness.app.store.messages.upsert({
      id: `${account.id}:g${index}`,
      accountId: account.id,
      threadId: `${account.id}:t:g${index}`,
      remoteId: `g${index}`,
      subject,
      from: { name: `Absender ${index}`, email: `sender${index}@example.com` },
      to: [{ name: null, email: 'max@muster-it.ch' }],
      date: at,
      labelRemoteIds: [SYSTEM_LABELS.inbox],
      body: { html: null, text: `Inhalt ${subject}` }
    })
  })
}

/** Enough rows that the oldest sits well below the fold. */
async function seedTwoLongSections(): Promise<void> {
  await harness.app.api['settings:set']({ onboardingComplete: true })
  const account = harness.app.store.accounts.upsert({
    kind: 'google',
    email: 'max@muster-it.ch',
    displayName: 'max@muster-it.ch'
  })
  harness.app.store.labels.ensureSystemLabels(account.id)
  for (let index = 0; index < 30; index += 1) {
    harness.app.store.messages.upsert({
      id: `${account.id}:g${index}`,
      accountId: account.id,
      threadId: `${account.id}:t:g${index}`,
      remoteId: `g${index}`,
      subject: `Konversation ${index}`,
      from: { name: `Absender ${index}`, email: `sender${index}@example.com` },
      to: [{ name: null, email: 'max@muster-it.ch' }],
      date: index < 15 ? NOW - index * 60_000 : NOW - 60 * DAY - index * 60_000,
      labelRemoteIds: [SYSTEM_LABELS.inbox],
      body: { html: null, text: `Inhalt ${index}` }
    })
  }
}

function pinnedLabel(list: HTMLElement): string | null {
  return list.querySelector('.list__section--pinned')?.textContent ?? null
}

function renderApp(): void {
  render(
    <UniboxProvider>
      <App />
    </UniboxProvider>
  )
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true, now: NOW })
  harness = createTestApp()
  bridge = installBridge(harness.app)
})

afterEach(() => {
  cleanup()
  bridge.uninstall()
  harness.dispose()
  vi.useRealTimers()
})

describe('the list groups conversations by age', () => {
  it('opens a section at each boundary and only there', async () => {
    await seedThreads()
    renderApp()

    const list = await screen.findByRole('listbox')
    await waitFor(() =>
      expect(within(list).getAllByRole('option')).toHaveLength(AGES.length)
    )

    const labels = within(list)
      .getAllByRole('presentation')
      .map((node) => node.textContent)
    // Two conversations from today share one label; the rest each open their own.
    expect(labels).toEqual([
      'Heute',
      'Gestern',
      'Diese Woche',
      'Letzte Woche',
      'Diesen Monat',
      'Juni 2026'
    ])
  })

  it('pins the section the top of the viewport is in', async () => {
    await seedTwoLongSections()
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    renderApp()

    const list = await screen.findByRole('listbox')
    await waitFor(() => expect(pinnedLabel(list)).toBe('Heute'))

    // `k` with nothing selected jumps to the very last row, far below the fold.
    await user.keyboard('k')
    await screen.findByRole('heading', { name: 'Konversation 29' })
    await waitFor(() => expect(pinnedLabel(list)).toBe('Juni 2026'))
  })

  it('leaves relevance-ranked search results ungrouped', async () => {
    await seedThreads()
    renderApp()

    const list = await screen.findByRole('listbox')
    await waitFor(() => expect(within(list).getAllByRole('presentation').length).toBeGreaterThan(0))

    const search = screen.getByPlaceholderText(/Suchen/)
    fireEvent.change(search, { target: { value: 'Mail' } })

    await waitFor(() => expect(within(list).queryAllByRole('presentation')).toHaveLength(0))
    // …and that is not simply an empty result set.
    expect(within(list).getAllByRole('option').length).toBeGreaterThan(1)
    expect(pinnedLabel(list)).toBeNull()
  })
})
