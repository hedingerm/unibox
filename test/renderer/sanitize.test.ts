// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { plainTextToHtml, sanitizeMessageHtml } from '@renderer/lib/sanitize'

describe('mail HTML sanitising', () => {
  it('removes scripts and event handlers', () => {
    const { html } = sanitizeMessageHtml(
      '<p onclick="steal()">Hallo</p><script>alert(1)</script>',
      { allowRemoteImages: true }
    )
    expect(html).toContain('Hallo')
    expect(html).not.toContain('script')
    expect(html).not.toContain('onclick')
  })

  it('withholds remote images until the user allows them', () => {
    const source = '<img src="https://tracker.example/pixel.gif">'
    const blocked = sanitizeMessageHtml(source, { allowRemoteImages: false })
    expect(blocked.blockedImages).toBe(1)
    expect(blocked.html).not.toMatch(/\ssrc="/)
    expect(blocked.html).toContain('data-blocked-src="https://tracker.example/pixel.gif"')

    const allowed = sanitizeMessageHtml(source, { allowRemoteImages: true })
    expect(allowed.blockedImages).toBe(0)
    expect(allowed.html).toContain('https://tracker.example')
  })

  it('withholds remote images hidden in a style attribute', () => {
    const source = '<div style="background-image:url(https://tracker.example/pixel.gif)">x</div>'
    const blocked = sanitizeMessageHtml(source, { allowRemoteImages: false })
    expect(blocked.blockedImages).toBe(1)
    expect(blocked.html).not.toContain('tracker.example')

    const allowed = sanitizeMessageHtml(source, { allowRemoteImages: true })
    expect(allowed.blockedImages).toBe(0)
    expect(allowed.html).toContain('tracker.example')
  })

  it('leaves data: and relative CSS urls alone', () => {
    const { html, blockedImages } = sanitizeMessageHtml(
      '<div style="background:url(\'data:image/png;base64,AAAA\')">x</div>',
      { allowRemoteImages: false }
    )
    expect(blockedImages).toBe(0)
    expect(html).toContain('base64,AAAA')
  })

  it('resolves cid: CSS urls from the local attachment cache', () => {
    const { html } = sanitizeMessageHtml('<div style="background:url(cid:bild1)">x</div>', {
      allowRemoteImages: false,
      inlineImages: { bild1: 'data:image/png;base64,AAAA' }
    })
    expect(html).toContain('data:image/png;base64,AAAA')
  })

  it('resolves cid: images from the local attachment cache', () => {
    const { html } = sanitizeMessageHtml('<img src="cid:bild1">', {
      allowRemoteImages: false,
      inlineImages: { bild1: 'data:image/png;base64,AAAA' }
    })
    expect(html).toContain('data:image/png;base64,AAAA')
  })

  it('drops javascript: links', () => {
    const { html } = sanitizeMessageHtml('<a href="javascript:alert(1)">x</a>', {
      allowRemoteImages: true
    })
    expect(html).not.toContain('javascript:')
  })

  it('opens surviving links outside the app', () => {
    const { html } = sanitizeMessageHtml('<a href="https://example.com">x</a>', {
      allowRemoteImages: true
    })
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noopener noreferrer"')
  })

  it('keeps links out of the tab order, but not in a quote that goes back out', () => {
    const read = sanitizeMessageHtml('<a href="https://example.com" tabindex="3">x</a>', {
      allowRemoteImages: true
    })
    expect(read.html).toContain('tabindex="-1"')

    const quoted = sanitizeMessageHtml('<a href="https://example.com">x</a>', {
      allowRemoteImages: true,
      tabbableLinks: true
    })
    expect(quoted.html).not.toContain('tabindex')
  })

  it('renders plain text as paragraphs and escapes markup', () => {
    expect(plainTextToHtml('Hallo\n\n<b>nicht fett</b>')).toBe(
      '<p>Hallo</p><p>&lt;b&gt;nicht fett&lt;/b&gt;</p>'
    )
  })
})
