// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useRichTextEditor } from '@renderer/components/Editor'
import { QUOTE_MARKER, SIGNATURE_MARKER, stripSignature, withSignature } from '@renderer/lib/compose'
import { draftText, modeForDraft, splitDraft } from '@renderer/lib/ai'

const SIGNATURE = '<p>Freundliche Grüsse<br>Max Muster</p>'

/** What the editor gives back after it has parsed the html once. */
function roundTrip(html: string): string {
  const { result } = renderHook(() => useRichTextEditor(html, () => undefined))
  return result.current?.getHTML() ?? ''
}

describe('marked blocks survive the editor', () => {
  it('keeps the signature marker, so the block stays recognisable', () => {
    const html = roundTrip(withSignature('<p>Hoi Marco</p>', SIGNATURE))
    expect(html).toContain(SIGNATURE_MARKER)
    expect(stripSignature(html)).not.toContain('Max Muster')
  })

  it('keeps the forwarded original apart from the draft', () => {
    const html = roundTrip(`<p>Schau mal</p><div ${QUOTE_MARKER}="true"><p>Fremde Mail</p></div>`)
    expect(html).toContain(QUOTE_MARKER)
    const { body, quote } = splitDraft(html)
    expect(body).toContain('Schau mal')
    expect(body).not.toContain('Fremde Mail')
    expect(quote).toContain('Fremde Mail')
  })

  it('hands the signature back exactly as it went in', () => {
    const table =
      '<table cellpadding="0" style="border-collapse:collapse">' +
      '<tbody><tr><td style="border-right:2px solid #14b8a6;padding-right:12px">' +
      '<img src="https://example.test/hd.png" width="64" height="64" alt="HD">' +
      '</td><td style="padding-left:12px">Max Muster</td></tr></tbody></table>'
    const html = roundTrip(withSignature('<p>Hoi</p>', table))
    expect(html).toContain('border-right:2px solid #14b8a6')
    expect(html).toContain('width="64"')
    // The editor's own table markup would announce itself here.
    expect(html).not.toContain('min-width')
  })

  it('leaves the quoted original untouched, cell styles and all', () => {
    const quote =
      `<div ${QUOTE_MARKER}="true"><table><tbody><tr>` +
      '<td valign="top" width="40"><img src="https://example.test/avatar.png" width="40" height="40" alt=""></td>' +
      '<td style="padding-left:8px">Jae (Pexels)</td></tr></tbody></table></div>'
    const html = roundTrip(`<p>Hoi</p>${quote}`)
    expect(html).toContain('valign="top"')
    expect(html).toContain('padding-left:8px')
    expect(html).not.toContain('colspan="1"')
  })

  it('replaces the signature on an identity change instead of stacking one on', () => {
    const once = roundTrip(withSignature('<p>Hoi Marco</p>', SIGNATURE))
    const twice = withSignature(once, '<p>Beste Grüsse<br>Beispielweb</p>')
    expect(twice).not.toContain('Max Muster')
    expect(twice.match(new RegExp(SIGNATURE_MARKER, 'g'))).toHaveLength(1)
  })

  it('starts the draft above the signature, not inside it', () => {
    const seeded = withSignature('', SIGNATURE)
    expect(seeded.indexOf('<p></p>')).toBeLessThan(seeded.indexOf(SIGNATURE_MARKER))
  })

  it('strips the signature even with a paragraph left behind it', () => {
    const trailing = `<p>Hoi</p><div ${SIGNATURE_MARKER}="true">${SIGNATURE}</div><p></p>`
    expect(stripSignature(trailing)).toBe('<p>Hoi</p><p></p>')
  })

  it('strips a signature that brings its own nested divs', () => {
    const nested = `<div ${SIGNATURE_MARKER}="true"><div>Max</div><div>081</div></div><p>x</p>`
    expect(stripSignature(nested)).toBe('<p>x</p>')
  })

  it('reads a mail that holds nothing but a signature as empty', () => {
    const html = roundTrip(withSignature('', SIGNATURE))
    expect(draftText(html)).toBe('')
    // This is what decides whether the assistant writes or reworks.
    expect(modeForDraft(html)).toBe('draft')
  })
})
