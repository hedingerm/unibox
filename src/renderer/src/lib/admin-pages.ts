/**
 * The pages of the Verwaltung, grouped the way its navigation shows them. The
 * group decides the section label; the order within it is the order on screen.
 */
export type AdminPage =
  | 'overview'
  | 'domains'
  | 'mailboxes'
  | 'routing'
  | 'delivery'
  | 'accounts'
  | 'identities'
  | 'templates'
  | 'notifications'
  | 'queue'
  | 'activity'
  | 'backups'
  | 'general'

export type AdminGroup = 'main' | 'email' | 'admin' | 'app'

export const ADMIN_NAV: Array<{ group: AdminGroup; pages: AdminPage[] }> = [
  { group: 'main', pages: ['overview'] },
  { group: 'email', pages: ['domains', 'mailboxes', 'routing', 'delivery'] },
  {
    group: 'admin',
    pages: ['accounts', 'identities', 'templates', 'notifications', 'queue', 'activity', 'backups']
  },
  { group: 'app', pages: ['general'] }
]
