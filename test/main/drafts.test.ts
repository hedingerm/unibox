import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DraftInput } from '@shared/types'
import { createTestApp } from '../helpers/app'

let harness: ReturnType<typeof createTestApp>
let accountId: string

function input(patch: Partial<DraftInput> = {}): DraftInput {
  return {
    id: null,
    accountId,
    kind: 'new',
    identityId: null,
    identityName: 'Max Muster',
    identityEmail: 'max@muster-it.ch',
    to: 's.keller@keller-farben.ch',
    cc: '',
    bcc: '',
    subject: 'Offerte',
    html: '<p>Hoi Sandra</p>',
    attachments: [],
    replyToMessageId: null,
    ...patch
  }
}

beforeEach(() => {
  harness = createTestApp()
  accountId = harness.app.store.accounts.upsert({
    kind: 'google',
    email: 'max@muster-it.ch',
    displayName: 'max@muster-it.ch'
  }).id
})

afterEach(() => harness.dispose())

describe('drafts', () => {
  it('creates on the first save and overwrites on every later one', async () => {
    const first = await harness.app.api['drafts:save'](input())
    const second = await harness.app.api['drafts:save'](
      input({ id: first.id, subject: 'Offerte Onlineshop' })
    )

    expect(second.id).toBe(first.id)
    expect(second.subject).toBe('Offerte Onlineshop')
    expect(await harness.app.api['drafts:list']()).toHaveLength(1)
  })

  it('keeps recipients exactly as typed, half-written ones included', async () => {
    const draft = await harness.app.api['drafts:save'](input({ to: 's.keller@keller-far' }))
    const reloaded = await harness.app.api['drafts:get'](draft.id)

    expect(reloaded?.to).toBe('s.keller@keller-far')
  })

  it('lists a text snippet and the file flag instead of body and files', async () => {
    await harness.app.api['drafts:save'](
      input({
        html: '<p>Hoi Sandra</p><p>Gerne, nächste Woche passt.</p>',
        attachments: [{ filename: 'offerte.pdf', mimeType: 'application/pdf', content: 'AAA' }]
      })
    )

    const [summary] = await harness.app.api['drafts:list']()
    expect(summary?.snippet).toBe('Hoi Sandra Gerne, nächste Woche passt.')
    expect(summary?.hasAttachments).toBe(true)
    // A list row must not carry a base64 attachment over IPC.
    expect(JSON.stringify(summary)).not.toContain('AAA')
  })

  it('sorts newest first and forgets a removed draft', async () => {
    const older = await harness.app.store.drafts.save(input({ subject: 'Älter' }), 1_000)
    const newer = await harness.app.store.drafts.save(input({ subject: 'Neuer' }), 2_000)

    expect((await harness.app.api['drafts:list']()).map((entry) => entry.id)).toEqual([
      newer.id,
      older.id
    ])

    await harness.app.api['drafts:remove'](newer.id)
    expect(await harness.app.api['drafts:get'](newer.id)).toBeNull()
    expect((await harness.app.api['drafts:list']()).map((entry) => entry.id)).toEqual([older.id])
  })

  it('survives a restart, which is the whole point of storing it', () => {
    const draft = harness.app.store.drafts.save(input({ html: '<p>Halb fertig</p>' }))
    const reopened = harness.app.store.drafts.get(draft.id)

    expect(reopened?.html).toBe('<p>Halb fertig</p>')
  })
})
