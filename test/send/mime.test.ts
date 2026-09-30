import { describe, expect, it } from 'vitest'
import { buildMimeMessage, htmlToText } from '@main/mime/build'
import { formatAddress, parseAddressList } from '@main/mime/addresses'

describe('address handling', () => {
  it('parses display names, quoted commas and encoded words', () => {
    const list = parseAddressList(
      '"Keller, Sandra" <s.keller@keller-farben.ch>, =?UTF-8?B?SsO8cmc=?= <juerg@example.ch>, plain@example.com'
    )
    expect(list).toEqual([
      { name: 'Keller, Sandra', email: 's.keller@keller-farben.ch' },
      { name: 'Jürg', email: 'juerg@example.ch' },
      { name: null, email: 'plain@example.com' }
    ])
  })

  it('encodes non-ASCII display names', () => {
    expect(formatAddress({ name: 'Jürg Müller', email: 'j@example.ch' })).toMatch(/^=\?UTF-8\?B\?/)
  })
})

describe('MIME builder', () => {
  it('builds a multipart/alternative message with both bodies', () => {
    const { raw, messageId } = buildMimeMessage({
      from: { name: 'Max Muster', email: 'kontakt@beispielweb.ch' },
      to: [{ name: null, email: 's.keller@keller-farben.ch' }],
      subject: 'Grüsse aus Zürich',
      html: '<p>Hallo</p>',
      text: 'Hallo'
    })
    expect(raw).toContain('From: Max Muster <kontakt@beispielweb.ch>')
    expect(raw).toContain('Subject: =?UTF-8?B?')
    expect(raw).toContain('multipart/alternative')
    expect(raw).toContain('Content-Type: text/plain; charset="UTF-8"')
    expect(raw).toContain('Content-Type: text/html; charset="UTF-8"')
    expect(raw).toContain(`Message-ID: ${messageId}`)
    expect(raw).toContain(Buffer.from('<p>Hallo</p>', 'utf8').toString('base64'))
  })

  it('wraps inline images in multipart/related and files in multipart/mixed', () => {
    const { raw } = buildMimeMessage({
      from: { name: null, email: 'a@b.ch' },
      to: [{ name: null, email: 'c@d.ch' }],
      subject: 'Test',
      html: '<img src="cid:bild1">',
      text: '',
      attachments: [
        { filename: 'bild.png', mimeType: 'image/png', content: 'AAAA', contentId: 'bild1', inline: true },
        { filename: 'offerte.pdf', mimeType: 'application/pdf', content: 'BBBB' }
      ]
    })
    expect(raw).toContain('multipart/mixed')
    expect(raw).toContain('multipart/related')
    expect(raw).toContain('Content-ID: <bild1>')
    expect(raw).toContain('Content-Disposition: inline; filename="bild.png"')
    expect(raw).toContain('Content-Disposition: attachment; filename="offerte.pdf"')
  })

  it('carries threading headers', () => {
    const { raw } = buildMimeMessage({
      from: { name: null, email: 'a@b.ch' },
      to: [{ name: null, email: 'c@d.ch' }],
      subject: 'Re: Test',
      html: '<p>x</p>',
      text: 'x',
      inReplyTo: '<parent@x.ch>',
      references: ['<root@x.ch>', '<parent@x.ch>']
    })
    expect(raw).toContain('In-Reply-To: <parent@x.ch>')
    expect(raw).toContain('References: <root@x.ch> <parent@x.ch>')
  })
})

describe('htmlToText', () => {
  it('produces a readable plain-text alternative', () => {
    expect(htmlToText('<p>Hallo</p><ul><li>Eins</li><li>Zwei</li></ul>')).toBe(
      'Hallo\n- Eins\n- Zwei'
    )
  })
})
