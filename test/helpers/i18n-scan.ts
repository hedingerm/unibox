const TEXT_PROPS = ['placeholder', 'title', 'aria-label', 'alt', 'label']
const WORD = /[A-Za-zÄÖÜäöüß]{2,}/

function stripNoise(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*(import|export \{|\/\/)/.test(line))
    .join('\n')
    .replace(/&[a-z]+;/g, '')
}

/**
 * Finds JSX text nodes written as literals. Only single-line `>text<` runs
 * without braces can be UI copy; anything with code operators (or preceded by
 * `=>`) is TypeScript, not text.
 */
export function findHardcodedText(source: string): string[] {
  const cleaned = stripNoise(source)
  const found: string[] = []
  for (const match of cleaned.matchAll(/(?<![=-])>([^<>{}\n]+)</g)) {
    const text = (match[1] ?? '').trim()
    if (!WORD.test(text)) continue
    if (/[=();]/.test(text)) continue
    found.push(text)
  }
  return found
}

export function findHardcodedAttributes(source: string): string[] {
  const cleaned = stripNoise(source)
  const found: string[] = []
  for (const prop of TEXT_PROPS) {
    for (const match of cleaned.matchAll(new RegExp(`${prop}="([^"]*)"`, 'g'))) {
      const value = (match[1] ?? '').trim()
      if (!WORD.test(value)) continue
      found.push(`${prop}="${value}"`)
    }
  }
  return found
}
