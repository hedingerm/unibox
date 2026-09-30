import type { EmailAddress, Message } from '@shared/types'
import { isNoReplyAddress } from '@shared/followup'
import type { Store } from '../db/store'
import { parseAddressList } from '../mime/addresses'
import { ownWords, stripHtml } from './text'

/** How the user addresses this person. Observed, never guessed. */
export type AddressForm = 'du' | 'sie'

export interface DossierMessage {
  from: string
  date: string
  direction: 'incoming' | 'outgoing'
  subject: string
  excerpt: string
}

export interface RecipientDossier {
  email: string
  name: string | null
  form: AddressForm | null
  /** The greeting the user opened their last mail to this address with. */
  salutation: string | null
  signOff: string | null
  /** In words — "vor 3 Tagen". Null when the archive holds nothing. */
  lastContact: string | null
  count: number
  /** Empty when a conversation travels with the prompt; that one wins. */
  messages: DossierMessage[]
}

/**
 * People the dossier is built for. Beyond a handful the mail is a circular, and
 * a circular has no single recipient to know anything about.
 */
export const MAX_RECIPIENTS = 3

/** Mails per recipient. Fewer than the thread carries — this is background. */
export const DOSSIER_DEPTH = 4

/** Characters per mail. A third of a thread excerpt: enough for tone. */
export const DOSSIER_EXCERPT_LENGTH = 400

/** What a greeting is worth against loose pronouns. Two: it is deliberate. */
const GREETING_WEIGHT = 2

/** Mails read for the address form, newest first. */
const SAMPLE_DEPTH = 6

const INFORMAL =
  /\b(du|dir|dich|dein\w*|euch|eue?re?\w*|hesch|chasch|bisch|wotsch|magsch|weisch)\b/gi
// Case-sensitive: lowercase "sie"/"ihr" is she, they or her. A capitalised
// "Sie" only counts mid-sentence — at the start of one it is just as likely to
// be the third person plural, and a wrong form is the one mistake that shows.
const FORMAL_UNAMBIGUOUS = /\b(Ihnen|Ihre[nmrs]?|Ihr)\b/g
const FORMAL_MIDSENTENCE = /[a-zäöüß,]\s+Sie\b/g

const GREETING =
  /^(hoi|sali|salü|hallo|hi|hey|guete morge|guten morgen|guten tag|grüezi|grüessech|liebe[rs]?|sehr geehrte[rs]?|werte[rs]?|dear|bonjour|ciao)\b/i
const SIGN_OFF =
  /^(liebe grüsse|liebi grüess|freundliche grüsse|beste grüsse|herzliche grüsse|schöne grüsse|viele grüsse|grüsse|gruess|gruass|gruss|lg|glg|merci|besten dank|vielen dank|best regards|kind regards|regards|cheers|best)\b/i


function count(text: string, pattern: RegExp): number {
  return text.match(pattern)?.length ?? 0
}

function lines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

function relativeDate(then: number, now: number): string {
  const days = Math.floor((now - then) / (24 * 60 * 60 * 1000))
  if (days <= 0) return 'heute'
  if (days === 1) return 'gestern'
  if (days < 14) return `vor ${days} Tagen`
  if (days < 60) return `vor ${Math.round(days / 7)} Wochen`
  if (days < 365) return `vor ${Math.round(days / 30)} Monaten`
  const years = Math.round(days / 365)
  return years <= 1 ? 'vor einem Jahr' : `vor ${years} Jahren`
}

function formatAddress(address: { name: string | null; email: string }): string {
  return address.name ? `${address.name} <${address.email}>` : address.email
}

/**
 * Decides between du and Sie from what was written, not from what sounds
 * likely. The most recent mail carrying any evidence decides — people move
 * from Sie to du, and a long history of Sie must not outvote the mail where
 * that happened. Without evidence the line stays out of the prompt: an absent
 * hint costs a guess, a wrong one costs the mail.
 */
export function addressForm(texts: string[]): AddressForm | null {
  for (const text of texts) {
    const greeting = greetingForm(text)
    const informal = count(text, INFORMAL) + (greeting === 'du' ? GREETING_WEIGHT : 0)
    const formal =
      count(text, FORMAL_UNAMBIGUOUS) +
      count(text, FORMAL_MIDSENTENCE) +
      (greeting === 'sie' ? GREETING_WEIGHT : 0)
    if (informal === 0 && formal === 0) continue
    return informal > formal ? 'du' : 'sie'
  }
  return null
}

/**
 * The greeting alone often settles it — and it is all there is in the mails
 * that carry no pronoun at all ("Hoi Marco. Passt so. Gruass"), which is the
 * shape most short mail takes. A surname behind the greeting outranks the
 * greeting itself: "Hallo Herr Meier" is a Sie in a friendly voice.
 */
function greetingForm(text: string): AddressForm | null {
  const greeting = greetingOf(text)
  if (!greeting) return null
  if (/\b(Herr|Frau)\b/.test(greeting)) return 'sie'
  if (/^(sehr geehrte|werte|dear)/i.test(greeting)) return 'sie'
  if (/^(hoi|sali|salü|hallo|hey|hi|liebe[rs]?)\b/i.test(greeting)) return 'du'
  return null
}

/**
 * The greeting and the closing the user last used, word for word. This is the
 * one string that carries name, register and language at once — and the only
 * thing left of the relationship when a thread suppresses the excerpts.
 */
export function greetingOf(text: string): string | null {
  const first = lines(text)[0]
  if (!first || first.length > 70 || !GREETING.test(first)) return null
  return first.replace(/[,!]+$/, '')
}

/**
 * Everything above the closing. A sent mail comes back from Gmail with its
 * signature attached, and a footer like "Besuchen Sie uns auf …" would count
 * as a Sie in every single mail — a short "Hoi Marco, passt. Gruass" has no
 * pronoun of its own to outvote it with.
 */
export function beforeSignature(text: string): string {
  const rows = text.split('\n')
  const closing = rows
    .map((line, index) => ({ line: line.trim(), index }))
    .filter((row) => row.line.length > 0)
    // Never the opening line: "Besten Dank" starts as many mails as it ends.
    .slice(1)
    .filter((row) => /^--\s*$/.test(row.line) || (row.line.length <= 40 && SIGN_OFF.test(row.line)))
    .at(-1)
  return (closing ? rows.slice(0, closing.index) : rows).join('\n').trim()
}

export function signOffOf(text: string): string | null {
  // From the back: "Besten Dank" opens as many mails as it closes, and the
  // closing is by definition the last of them.
  const tail = lines(text).slice(-8).reverse()
  const hit = tail.find((line) => line.length <= 40 && SIGN_OFF.test(line))
  return hit ? hit.replace(/[,!]+$/, '') : null
}

/** The address as it should be displayed: whatever name the archive knows. */
function nameOf(email: string, messages: Message[], typed: string | null): string | null {
  for (const message of messages) {
    if (message.from.email.toLowerCase() === email && message.from.name) return message.from.name
    const named = [...message.to, ...message.cc].find(
      (address) => address.email.toLowerCase() === email && address.name
    )
    if (named?.name) return named.name
  }
  return typed
}

interface ReadMessage {
  message: Message
  /** The sender's own words: quoted original already cut away. */
  text: string
}

function read(store: Store, history: { messages: Message[] }): ReadMessage[] {
  return history.messages.map((message) => {
    const body = store.messages.body(message.id)
    const text = body.text?.trim() || (body.html ? stripHtml(body.html) : '') || message.snippet
    return { message, text: ownWords(text) }
  })
}

/**
 * The mails that travel. At least two of them are the user's own where they
 * exist: seeing how someone writes back matters less than seeing how the user
 * writes to them, and the newest few alone can be all incoming.
 */
function excerpts(mixed: ReadMessage[], mine: ReadMessage[]): ReadMessage[] {
  const picked = new Map<string, ReadMessage>()
  for (const entry of mine.slice(0, 2)) picked.set(entry.message.id, entry)
  for (const entry of mixed) {
    if (picked.size >= DOSSIER_DEPTH) break
    picked.set(entry.message.id, entry)
  }
  return [...picked.values()]
    .slice(0, DOSSIER_DEPTH)
    .sort((a, b) => b.message.date - a.message.date)
}

export interface DossierRequest {
  to: string
  cc: string
  /** Whether a conversation travels with the prompt; it outranks old mail. */
  isReply: boolean
  now: number
}

/**
 * What the archive knows about the people this mail goes to. A vague
 * instruction — "frag ihn wegen der Offerte" — carries no salutation, no
 * language and no register; without this the model has to invent all three,
 * and inventing them is exactly how a mail comes back wrong.
 */
export function buildDossiers(store: Store, request: DossierRequest): RecipientDossier[] {
  const own = new Set(store.messages.ownAddresses())
  const seen = new Set<string>()
  const people: EmailAddress[] = []

  for (const address of [...parseAddressList(request.to), ...parseAddressList(request.cc)]) {
    const email = address.email.trim().toLowerCase()
    if (!email.includes('@') || seen.has(email)) continue
    seen.add(email)
    // The user's own addresses and mailboxes nobody reads are not people one
    // can know anything about.
    if (own.has(email) || isNoReplyAddress(email)) continue
    people.push({ name: address.name, email })
  }
  // A circular has no recipient. Handing out three dossiers for a mail to
  // eight people would describe a relationship the mail does not have.
  if (people.length > MAX_RECIPIENTS) return []

  const dossiers: RecipientDossier[] = []
  for (const address of people) {
    const email = address.email

    const history = store.messages.correspondenceWith(email, SAMPLE_DEPTH)
    // Someone the archive has never seen gets no entry at all. "Kein früherer
    // Kontakt" would only invite the model to write a sentence about it.
    if (history.count === 0) continue

    // Own mail is asked for separately, not filtered out of the newest few:
    // someone who writes more often than they are written to would push every
    // own mail out of the window, and the fallback is meant for never having
    // written — not for having written a while ago.
    const mine = read(store, store.messages.correspondenceWith(email, SAMPLE_DEPTH, 'outgoing'))
    const texts = read(store, history)
    const theirs = texts.filter((entry) => entry.message.direction === 'incoming')
    const lastMine = mine[0]?.text ?? ''

    dossiers.push({
      email,
      name: nameOf(email, history.messages, address.name?.trim() || null),
      // How the user writes to someone is the thing being reproduced; only
      // when they never wrote does the other side's form stand in.
      form:
        addressForm(mine.map((entry) => beforeSignature(entry.text))) ??
        addressForm(theirs.map((entry) => beforeSignature(entry.text))),
      salutation: greetingOf(lastMine),
      signOff: signOffOf(lastMine),
      lastContact: history.lastAt === null ? null : relativeDate(history.lastAt, request.now),
      count: history.count,
      // Answering a conversation already comes with that conversation. Older
      // mail on top would only push it out of view.
      messages: request.isReply
        ? []
        : excerpts(texts, mine).map(({ message, text }) => ({
            from: formatAddress(message.from),
            date: new Date(message.date).toISOString().slice(0, 16).replace('T', ' '),
            direction: message.direction,
            subject: message.subject,
            excerpt: text.slice(0, DOSSIER_EXCERPT_LENGTH)
          }))
    })
  }
  return dossiers
}
