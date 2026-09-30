import DOMPurify from 'dompurify'

export interface SanitizeResult {
  html: string
  /** Number of remote images that were withheld until the user allows them. */
  blockedImages: number
}

const ALLOWED_SCHEMES = /^(https?:|mailto:|data:image\/|cid:)/i

/**
 * `style` survives sanitising because mail is unreadable without it, and
 * DOMPurify does not look inside the declarations. A tracking pixel hidden in
 * `background-image: url(…)` would load while the reader believes images are
 * held back, so the CSS is walked for remote and `cid:` references separately.
 */
const CSS_URL = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi

/**
 * Sanitises third-party mail HTML and, unless the user asked for it, strips the
 * source of remote images so opening a mail never phones home.
 */
export function sanitizeMessageHtml(
  html: string,
  options: {
    allowRemoteImages: boolean
    inlineImages?: Record<string, string>
    /**
     * Mail is read, not tabbed through: in the reading pane a newsletter with
     * fifty links would be fifty stops between the message and the next
     * control, so links are taken out of the tab order and stay clickable.
     * Only html that is on its way back out — a quoted original — keeps it.
     */
    tabbableLinks?: boolean
  }
): SanitizeResult {
  let blockedImages = 0

  const purify = DOMPurify(window)
  purify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A' || node.tagName === 'AREA') {
      node.setAttribute('target', '_blank')
      node.setAttribute('rel', 'noopener noreferrer')
      // Set here rather than allowed through, so a sender cannot bring its own.
      if (!options.tabbableLinks) node.setAttribute('tabindex', '-1')
    }
    const style = node.getAttribute?.('style')
    if (style && CSS_URL.test(style)) {
      CSS_URL.lastIndex = 0
      const rewritten = style.replace(CSS_URL, (match, _quote: string, target: string) => {
        const url = target.trim()
        if (url.toLowerCase().startsWith('cid:')) {
          const inline = options.inlineImages?.[url.slice(4).replace(/^<|>$/g, '')]
          return inline ? `url("${inline}")` : 'none'
        }
        if (options.allowRemoteImages || !/^https?:/i.test(url)) return match
        blockedImages += 1
        return 'none'
      })
      if (rewritten !== style) node.setAttribute('style', rewritten)
    }
    if (node.tagName === 'IMG') {
      const source = node.getAttribute('src') ?? ''
      if (source.toLowerCase().startsWith('cid:')) {
        const key = source.slice(4).replace(/^<|>$/g, '')
        const inline = options.inlineImages?.[key]
        if (inline) node.setAttribute('src', inline)
        else node.removeAttribute('src')
        return
      }
      if (!options.allowRemoteImages && /^https?:/i.test(source)) {
        blockedImages += 1
        node.setAttribute('data-blocked-src', source)
        node.removeAttribute('src')
        node.removeAttribute('srcset')
      }
    }
    for (const attribute of ['href', 'src']) {
      const value = node.getAttribute?.(attribute)
      if (value && !ALLOWED_SCHEMES.test(value)) node.removeAttribute(attribute)
    }
  })

  const clean = purify.sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['style', 'script', 'iframe', 'object', 'embed', 'form', 'input', 'link', 'meta'],
    FORBID_ATTR: ['srcset', 'background', 'ping'],
    ALLOWED_ATTR: [
      'href',
      'src',
      'alt',
      'title',
      'width',
      'height',
      'align',
      'colspan',
      'rowspan',
      'style',
      'target',
      'rel',
      'data-blocked-src',
      'class'
    ]
  })
  purify.removeAllHooks()
  return { html: clean, blockedImages }
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export function plainTextToHtml(text: string): string {
  return escapeHtml(text)
    .split(/\n{2,}/)
    .map((paragraph) => `<p>${paragraph.replace(/\n/g, '<br>')}</p>`)
    .join('')
}
