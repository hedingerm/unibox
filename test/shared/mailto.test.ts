import { describe, expect, it } from 'vitest'
import { parseMailto } from '@shared/mailto'

describe('mailto links', () => {
  it('reads a bare address', () => {
    expect(parseMailto('mailto:sandra@keller-farben.ch')).toEqual({
      to: 'sandra@keller-farben.ch',
      cc: '',
      bcc: '',
      subject: '',
      body: ''
    })
  })

  it('reads the fields a newsletter unsubscribe link carries', () => {
    const link = parseMailto(
      'mailto:unsubscribe@list.ch?subject=Abmelden%20bitte&body=Bitte%20austragen.&cc=archiv@list.ch'
    )
    expect(link?.subject).toBe('Abmelden bitte')
    expect(link?.body).toBe('Bitte austragen.')
    expect(link?.cc).toBe('archiv@list.ch')
  })

  it('keeps a plus in the address but reads one in a field as a space', () => {
    // The plus is a literal character in the address and an encoded space in a
    // query value — the same byte meaning two things in one url.
    const link = parseMailto('mailto:max+shop@muster.ch?subject=Offerte+Onlineshop')
    expect(link?.to).toBe('max+shop@muster.ch')
    expect(link?.subject).toBe('Offerte Onlineshop')
  })

  it('opens an empty composer for a link without an address', () => {
    expect(parseMailto('mailto:')?.to).toBe('')
  })

  it('survives a half-written escape instead of losing the field', () => {
    expect(parseMailto('mailto:a@b.ch?subject=100%25%20oder%zz')?.subject).toBe('100%25%20oder%zz')
  })

  it('is not a mailto link', () => {
    expect(parseMailto('https://example.ch')).toBeNull()
  })
})
