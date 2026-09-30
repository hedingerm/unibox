/**
 * Every failed action ends up in front of the user, so the message has to be
 * whatever the main process actually said — never a generic placeholder.
 */
export function errorMessage(cause: unknown): string {
  if (cause instanceof Error) return cause.message
  if (typeof cause === 'string') return cause
  return String(cause)
}
