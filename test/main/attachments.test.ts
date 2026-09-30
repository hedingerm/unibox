import { describe, expect, it } from 'vitest'
import { MAX_ATTACHMENT_BYTES } from '@shared/attachments'
import { createTestApp } from '../helpers/app'

describe('picking attachments', () => {
  it('reads a picked file into the shape a draft stores', async () => {
    const harness = createTestApp()
    try {
      harness.files.set('/Users/max/Offerte.pdf', Buffer.from('%PDF-1.7'))
      harness.pickedFiles.push('/Users/max/Offerte.pdf')

      expect(await harness.app.api['attachments:pick']()).toEqual([
        {
          filename: 'Offerte.pdf',
          mimeType: 'application/pdf',
          content: Buffer.from('%PDF-1.7').toString('base64')
        }
      ])
    } finally {
      harness.dispose()
    }
  })

  it('refuses a file over the size limit before it reaches the draft', async () => {
    const harness = createTestApp()
    try {
      harness.files.set('/Users/max/Film.mov', Buffer.alloc(MAX_ATTACHMENT_BYTES + 1))
      harness.pickedFiles.push('/Users/max/Film.mov')

      await expect(harness.app.api['attachments:pick']()).rejects.toThrow(
        '«Film.mov» ist grösser als 25 MB und passt nicht in eine E-Mail.'
      )
    } finally {
      harness.dispose()
    }
  })
})
