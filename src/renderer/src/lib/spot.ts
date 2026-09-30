import type { Editor } from '@tiptap/react'
import type { AiSpot } from '@shared/types'
import { SPOT_CLOSE, SPOT_OPEN } from '@shared/types'

/** A stretch of the document, in the editor's own positions. */
export interface SpotRange {
  from: number
  to: number
}

/**
 * A run of text and where it starts. Block boundaries travel as their own
 * chunk so the concatenation reads the same way the editor's `textBetween`
 * does — without them a spot spanning two paragraphs could never be found
 * again, because the words would run together where the blank line was.
 */
export interface TextChunk {
  pos: number
  text: string
}

/** How blocks are separated wherever the draft is read as text. */
export const BLOCK_SEPARATOR = '\n\n'

/**
 * Finds `needle` in the chunks and maps it back to a range. The offset is
 * walked chunk by chunk rather than computed, because a separator chunk stands
 * for a boundary the document counts differently than the text does.
 */
export function findInChunks(chunks: TextChunk[], needle: string): SpotRange | null {
  if (needle === '') return null
  const joined = chunks.map((chunk) => chunk.text).join('')
  const index = joined.indexOf(needle)
  if (index === -1) return null
  const end = index + needle.length

  let offset = 0
  let from: number | null = null
  let to: number | null = null
  for (const chunk of chunks) {
    const next = offset + chunk.text.length
    // A separator has no width in the document, so a hit that starts or ends
    // on one belongs to the neighbouring text, not to the boundary itself.
    if (from === null && index < next) from = chunk.pos + Math.max(0, index - offset)
    if (to === null && end <= next) to = chunk.pos + Math.max(0, end - offset)
    offset = next
    if (from !== null && to !== null) break
  }
  return from === null || to === null ? null : { from, to }
}

/** The draft's text nodes and block boundaries, in document order. */
export function textChunks(editor: Editor): TextChunk[] {
  const chunks: TextChunk[] = []
  let previousBlockEnd: number | null = null
  editor.state.doc.descendants((node, pos) => {
    if (node.isText) {
      chunks.push({ pos, text: node.text ?? '' })
      return false
    }
    // Signature and quoted original are atoms: they carry their html as an
    // attribute, not as text, so they contribute nothing and are skipped whole.
    if (node.isAtom) return false
    if (node.isTextblock) {
      if (previousBlockEnd !== null) chunks.push({ pos: previousBlockEnd, text: BLOCK_SEPARATOR })
      previousBlockEnd = pos + node.nodeSize
    }
    return true
  })
  return chunks
}

/**
 * The document position under the pointer. ProseMirror maps coordinates
 * through `elementFromPoint`, which not every environment the editor runs in
 * provides — and a menu that cannot place the caret is still a usable menu, so
 * a miss is a null rather than a thrown handler.
 */
export function posAt(editor: Editor, x: number, y: number): number | null {
  try {
    return editor.view.posAtCoords({ left: x, top: y })?.pos ?? null
  } catch {
    return null
  }
}

/**
 * The place the assistant is asked to work on: what is selected, and the whole
 * draft with that place marked so the answer fits its surroundings. An empty
 * selection is a gap to fill rather than text to replace.
 */
export function buildSpot(editor: Editor): AiSpot {
  const { from, to } = editor.state.selection
  const doc = editor.state.doc
  const read = (start: number, end: number): string =>
    doc.textBetween(start, end, BLOCK_SEPARATOR, ' ')
  const text = read(from, to)
  return {
    text,
    draft: `${read(0, from)}${SPOT_OPEN}${text}${SPOT_CLOSE}${read(to, doc.content.size)}`
  }
}

/**
 * Where the answer goes. The range the user marked is used as long as the same
 * words still stand there; once the draft has moved on — the window was closed
 * and rebuilt, or something was typed above — the text is looked up again.
 * Nothing found means the place is gone, and guessing one would write the
 * answer somewhere nobody pointed at.
 */
export function resolveSpot(
  editor: Editor,
  remembered: SpotRange | null,
  spot: AiSpot
): SpotRange | null {
  const size = editor.state.doc.content.size
  if (remembered && remembered.from <= size && remembered.to <= size) {
    const standing = editor.state.doc.textBetween(
      remembered.from,
      remembered.to,
      BLOCK_SEPARATOR,
      ' '
    )
    if (standing === spot.text) return remembered
  }
  // A gap has no words to find again, so a moved caret cannot be recovered.
  if (spot.text === '') return null
  return findInChunks(textChunks(editor), spot.text)
}
