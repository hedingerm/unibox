import { screen, within } from '@testing-library/react'
import type userEvent from '@testing-library/user-event'

/**
 * Opens the Verwaltung from the top bar and, when named, one of its pages.
 * Returns the workspace, so queries stay inside it.
 */
export async function openAdmin(
  user: ReturnType<typeof userEvent.setup>,
  page?: string
): Promise<HTMLElement> {
  await user.click(screen.getByRole('button', { name: 'Verwaltung' }))
  const region = await screen.findByRole('region', { name: 'Verwaltung' })
  if (page) await goToAdminPage(user, page)
  return region
}

export async function goToAdminPage(
  user: ReturnType<typeof userEvent.setup>,
  page: string
): Promise<void> {
  const nav = screen.getByRole('navigation', { name: 'Bereiche der Verwaltung' })
  await user.click(within(nav).getByRole('button', { name: page }))
}
