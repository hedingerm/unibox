// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import { SPOT_CLOSE, SPOT_OPEN } from '@shared/types'
import { editorExtensions } from '@renderer/components/Editor'
import { buildSpot, findInChunks, resolveSpot } from '@renderer/lib/spot'
import { QUOTE_MARKER, SIGNATURE_MARKER } from '@renderer/lib/compose'

let editor: Editor | null = null

function make(html: string): Editor {
  editor = new Editor({ extensions: editorExtensions(), content: html })
  return editor
}

/** Puts the selection on the first occurrence of `text` in the document. */
function select(instance: Editor, text: string): void {
  const found = findInChunks(
    (() => {
      const chunks: Array<{ pos: number; text: string }> = []
      instance.state.doc.descendants((node, pos) => {
        if (node.isText) chunks.push({ pos, text: node.text ?? '' })
        return !node.isAtom
      })
      return chunks
    })(),
    text
  )
  if (!found) throw new Error(`«${text}» steht nicht im Entwurf`)
  instance.commands.setTextSelection(found)
}

afterEach(() => {
  editor?.destroy()
  editor = null
})

describe('finding a marked place again', () => {
  it('maps a hit back to document positions', () => {
    const chunks = [
      { pos: 1, text: 'Hoi Sandra' },
      { pos: 11, text: '\n\n' },
      { pos: 13, text: 'Passt nicht.' }
    ]
    expect(findInChunks(chunks, 'Passt')).toEqual({ from: 13, to: 18 })
  })

  it('finds a place that runs across a paragraph break', () => {
    const chunks = [
      { pos: 1, text: 'Hoi Sandra' },
      { pos: 11, text: '\n\n' },
      { pos: 13, text: 'Passt nicht.' }
    ]
    expect(findInChunks(chunks, 'Sandra\n\nPasst')).toEqual({ from: 5, to: 18 })
  })

  it('has nothing to find for a gap', () => {
    expect(findInChunks([{ pos: 1, text: 'Hoi' }], '')).toBeNull()
  })
})

describe('the place the assistant works on', () => {
  it('marks the selection inside the draft it hands over', () => {
    const instance = make('<p>Hoi Sandra</p><p>Passt nicht.</p>')
    select(instance, 'Passt nicht.')
    const spot = buildSpot(instance)
    expect(spot.text).toBe('Passt nicht.')
    expect(spot.draft).toBe(`Hoi Sandra\n\n${SPOT_OPEN}Passt nicht.${SPOT_CLOSE}`)
  })

  it('leaves signature and quoted original out of the draft entirely', () => {
    // They are somebody else's words and the app's own footer: rewriting a
    // sentence must not be told to fit either of them.
    const instance = make(
      `<p>Passt nicht.</p><div ${SIGNATURE_MARKER}="true"><p>Gruass Max</p></div>` +
        `<div ${QUOTE_MARKER}="true"><p>Wann können Sie starten?</p></div>`
    )
    select(instance, 'Passt nicht.')
    const spot = buildSpot(instance)
    expect(spot.draft).not.toContain('Gruass Max')
    expect(spot.draft).not.toContain('Wann können Sie starten?')
  })

  it('marks a gap where nothing is selected', () => {
    const instance = make('<p>Hoi Sandra</p>')
    instance.commands.setTextSelection(4)
    const spot = buildSpot(instance)
    expect(spot.text).toBe('')
    expect(spot.draft).toBe(`Hoi${SPOT_OPEN}${SPOT_CLOSE} Sandra`)
  })
})

describe('the selection while the focus is elsewhere', () => {
  it('paints it itself, because an unfocused contenteditable has none', () => {
    const instance = make('<p>Hoi Sandra</p><p>Passt nicht.</p>')
    select(instance, 'Passt nicht.')
    // The editor never had the focus here, which is the blurred case: the
    // marked words have to stay marked, or the menu is about nothing visible.
    expect(instance.view.dom.querySelector('.selection-held')?.textContent).toBe('Passt nicht.')
  })

  it('leaves a bare caret alone', () => {
    const instance = make('<p>Hoi Sandra</p>')
    instance.commands.setTextSelection(4)
    expect(instance.view.dom.querySelector('.selection-held')).toBeNull()
  })
})

describe('putting the answer back', () => {
  it('uses the remembered range while the same words still stand there', () => {
    const instance = make('<p>Hoi Sandra</p><p>Passt nicht.</p>')
    select(instance, 'Passt nicht.')
    const spot = buildSpot(instance)
    const remembered = { from: instance.state.selection.from, to: instance.state.selection.to }
    expect(resolveSpot(instance, remembered, spot)).toEqual(remembered)
  })

  it('finds the place again after the draft moved under it', () => {
    const instance = make('<p>Hoi Sandra</p><p>Passt nicht.</p>')
    select(instance, 'Passt nicht.')
    const spot = buildSpot(instance)
    const remembered = { from: instance.state.selection.from, to: instance.state.selection.to }
    // Something typed above shifts every position after it.
    instance.commands.insertContentAt(1, 'Guten Tag. ')
    const resolved = resolveSpot(instance, remembered, spot)
    expect(resolved).not.toBeNull()
    expect(
      instance.state.doc.textBetween(resolved!.from, resolved!.to, '\n\n', ' ')
    ).toBe('Passt nicht.')
  })

  it('refuses to guess once the marked words are gone', () => {
    const instance = make('<p>Passt nicht.</p>')
    select(instance, 'Passt nicht.')
    const spot = buildSpot(instance)
    instance.commands.setContent('<p>Etwas ganz anderes.</p>')
    expect(resolveSpot(instance, { from: 1, to: 13 }, spot)).toBeNull()
  })

  it('gives up on a gap whose position no longer exists', () => {
    const instance = make('<p>Hoi Sandra</p>')
    instance.commands.setTextSelection(4)
    const spot = buildSpot(instance)
    instance.commands.setContent('<p>Hi</p>')
    expect(resolveSpot(instance, { from: 40, to: 40 }, spot)).toBeNull()
  })
})
