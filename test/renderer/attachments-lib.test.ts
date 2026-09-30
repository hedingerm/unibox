// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { collectAttachments, fileToAttachment, hasFiles } from '@renderer/lib/attachments'
import { MAX_ATTACHMENT_BYTES } from '@shared/attachments'

function fileOf(name: string, bytes: number, type = ''): File {
  return new File([new Uint8Array(bytes)], name, { type })
}

/** A file that claims a size without the test allocating it. */
function sized(file: File, bytes: number): File {
  Object.defineProperty(file, 'size', { value: bytes })
  return file
}

describe('reading dropped files', () => {
  it('encodes a file the way the draft stores it', async () => {
    const attachment = await fileToAttachment(
      new File([new Uint8Array([1, 2, 3])], 'daten.bin', { type: 'application/octet-stream' })
    )
    expect(attachment).toEqual({
      filename: 'daten.bin',
      mimeType: 'application/octet-stream',
      content: Buffer.from([1, 2, 3]).toString('base64')
    })
  })

  it('falls back to the extension when the OS names no type', async () => {
    const attachment = await fileToAttachment(fileOf('offerte.pdf', 2))
    expect(attachment.mimeType).toBe('application/pdf')
  })

  it('encodes a payload past the chunk size without losing bytes', async () => {
    const bytes = new Uint8Array(0x8000 + 5).map((_, index) => index % 256)
    const attachment = await fileToAttachment(new File([bytes], 'gross.bin'))
    expect(attachment.content).toBe(Buffer.from(bytes).toString('base64'))
  })
})

describe('the size budget', () => {
  it('takes on what fits', async () => {
    const { added, rejected } = await collectAttachments(
      [fileOf('brief.txt', 3, 'text/plain'), fileOf('bild.png', 4, 'image/png')],
      []
    )
    expect(added.map((entry) => entry.filename)).toEqual(['brief.txt', 'bild.png'])
    expect(rejected).toEqual([])
  })

  it('refuses a single file over the limit', async () => {
    const { added, rejected } = await collectAttachments(
      [sized(fileOf('video.mov', 8), MAX_ATTACHMENT_BYTES + 1)],
      []
    )
    expect(added).toEqual([])
    expect(rejected).toEqual([{ filename: 'video.mov', reason: 'tooLarge' }])
  })

  it('counts the files of one drop against each other', async () => {
    const half = Math.floor(MAX_ATTACHMENT_BYTES * 0.6)
    const { added, rejected } = await collectAttachments(
      [sized(fileOf('eins.zip', 8), half), sized(fileOf('zwei.zip', 8), half)],
      []
    )
    expect(added.map((entry) => entry.filename)).toEqual(['eins.zip'])
    expect(rejected).toEqual([{ filename: 'zwei.zip', reason: 'tooLarge' }])
  })

  it('counts what the draft already carries', async () => {
    const existing = await fileToAttachment(fileOf('schon-da.pdf', 1_000))
    const { added, rejected } = await collectAttachments(
      [sized(fileOf('rest.zip', 8), MAX_ATTACHMENT_BYTES - 500)],
      [existing]
    )
    expect(added).toEqual([])
    expect(rejected).toEqual([{ filename: 'rest.zip', reason: 'tooLarge' }])
  })

  it('reports a folder as rejected instead of failing the whole drop', async () => {
    const folder = fileOf('Projekte', 0)
    Object.defineProperty(folder, 'arrayBuffer', {
      value: () => Promise.reject(new Error('is a directory'))
    })

    const { added, rejected } = await collectAttachments(
      [folder, fileOf('brief.txt', 3, 'text/plain')],
      []
    )
    expect(added.map((entry) => entry.filename)).toEqual(['brief.txt'])
    expect(rejected).toEqual([{ filename: 'Projekte', reason: 'unreadable' }])
  })
})

describe('telling a file drag from a text drag', () => {
  it('reads the drag types', () => {
    expect(hasFiles({ types: ['Files'], files: [] } as unknown as DataTransfer)).toBe(true)
    expect(hasFiles({ types: ['text/plain'], files: [] } as unknown as DataTransfer)).toBe(false)
    expect(hasFiles(null)).toBe(false)
  })
})
