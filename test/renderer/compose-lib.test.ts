import { describe, expect, it } from 'vitest'
import {
  extractInlineImages,
  formatRecipient,
  isValidRecipientList,
  parseRecipients,
  stripSignature,
  withSignature
} from '@renderer/lib/compose'

describe('signature handling', () => {
  it('appends a signature and replaces it on the next call', () => {
    const first = withSignature('<p>Hallo</p>', '<p>Max</p>')
    expect(first).toContain('<p>Hallo</p>')
    expect(first).toContain('<p>Max</p>')

    const second = withSignature(first, '<p>Beispielweb</p>')
    expect(second).toContain('<p>Beispielweb</p>')
    expect(second).not.toContain('<p>Max</p>')
    expect(stripSignature(second)).toBe('<p>Hallo</p>')
  })

  it('removes the block when the identity has no signature', () => {
    const withOne = withSignature('<p>Hallo</p>', '<p>Max</p>')
    expect(withSignature(withOne, null)).toBe('<p>Hallo</p>')
  })
})

describe('inline images', () => {
  it('replaces data URIs with CID references and collects attachments', () => {
    const png = Buffer.from('fake-png').toString('base64')
    const { html, attachments } = extractInlineImages(
      `<p><img src="data:image/png;base64,${png}"></p>`
    )
    expect(html).toMatch(/src="cid:unibox-inline-\d+@unibox\.local"/)
    expect(attachments).toHaveLength(1)
    expect(attachments[0]).toMatchObject({ mimeType: 'image/png', content: png, inline: true })
    expect(html).toContain(attachments[0]!.contentId!)
  })

  it('leaves remote images alone', () => {
    const html = '<img src="https://example.com/a.png">'
    expect(extractInlineImages(html).html).toBe(html)
  })
})

describe('recipient parsing', () => {
  it('parses comma separated addresses with display names', () => {
    expect(parseRecipients('Sandra <s@k.ch>, b@c.ch')).toEqual([
      { name: 'Sandra', email: 's@k.ch' },
      { name: null, email: 'b@c.ch' }
    ])
  })

  it('rejects incomplete input', () => {
    expect(isValidRecipientList('nicht-eine-adresse')).toBe(false)
    expect(isValidRecipientList('')).toBe(false)
    expect(isValidRecipientList('a@b.ch, kaputt')).toBe(false)
    expect(isValidRecipientList('a@b.ch')).toBe(true)
  })
})

describe('formatting a recipient', () => {
  it('keeps the display name and drops one that would tear the entry in two', () => {
    expect(formatRecipient({ name: 'Sandra Keller', email: 's@k.ch' })).toBe(
      'Sandra Keller <s@k.ch>'
    )
    expect(formatRecipient({ name: 'Keller, Sandra', email: 's@k.ch' })).toBe('s@k.ch')
    expect(formatRecipient({ name: null, email: 's@k.ch' })).toBe('s@k.ch')
  })
})
