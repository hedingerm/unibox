import type { Attachment } from '@shared/types'
import { api } from './bridge'

/**
 * Maps the Content-IDs of a message's embedded images to data URIs, so a quoted
 * or forwarded original keeps the pictures the sender put in it. A file that
 * cannot be fetched is left out rather than failing the whole quote.
 */
export async function loadInlineImages(
  attachments: Attachment[]
): Promise<Record<string, string>> {
  const entries = await Promise.all(
    attachments
      .filter((attachment) => attachment.inline && attachment.contentId)
      .map(async (attachment) => {
        try {
          const content = await api.invoke('attachments:open', attachment.id)
          return [
            attachment.contentId as string,
            `data:${content.mimeType};base64,${content.content}`
          ] as const
        } catch {
          return null
        }
      })
  )
  return Object.fromEntries(entries.filter((entry) => entry !== null))
}
