import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import postcss from 'postcss'
import { describe, expect, it } from 'vitest'

// jsdom never parses the stylesheet, so a broken block only shows up in the
// production build. Merges into styles.css have dropped a brace before.
describe('styles.css', () => {
  it('parses', () => {
    const css = readFileSync(resolve(__dirname, '../../src/renderer/src/styles.css'), 'utf8')
    expect(() => postcss.parse(css)).not.toThrow()
  })
})
