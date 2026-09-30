/**
 * Escapes the LIKE wildcards in user input. Without this, `from:100%_sale`
 * silently turns into a match-everything pattern. Every LIKE built from user
 * text must pair this with `ESCAPE '\'`.
 */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`)
}

/** `%value%`, wildcards inside `value` neutralised. */
export function containsLike(value: string): string {
  return `%${escapeLike(value)}%`
}
