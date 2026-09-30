// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SYSTEM_LABELS } from '@shared/types'
import { App } from '@renderer/App'
import { UniboxProvider } from '@renderer/state'
import { createTestApp } from '../helpers/app'
import { installBridge } from '../helpers/fake-bridge'

let harness: ReturnType<typeof createTestApp>
let bridge: ReturnType<typeof installBridge>

async function seedTwoAccounts(): Promise<void> {
  await harness.app.api['settings:set']({ onboardingComplete: true })
  harness.resend.addDomain('beispielweb.ch', true)
  harness.resend.mx.set('beispielweb.ch', [
    { exchange: 'inbound-smtp.eu-west-1.amazonaws.com', priority: 10 }
  ])
  await harness.app.api['resend:setKey']('re_test')
  await harness.app.api['resend:enableReceiving']('dom_beispielweb_ch')
  harness.resend.addReceived({
    id: 'r1',
    subject: 'Website-Relaunch Malergeschäft',
    from: 'Sandra Keller <s.keller@keller-farben.ch>',
    to: ['kontakt@beispielweb.ch'],
    text: 'Wir möchten unsere Website erneuern lassen',
    created_at: '2026-08-18T09:42:00.000Z'
  })

  const google = harness.app.store.accounts.upsert({
    kind: 'google',
    email: 'max@muster-it.ch',
    displayName: 'max@muster-it.ch'
  })
  harness.app.store.labels.ensureSystemLabels(google.id)
  harness.app.store.labels.replaceAll(google.id, [
    { remoteId: SYSTEM_LABELS.inbox, name: 'INBOX', type: 'system' },
    { remoteId: SYSTEM_LABELS.sent, name: 'SENT', type: 'system' },
    { remoteId: SYSTEM_LABELS.unread, name: 'UNREAD', type: 'system' },
    { remoteId: SYSTEM_LABELS.trash, name: 'TRASH', type: 'system' },
    { remoteId: SYSTEM_LABELS.spam, name: 'SPAM', type: 'system' },
    { remoteId: 'Label_7', name: 'Kunden', type: 'user' }
  ])
  for (const [index, subject] of ['Security alert', 'Re: Offerte Onlineshop'].entries()) {
    harness.app.store.messages.upsert({
      id: `${google.id}:g${index}`,
      accountId: google.id,
      threadId: `${google.id}:t:g${index}`,
      remoteId: `g${index}`,
      subject,
      from: { name: index === 0 ? 'GitHub' : 'Marco Bianchi', email: `sender${index}@example.com` },
      to: [{ name: null, email: 'max@muster-it.ch' }],
      date: Date.parse('2026-08-18T10:12:00.000Z') - index * 60_000,
      labelRemoteIds: [SYSTEM_LABELS.inbox, SYSTEM_LABELS.unread],
      body: { html: null, text: `Inhalt ${subject}` }
    })
  }
  await harness.app.syncAll()
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

describe('unified inbox', () => {
  it('shows all accounts merged and newest first with an account badge', async () => {
    await seedTwoAccounts()
    render(
      <UniboxProvider>
        <App />
      </UniboxProvider>
    )

    const list = await screen.findByRole('listbox')
    await waitFor(() => expect(within(list).getAllByRole('option')).toHaveLength(3))
    const rows = within(list).getAllByRole('option')
    expect(rows[0]).toHaveTextContent('Security alert')
    expect(rows[2]).toHaveTextContent('Website-Relaunch')
    expect(rows[2]).toHaveTextContent('beispielweb.ch')
    expect(rows[0]).toHaveTextContent('muster-it.ch')
  })

  it('lists a sidebar section per account with translated system labels', async () => {
    await seedTwoAccounts()
    render(
      <UniboxProvider>
        <App />
      </UniboxProvider>
    )

    expect(await screen.findByText('Alle Eingänge')).toBeTruthy()
    expect(await screen.findByText('max@muster-it.ch')).toBeTruthy()
    expect(await screen.findAllByText('beispielweb.ch')).not.toHaveLength(0)
    await waitFor(() => expect(screen.getAllByText('Eingang').length).toBe(2))
    expect(screen.getAllByText('Gesendet').length).toBe(2)
    expect(screen.getByText('Kunden')).toBeTruthy()
  })

  it('opens a conversation and marks it read', async () => {
    await seedTwoAccounts()
    const user = userEvent.setup()
    render(
      <UniboxProvider>
        <App />
      </UniboxProvider>
    )

    const list = await screen.findByRole('listbox')
    await waitFor(() => expect(within(list).getAllByRole('option').length).toBe(3))
    await user.click(within(list).getAllByRole('option')[0]!)

    expect(await screen.findByRole('heading', { name: 'Security alert' })).toBeTruthy()
    await waitFor(() => {
      const google = harness.app.store.accounts.findByEmail('google', 'max@muster-it.ch')!
      const message = harness.app.store.messages.getByRemoteId(google.id, 'g0')!
      expect(message.labelIds.some((id) => id.endsWith(':l:UNREAD'))).toBe(false)
    })
  })

  it('filters the list to one account when its inbox is selected', async () => {
    await seedTwoAccounts()
    const user = userEvent.setup()
    render(
      <UniboxProvider>
        <App />
      </UniboxProvider>
    )

    await waitFor(() => expect(screen.getAllByText('Eingang').length).toBe(2))
    await user.click(screen.getAllByText('Eingang')[1]!)

    const list = screen.getByRole('listbox')
    await waitFor(() => expect(within(list).getAllByRole('option')).toHaveLength(1))
    expect(within(list).getAllByRole('option')[0]).toHaveTextContent('Website-Relaunch')
  })
})

describe('search', () => {
  it('searches all accounts from the toolbar', async () => {
    await seedTwoAccounts()
    const user = userEvent.setup()
    render(
      <UniboxProvider>
        <App />
      </UniboxProvider>
    )

    const list = await screen.findByRole('listbox')
    await waitFor(() => expect(within(list).getAllByRole('option').length).toBe(3))

    // The search field is a combobox now: it completes operators while typing.
    await user.type(screen.getByRole('combobox'), 'Malergeschäft')
    await waitFor(() => expect(within(list).getAllByRole('option')).toHaveLength(1))
    expect(within(list).getAllByRole('option')[0]).toHaveTextContent('Website-Relaunch')
  })
})

describe('search suggestions', () => {
  it('completes an operator and then a sender from the mailbox', async () => {
    await seedTwoAccounts()
    const user = userEvent.setup()
    render(
      <UniboxProvider>
        <App />
      </UniboxProvider>
    )
    await screen.findByRole('listbox')

    const box = screen.getByRole('combobox')
    await user.type(box, 'fr')
    const operator = await screen.findByRole('option', { name: /from:/ })
    await user.click(operator)
    expect(box).toHaveValue('from:')

    await user.type(box, 'keller')
    const sender = await screen.findByRole('option', { name: /keller-farben/ })
    await user.click(sender)
    expect(box).toHaveValue('from:s.keller@keller-farben.ch ')

    // The operator is understood, not just typed: the toolbar shows it as a chip.
    expect(screen.getByLabelText('Aktive Suchfilter')).toHaveTextContent(
      'from:s.keller@keller-farben.ch'
    )
  })

  it('pins a search to the sidebar and opens it again from there', async () => {
    await seedTwoAccounts()
    const user = userEvent.setup()
    render(
      <UniboxProvider>
        <App />
      </UniboxProvider>
    )
    await screen.findByRole('listbox')

    await user.type(screen.getByRole('combobox'), 'is:unread')
    await user.click(screen.getByRole('button', { name: 'Suche merken' }))

    const prompt = await screen.findByRole('dialog', { name: 'Name für die gespeicherte Suche' })
    await user.clear(within(prompt).getByRole('textbox'))
    await user.type(within(prompt).getByRole('textbox'), 'Ungelesen')
    await user.click(within(prompt).getByRole('button', { name: 'Suche merken' }))

    const saved = await screen.findByRole('button', { name: 'Ungelesen' })
    await user.clear(screen.getByRole('combobox'))
    await user.click(saved)
    expect(screen.getByRole('combobox')).toHaveValue('is:unread')
  })
})

describe('keyboard shortcuts', () => {
  it('navigates with j and k, archives with e', async () => {
    await seedTwoAccounts()
    const user = userEvent.setup()
    render(
      <UniboxProvider>
        <App />
      </UniboxProvider>
    )

    const list = await screen.findByRole('listbox')
    await waitFor(() => expect(within(list).getAllByRole('option').length).toBe(3))

    await user.keyboard('j')
    await waitFor(() =>
      expect(within(list).getAllByRole('option')[0]?.getAttribute('aria-current')).toBe('true')
    )

    await user.keyboard('j')
    await waitFor(() =>
      expect(within(list).getAllByRole('option')[1]?.getAttribute('aria-current')).toBe('true')
    )

    await user.keyboard('k')
    await waitFor(() =>
      expect(within(list).getAllByRole('option')[0]?.getAttribute('aria-current')).toBe('true')
    )

    await user.keyboard('e')
    await waitFor(() => expect(within(list).getAllByRole('option')).toHaveLength(2))
  })

  it('opens a reply with r and a new mail with meta+n', async () => {
    await seedTwoAccounts()
    const user = userEvent.setup()
    render(
      <UniboxProvider>
        <App />
      </UniboxProvider>
    )

    const list = await screen.findByRole('listbox')
    await waitFor(() => expect(within(list).getAllByRole('option').length).toBe(3))

    await user.keyboard('j')
    await waitFor(() => expect(screen.getByRole('heading', { level: 1 })).toBeTruthy())
    await user.keyboard('r')
    expect(await screen.findByRole('dialog', { name: 'Antworten' })).toBeTruthy()
    await user.click(screen.getByLabelText('Schliessen'))

    await user.keyboard('{Meta>}n{/Meta}')
    expect(await screen.findByRole('dialog', { name: 'Neue E-Mail' })).toBeTruthy()
  })
})

describe('compose', () => {
  it('inserts the identity signature into a reply', async () => {
    await seedTwoAccounts()
    const resendAccount = harness.app.store.accounts.findByEmail('resend', 'beispielweb.ch')!
    harness.app.store.identities.create({
      accountId: resendAccount.id,
      name: 'Max Muster',
      email: 'kontakt@beispielweb.ch',
      isDefault: true,
      signatureHtml: '<p>Freundliche Grüsse<br>Max Muster</p>'
    })

    const user = userEvent.setup()
    render(
      <UniboxProvider>
        <App />
      </UniboxProvider>
    )

    const list = await screen.findByRole('listbox')
    await waitFor(() => expect(within(list).getAllByRole('option').length).toBe(3))
    await user.click(within(list).getAllByRole('option')[2]!)
    await screen.findByRole('heading', { name: 'Website-Relaunch Malergeschäft' })

    await user.click(screen.getByRole('button', { name: /Antworten als/ }))
    const dialog = await screen.findByRole('dialog', { name: 'Antworten' })
    await waitFor(() => expect(dialog.textContent).toContain('Freundliche Grüsse'))
    expect(dialog.textContent).toContain('Wird über Resend gesendet (beispielweb.ch)')
  })
})

describe('backfill progress', () => {
  it('shows how far the first sync got, per account', async () => {
    await seedTwoAccounts()
    render(
      <UniboxProvider>
        <App />
      </UniboxProvider>
    )
    await screen.findByRole('listbox')

    const google = harness.app.store.accounts.findByEmail('google', 'max@muster-it.ch')!
    act(() => {
      bridge.emit('sync:progress', {
        accountId: google.id,
        phase: 'initial',
        processed: 3115,
        total: 6393,
        message: null
      })
    })

    expect(await screen.findByText('Erst-Sync: 3115 von 6393')).toBeInTheDocument()

    act(() => {
      bridge.emit('sync:progress', {
        accountId: google.id,
        phase: 'idle',
        processed: 6393,
        total: 6393,
        message: null
      })
    })
    await waitFor(() => expect(screen.queryByText(/Erst-Sync/)).not.toBeInTheDocument())
  })
})
