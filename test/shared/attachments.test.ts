import { describe, expect, it } from 'vitest'
import {
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_MB,
  attachedBytes,
  base64Bytes,
  mimeTypeForFile
} from '@shared/attachments'

describe('mime types', () => {
  it('maps common file extensions', () => {
    expect(mimeTypeForFile('offerte.pdf')).toBe('application/pdf')
    expect(mimeTypeForFile('bild.PNG')).toBe('image/png')
    expect(mimeTypeForFile('unbekannt.xyz')).toBe('application/octet-stream')
  })

  it('falls back for a name without an extension', () => {
    expect(mimeTypeForFile('Makefile')).toBe('application/octet-stream')
  })
})

describe('attachment size', () => {
  it('reads the decoded size off a base64 payload', () => {
    for (const size of [0, 1, 2, 3, 4, 5, 60, 999]) {
      const content = Buffer.alloc(size, 7).toString('base64')
      expect(base64Bytes(content)).toBe(size)
    }
  })

  it('adds up what a draft already carries', () => {
    const attachments = [
      { content: Buffer.alloc(100).toString('base64') },
      { content: Buffer.alloc(250).toString('base64') }
    ]
    expect(attachedBytes(attachments)).toBe(350)
    expect(attachedBytes([])).toBe(0)
  })

  it('states the limit Gmail enforces', () => {
    expect(MAX_ATTACHMENT_BYTES).toBe(25 * 1024 * 1024)
    expect(MAX_ATTACHMENT_MB).toBe(25)
  })
})
