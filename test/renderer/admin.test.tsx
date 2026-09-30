// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Account } from '@shared/types'
import { App } from '@renderer/App'
import { UniboxProvider } from '@renderer/state'
import { createTestApp } from '../helpers/app'
import { installBridge } from '../helpers/fake-bridge'
import { addResendAccount, seedMessage } from '../helpers/store'
import { goToAdminPage, openAdmin } from '../helpers/admin'

let harness: ReturnType<typeof createTestApp>
let bridge: ReturnType<typeof installBridge>

function renderApp(): void {
  render(
    <UniboxProvider>
      <App />
    </UniboxProvider>
  )
}

async function start(): Promise<ReturnType<typeof userEvent.setup>> {
  renderApp()
  await screen.findByRole('listbox')
  return userEvent.setup()
}

function heading(name: string): Promise<HTMLElement> {
  return screen.findByRole('heading', { level: 1, name })
}

/** A Resend domain with receiving on and a little mail in its catch-all. */
function seedResend(): Account {
  const account = addResendAccount(harness.app.store, 'beispielweb.ch')
  seedMessage(harness.app.store, account, {
    remoteId: 'r1',
    subject: 'Rechnung Juli',
    from: { name: 'Lieferant', email: 'buchhaltung@lieferant.ch' },
    to: [{ name: null, email: 'info@beispielweb.ch' }]
  })
  seedMessage(harness.app.store, account, {
    remoteId: 'r2',
    subject: 'Irgendwas',
    to: [{ name: null, email: 'random@beispielweb.ch' }]
  })
  return account
}

beforeEach(async () => {
  harness = createTestApp()
  bridge = installBridge(harness.app)
  await harness.app.api['settings:set']({ onboardingComplete: true })
})

afterEach(() => {
  cleanup()
  bridge.uninstall()
  harness.dispose()
  vi.restoreAllMocks()
})

describe('Verwaltung workspace', () => {
  it('replaces the mailbox, moves between pages and leads back to the mail', async () => {
    const user = await start()
    const admin = await openAdmin(user)

    expect(await heading('Übersicht')).toBeInTheDocument()
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    // Not a modal: the workspace stands in for the mailbox.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    await goToAdminPage(user, 'Routing')
    expect(await heading('Routing')).toBeInTheDocument()
    const nav = screen.getByRole('navigation', { name: 'Bereiche der Verwaltung' })
    expect(within(nav).getByRole('button', { name: 'Routing' })).toHaveAttribute(
      'aria-current',
      'page'
    )

    // An overview tile is a way into its page.
    await goToAdminPage(user, 'Übersicht')
    await user.click(await within(admin).findByRole('button', { name: /Aktive Regeln/ }))
    expect(await heading('Routing')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Zurück zur Mail' }))
    expect(await screen.findByRole('listbox')).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Verwaltung' })).not.toBeInTheDocument()
  })
})

describe('domains', () => {
  it('shows every DNS record with what was found for it', async () => {
    const domain = harness.resend.addDomain('beispielweb.ch', true)
    domain.records = [
      { record: 'SPF', name: 'send', type: 'MX', value: 'feedback-smtp.eu-west-1.amazonses.com', priority: 10, status: 'verified' },
      { record: 'SPF', name: 'send', type: 'TXT', value: '"v=spf1 include:amazonses.com ~all"', status: 'failed' },
      { record: 'DKIM', name: 'resend._domainkey', type: 'TXT', value: 'p=MIGf', status: 'pending' }
    ]
    harness.resend.mx.set('beispielweb.ch', [
      { exchange: 'inbound-smtp.eu-west-1.amazonaws.com', priority: 10 }
    ])
    await harness.app.api['resend:setKey']('re_test')
    const user = await start()
    await openAdmin(user, 'Domains')

    const card = await screen.findByRole('region', { name: 'beispielweb.ch' })
    expect(within(card).getByText('Verifiziert')).toBeInTheDocument()
    await user.click(within(card).getByRole('button', { name: /Details anzeigen/ }))

    const records = within(card).getAllByRole('listitem')
    const row = (title: string): HTMLElement =>
      records.find((item) => within(item).queryByText(title) !== null)!
    expect(within(row('SPF-Eintrag')).getByText('Fehlt')).toBeInTheDocument()
    expect(row('SPF-Eintrag')).toHaveClass('admin-record--danger')
    expect(within(row('DKIM-Eintrag')).getByText('Ausstehend')).toBeInTheDocument()
    expect(within(row('Return-Path')).getByText('Gefunden')).toBeInTheDocument()
    expect(within(row('MX-Eintrag (Empfang)')).getByText('Gefunden')).toBeInTheDocument()
    // No DMARC published: advice, not a failure.
    expect(within(row('DMARC-Eintrag')).getByText('Empfohlen')).toBeInTheDocument()
    expect(within(row('DKIM-Eintrag')).getByText('p=MIGf')).toBeInTheDocument()

    await user.click(within(row('DKIM-Eintrag')).getByRole('button', { name: 'Wert kopieren' }))
    await waitFor(() => expect(harness.clipboard.text).toBe('p=MIGf'))

    await user.click(within(card).getByRole('button', { name: 'DNS prüfen' }))
    await waitFor(() => expect(harness.resend.verified).toEqual(['dom_beispielweb_ch']))
  })

  it('asks before receiving takes the domain away from its current mail host', async () => {
    harness.resend.addDomain('beispielweb.ch')
    harness.resend.mx.set('beispielweb.ch', [{ exchange: 'mx.old-host.ch', priority: 10 }])
    await harness.app.api['resend:setKey']('re_test')
    const user = await start()
    await openAdmin(user, 'Domains')

    await user.click(await screen.findByRole('switch', { name: 'Empfang für beispielweb.ch' }))
    expect(await screen.findByText('Fremder MX-Record erkannt')).toBeInTheDocument()
    expect(harness.app.store.accounts.findByEmail('resend', 'beispielweb.ch')).toBeNull()

    await user.click(screen.getByRole('button', { name: 'Trotzdem aktivieren' }))
    await waitFor(() =>
      expect(harness.app.store.accounts.findByEmail('resend', 'beispielweb.ch')).not.toBeNull()
    )
  })

  it('creates a domain at Resend and opens its DNS records right away', async () => {
    await harness.app.api['resend:setKey']('re_test')
    const user = await start()
    await openAdmin(user, 'Domains')

    await user.click(await screen.findByRole('button', { name: 'Neue Domain' }))
    const dialog = await screen.findByRole('dialog', { name: 'Neue Domain' })
    const submit = within(dialog).getByRole('button', { name: 'Domain anlegen' })
    await user.type(within(dialog).getByLabelText('Domain'), 'kein domain')
    expect(submit).toBeDisabled()
    await user.clear(within(dialog).getByLabelText('Domain'))
    await user.type(within(dialog).getByLabelText('Domain'), 'neu-kunde.ch')
    await user.selectOptions(within(dialog).getByLabelText('Region'), 'us-east-1')
    await user.click(submit)

    const card = await screen.findByRole('region', { name: 'neu-kunde.ch' })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(harness.resend.domains.find((d) => d.name === 'neu-kunde.ch')?.region).toBe('us-east-1')
    expect(within(card).getByRole('button', { name: /Details ausblenden/ })).toHaveAttribute(
      'aria-expanded',
      'true'
    )
    expect(within(card).getByText('DKIM-Eintrag')).toBeInTheDocument()
  })
})

describe('mailboxes', () => {
  it('creates a mailbox with an alias on a domain', async () => {
    seedResend()
    const user = await start()
    await openAdmin(user, 'Postfächer')

    await user.click(screen.getByRole('button', { name: 'Neues Postfach' }))
    const dialog = await screen.findByRole('dialog', { name: 'Neues Postfach' })
    await user.type(within(dialog).getByLabelText('Adresse'), 'info')
    await user.type(within(dialog).getByLabelText('Anzeigename'), 'Info')
    await user.type(within(dialog).getByLabelText('Aliase'), 'hallo{Enter}')
    expect(within(dialog).getByText('hallo@beispielweb.ch')).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Postfach anlegen' }))

    await waitFor(async () =>
      expect(await harness.app.api['mailboxes:list']()).toMatchObject([
        { address: 'info@beispielweb.ch', displayName: 'Info', aliases: ['hallo@beispielweb.ch'] }
      ])
    )
    expect(await screen.findByText('info@beispielweb.ch')).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('reorders mailboxes by dragging a row onto another', async () => {
    const account = seedResend()
    for (const local of ['info', 'offerten', 'support']) {
      await harness.app.api['mailboxes:create']({ accountId: account.id, address: `${local}@beispielweb.ch` })
    }
    const user = await start()
    await openAdmin(user, 'Postfächer')

    const row = async (address: string): Promise<HTMLElement> =>
      (await screen.findByText(address, { selector: '.admin-row__sub' })).closest('li')!
    const dataTransfer = { effectAllowed: 'none', setData: () => undefined }
    fireEvent.dragStart(await row('support@beispielweb.ch'), { dataTransfer })
    fireEvent.dragOver(await row('info@beispielweb.ch'), { dataTransfer })
    expect(await row('info@beispielweb.ch')).toHaveClass('admin-row--drop')
    fireEvent.drop(await row('info@beispielweb.ch'), { dataTransfer })

    await waitFor(async () =>
      expect((await harness.app.api['mailboxes:list']()).map((m) => m.address)).toEqual([
        'support@beispielweb.ch',
        'info@beispielweb.ch',
        'offerten@beispielweb.ch'
      ])
    )
  })
})

describe('routing rules', () => {
  it('tries a rule on received mail before it is saved', async () => {
    seedResend()
    const user = await start()
    await openAdmin(user, 'Routing')

    await user.click(screen.getByRole('button', { name: 'Neue Regel' }))
    const dialog = await screen.findByRole('dialog', { name: 'Neue Regel' })
    await user.type(within(dialog).getByLabelText('Name'), 'Rechnungen')
    await user.selectOptions(within(dialog).getByLabelText('Feld'), 'from')
    await user.selectOptions(within(dialog).getByLabelText('Bedingung'), 'regex')
    await user.type(within(dialog).getByLabelText('Wert'), 'lieferant(')
    expect(within(dialog).getByText(/Ungültiger regulärer Ausdruck/)).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Regel anlegen' })).toBeDisabled()

    await user.selectOptions(within(dialog).getByLabelText('Bedingung'), 'contains')
    await user.clear(within(dialog).getByLabelText('Wert'))
    await user.type(within(dialog).getByLabelText('Wert'), 'lieferant')
    await user.selectOptions(within(dialog).getByLabelText('Aktion'), 'archive')
    await user.click(within(dialog).getByRole('button', { name: 'Testen' }))
    expect(
      await within(dialog).findByText('1 von 2 zuletzt empfangenen Mails würden passen.')
    ).toBeInTheDocument()
    expect(within(dialog).getByText('Rechnung Juli')).toBeInTheDocument()
    // A dry run changes nothing.
    expect(await harness.app.api['rules:list']()).toHaveLength(0)

    await user.click(within(dialog).getByRole('button', { name: 'Regel anlegen' }))
    await waitFor(async () =>
      expect(await harness.app.api['rules:list']()).toMatchObject([
        { name: 'Rechnungen', matchField: 'from', operator: 'contains', value: 'lieferant', action: 'archive' }
      ])
    )
    expect(
      await screen.findByText('Wenn Absender enthält «lieferant» → Archivieren')
    ).toBeInTheDocument()
  })
})

describe('webhooks', () => {
  it('shows the signing secret once, right after creating a webhook', async () => {
    await harness.app.api['resend:setKey']('re_test')
    const user = await start()
    await openAdmin(user, 'Zustellung')

    await user.click(screen.getByRole('button', { name: 'Webhook' }))
    const dialog = await screen.findByRole('dialog', { name: 'Neuer Webhook' })
    await user.type(within(dialog).getByLabelText('Endpunkt'), 'https://hooks.example.ch/resend')
    await user.click(within(dialog).getByRole('checkbox', { name: 'email.complained' }))
    await user.click(within(dialog).getByRole('button', { name: 'Webhook anlegen' }))

    const created = await screen.findByRole('dialog', { name: 'Webhook angelegt' })
    expect(within(created).getByText('whsec_wh_1')).toBeInTheDocument()
    await user.click(within(created).getByRole('button', { name: 'Secret kopieren' }))
    await waitFor(() => expect(harness.clipboard.text).toBe('whsec_wh_1'))
    expect(harness.resend.webhooks[0]).toMatchObject({
      endpoint: 'https://hooks.example.ch/resend'
    })

    await user.click(within(created).getByRole('button', { name: 'Fertig' }))
    expect(await screen.findByText('https://hooks.example.ch/resend')).toBeInTheDocument()
    expect(screen.queryByText('whsec_wh_1')).not.toBeInTheDocument()
  })
})

describe('mailboxes in the sidebar', () => {
  it('lists a domain’s mailboxes with their unread count and opens their mail', async () => {
    const account = seedResend()
    await harness.app.api['mailboxes:create']({
      accountId: account.id,
      address: 'info@beispielweb.ch',
      displayName: 'Info'
    })
    const user = await start()

    const info = await screen.findByRole('button', { name: /^Info/ })
    expect(within(info).getByText('1')).toBeInTheDocument()
    await user.click(info)
    const list = screen.getByRole('listbox')
    expect(await within(list).findByText('Rechnung Juli')).toBeInTheDocument()
    await waitFor(() => expect(within(list).queryByText('Irgendwas')).not.toBeInTheDocument())

    await user.click(screen.getByRole('button', { name: /Nicht zugeordnet/ }))
    expect(await within(screen.getByRole('listbox')).findByText('Irgendwas')).toBeInTheDocument()
    await waitFor(() =>
      expect(within(screen.getByRole('listbox')).queryByText('Rechnung Juli')).not.toBeInTheDocument()
    )
  })
  it('shows unassigned mail under every domain with its own count', async () => {
    const account = seedResend()
    const other = addResendAccount(harness.app.store, 'andere.ch')
    seedMessage(harness.app.store, other, {
      remoteId: 'o1',
      subject: 'Fremd',
      to: [{ name: null, email: 'x@andere.ch' }]
    })
    await harness.app.api['mailboxes:create']({ accountId: account.id, address: 'info@beispielweb.ch' })
    await harness.app.api['mailboxes:create']({ accountId: other.id, address: 'info@andere.ch' })
    const user = await start()

    const rows = await screen.findAllByRole('button', { name: /Nicht zugeordnet/ })
    expect(rows).toHaveLength(2)
    for (const row of rows) expect(within(row).getByText('1')).toBeInTheDocument()
    await user.click(rows[1]!)
    expect(await within(screen.getByRole('listbox')).findByText('Fremd')).toBeInTheDocument()
    await waitFor(() =>
      expect(within(screen.getByRole('listbox')).queryByText('Irgendwas')).not.toBeInTheDocument()
    )
  })
})
