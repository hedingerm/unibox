import { describe, expect, it } from 'vitest'
import { aiInstruction, draftText, modeForDraft, textToHtml } from '@renderer/lib/ai'
import { withSignature } from '@renderer/lib/compose'

describe('@ai command line', () => {
  it('reads the instruction off a command line', () => {
    expect(aiInstruction('@ai schreib eine Absage')).toBe('schreib eine Absage')
    expect(aiInstruction('  @ai  mach es kürzer  ')).toBe('mach es kürzer')
  })

  it('is not a command without an instruction', () => {
    expect(aiInstruction('@ai')).toBeNull()
    expect(aiInstruction('@ai   ')).toBeNull()
  })

  it('leaves ordinary mail text alone', () => {
    expect(aiInstruction('Schreib mir an kontakt@ai.ch')).toBeNull()
    expect(aiInstruction('@aixyz was auch immer')).toBeNull()
    expect(aiInstruction('Hallo Marco @ai mach das')).toBeNull()
  })
})

describe('draft text', () => {
  it('reads the body without the signature block', () => {
    const html = withSignature('<p>Hoi Marco</p>', '<p>Max Muster</p>')
    expect(draftText(html)).toBe('Hoi Marco')
  })

  it('treats a body that is only a signature as empty', () => {
    const html = withSignature('', '<p>Max Muster</p>')
    expect(modeForDraft(html)).toBe('draft')
  })

  it('switches to a rework as soon as the user wrote something', () => {
    const html = withSignature('<p>Hoi Marco</p>', '<p>Max Muster</p>')
    expect(modeForDraft(html)).toBe('rewrite')
  })
})

describe('generated text to markup', () => {
  it('turns blank lines into paragraphs and single breaks into <br>', () => {
    expect(textToHtml('Hoi Marco\n\nPasst so.\nGruass')).toBe(
      '<p>Hoi Marco</p><p>Passt so.<br>Gruass</p>'
    )
  })

  it('escapes markup so a model answer cannot inject html', () => {
    expect(textToHtml('<script>alert(1)</script>')).toBe(
      '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>'
    )
  })

  it('answers empty for empty input', () => {
    expect(textToHtml('   \n  ')).toBe('')
  })

  it('round-trips paragraphs, so a correction only shows real changes', () => {
    // The draft goes to the model as text and comes back as text. If a
    // paragraph lost its blank line on the way out, every paragraph break
    // would come back as a change nobody made.
    const text = 'Hoi Marco\n\nPasst so.\nGruass'
    expect(draftText(textToHtml(text))).toBe(text)
  })
})
