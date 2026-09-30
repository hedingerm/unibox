/**
 * One stretch of the comparison: text both versions agree on, or a place where
 * they differ. A change carries both sides so it can be shown and toggled as
 * one unit instead of as a stray deletion next to a stray insertion.
 */
export type DiffPart =
  | { kind: 'equal'; text: string }
  | { kind: 'change'; before: string; after: string }

/** Words and the whitespace between them, so the parts concatenate back exactly. */
export function tokenize(text: string): string[] {
  return text.split(/(\s+)/).filter((token) => token !== '')
}

/**
 * Above this the quadratic table stops being worth it. A mail never gets
 * there; a pasted document might, and then a single whole-text change is the
 * honest answer rather than a frozen window.
 */
const MAX_TOKENS = 4000

type Op = { kind: 'equal' | 'delete' | 'insert'; text: string }

function lcsOps(before: string[], after: string[]): Op[] {
  const rows = before.length
  const columns = after.length
  // table[i][j] = length of the longest common subsequence of the suffixes.
  const table = new Uint32Array((rows + 1) * (columns + 1))
  const at = (i: number, j: number): number => table[i * (columns + 1) + j]!
  for (let i = rows - 1; i >= 0; i -= 1) {
    for (let j = columns - 1; j >= 0; j -= 1) {
      table[i * (columns + 1) + j] =
        before[i] === after[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1))
    }
  }

  const ops: Op[] = []
  let i = 0
  let j = 0
  while (i < rows && j < columns) {
    if (before[i] === after[j]) {
      ops.push({ kind: 'equal', text: before[i]! })
      i += 1
      j += 1
    } else if (at(i + 1, j) >= at(i, j + 1)) {
      ops.push({ kind: 'delete', text: before[i]! })
      i += 1
    } else {
      ops.push({ kind: 'insert', text: after[j]! })
      j += 1
    }
  }
  while (i < rows) {
    ops.push({ kind: 'delete', text: before[i]! })
    i += 1
  }
  while (j < columns) {
    ops.push({ kind: 'insert', text: after[j]! })
    j += 1
  }
  return ops
}

/**
 * Compares two versions word by word. Neighbouring insertions and deletions
 * collapse into one change: a corrected word reads as "this became that", not
 * as two unrelated edits the user has to line up by eye.
 */
export function diffWords(before: string, after: string): DiffPart[] {
  if (before === after) return before ? [{ kind: 'equal', text: before }] : []
  const left = tokenize(before)
  const right = tokenize(after)
  if (left.length > MAX_TOKENS || right.length > MAX_TOKENS) {
    return [{ kind: 'change', before, after }]
  }

  const parts: DiffPart[] = []
  for (const op of lcsOps(left, right)) {
    const last = parts[parts.length - 1]
    if (op.kind === 'equal') {
      if (last?.kind === 'equal') last.text += op.text
      else parts.push({ kind: 'equal', text: op.text })
      continue
    }
    if (last?.kind !== 'change') parts.push({ kind: 'change', before: '', after: '' })
    const change = parts[parts.length - 1] as { kind: 'change'; before: string; after: string }
    if (op.kind === 'delete') change.before += op.text
    else change.after += op.text
  }
  return joinAcrossBlanks(parts)
}

/**
 * Pulls apart changes back together when only a blank separates them. Without
 * this, "Hallo" → "Guten Tag" arrives as two decisions whose halves can be
 * combined into "Hallo Tag" — a wording neither side proposed. A line break is
 * left alone: merging across paragraphs makes the decision too coarse.
 */
function joinAcrossBlanks(parts: DiffPart[]): DiffPart[] {
  const joined: DiffPart[] = []
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index]!
    const previous = joined[joined.length - 1]
    const next = parts[index + 1]
    if (
      part.kind === 'equal' &&
      previous?.kind === 'change' &&
      next?.kind === 'change' &&
      /^[^\S\n]+$/.test(part.text)
    ) {
      previous.before += part.text + next.before
      previous.after += part.text + next.after
      index += 1
      continue
    }
    joined.push({ ...part })
  }
  return joined
}

/** How many decisions a diff asks the user to make. */
export function countChanges(parts: DiffPart[]): number {
  return parts.filter((part) => part.kind === 'change').length
}

/**
 * Rebuilds the text with exactly the changes in `accepted` taken over; every
 * other change falls back to the original wording.
 */
export function applyChanges(parts: DiffPart[], accepted: ReadonlySet<number>): string {
  let index = -1
  return parts
    .map((part) => {
      if (part.kind === 'equal') return part.text
      index += 1
      return accepted.has(index) ? part.after : part.before
    })
    .join('')
}
