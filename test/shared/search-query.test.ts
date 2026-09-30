import { describe, expect, it } from 'vitest'
import { filterToText, parseSearchQuery, resolveDate } from '@shared/search-query'

describe('search query parser', () => {
  it('splits free text from operators', () => {
    const parsed = parseSearchQuery('offerte from:sandra is:unread')
    expect(parsed.terms).toEqual(['offerte'])
    expect(parsed.filters).toEqual([
      { field: 'from', value: 'sandra', negated: false },
      { field: 'is', value: 'unread', negated: false }
    ])
  })

  it('keeps quoted runs as phrases and supports quoted operator values', () => {
    const parsed = parseSearchQuery('subject:"Rechnung Januar" "zwei worte"')
    expect(parsed.phrases).toEqual(['zwei worte'])
    expect(parsed.filters).toEqual([
      { field: 'subject', value: 'Rechnung Januar', negated: false }
    ])
  })

  it('reads a leading dash as negation', () => {
    expect(parseSearchQuery('-from:noreply@example.com').filters).toEqual([
      { field: 'from', value: 'noreply@example.com', negated: true }
    ])
  })

  it('treats unknown prefixes, URLs and German colons as free text', () => {
    const parsed = parseSearchQuery('Re: Angebot https://beispielweb.ch foo:bar')
    expect(parsed.filters).toEqual([])
    expect(parsed.terms).toEqual(['Re:', 'Angebot', 'https://beispielweb.ch', 'foo:bar'])
  })

  it('rejects operator values outside their vocabulary', () => {
    expect(parseSearchQuery('is:gelesen').filters).toEqual([])
    expect(parseSearchQuery('is:gelesen').terms).toEqual(['is:gelesen'])
    expect(parseSearchQuery('after:irgendwann').terms).toEqual(['after:irgendwann'])
  })

  it('drops operators without a value', () => {
    const parsed = parseSearchQuery('from:')
    expect(parsed.filters).toEqual([])
    expect(parsed.terms).toEqual(['from:'])
  })

  it('renders filters back into typed text', () => {
    expect(filterToText({ field: 'from', value: 'a@b.ch', negated: true })).toBe('-from:a@b.ch')
    expect(filterToText({ field: 'subject', value: 'zwei worte', negated: false })).toBe(
      'subject:"zwei worte"'
    )
  })
})

describe('date operands', () => {
  const now = new Date(2026, 7, 20, 14, 30).getTime()

  it('reads ISO and Swiss dates as local midnight', () => {
    expect(resolveDate('2026-01-31', now)).toBe(new Date(2026, 0, 31).getTime())
    expect(resolveDate('31.1.2026', now)).toBe(new Date(2026, 0, 31).getTime())
  })

  it('reads relative spans', () => {
    expect(resolveDate('7d', now)).toBe(new Date(2026, 7, 13, 14, 30).getTime())
    expect(resolveDate('2w', now)).toBe(new Date(2026, 7, 6, 14, 30).getTime())
    expect(resolveDate('1y', now)).toBe(new Date(2025, 7, 20, 14, 30).getTime())
  })

  it('refuses nonsense', () => {
    expect(resolveDate('gestern', now)).toBeNull()
    expect(resolveDate('2026-13-01', now)).toBeNull()
  })
})
