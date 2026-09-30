import { useCallback } from 'react'
import { parseMailto } from '@shared/mailto'
import { useUnibox } from '../state'
import { api } from './bridge'
import { plainTextToHtml } from './sanitize'

/**
 * Follows a link the way a mail client should. `mailto:` stays here: handing it
 * to the OS would open whatever other client is installed and write the answer
 * somewhere this inbox never sees it. Everything else goes to the browser,
 * where the scheme is checked once more before it reaches the system.
 */
export function useOpenLink(): (href: string) => void {
  const { openCompose } = useUnibox()
  return useCallback(
    (href: string) => {
      const mail = parseMailto(href)
      if (!mail) {
        void api.invoke('shell:openUrl', href)
        return
      }
      void openCompose({
        to: mail.to,
        cc: mail.cc,
        subject: mail.subject,
        html: mail.body ? plainTextToHtml(mail.body) : ''
      })
    },
    [openCompose]
  )
}
