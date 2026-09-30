import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SYSTEM_LABELS } from '@shared/types'
import { Store } from '@main/db/store'
import { backupFileName } from '@main/app'
import { createTestApp } from '../helpers/app'

async function connectResend(harness: ReturnType<typeof createTestApp>): Promise<string> {
  harness.resend.addDomain('beispielweb.ch', true)
  harness.resend.mx.set('beispielweb.ch', [
    { exchange: 'inbound-smtp.eu-west-1.amazonaws.com', priority: 10 }
  ])
  await harness.app.api['resend:setKey']('re_test')
  await harness.app.api['resend:enableReceiving']('dom_beispielweb_ch')
  return harness.app.store.accounts.findByEmail('resend', 'beispielweb.ch')!.id
}

describe('attachment cache', () => {
  it('reports its size and frees it without touching the mail', async () => {
    const harness = createTestApp({ googleOAuth: true, autoCompleteOAuth: true })
    try {
      harness.gmail.addMessage({
        id: 'm1',
        subject: 'Offerte Onlineshop',
        attachments: [
          { filename: 'offerte.pdf', mimeType: 'application/pdf', attachmentId: 'att-1', size: 10 }
        ]
      })
      harness.gmail.attachments.set('att-1', 'PDF-INHALT')
      const account = await harness.app.api['google:connect']()
      await harness.app.syncAll()

      const message = harness.app.store.messages.getByRemoteId(account.id, 'm1')!
      const [attachment] = harness.app.store.messages.attachments(message.id)

      expect(await harness.app.api['attachments:cacheInfo']()).toEqual({
        bytes: 0,
        files: 0,
        reclaimableBytes: 0,
        reclaimableFiles: 0
      })

      // Opening it is what fills the cache.
      await harness.app.api['attachments:open'](attachment!.id)
      const filled = await harness.app.api['attachments:cacheInfo']()
      expect(filled.files).toBe(1)
      expect(filled.bytes).toBeGreaterThan(0)
      expect(filled.reclaimableFiles).toBe(1)
      const cachedPath = harness.app.store.messages.attachment(attachment!.id)!.filePath!
      expect(existsSync(cachedPath)).toBe(true)

      const cleared = await harness.app.api['attachments:clearCache']()
      expect(cleared).toEqual({ bytes: 0, files: 0, reclaimableBytes: 0, reclaimableFiles: 0 })
      expect(existsSync(cachedPath)).toBe(false)
      expect(harness.app.store.messages.attachment(attachment!.id)?.downloaded).toBe(false)

      // The mail itself is untouched, and the payload comes back on demand.
      expect(harness.app.store.messages.get(message.id)?.subject).toBe('Offerte Onlineshop')
      expect(harness.app.store.messages.body(message.id).text).toBeTruthy()
      const reopened = await harness.app.api['attachments:open'](attachment!.id)
      expect(reopened.filename).toBe('offerte.pdf')
      expect((await harness.app.api['attachments:cacheInfo']()).files).toBe(1)
    } finally {
      harness.dispose()
    }
  })

  it('never clears a Resend attachment, which has no second copy', async () => {
    const harness = createTestApp()
    try {
      await connectResend(harness)
      harness.resend.addReceived({
        id: 'r1',
        subject: 'Anfrage mit Anhang',
        attachments: [{ id: 'a1', filename: 'plan.pdf', content_type: 'application/pdf', size: 9 }]
      })
      harness.resend.addAttachment(
        'r1',
        { id: 'a1', filename: 'plan.pdf', content_type: 'application/pdf', size: 9 },
        'PLAN-DATEN'
      )
      await harness.app.syncAll()

      const info = await harness.app.api['attachments:cacheInfo']()
      expect(info.files).toBe(1)
      expect(info.bytes).toBeGreaterThan(0)
      // Resend deletes upstream after 30 days, so nothing here is reclaimable.
      expect(info.reclaimableFiles).toBe(0)

      const after = await harness.app.api['attachments:clearCache']()
      expect(after.files).toBe(1)
      expect(after.bytes).toBe(info.bytes)
    } finally {
      harness.dispose()
    }
  })
})

describe('database backup', () => {
  it('writes a copy that opens and holds the same mail', async () => {
    const harness = createTestApp()
    try {
      const accountId = await connectResend(harness)
      harness.app.store.messages.upsert({
        id: `${accountId}:r1`,
        accountId,
        threadId: `${accountId}:t:r1`,
        remoteId: 'r1',
        subject: 'Website-Relaunch Malergeschäft',
        from: { name: 'Sandra Keller', email: 's.keller@keller-farben.ch' },
        to: [{ name: null, email: 'kontakt@beispielweb.ch' }],
        date: Date.parse('2026-08-18T09:42:00.000Z'),
        labelRemoteIds: [SYSTEM_LABELS.inbox],
        body: { html: null, text: 'Wir möchten unsere Website erneuern lassen' }
      })

      const target = join(mkdtempSync(join(tmpdir(), 'unibox-backup-')), 'copy.db')
      harness.saveTarget.path = target

      const written = await harness.app.api['db:backup']()
      expect(written).toBe(target)
      expect(existsSync(target)).toBe(true)

      const restored = Store.openFile(target)
      try {
        const account = restored.accounts.findByEmail('resend', 'beispielweb.ch')
        expect(account).not.toBeNull()
        const threads = restored.messages.listThreadIds({ labelRemoteId: SYSTEM_LABELS.inbox })
        expect(threads).toHaveLength(1)
        const message = restored.messages.getByRemoteId(account!.id, 'r1')!
        expect(message.subject).toBe('Website-Relaunch Malergeschäft')
        expect(restored.messages.body(message.id).text).toBe(
          'Wir möchten unsere Website erneuern lassen'
        )
        // The search index survives the copy, so the backup is usable as-is.
        expect(restored.search.query({ text: 'Relaunch' })).toHaveLength(1)
      } finally {
        restored.close()
      }
    } finally {
      harness.dispose()
    }
  })

  it('does nothing when the user cancels the save dialog', async () => {
    const harness = createTestApp()
    try {
      harness.saveTarget.path = null
      expect(await harness.app.api['db:backup']()).toBeNull()
    } finally {
      harness.dispose()
    }
  })

  it('names the copy after the day it was taken', () => {
    expect(backupFileName(Date.parse('2026-08-20T14:05:00.000Z'))).toBe(
      'unibox-backup-2026-08-20.db'
    )
  })
})
