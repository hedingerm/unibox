/** One entry in the command palette. */
export interface PaletteCommand {
  id: string
  title: string
  /** Heading the entry is listed under. */
  section: string
  /** Extra words it can be found by — an account's address, a label's path. */
  keywords?: readonly string[]
  /** Registry binding shown on the right, e.g. `g i`. */
  binding?: string
  run: () => void
}

/**
 * How well `word` matches `text`: the start of the text beats the start of a
 * later word, which beats the middle of one; letters in order with gaps score
 * lowest, anything else is no match. Word starts tie on purpose, so equally
 * good matches keep the palette's own order.
 */
function wordScore(word: string, text: string): number | null {
  const at = text.indexOf(word)
  if (at === 0) return 1050
  if (at > 0) return /[\s@.:·/-]/.test(text[at - 1]!) ? 1000 : 800 - at
  let position = -1
  let gaps = 0
  for (const char of word) {
    const next = text.indexOf(char, position + 1)
    if (next < 0) return null
    if (position >= 0) gaps += next - position - 1
    position = next
  }
  return 500 - gaps
}

/** Fuzzy score of a command, or `null` when some word of the query is missing. */
export function commandScore(command: PaletteCommand, query: string): number | null {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return 0
  const haystacks = [command.title, ...(command.keywords ?? [])].map((text) => text.toLowerCase())
  let total = 0
  for (const word of words) {
    const scores = haystacks
      .map((text) => wordScore(word, text))
      .filter((score): score is number => score !== null)
    if (scores.length === 0) return null
    total += Math.max(...scores)
  }
  return total
}

/**
 * The commands matching `query`, best first. An empty query keeps the given
 * order, which is the order the sections are meant to be read in.
 */
export function filterCommands(
  commands: readonly PaletteCommand[],
  query: string
): PaletteCommand[] {
  if (query.trim().length === 0) return [...commands]
  return commands
    .map((command, index) => ({ command, index, score: commandScore(command, query) }))
    .filter((entry): entry is { command: PaletteCommand; index: number; score: number } =>
      entry.score !== null
    )
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.command)
}
