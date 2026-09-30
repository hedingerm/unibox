/** The failure of an action, rendered where that action lives. */
export function InlineError({ message }: { message: string | null }): React.JSX.Element | null {
  if (!message) return null
  return (
    <span className="error-text" role="alert">
      {message}
    </span>
  )
}
