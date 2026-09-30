import { describe, expect, it } from 'vitest'
import { applyChanges, countChanges, diffWords, tokenize } from '@renderer/lib/diff'

describe('word diff', () => {
  it('keeps identical text as one equal part', () => {
    expect(diffWords('Guten Tag', 'Guten Tag')).toEqual([{ kind: 'equal', text: 'Guten Tag' }])
  })

  it('pairs a replaced word into a single change', () => {
    const parts = diffWords('Liebe Grüsse Max', 'Freundliche Grüsse Max')
    expect(countChanges(parts)).toBe(1)
    expect(parts[0]).toEqual({ kind: 'change', before: 'Liebe', after: 'Freundliche' })
  })

  it('records a pure insertion with an empty before side', () => {
    const parts = diffWords('Danke für die Info', 'Danke vielmals für die Info')
    expect(countChanges(parts)).toBe(1)
    const change = parts.find((part) => part.kind === 'change')
    expect(change).toMatchObject({ before: '' })
    expect((change as { after: string }).after.trim()).toBe('vielmals')
  })

  it('records a pure deletion with an empty after side', () => {
    const parts = diffWords('Danke vielmals für die Info', 'Danke für die Info')
    const change = parts.find((part) => part.kind === 'change')
    expect(change).toMatchObject({ after: '' })
    expect((change as { before: string }).before.trim()).toBe('vielmals')
  })

  it('reassembles the original when every change is rejected', () => {
    const before = 'Ich melde mich morgen bei dir.'
    const parts = diffWords(before, 'Ich melde mich übermorgen bei Ihnen zurück.')
    expect(applyChanges(parts, new Set())).toBe(before)
  })

  it('reassembles the proposal when every change is accepted', () => {
    const after = 'Ich melde mich übermorgen bei Ihnen zurück.'
    const parts = diffWords('Ich melde mich morgen bei dir.', after)
    const all = new Set(parts.map((_, index) => index))
    expect(applyChanges(parts, all)).toBe(after)
  })

  it('mixes accepted and rejected changes word by word', () => {
    const parts = diffWords('Hallo Herr Meier, danke', 'Guten Tag Herr Meier, vielen Dank')
    expect(countChanges(parts)).toBe(2)
    // Take the greeting, keep the original thanks.
    const text = applyChanges(parts, new Set([0]))
    expect(text).toContain('Guten Tag')
    expect(text).toContain('danke')
    expect(text).not.toContain('vielen Dank')
  })

  it('keeps a multi-word replacement as one decision', () => {
    const parts = diffWords('Hallo Herr Meier', 'Guten Tag Herr Meier')
    expect(countChanges(parts)).toBe(1)
    expect(applyChanges(parts, new Set())).toBe('Hallo Herr Meier')
    expect(applyChanges(parts, new Set([0]))).toBe('Guten Tag Herr Meier')
  })

  it('does not merge changes across a paragraph break', () => {
    const parts = diffWords('Erste\n\nZweite', 'Dritte\n\nVierte')
    expect(countChanges(parts)).toBe(2)
    expect(applyChanges(parts, new Set([0]))).toBe('Dritte\n\nZweite')
  })

  it('keeps whitespace so the parts join back to the exact text', () => {
    const before = 'Erste Zeile\n\nZweite  Zeile'
    const after = 'Erste Zeile\n\nDritte  Zeile'
    const parts = diffWords(before, after)
    expect(applyChanges(parts, new Set())).toBe(before)
    expect(applyChanges(parts, new Set(parts.map((_, i) => i)))).toBe(after)
  })

  it('splits into words and the whitespace between them', () => {
    expect(tokenize('a  b\nc')).toEqual(['a', '  ', 'b', '\n', 'c'])
  })
})
