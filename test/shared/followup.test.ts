import { describe, expect, it } from 'vitest'
import {
  addWorkingDays,
  isAutoReplyHeaders,
  isAutoReplySubject,
  isFollowUpCandidate,
  isNoReplyAddress
} from '@shared/followup'

/** Local noon, so no test result can hinge on a timezone rolling the date. */
function at(year: number, month: number, day: number, hour = 12): number {
  return new Date(year, month - 1, day, hour, 0, 0, 0).getTime()
}

describe('working-day arithmetic', () => {
  it('skips the weekend', () => {
    // Friday + 3 working days is Wednesday, not Monday.
    const friday = at(2026, 8, 21)
    expect(new Date(addWorkingDays(friday, 3)).getDay()).toBe(3)
    expect(addWorkingDays(friday, 3)).toBe(at(2026, 8, 26))
  })

  it('counts from a weekend forwards, not backwards', () => {
    // Saturday + 1 is Monday: Sunday is not a working day either.
    expect(addWorkingDays(at(2026, 8, 22), 1)).toBe(at(2026, 8, 24))
  })

  it('keeps the time of day', () => {
    const monday = at(2026, 8, 17, 9)
    expect(new Date(addWorkingDays(monday, 2)).getHours()).toBe(9)
  })

  it('treats a zero or negative wait as no wait at all', () => {
    const monday = at(2026, 8, 17)
    expect(addWorkingDays(monday, 0)).toBe(monday)
    expect(addWorkingDays(monday, -3)).toBe(monday)
  })
})

describe('addresses that never write back', () => {
  it('recognises the usual machine mailboxes, tags included', () => {
    for (const address of [
      'no-reply@stripe.com',
      'noreply@github.com',
      'noreply+abc@github.com',
      'donotreply@bank.ch',
      'bounce-7f3a@sendgrid.net',
      'MAILER-DAEMON@example.com',
      'notifications@slack.com'
    ]) {
      expect(isNoReplyAddress(address), address).toBe(true)
    }
  })

  it('leaves ordinary addresses alone', () => {
    for (const address of [
      's.keller@keller-farben.ch',
      'max@muster-it.ch',
      // Contains "alert" but is not the automated mailbox itself.
      'alertag@example.ch',
      'reply@example.ch'
    ]) {
      expect(isNoReplyAddress(address), address).toBe(false)
    }
  })
})

describe('which mails may expect an answer', () => {
  const person = { name: null, email: 's.keller@keller-farben.ch' }

  it('accepts a mail to a person', () => {
    expect(isFollowUpCandidate([person])).toBe(true)
  })

  it('rejects a mail with no recipients at all', () => {
    expect(isFollowUpCandidate([])).toBe(false)
  })

  it('rejects a mail only to machines', () => {
    expect(isFollowUpCandidate([{ name: null, email: 'noreply@stripe.com' }])).toBe(false)
  })

  it('accepts a mail that reaches at least one person', () => {
    expect(isFollowUpCandidate([{ name: null, email: 'noreply@stripe.com' }, person])).toBe(true)
  })

  it('rejects an announcement to a whole list', () => {
    const many = Array.from({ length: 6 }, (_, index) => ({
      name: null,
      email: `person${index}@example.ch`
    }))
    expect(isFollowUpCandidate(many)).toBe(false)
  })
})

describe('telling an auto-reply from an answer', () => {
  it('reads the headers a responder sets', () => {
    expect(isAutoReplyHeaders({ 'auto-submitted': 'auto-replied' })).toBe(true)
    expect(isAutoReplyHeaders({ precedence: 'auto_reply' })).toBe(true)
    expect(isAutoReplyHeaders({ 'list-id': '<dev.example.ch>' })).toBe(true)
    expect(isAutoReplyHeaders({ 'x-autoreply': 'yes' })).toBe(true)
  })

  it('treats "Auto-Submitted: no" as the answer it claims to be', () => {
    expect(isAutoReplyHeaders({ 'auto-submitted': 'no' })).toBe(false)
    expect(isAutoReplyHeaders({})).toBe(false)
  })

  it('recognises an absence notice by its subject', () => {
    expect(isAutoReplySubject('Automatische Antwort: Offerte')).toBe(true)
    expect(isAutoReplySubject('Abwesenheitsnotiz')).toBe(true)
    expect(isAutoReplySubject('Out of office')).toBe(true)
    // A reply prefix in front of it changes nothing about what it is.
    expect(isAutoReplySubject('AW: Automatische Antwort: Offerte')).toBe(true)
  })

  it('does not mistake an ordinary German reply for one', () => {
    // "AW:" is Re:, not "auto" — the very confusion this has to survive.
    expect(isAutoReplySubject('AW: Offerte Website')).toBe(false)
    expect(isAutoReplySubject('Re: Offerte')).toBe(false)
    expect(isAutoReplySubject('Antwort auf die Offerte')).toBe(false)
  })
})
