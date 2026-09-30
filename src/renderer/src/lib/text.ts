/** Plain-text alternative for the rich-text draft. */
export function htmlToPlainText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    // A paragraph is a blank line and a <br> is a single one, the same way the
    // text goes back into markup. Without that split, every paragraph of a
    // draft comes back one line short and reads as a change against the
    // model's answer.
    .replace(/<li[^>]*>\s*<p[^>]*>/gi, '<li>')
    .replace(/<\/p>\s*<\/li>/gi, '</li>')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|h[1-6])>/gi, '\n\n')
    .replace(/<\/(div|li|tr)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
