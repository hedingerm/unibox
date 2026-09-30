/**
 * Electron prefixes every rejected `invoke` with its own transport wording and
 * the error class name. These messages end up in front of the user, so strip
 * the plumbing and keep what the main process actually said.
 */
export function unwrapIpcError(error: unknown): Error {
  const raw = error instanceof Error ? error.message : String(error)
  const message = raw
    .replace(/^Error invoking remote method '[^']*':\s*/, '')
    .replace(/^[A-Za-z]*Error:\s*/, '')
    .trim()
  return new Error(message || raw)
}
