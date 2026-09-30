import type { OutboxAttachment } from '@shared/types'
import { MAX_ATTACHMENT_BYTES, attachedBytes, mimeTypeForFile } from '@shared/attachments'

/** Why a file did not make it into the draft, so the UI can say which it was. */
export interface RejectedFile {
  filename: string
  reason: 'tooLarge' | 'unreadable'
}

/**
 * Whether a drag carries files at all. A drag inside the editor moves text and
 * must be left to tiptap; only a drag from outside the app brings `Files`.
 */
export function hasFiles(transfer: DataTransfer | null | undefined): boolean {
  if (!transfer) return false
  const types = Array.from(transfer.types ?? [])
  return types.includes('Files') || transfer.files.length > 0
}

/** Base64 without blowing the call stack on a file of any size. */
function toBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK))
  }
  return btoa(binary)
}

/**
 * Reads a dropped file into the shape a draft stores — the same shape the file
 * dialog produces, so both ways of attaching end in one code path from here on.
 */
export async function fileToAttachment(file: File): Promise<OutboxAttachment> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  return {
    filename: file.name || 'anhang',
    // The OS knows the type better than an extension table does, but hands out
    // an empty string for anything it does not recognise itself.
    mimeType: file.type || mimeTypeForFile(file.name),
    content: toBase64(bytes)
  }
}

/**
 * Takes on as many of the dropped files as the size budget allows. The budget
 * counts what the draft already carries, because the limit is per mail rather
 * than per file — and a folder, which arrives looking like a file and cannot be
 * read, comes back as rejected instead of failing the whole drop.
 */
export async function collectAttachments(
  files: readonly File[],
  current: readonly OutboxAttachment[]
): Promise<{ added: OutboxAttachment[]; rejected: RejectedFile[] }> {
  let used = attachedBytes(current)
  const added: OutboxAttachment[] = []
  const rejected: RejectedFile[] = []
  for (const file of files) {
    if (used + file.size > MAX_ATTACHMENT_BYTES) {
      rejected.push({ filename: file.name, reason: 'tooLarge' })
      continue
    }
    try {
      added.push(await fileToAttachment(file))
      used += file.size
    } catch {
      rejected.push({ filename: file.name, reason: 'unreadable' })
    }
  }
  return { added, rejected }
}
