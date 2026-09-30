import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DraftInput } from '@shared/types'
import { SYSTEM_LABELS } from '@shared/types'
import { GmailDraftSync } from '@main/google/drafts'
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

/** Pulls Gmail's drafts with the same client the app uses. */
async function pull(): Promise<void> {
  const client = harness.app.gmailClientFor(accountId)!
  await new GmailDraftSync(harness.app.store, accountId, client).sync()
}

beforeEach(async () => {
  harness = createTestApp({ googleOAuth: true, autoCompleteOAuth: true })
  const account = await harness.app.api['google:connect']()
  accountId = account.id
  harness.app.store.labels.ensureSystemLabels(accountId)
})

afterEach(() => harness.dispose())

describe('draft mirroring to Gmail', () => {
  it('creates the Gmail draft on the first save and updates the same one after', async () => {
    const first = await harness.app.api['drafts:save'](input())
    await harness.app.mutations.flush()

    expect(harness.gmail.drafts.size).toBe(1)
    const remoteId = harness.app.store.drafts.get(first.id)?.remoteId
    expect(remoteId).toBeTruthy()

    await harness.app.api['drafts:save'](input({ id: first.id, subject: 'Offerte Onlineshop' }))
    await harness.app.mutations.flush()

    expect(harness.gmail.drafts.size).toBe(1)
    expect(harness.app.store.drafts.get(first.id)?.remoteId).toBe(remoteId)
    expect(harness.app.store.drafts.get(first.id)?.dirty).toBe(false)
  })

  it('collapses a burst of autosaves into one push', async () => {
    const draft = await harness.app.api['drafts:save'](input())
    await harness.app.api['drafts:save'](input({ id: draft.id, subject: 'Zweiter Stand' }))
    await harness.app.api['drafts:save'](input({ id: draft.id, subject: 'Dritter Stand' }))

    const pending = harness.app.store.queue.list().filter((entry) => entry.op === 'draft_upsert')
    expect(pending).toHaveLength(1)
  })

  it('removes the Gmail draft when the local one is thrown away', async () => {
    const draft = await harness.app.api['drafts:save'](input())
    await harness.app.mutations.flush()
    const remoteId = harness.app.store.drafts.get(draft.id)!.remoteId!

    await harness.app.api['drafts:remove'](draft.id)
    await harness.app.mutations.flush()

    expect(harness.gmail.deletedDrafts).toContain(remoteId)
    expect(harness.gmail.drafts.size).toBe(0)
  })

  it('keeps the draft owed while the machine is offline and pushes it later', async () => {
    harness.gmail.offline = true
    const draft = await harness.app.api['drafts:save'](input())
    await harness.app.mutations.flush()

    // Offline is a normal state: the work waits instead of being lost.
    expect(harness.app.store.drafts.get(draft.id)?.dirty).toBe(true)
    expect(harness.gmail.drafts.size).toBe(0)
    expect(harness.app.store.queue.list().some((entry) => entry.op === 'draft_upsert')).toBe(true)

    harness.gmail.offline = false
    // The next autosave re-arms the push, which is what happens in the app too.
    await harness.app.api['drafts:save'](input({ id: draft.id, subject: 'Wieder online' }))
    await harness.app.mutations.flush()

    expect(harness.gmail.drafts.size).toBe(1)
    expect(harness.app.store.drafts.get(draft.id)?.dirty).toBe(false)
  })
})

describe('draft sync from Gmail', () => {
  it('imports a draft written elsewhere, editable here', async () => {
    harness.gmail.addDraft({
      id: 'phone-1',
      subject: 'Vom Handy',
      from: 'max@muster-it.ch',
      to: 's.keller@keller-farben.ch',
      html: '<p>Angefangen im Zug</p>',
      labelIds: [SYSTEM_LABELS.drafts]
    })

    await pull()

    const [draft] = harness.app.store.drafts.listForAccount(accountId)
    expect(draft?.subject).toBe('Vom Handy')
    expect(draft?.to).toBe('s.keller@keller-farben.ch')
    expect(draft?.html).toContain('Angefangen im Zug')
    expect(draft?.dirty).toBe(false)
  })

  it('takes over a remote edit when nothing was typed here', async () => {
    const remote = harness.gmail.addDraft({
      id: 'phone-2',
      subject: 'Erst so',
      from: 'max@muster-it.ch',
      html: '<p>Erster Stand</p>'
    })
    await pull()
    const local = harness.app.store.drafts.listForAccount(accountId)[0]!
    expect(local.remoteMessageId).toBe(remote.messageId)

    harness.gmail.editDraft('r1', {
      subject: 'Dann so',
      from: 'max@muster-it.ch',
      html: '<p>Zweiter Stand</p>'
    })
    await pull()

    const after = harness.app.store.drafts.get(local.id)
    expect(after?.subject).toBe('Dann so')
    expect(harness.app.store.drafts.listForAccount(accountId)).toHaveLength(1)
  })

  it('keeps both versions when the draft changed on either side', async () => {
    harness.gmail.addDraft({
      id: 'phone-3',
      subject: 'Gemeinsam',
      from: 'max@muster-it.ch',
      html: '<p>Ursprung</p>'
    })
    await pull()
    const local = harness.app.store.drafts.listForAccount(accountId)[0]!

    // Both sides move before the next sync — the local edit is written while
    // the machine is offline, so Gmail never sees it.
    harness.gmail.offline = true
    await harness.app.api['drafts:save'](
      input({ id: local.id, subject: 'Hier geändert', html: '<p>Lokal weitergeschrieben</p>' })
    )
    await harness.app.mutations.flush()
    harness.gmail.offline = false
    harness.gmail.editDraft('r1', {
      subject: 'Dort geändert',
      from: 'max@muster-it.ch',
      html: '<p>Am Handy weitergeschrieben</p>'
    })
    await pull()

    const drafts = harness.app.store.drafts.listForAccount(accountId)
    expect(drafts).toHaveLength(2)
    expect(drafts.map((entry) => entry.subject).sort()).toEqual([
      'Dort geändert (Konflikt)',
      'Hier geändert'
    ])
    // The local version lost its link and will be pushed as its own draft.
    expect(drafts.find((entry) => entry.subject === 'Hier geändert')?.remoteId).toBeNull()
  })

  it('drops a local copy of a draft that disappeared at Gmail', async () => {
    harness.gmail.addDraft({
      id: 'phone-4',
      subject: 'Weg damit',
      from: 'max@muster-it.ch'
    })
    await pull()
    expect(harness.app.store.drafts.listForAccount(accountId)).toHaveLength(1)

    harness.gmail.drafts.clear()
    await pull()

    expect(harness.app.store.drafts.listForAccount(accountId)).toHaveLength(0)
  })

  it('never throws away local edits for a draft deleted at Gmail', async () => {
    harness.gmail.addDraft({
      id: 'phone-5',
      subject: 'Umkämpft',
      from: 'max@muster-it.ch'
    })
    await pull()
    const local = harness.app.store.drafts.listForAccount(accountId)[0]!
    await harness.app.api['drafts:save'](input({ id: local.id, subject: 'Noch dran' }))

    harness.gmail.drafts.clear()
    await pull()

    const after = harness.app.store.drafts.get(local.id)
    expect(after?.subject).toBe('Noch dran')
    expect(after?.remoteId).toBeNull()
    expect(after?.dirty).toBe(true)
  })

  it('survives a full round trip: written here, read back from Gmail', async () => {
    const draft = await harness.app.api['drafts:save'](
      input({ subject: 'Rundreise', html: '<p>Hin und zurück</p>' })
    )
    await harness.app.mutations.flush()
    await pull()

    const after = harness.app.store.drafts.get(draft.id)
    expect(after?.subject).toBe('Rundreise')
    expect(harness.app.store.drafts.listForAccount(accountId)).toHaveLength(1)
  })
})
