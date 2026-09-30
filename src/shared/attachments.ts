/**
 * What one mail may carry, in bytes. Gmail refuses anything above 25 MB — and
 * long before the send, the payload travels base64-encoded through the React
 * state, the IPC boundary, the `attachments_json` column and, on every autosave
 * tick, the mirror queue towards Gmail. So the limit is checked when a file is
 * taken on, not when the mail goes out.
 */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024

const MIME_BY_EXTENSION: Record<string, string> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  txt: 'text/plain',
  csv: 'text/csv',
  zip: 'application/zip',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
}

/**
 * The type a filename suggests. Used where nothing better is known: the file
 * dialog hands out paths, and a dropped file's own `type` is empty whenever the
 * OS does not recognise it either.
 */
export function mimeTypeForFile(filename: string): string {
  const extension = filename.split('.').pop()?.toLowerCase() ?? ''
  return MIME_BY_EXTENSION[extension] ?? 'application/octet-stream'
}

/** How many bytes a base64 payload holds, without decoding it to find out. */
export function base64Bytes(content: string): number {
  if (!content) return 0
  const padding = content.endsWith('==') ? 2 : content.endsWith('=') ? 1 : 0
  return Math.floor((content.length * 3) / 4) - padding
}

/** What a draft's attachments currently cost, decoded. */
export function attachedBytes(attachments: ReadonlyArray<{ content: string }>): number {
  return attachments.reduce((total, attachment) => total + base64Bytes(attachment.content), 0)
}

/** The limit as the number people know it from mail clients. */
export const MAX_ATTACHMENT_MB = Math.round(MAX_ATTACHMENT_BYTES / (1024 * 1024))
