import { describe, expect, it } from 'vitest'
import {
  autoValues,
  hasPlaceholders,
  openVariables,
  renderSubject,
  renderTemplate,
  scanTemplate
} from '@shared/template-vars'

const CONTEXT = {
  recipientName: 'Sandra Keller',
  recipientEmail: 's.keller@keller-farben.ch',
  senderName: 'Max Muster',
  senderEmail: 'max@muster-it.ch',
  subject: '',
  date: '21. August 2026'
}

describe('placeholder scanning', () => {
  it('finds each placeholder once, in the order it appears', () => {
    const html = '<p>Hallo {{empfaenger.vorname}}, der Betrag ist {{Betrag}}.</p><p>{{Betrag}}</p>'
    expect(scanTemplate(html)).toEqual(['empfaenger.vorname', 'Betrag'])
  })

  it('ignores braces that run across a tag', () => {
    // A single brace pair that swallowed markup would take the tag with it
    // when the value is substituted in.
    expect(scanTemplate('<p>{{ <b>nicht</b> }}</p>')).toEqual([])
  })

  it('leaves ordinary braces alone', () => {
    expect(hasPlaceholders('<p>{ kein Platzhalter }</p>')).toBe(false)
    expect(hasPlaceholders('<p>{{Betrag}}</p>')).toBe(true)
  })
})

describe('automatic values', () => {
  it('splits the recipient name into what one writes on an envelope', () => {
    const values = autoValues(CONTEXT)
    expect(values['empfaenger.vorname']).toBe('Sandra')
    expect(values['empfaenger.name']).toBe('Sandra Keller')
    expect(values['absender.name']).toBe('Max Muster')
    expect(values['datum']).toBe('21. August 2026')
  })

  it('leaves out what it does not know rather than filling in nothing', () => {
    const values = autoValues({ ...CONTEXT, recipientName: null, subject: '' })
    expect(values['empfaenger.vorname']).toBeUndefined()
    expect(values['betreff']).toBeUndefined()
    // Which is exactly what puts it in front of the user instead.
    expect(openVariables('<p>{{empfaenger.vorname}}</p>', values)).toEqual([
      'empfaenger.vorname'
    ])
  })
})

describe('rendering', () => {
  it('fills what it has and keeps what it has not', () => {
    const html = '<p>Hallo {{empfaenger.vorname}}, es geht um {{Projekt}}.</p>'
    const filled = renderTemplate(html, autoValues(CONTEXT))
    expect(filled).toContain('Hallo Sandra')
    // The unanswered one stays visible — the send guard reads exactly this.
    expect(filled).toContain('{{Projekt}}')
    expect(hasPlaceholders(filled)).toBe(true)
  })

  it('escapes values going into the body', () => {
    const filled = renderTemplate('<p>{{firma}}</p>', { firma: 'Meier & <b>Söhne</b>' })
    expect(filled).toBe('<p>Meier &amp; &lt;b&gt;Söhne&lt;/b&gt;</p>')
  })

  it('does not escape the subject, which is text', () => {
    expect(renderSubject('Offerte für {{firma}}', { firma: 'Meier & Söhne' })).toBe(
      'Offerte für Meier & Söhne'
    )
  })

  it('treats an empty answer as no answer', () => {
    // Submitting the fill dialog with a field left blank must not quietly cut
    // a hole in the mail; the placeholder survives and blocks the send.
    expect(renderTemplate('<p>{{Betrag}}</p>', { Betrag: '' })).toBe('<p>{{Betrag}}</p>')
  })
})
