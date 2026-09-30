import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Account } from '@shared/types'
import { SYSTEM_LABELS } from '@shared/types'
import { labelKey } from '@main/db/ids'
import type { TestApp } from '../helpers/app'
import { createTestApp } from '../helpers/app'

let harness: TestApp

function seedAccount(): Account {
  const account = harness.app.store.accounts.upsert({
    kind: 'google',
    email: 'max@muster-it.ch',
    displayName: 'max@muster-it.ch'
  })
  harness.app.store.labels.ensureSystemLabels(account.id)
  // Label calls reach the Gmail API, which needs a usable token.
  harness.app.vault.setGoogleTokens(account.id, {
    accessToken: 'test-access',
    refreshToken: 'test-refresh',
    expiresAt: Date.now() + 3_600_000,
    scope: 'gmail.modify',
    tokenType: 'Bearer'
  })
  return account
}

function seedMessage(account: Account, remoteId: string, labels: string[]): string {
  const id = `${account.id}:${remoteId}`
  harness.app.store.messages.upsert({
    id,
    accountId: account.id,
    threadId: `${account.id}:t:${remoteId}`,
    remoteId,
    subject: `Betreff ${remoteId}`,
    from: { name: 'Sandra Keller', email: 's.keller@keller-farben.ch' },
    to: [{ name: null, email: account.email }],
    date: Date.now(),
    labelRemoteIds: labels,
    body: { html: null, text: 'Inhalt' }
  })
  return id
}

beforeEach(() => {
  harness = createTestApp({ googleOAuth: true })
})

afterEach(() => {
  harness.dispose()
})

describe('managing labels over IPC', () => {
  it('creates a label in Gmail first and mirrors it locally', async () => {
    const account = seedAccount()

    const label = await harness.app.api['labels:create'](account.id, 'Kunden')

    expect(harness.gmail.labels.some((entry) => entry.name === 'Kunden')).toBe(true)
    expect(label.id).toBe(labelKey(account.id, label.remoteId))
    expect(harness.app.store.labels.byId(label.id)?.name).toBe('Kunden')
  })

  it('refuses a name that is already taken', async () => {
    const account = seedAccount()
    await harness.app.api['labels:create'](account.id, 'Kunden')

    await expect(harness.app.api['labels:create'](account.id, 'kunden')).rejects.toThrow(
      /existiert bereits/
    )
  })

  it('renames a label remotely and locally, keeping its id', async () => {
    const account = seedAccount()
    const label = await harness.app.api['labels:create'](account.id, 'Kunden')

    const renamed = await harness.app.api['labels:rename'](label.id, 'Kunden/Aktiv')

    expect(renamed.id).toBe(label.id)
    expect(harness.gmail.labels.find((entry) => entry.id === label.remoteId)?.name).toBe(
      'Kunden/Aktiv'
    )
    expect(harness.app.store.labels.byId(label.id)?.name).toBe('Kunden/Aktiv')
  })

  it('refuses to rename or delete a system label', async () => {
    const account = seedAccount()
    const inbox = labelKey(account.id, SYSTEM_LABELS.inbox)

    await expect(harness.app.api['labels:rename'](inbox, 'Eingang')).rejects.toThrow(/Systemlabels/)
    await expect(harness.app.api['labels:remove'](inbox)).rejects.toThrow(/Systemlabels/)
  })

  it('deletes a label everywhere but leaves the messages that carried it', async () => {
    const account = seedAccount()
    const label = await harness.app.api['labels:create'](account.id, 'Kunden')
    const messageId = seedMessage(account, 'g1', [SYSTEM_LABELS.inbox, label.remoteId])

    await harness.app.api['labels:remove'](label.id)

    expect(harness.gmail.labels.some((entry) => entry.id === label.remoteId)).toBe(false)
    expect(harness.app.store.labels.byId(label.id)).toBeNull()
    const message = harness.app.store.messages.get(messageId)
    expect(message).not.toBeNull()
    expect(message?.labelIds).not.toContain(label.id)
    expect(message?.labelIds).toContain(labelKey(account.id, SYSTEM_LABELS.inbox))
  })

  it('marks every unread message of a label read', async () => {
    const account = seedAccount()
    const unreadId = labelKey(account.id, SYSTEM_LABELS.unread)
    const inbox = labelKey(account.id, SYSTEM_LABELS.inbox)
    const first = seedMessage(account, 'g1', [SYSTEM_LABELS.inbox, SYSTEM_LABELS.unread])
    const second = seedMessage(account, 'g2', [SYSTEM_LABELS.inbox])

    await harness.app.api['labels:markAllRead'](inbox)

    expect(harness.app.store.messages.get(first)?.labelIds).not.toContain(unreadId)
    expect(harness.app.store.messages.get(second)?.labelIds).not.toContain(unreadId)
  })

  it('empties the trash for good but refuses to empty an ordinary mailbox', async () => {
    const account = seedAccount()
    const trash = labelKey(account.id, SYSTEM_LABELS.trash)
    const trashed = seedMessage(account, 'g1', [SYSTEM_LABELS.trash])
    const kept = seedMessage(account, 'g2', [SYSTEM_LABELS.inbox])

    await expect(
      harness.app.api['labels:empty'](labelKey(account.id, SYSTEM_LABELS.inbox))
    ).rejects.toThrow(/Papierkorb und Spam/)

    await harness.app.api['labels:empty'](trash)

    expect(harness.app.store.messages.get(trashed)).toBeNull()
    expect(harness.app.store.messages.get(kept)).not.toBeNull()
  })
})
