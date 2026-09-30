import type { DiffPart } from './diff'

/**
 * A stretch of the flattened draft and the text node it came out of. One text
 * node yields exactly one span, which is what lets the edits be written back
 * from the end: an edit never invalidates the offsets of the ones before it.
 */
interface Span {
  node: Text
  /** Where the span starts inside the node's own text. */
  offset: number
  /** Where the span starts in the flattened draft. */
  start: number
  length: number
}

interface Flat {
  doc: Document
  text: string
  spans: Span[]
}

interface Edit {
  start: number
  end: number
  text: string
}

/** The text `stripHtml` would have made of these elements. */
function breakAfter(element: Element): number {
  const tag = element.tagName
  if (tag === 'P' || /^H[1-6]$/.test(tag)) return endsListItem(element) ? 0 : 2
  if (tag === 'DIV' || tag === 'LI' || tag === 'TR') return 1
  return 0
}

/**
 * A list item wraps its text in a paragraph, and the paragraph break at the end
 * of it belongs to the item, not on top of it — the same unwrapping the text
 * side does before it reads the item as one line.
 */
function endsListItem(element: Element): boolean {
  if (element.tagName !== 'P' || element.parentElement?.tagName !== 'LI') return false
  for (let next = element.nextSibling; next; next = next.nextSibling) {
    if (next.nodeType === Node.ELEMENT_NODE) return false
    if (next.nodeType === Node.TEXT_NODE && (next as Text).data.trim() !== '') return false
  }
  return true
}

/**
 * Reads the draft as the text the model was given, remembering where every
 * piece of it sits in the markup. This has to agree with `stripHtml` in the
 * main process character for character — the caller checks that it does and
 * falls back when it does not, so a disagreement costs the markup, not the
 * correction.
 */
function flatten(html: string): Flat {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const spans: Span[] = []
  let text = ''
  let pending = 0

  const put = (chunk: string, node: Text | null): void => {
    if (chunk === '') return
    if (text !== '') text += '\n'.repeat(pending)
    pending = 0
    if (node) spans.push({ node, offset: 0, start: text.length, length: chunk.length })
    text += chunk
  }
  // A break before the first word is no break at all: the text is trimmed.
  const breakHere = (count: number): void => {
    if (text !== '') pending = Math.max(pending, count)
  }

  const walk = (parent: Node): void => {
    for (let child = parent.firstChild; child; child = child.nextSibling) {
      if (child.nodeType === Node.TEXT_NODE) {
        // A non-breaking space is a space to the model, and replacing it keeps
        // the length, so the offsets into the node stay the ones we recorded.
        put((child as Text).data.replace(/\u00a0/g, ' '), child as Text)
        continue
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue
      const element = child as Element
      if (element.tagName === 'STYLE' || element.tagName === 'SCRIPT') {
        put(' ', null)
        continue
      }
      if (element.tagName === 'BR') {
        breakHere(1)
        continue
      }
      if (element.tagName === 'LI') put('- ', null)
      walk(element)
      breakHere(breakAfter(element))
    }
  }
  walk(doc.body)
  return clip({ doc, text, spans })
}

/** Drops the whitespace the text side trims off both ends. */
function clip(flat: Flat): Flat {
  const start = flat.text.length - flat.text.replace(/^\s+/, '').length
  const end = flat.text.replace(/\s+$/, '').length
  if (start === 0 && end === flat.text.length) return flat
  const spans: Span[] = []
  for (const span of flat.spans) {
    const from = Math.max(span.start, start)
    const to = Math.min(span.start + span.length, end)
    if (to <= from) continue
    spans.push({
      node: span.node,
      offset: span.offset + (from - span.start),
      start: from - start,
      length: to - from
    })
  }
  return { doc: flat.doc, text: flat.text.slice(start, end), spans }
}

/** The version the changes start from — the draft as the model received it. */
function sourceOf(parts: DiffPart[]): string {
  return parts.map((part) => (part.kind === 'equal' ? part.text : part.before)).join('')
}

/** The accepted decisions as replacements in the source, in reading order. */
function editsOf(parts: DiffPart[], accepted: ReadonlySet<number>): Edit[] {
  const edits: Edit[] = []
  let offset = 0
  let change = -1
  for (const part of parts) {
    if (part.kind === 'equal') {
      offset += part.text.length
      continue
    }
    change += 1
    if (accepted.has(change) && part.after !== part.before) {
      edits.push({ start: offset, end: offset + part.before.length, text: part.after })
    }
    offset += part.before.length
  }
  return edits
}

/**
 * Writes one replacement into the markup. An insertion goes to the node that
 * ends where it starts, so a word added in front of a link lands beside it
 * rather than inside it. A replacement that runs across nodes is written into
 * the first of them; the rest only lose their share of the old wording.
 */
function write(spans: Span[], edit: Edit): boolean {
  if (edit.start === edit.end) {
    const span =
      spans.find((entry) => edit.start > entry.start && edit.start <= entry.start + entry.length) ??
      spans.find((entry) => edit.start >= entry.start && edit.start <= entry.start + entry.length)
    if (!span) return false
    const at = span.offset + (edit.start - span.start)
    span.node.data = `${span.node.data.slice(0, at)}${edit.text}${span.node.data.slice(at)}`
    return true
  }
  const touched = spans.filter(
    (span) => span.start < edit.end && span.start + span.length > edit.start
  )
  if (touched.length === 0) return false
  for (let index = touched.length - 1; index >= 0; index -= 1) {
    const span = touched[index]!
    const from = span.offset + Math.max(edit.start, span.start) - span.start
    const to = span.offset + Math.min(edit.end, span.start + span.length) - span.start
    const written = index === 0 ? edit.text : ''
    span.node.data = `${span.node.data.slice(0, from)}${written}${span.node.data.slice(to)}`
  }
  return true
}

/**
 * Puts the accepted changes back into the draft without rebuilding it: the
 * corrected words are written into the text of the markup that is already
 * there, so a link stays a link and a list stays a list. The words come from
 * the model and are set as text, never as markup — the serializer escapes them.
 *
 * Answers null when the draft cannot carry the decisions: when it is not the
 * text the changes were measured against, or when a change falls between the
 * words — a paragraph break the model moved has no text node to live in. The
 * caller then rebuilds the body from plain text, which is the older, coarser
 * answer rather than a wrong one.
 */
export function applyChangesToHtml(
  html: string,
  parts: DiffPart[],
  accepted: ReadonlySet<number>
): string | null {
  const flat = flatten(html)
  if (flat.text !== sourceOf(parts)) return null
  const edits = editsOf(parts, accepted)
  for (let index = edits.length - 1; index >= 0; index -= 1) {
    if (!write(flat.spans, edits[index]!)) return null
  }
  return flat.doc.body.innerHTML
}
