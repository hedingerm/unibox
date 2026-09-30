// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { splitQuotedHtml, splitQuotedText } from '@renderer/lib/quote'
import { formatAgo, formatMessageDate } from '@renderer/lib/format'

describe('splitting off the quoted history', () => {
  it('cuts a Gmail reply at its quote block', () => {
    const split = splitQuotedHtml(
      '<div>Passt.</div><div class="gmail_quote"><blockquote>Alt</blockquote></div>'
    )
    expect(split.body).toBe('<div>Passt.</div>')
    expect(split.quote).toContain('Alt')
  })

  it('takes Outlook’s rule and the siblings after its header block along', () => {
    const split = splitQuotedHtml(
      '<p>Neu</p><hr><div id="divRplyFwdMsg">Von: A</div><div>Alter Text</div>'
    )
    expect(split.body).toBe('<p>Neu</p>')
    expect(split.quote).toContain('<hr>')
    expect(split.quote).toContain('Alter Text')
  })

  it('finds an Apple Mail cite blockquote inside a wrapper', () => {
    const split = splitQuotedHtml(
      '<div>Hoi<div><br><blockquote type="cite">Früher</blockquote></div></div>'
    )
    expect(split.body).not.toContain('Früher')
    expect(split.quote).toContain('Früher')
  })

  it('leaves a bare forward and a mail without a quote whole', () => {
    const only = '<div class="gmail_quote">Nur Zitat</div>'
    expect(splitQuotedHtml(only)).toEqual({ body: only, quote: null })
    const forward =
      '<p>FYI</p><div class="gmail_quote">---------- Forwarded message ---------<br>Inhalt</div>'
    expect(splitQuotedHtml(forward).quote).toBeNull()
    expect(splitQuotedHtml('<p>Hallo</p>').quote).toBeNull()
  })

  it('cuts a text mail at the attribution above its > lines', () => {
    const split = splitQuotedText('Danke!\n\nAm 18.08.2026 schrieb Sandra:\n> Frage\n> Zweite')
    expect(split.body).toBe('Danke!')
    expect(split.quote).toBe('Am 18.08.2026 schrieb Sandra:\n> Frage\n> Zweite')
    expect(splitQuotedText('> nur Zitat').quote).toBeNull()
    expect(splitQuotedText('Kein Zitat').quote).toBeNull()
  })
})

describe('message header dates', () => {
  const now = new Date(2026, 8, 25, 12, 24).getTime()

  it('says how long ago for the last week only', () => {
    expect(formatAgo(now - 30_000, now)).toBe('gerade eben')
    expect(formatAgo(now - 5 * 60_000, now)).toBe('vor 5 Min.')
    expect(formatAgo(now - 2 * 3_600_000, now)).toBe('vor 2 Std.')
    expect(formatAgo(now - 26 * 3_600_000, now)).toBe('vor 1 Tag')
    expect(formatAgo(now - 3 * 86_400_000, now)).toBe('vor 3 Tagen')
    expect(formatAgo(now - 9 * 86_400_000, now)).toBeNull()
  })

  it('writes the time today and the day before that', () => {
    expect(formatMessageDate(new Date(2026, 8, 25, 10, 24).getTime(), now)).toBe(
      '10:24 (vor 2 Std.)'
    )
    expect(formatMessageDate(new Date(2026, 8, 1, 8, 5).getTime(), now)).not.toContain('vor')
  })
})
