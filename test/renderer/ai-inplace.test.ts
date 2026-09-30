// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { stripHtml } from '@main/ai/text'
import { diffWords } from '@renderer/lib/diff'
import { applyChangesToHtml } from '@renderer/lib/inplace'

/** The correction as it really runs: the draft goes out as text and comes back. */
function correct(html: string, corrected: string, accepted?: ReadonlySet<number>): string | null {
  const parts = diffWords(stripHtml(html), corrected)
  const count = parts.filter((part) => part.kind === 'change').length
  return applyChangesToHtml(
    html,
    parts,
    accepted ?? new Set(Array.from({ length: count }, (_, index) => index))
  )
}

describe('correction in place', () => {
  it('keeps a link while the words around it are corrected', () => {
    const html = '<p>Die Details stehen auf <a href="https://example.ch/preise">unserer Seite</a>.</p>'
    expect(correct(html, 'Die Details stehen auf unserer Seite.')).toBe(html)
    expect(correct(html, 'Die Angaben stehen auf unserer Seite.')).toBe(
      '<p>Die Angaben stehen auf <a href="https://example.ch/preise">unserer Seite</a>.</p>'
    )
  })

  it('corrects the words inside a link without losing the link', () => {
    const html = '<p>Mehr auf <a href="https://example.ch">unsri Seite</a>.</p>'
    expect(correct(html, 'Mehr auf unsere Seite.')).toBe(
      '<p>Mehr auf <a href="https://example.ch">unsere Seite</a>.</p>'
    )
  })

  it('keeps emphasis and the shape of a list', () => {
    const html =
      '<p><strong>Wichtig</strong>: bitte prüfen</p><ul><li><p>erstens</p></li><li><p>zweitens</p></li></ul>'
    expect(correct(html, 'Wichtig: bitte prüfe\n\n- erstens\n- zweitens')).toBe(
      '<p><strong>Wichtig</strong>: bitte prüfe</p><ul><li><p>erstens</p></li><li><p>zweitens</p></li></ul>'
    )
  })

  it('leaves a rejected change on the original wording', () => {
    // Two changes — a word between them keeps them apart as two decisions —
    // and only the second one is taken over.
    const html = '<p>Ich melde mi am nächsti Tag.</p>'
    expect(correct(html, 'Ich melde mich am nächsten Tag.', new Set([1]))).toBe(
      '<p>Ich melde mi am nächsten Tag.</p>'
    )
  })

  it('puts an added word beside a link rather than into it', () => {
    const html = '<p>Siehe <a href="https://example.ch">hier</a>.</p>'
    expect(correct(html, 'Siehe bitte hier.')).toBe(
      '<p>Siehe bitte <a href="https://example.ch">hier</a>.</p>'
    )
  })

  it('sets the model answer as text, so it cannot bring markup of its own', () => {
    const html = '<p>Hoi Marco</p>'
    expect(correct(html, 'Hoi <script>alert(1)</script>')).toBe(
      '<p>Hoi &lt;script&gt;alert(1)&lt;/script&gt;</p>'
    )
  })

  it('gives up on a draft that is not what the changes were measured against', () => {
    const parts = diffWords('Hoi Marco', 'Hoi Marco, passt so.')
    expect(applyChangesToHtml('<p>Etwas ganz anderes</p>', parts, new Set([0]))).toBeNull()
  })

  it('gives up when a change lands between the words', () => {
    // A paragraph break has no text node to live in: merging the two
    // paragraphs is beyond writing into the draft.
    const html = '<p>Erstens</p><p>Zweitens</p>'
    expect(correct(html, 'Erstens Zweitens')).toBeNull()
  })
})
