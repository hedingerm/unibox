// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SYSTEM_LABELS } from '@shared/types'
import { App } from '@renderer/App'
import { UniboxProvider, THREAD_PAGE_SIZE } from '@renderer/state'
import { ROW_HEIGHT } from '@renderer/components/MessageList'
import { createTestApp } from '../helpers/app'
import { installBridge } from '../helpers/fake-bridge'

let harness: ReturnType<typeof createTestApp>
let bridge: ReturnType<typeof installBridge>

const TOTAL = 150

async function seedManyThreads(): Promise<void> {
  await harness.app.api['settings:set']({ onboardingComplete: true })
  const account = harness.app.store.accounts.upsert({
    kind: 'google',
    email: 'max@muster-it.ch',
    displayName: 'max@muster-it.ch'
  })
  harness.app.store.labels.ensureSystemLabels(account.id)
  const base = Date.parse('2026-08-18T10:00:00.000Z')
  for (let index = 0; index < TOTAL; index += 1) {
    harness.app.store.messages.upsert({
      id: `${account.id}:g${index}`,
      accountId: account.id,
      threadId: `${account.id}:t:g${index}`,
      remoteId: `g${index}`,
      // Descending dates, so index 0 is newest and index 149 the oldest.
      subject: `Konversation ${index}`,
      from: { name: `Absender ${index}`, email: `sender${index}@example.com` },
      to: [{ name: null, email: 'max@muster-it.ch' }],
      date: base - index * 60_000,
      labelRemoteIds: [SYSTEM_LABELS.inbox],
      body: { html: null, text: `Inhalt ${index}` }
    })
  }
}

function renderApp(): void {
  render(
    <UniboxProvider>
      <App />
    </UniboxProvider>
  )
}

beforeEach(() => {
  harness = createTestApp()
  bridge = installBridge(harness.app)
})

afterEach(() => {
  cleanup()
  bridge.uninstall()
  harness.dispose()
})

describe('the list reaches the whole local store', () => {
  it('starts with one page and loads older conversations on scroll', async () => {
    await seedManyThreads()
    renderApp()

    const list = await screen.findByRole('listbox')
    await waitFor(() => expect(screen.getByText(/Konversation 0$/)).toBeInTheDocument())
    // The newest page is there, the oldest conversation is not yet.
    expect(screen.queryByText(`Konversation ${TOTAL - 1}`)).not.toBeInTheDocument()
    expect(screen.getByText('Zum Laden älterer Konversationen weiterscrollen')).toBeInTheDocument()

    const firstPageCalls = bridge.calls.filter((call) => call.channel === 'threads:list').length
    fireEvent.scroll(list)

    await waitFor(() =>
      expect(
        screen.queryByText('Zum Laden älterer Konversationen weiterscrollen')
      ).not.toBeInTheDocument()
    )
    expect(bridge.calls.filter((call) => call.channel === 'threads:list').length).toBeGreaterThan(
      firstPageCalls
    )

    // The second page was appended, not fetched from the top again.
    const paged = bridge.calls.filter((call) => call.channel === 'threads:list').at(-1)!
    expect((paged.args[0] as { offset?: number }).offset).toBe(THREAD_PAGE_SIZE)
  })

  it('renders only a window of rows, not the whole mailbox', async () => {
    await seedManyThreads()
    renderApp()

    const list = await screen.findByRole('listbox')
    await waitFor(() => expect(within(list).getAllByRole('option').length).toBeGreaterThan(0))
    fireEvent.scroll(list)
    await waitFor(() =>
      expect(
        screen.queryByText('Zum Laden älterer Konversationen weiterscrollen')
      ).not.toBeInTheDocument()
    )

    // All 150 are loaded, but only the visible slice is in the DOM.
    const rendered = within(list).getAllByRole('option').length
    expect(rendered).toBeLessThan(TOTAL)
    expect(rendered).toBeGreaterThan(5)
  })

  it('reaches the oldest conversation without searching for it', async () => {
    await seedManyThreads()
    const user = userEvent.setup()
    renderApp()

    const list = await screen.findByRole('listbox')
    await waitFor(() => expect(screen.getByText(/Konversation 0$/)).toBeInTheDocument())
    fireEvent.scroll(list)
    await waitFor(() =>
      expect(
        screen.queryByText('Zum Laden älterer Konversationen weiterscrollen')
      ).not.toBeInTheDocument()
    )

    // `k` from no selection jumps to the very last row, which is off screen.
    await user.keyboard('k')
    expect(
      await screen.findByRole('heading', { name: `Konversation ${TOTAL - 1}` })
    ).toBeInTheDocument()
    expect(within(list).getByText(`Konversation ${TOTAL - 1}`)).toBeInTheDocument()
  })

  it('lets the user scroll past the selected conversation', async () => {
    await seedManyThreads()
    const user = userEvent.setup()
    renderApp()

    const list = await screen.findByRole('listbox')
    await waitFor(() => expect(screen.getByText(/Konversation 0$/)).toBeInTheDocument())
    fireEvent.scroll(list)
    await waitFor(() =>
      expect(
        screen.queryByText('Zum Laden \u00e4lterer Konversationen weiterscrollen')
      ).not.toBeInTheDocument()
    )

    // Selecting the newest conversation must not pin the list to it.
    await user.click(screen.getByText(/Konversation 0$/))
    await screen.findByRole('heading', { name: 'Konversation 0' })

    // jsdom has no layout, so the scroll offset is supplied by hand.
    Object.defineProperty(list, 'scrollTop', { value: ROW_HEIGHT * 40, configurable: true })
    fireEvent.scroll(list)

    await waitFor(() =>
      expect(within(list).getByText('Konversation 40')).toBeInTheDocument()
    )
    // The selected row is far above the window now and no longer drawn.
    expect(within(list).queryByText(/^Konversation 0$/)).not.toBeInTheDocument()
  })

  it('keeps the selection when the list is reloaded', async () => {
    await seedManyThreads()
    const user = userEvent.setup()
    renderApp()

    const list = await screen.findByRole('listbox')
    await waitFor(() => expect(screen.getByText(/Konversation 0$/)).toBeInTheDocument())
    fireEvent.scroll(list)
    await waitFor(() =>
      expect(
        screen.queryByText('Zum Laden älterer Konversationen weiterscrollen')
      ).not.toBeInTheDocument()
    )

    await user.keyboard('k')
    await screen.findByRole('heading', { name: `Konversation ${TOTAL - 1}` })

    // A sync pushing new data must not throw the loaded window away.
    bridge.emit('data:changed', { accountIds: [] })
    await waitFor(() =>
      expect(
        screen.getByRole('heading', { name: `Konversation ${TOTAL - 1}` })
      ).toBeInTheDocument()
    )
    const reloaded = bridge.calls.filter((call) => call.channel === 'threads:list').at(-1)!
    expect((reloaded.args[0] as { limit?: number }).limit).toBeGreaterThan(TOTAL)
  })
})
