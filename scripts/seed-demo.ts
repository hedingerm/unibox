/**
 * Fills a user-data directory with representative data so the UI can be
 * inspected (and screenshotted) without connecting real accounts.
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { Store } from '../src/main/db/store'
import { messageKey, threadKey } from '../src/main/db/ids'
import { SYSTEM_LABELS } from '../src/shared/types'

const userDataPath = process.argv[2]
if (!userDataPath) throw new Error('Nutzung: bun scripts/seed-demo.ts <userDataPath>')
mkdirSync(userDataPath, { recursive: true })

const store = Store.openFile(join(userDataPath, 'unibox.db'))
store.settings.set({ onboardingComplete: true })

const day = 24 * 3600 * 1000
const now = Date.parse('2026-08-20T10:30:00+02:00')

const gmail = store.accounts.upsert({
  kind: 'google',
  email: 'max.muster@gmail.com',
  displayName: 'max.muster@gmail.com'
})
const workspace = store.accounts.upsert({
  kind: 'google',
  email: 'max@muster-it.ch',
  displayName: 'max@muster-it.ch'
})
store.labels.replaceAll(gmail.id, [
  { remoteId: SYSTEM_LABELS.inbox, name: 'INBOX', type: 'system' },
  { remoteId: SYSTEM_LABELS.sent, name: 'SENT', type: 'system' },
  { remoteId: SYSTEM_LABELS.drafts, name: 'DRAFT', type: 'system' },
  { remoteId: SYSTEM_LABELS.unread, name: 'UNREAD', type: 'system' },
  { remoteId: SYSTEM_LABELS.trash, name: 'TRASH', type: 'system' },
  { remoteId: SYSTEM_LABELS.spam, name: 'SPAM', type: 'system' },
  { remoteId: 'Label_1', name: 'Privat', type: 'user', color: '#ff9f0a' },
  { remoteId: 'Label_2', name: 'Finanzen', type: 'user', color: '#28a745' }
])
store.labels.replaceAll(workspace.id, [
  { remoteId: SYSTEM_LABELS.inbox, name: 'INBOX', type: 'system' },
  { remoteId: SYSTEM_LABELS.sent, name: 'SENT', type: 'system' },
  { remoteId: SYSTEM_LABELS.unread, name: 'UNREAD', type: 'system' },
  { remoteId: SYSTEM_LABELS.trash, name: 'TRASH', type: 'system' },
  { remoteId: SYSTEM_LABELS.spam, name: 'SPAM', type: 'system' },
  { remoteId: 'Label_3', name: 'Kunden', type: 'user', color: '#0a7aff' },
  { remoteId: 'Label_4', name: 'Rechnungen', type: 'user', color: '#bf5af2' },
  { remoteId: 'Label_5', name: 'Projekte', type: 'user', color: '#64d2ff' }
])

const domains = ['beispielweb.ch', 'nordwind.ch', 'rechnix.ch']
const resendAccounts = domains.map((domain) => {
  const account = store.accounts.upsert({
    kind: 'resend',
    email: domain,
    displayName: domain,
    resendDomainId: `dom_${domain}`,
    resendRegion: 'eu-west-1',
    receivingEnabled: true
  })
  store.labels.ensureSystemLabels(account.id)
  return account
})

store.identities.create({
  accountId: resendAccounts[0]!.id,
  name: 'Max Muster',
  email: 'kontakt@beispielweb.ch',
  isDefault: true,
  signatureHtml: '<p>Freundliche Grüsse<br>Max Muster</p>'
})
store.identities.create({
  accountId: workspace.id,
  name: 'Max Muster',
  email: 'max@muster-it.ch',
  isDefault: true,
  source: 'gmail_sendas'
})
store.identities.create({
  accountId: workspace.id,
  name: 'Muster IT',
  email: 'kontakt@muster-it.ch',
  source: 'gmail_sendas'
})

interface Seed {
  accountId: string
  remoteId: string
  threadRemoteId?: string
  subject: string
  fromName: string
  fromEmail: string
  toEmail: string
  minutesAgo: number
  text: string
  unread?: boolean
  outgoing?: boolean
}

const seeds: Seed[] = [
  {
    accountId: gmail.id,
    remoteId: 'g1',
    subject: 'Security alert: lodash dependency',
    fromName: 'GitHub',
    fromEmail: 'noreply@github.com',
    toEmail: 'max.muster@gmail.com',
    minutesAgo: 18,
    text: 'A vulnerability was found in one of your repositories',
    unread: true
  },
  {
    accountId: resendAccounts[0]!.id,
    remoteId: 'r1',
    threadRemoteId: 'thread-relaunch',
    subject: 'Website-Relaunch Malergeschäft',
    fromName: 'Sandra Keller',
    fromEmail: 's.keller@keller-farben.ch',
    toEmail: 'kontakt@beispielweb.ch',
    minutesAgo: 48,
    text: 'Guten Tag\n\nWir möchten unsere Website erneuern lassen. Die aktuelle Seite ist rund zehn Jahre alt und nicht für Mobilgeräte optimiert. Uns schwebt ein moderner Auftritt mit Referenzfotos unserer Projekte vor.\n\nKönnen Sie uns eine grobe Einschätzung zu Kosten und Zeitrahmen geben?\n\nFreundliche Grüsse\nSandra Keller'
  },
  {
    accountId: resendAccounts[0]!.id,
    remoteId: 'r2',
    threadRemoteId: 'thread-relaunch',
    subject: 'Re: Website-Relaunch Malergeschäft',
    fromName: 'Max Muster',
    fromEmail: 'kontakt@beispielweb.ch',
    toEmail: 's.keller@keller-farben.ch',
    minutesAgo: 25,
    outgoing: true,
    text: 'Guten Tag Frau Keller\n\nBesten Dank für Ihre Anfrage. Gerne schaue ich mir Ihre aktuelle Website an und melde mich bis morgen mit einer ersten Einschätzung inklusive Kostenrahmen.'
  },
  {
    accountId: workspace.id,
    remoteId: 'w1',
    subject: "Auszahlung über CHF 1'240.00",
    fromName: 'Stripe',
    fromEmail: 'no-reply@stripe.com',
    toEmail: 'max@muster-it.ch',
    minutesAgo: 95,
    text: 'Deine Auszahlung ist unterwegs auf dein Konto'
  },
  {
    accountId: workspace.id,
    remoteId: 'w2',
    subject: 'Re: Offerte Onlineshop',
    fromName: 'Marco Bianchi',
    fromEmail: 'm.bianchi@bianchi-velo.ch',
    toEmail: 'kontakt@muster-it.ch',
    minutesAgo: 120,
    unread: true,
    text: 'Besten Dank für die Offerte, wir hätten noch zwei Fragen'
  },
  {
    accountId: resendAccounts[1]!.id,
    remoteId: 'n1',
    subject: 'Neue Registrierung: studio-graf',
    fromName: 'nordwind',
    fromEmail: 'system@nordwind.ch',
    toEmail: 'hallo@nordwind.ch',
    minutesAgo: 60 * 26,
    text: 'Ein neuer Account wurde soeben erstellt'
  },
  {
    accountId: gmail.id,
    remoteId: 'g2',
    subject: 'Rechnung für Google Workspace',
    fromName: 'Google Payments',
    fromEmail: 'payments-noreply@google.com',
    toEmail: 'max.muster@gmail.com',
    minutesAgo: 60 * 27,
    text: 'Ihre Rechnung für August ist verfügbar'
  },
  {
    accountId: workspace.id,
    remoteId: 'w3',
    subject: 'Terminverschiebung Kickoff',
    fromName: 'Lisa Steiner',
    fromEmail: 'l.steiner@steiner-revision.ch',
    toEmail: 'max@muster-it.ch',
    minutesAgo: 60 * 30,
    unread: true,
    text: 'Könnten wir den Kickoff auf Donnerstag verschieben?'
  },
  {
    accountId: resendAccounts[2]!.id,
    remoteId: 'b1',
    subject: 'Entwurf #1043 versendet',
    fromName: 'rechnix',
    fromEmail: 'system@rechnix.ch',
    toEmail: 'hallo@rechnix.ch',
    minutesAgo: 60 * 24 * 2,
    text: 'Der Rechnungsentwurf wurde an den Kunden gesendet'
  }
]

for (const seed of seeds) {
  const id = messageKey(seed.accountId, seed.remoteId)
  store.messages.upsert({
    id,
    accountId: seed.accountId,
    threadId: threadKey(seed.accountId, seed.threadRemoteId ?? seed.remoteId),
    remoteId: seed.remoteId,
    messageIdHeader: `<${seed.remoteId}@demo.local>`,
    subject: seed.subject,
    from: { name: seed.fromName, email: seed.fromEmail },
    to: [{ name: null, email: seed.toEmail }],
    date: now - seed.minutesAgo * 60_000,
    direction: seed.outgoing ? 'outgoing' : 'incoming',
    labelRemoteIds: seed.outgoing
      ? [SYSTEM_LABELS.inbox, SYSTEM_LABELS.sent]
      : seed.unread
        ? [SYSTEM_LABELS.inbox, SYSTEM_LABELS.unread]
        : [SYSTEM_LABELS.inbox],
    body: {
      html: seed.text
        .split('\n\n')
        .map((paragraph) => `<p>${paragraph.replace(/\n/g, '<br>')}</p>`)
        .join(''),
      text: seed.text
    }
  })
}

// Older mail so the list has depth beyond the visible page.
for (let i = 0; i < 40; i += 1) {
  const account = i % 2 === 0 ? workspace : gmail
  const id = messageKey(account.id, `old-${i}`)
  store.messages.upsert({
    id,
    accountId: account.id,
    threadId: threadKey(account.id, `old-${i}`),
    remoteId: `old-${i}`,
    subject: `Archivierte Nachricht ${i + 1}`,
    from: { name: 'Newsletter', email: 'news@example.com' },
    to: [{ name: null, email: account.email }],
    date: now - (3 + i) * day,
    labelRemoteIds: [SYSTEM_LABELS.inbox],
    body: { html: null, text: 'Ältere Nachricht aus dem lokalen Archiv.' }
  })
}

store.close()
console.info(`Demo-Daten in ${userDataPath} angelegt.`)
