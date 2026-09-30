// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import {
  QUOTE_MARKER,
  buildForwardHtml,
  forwardSubject,
  withSignature,
  type ForwardSource
} from '@renderer/lib/compose'

const source: ForwardSource = {
  from: { name: 'Anna Muster', email: 'anna@example.com' },
  to: [{ name: null, email: 'max@beispielweb.ch' }],
  cc: [],
  subject: 'Offerte Website',
  date: Date.UTC(2026, 7, 20, 8, 30),
  body: { html: '<p>Hallo Max</p>', text: null }
}

describe('forward subject', () => {
  it('prefixes once and keeps an existing prefix', () => {
    expect(forwardSubject('Offerte')).toBe('Fwd: Offerte')
    expect(forwardSubject('Fwd: Offerte')).toBe('Fwd: Offerte')
    expect(forwardSubject('WG: Offerte')).toBe('WG: Offerte')
  })
})

describe('forwarded body', () => {
  it('quotes the original behind a header block', () => {
    const html = buildForwardHtml(source)
    expect(html).toContain(QUOTE_MARKER)
    expect(html).toContain('Anna Muster &lt;anna@example.com&gt;')
    expect(html).toContain('Offerte Website')
    expect(html).toContain('<p>Hallo Max</p>')
  })

  it('names the copied recipients only when there are any', () => {
    expect(buildForwardHtml(source)).not.toContain('Kopie:')
    const withCc = buildForwardHtml({
      ...source,
      cc: [{ name: null, email: 'buchhaltung@example.com' }]
    })
    expect(withCc).toContain('buchhaltung@example.com')
  })

  it('falls back to the plain text part', () => {
    const html = buildForwardHtml({ ...source, body: { html: null, text: 'Nur Text' } })
    expect(html).toContain('Nur Text')
  })

  it('keeps remote images and resolves embedded ones to data URIs', () => {
    const remote = buildForwardHtml({
      ...source,
      body: { html: '<p><img src="https://example.com/logo.png"></p>', text: null }
    })
    expect(remote).toContain('https://example.com/logo.png')

    const embedded = buildForwardHtml(
      { ...source, body: { html: '<p><img src="cid:logo@mail"></p>', text: null } },
      { 'logo@mail': 'data:image/png;base64,AAA' }
    )
    expect(embedded).toContain('data:image/png;base64,AAA')
  })

  it('drops scripts from the original', () => {
    const html = buildForwardHtml({
      ...source,
      body: { html: '<p>Hi</p><script>alert(1)</script>', text: null }
    })
    expect(html).not.toContain('<script')
  })
})

describe('signature placement', () => {
  it('sits above the forwarded original instead of below it', () => {
    const draft = withSignature(buildForwardHtml(source), '<p>Max</p>')
    expect(draft.indexOf('<p>Max</p>')).toBeLessThan(draft.indexOf(QUOTE_MARKER))
  })

  it('still replaces itself when the identity changes', () => {
    const first = withSignature(buildForwardHtml(source), '<p>Max</p>')
    const second = withSignature(first, '<p>Beispielweb</p>')
    expect(second).toContain('<p>Beispielweb</p>')
    expect(second).not.toContain('<p>Max</p>')
    expect(second.indexOf('<p>Beispielweb</p>')).toBeLessThan(second.indexOf(QUOTE_MARKER))
  })
})
