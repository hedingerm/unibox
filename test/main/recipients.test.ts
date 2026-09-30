import { describe, expect, it } from 'vitest'
import { addressForm, beforeSignature, greetingOf, signOffOf } from '@main/ai/recipients'
import { ownWords, stripHtml } from '@main/ai/text'

describe('address form', () => {
  it('reads du off the words that can only mean du', () => {
    expect(addressForm(['Hoi Marco\n\nChasch du mir das no schicke?'])).toBe('du')
  })

  it('reads Sie off Ihnen and a Sie that stands mid-sentence', () => {
    expect(addressForm(['Guten Tag\n\nKönnen Sie mir Ihre Unterlagen senden?'])).toBe('sie')
  })

  it('says nothing when nobody is addressed at all', () => {
    expect(addressForm(['Anbei die Fotos von gestern.'])).toBeNull()
  })

  it('reads the polite capitalisation as the du it is', () => {
    // "Danke Dir", "Deine Unterlagen" — capitalised, those words are never
    // anything but a du.
    expect(addressForm(['Danke Dir für Deine Unterlagen.'])).toBe('du')
  })

  it('lets a surname outrank a friendly greeting', () => {
    expect(addressForm(['Hallo Herr Meier\n\nAnbei die Fotos.'])).toBe('sie')
  })

  it('does not read a form out of a sentence that merely starts with Sie', () => {
    // "Sie finden" and "Sie melden sich" are the same three letters — one is an
    // address, the other is the third person plural.
    expect(addressForm(['Sie finden das Angebot im Anhang.'])).toBeNull()
  })

  it('lets the newest mail decide when a Sie turned into a du', () => {
    expect(
      addressForm([
        'Hoi Sandra\n\nPasst das bei dir am Donnerstag?',
        'Guten Tag Frau Keller\n\nKönnen Sie mir Ihre Unterlagen senden?'
      ])
    ).toBe('du')
  })

  it('does not cut a sentence that merely begins with "Am"', () => {
    const mail = 'Hoi Marco\n\nAm liebsten schrieb ich dir per WhatsApp, aber gut.'
    expect(ownWords(mail)).toContain('per WhatsApp')
  })

  it('ignores a Sie that belongs to the quoted original', () => {
    const mail = [
      'Hoi Marco',
      '',
      'Klar, ich schicke dir das morgen.',
      '',
      'Am 12.08.2026 schrieb Marco Bauer:',
      '> Guten Tag, können Sie mir Ihre Unterlagen zustellen?'
    ].join('\n')
    expect(addressForm([ownWords(mail)])).toBe('du')
  })
})

describe('signature', () => {
  it('keeps a short du-mail from being outvoted by its own footer', () => {
    const mail = [
      'Hoi Marco',
      '',
      'Passt so, bis Donnerstag.',
      '',
      'Gruass',
      'Max Muster',
      'Besuchen Sie uns auf muster-it.ch — wir freuen uns auf Ihren Besuch.'
    ].join('\n')
    expect(addressForm([beforeSignature(mail)])).toBe('du')
    // Without the cut the footer alone decides, and it decides wrong.
    expect(addressForm([mail])).toBe('sie')
  })

  it('does not mistake an opening thank-you for the closing', () => {
    const mail = 'Besten Dank für deine Rückmeldung.\n\nIch schaue es mir an.'
    expect(beforeSignature(mail)).toContain('Ich schaue es mir an.')
  })
})

describe('greeting and closing', () => {
  it('takes the opening line word for word, without its comma', () => {
    expect(greetingOf('Grüezi Frau Keller,\n\nBesten Dank.')).toBe('Grüezi Frau Keller')
    expect(greetingOf('Hoi Marco\n\nKlar.')).toBe('Hoi Marco')
  })

  it('takes no greeting from a mail that starts straight into the matter', () => {
    expect(greetingOf('Danke für Ihre Anfrage, ich schaue es an.')).toBeNull()
  })

  it('finds the closing above the signature', () => {
    const mail = 'Text.\n\nFreundliche Grüsse\nMax Muster\nMuster IT\n079 000 00 00'
    expect(signOffOf(mail)).toBe('Freundliche Grüsse')
  })

  it('returns nothing when the mail just stops', () => {
    expect(signOffOf('Passt so, bis Donnerstag.')).toBeNull()
  })
})

describe('plain text of a mail', () => {
  it('keeps the line structure an HTML-only body carries', () => {
    // Our own sent mail is HTML. A stripper that flattened it to one line would
    // leave every line-based reading below with nothing to read.
    const html = '<p>Grüezi Frau Keller</p><p>Besten Dank.</p><p>Freundliche Grüsse</p>'
    const text = stripHtml(html)
    expect(greetingOf(text)).toBe('Grüezi Frau Keller')
    expect(signOffOf(text)).toBe('Freundliche Grüsse')
  })

  it('keeps a paragraph a blank line apart and a break a single one', () => {
    // The draft of a correction travels through here and comes back from the
    // model as text again. Both sides have to write a paragraph the same way,
    // or the diff shows every paragraph break as a change.
    expect(stripHtml('<p>Hoi Marco</p><p>Passt so.<br>Gruass</p>')).toBe(
      'Hoi Marco\n\nPasst so.\nGruass'
    )
  })

  it('keeps the items of a list on consecutive lines', () => {
    expect(stripHtml('<ul><li><p>eins</p></li><li><p>zwei</p></li></ul>')).toBe('- eins\n- zwei')
  })
})
