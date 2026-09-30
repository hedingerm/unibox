import { describe, expect, it } from 'vitest'
import { SYSTEM_LABELS } from '@shared/types'
import type { Account, SettleProgress } from '@shared/types'
import { labelKey } from '@main/db/ids'
import type { TestApp } from '../helpers/app'
import { createTestApp } from '../helpers/app'

function seedInbox(harness: TestApp, subject: string, remoteId: string): Account {
  const existing = harness.app.store.accounts.list()[0]
  const account =
    existing ??
    harness.app.store.accounts.upsert({
      kind: 'google',
      email: 'max@muster-it.ch',
      displayName: 'max@muster-it.ch'
    })
  harness.app.store.labels.ensureSystemLabels(account.id)
  // Label creation goes through the Gmail API, which needs a usable token.
  harness.app.vault.setGoogleTokens(account.id, {
    accessToken: 'test-access',
    refreshToken: 'test-refresh',
    expiresAt: Date.now() + 3_600_000,
    scope: 'gmail.modify',
    tokenType: 'Bearer'
  })
  harness.app.store.messages.upsert({
    id: `${account.id}:${remoteId}`,
    accountId: account.id,
    threadId: `${account.id}:t:${remoteId}`,
    remoteId,
    subject,
    from: { name: 'Sandra Keller', email: 's.keller@keller-farben.ch' },
    to: [{ name: null, email: account.email }],
    date: Date.now(),
    labelRemoteIds: [SYSTEM_LABELS.inbox, SYSTEM_LABELS.unread],
    body: { html: null, text: 'Anbei die unterschriebene Offerte.' }
  })
  return account
}

describe('settle over IPC', () => {
  it('reports Claude Code as unavailable when there is no runner', async () => {
    const harness = createTestApp()
    try {
      const availability = await harness.app.api['settle:available']()
      expect(availability.available).toBe(false)
      expect(availability.message).toBeTruthy()
      await expect(harness.app.api['settle:analyze']()).rejects.toThrow()
    } finally {
      harness.dispose()
    }
  })

  it('analyzes without touching the mailbox and applies only on confirmation', async () => {
    const progress: SettleProgress[] = []
    const harness = createTestApp({
      googleOAuth: true,
      runClaude: async () =>
        JSON.stringify({
          decisions: [
            {
              ref: 'm1',
              action: 'label',
              label: 'Kunden',
              new_label: true,
              confidence: 'high',
              reason: 'Unterschriebene Offerte'
            }
          ]
        })
    })
    try {
      const account = seedInbox(harness, 'Offerte unterschrieben', 'g1')
      const messageId = `${account.id}:g1`
      const inbox = labelKey(account.id, SYSTEM_LABELS.inbox)

      expect((await harness.app.api['settle:available']()).available).toBe(true)

      const report = await harness.app.api['settle:analyze']()
      expect(report.suggestions).toHaveLength(1)
      expect(report.suggestions[0]?.labelName).toBe('Kunden')
      // Analysing must not move anything by itself.
      expect(harness.app.store.messages.labelIdsOf(messageId)).toContain(inbox)

      const result = await harness.app.api['settle:apply']([
        {
          threadId: report.suggestions[0]!.threadId,
          action: 'label',
          labelName: 'Kunden',
          labelId: null,
          archive: true
        }
      ])
      expect(result.applied).toBe(1)
      expect(result.createdLabels).toEqual(['Kunden'])
      const after = harness.app.store.messages.labelIdsOf(messageId)
      expect(after).not.toContain(inbox)
      expect(harness.gmail.labels.some((label) => label.name === 'Kunden')).toBe(true)

      progress.push(
        ...harness.events
          .filter((event) => event.name === 'settle:progress')
          .map((event) => event.payload as SettleProgress)
      )
      expect(progress.at(-1)?.phase).toBe('done')
      expect(harness.events.some((event) => event.name === 'data:changed')).toBe(true)
    } finally {
      harness.dispose()
    }
  })

  it('looks at only the given conversations when a selection is passed', async () => {
    const prompts: string[] = []
    const harness = createTestApp({
      googleOAuth: true,
      runClaude: async ({ prompt }) => {
        prompts.push(prompt)
        return JSON.stringify({
          decisions: [{ ref: 'm1', action: 'trash', confidence: 'high', reason: 'Werbung' }]
        })
      }
    })
    try {
      const account = seedInbox(harness, 'Offerte', 'g1')
      seedInbox(harness, 'Newsletter August', 'g2')

      const report = await harness.app.api['settle:analyze']([`${account.id}:t:g2`])

      expect(report.scanned).toBe(1)
      expect(report.suggestions).toHaveLength(1)
      expect(report.suggestions[0]?.subject).toBe('Newsletter August')
      expect(prompts).toHaveLength(1)
      expect(prompts[0]).toContain('Newsletter August')
      // Exactly one mail was handed over — the other inbox thread stayed out.
      expect(prompts[0]?.match(/<mail ref=/g)).toHaveLength(1)
    } finally {
      harness.dispose()
    }
  })

  it('runs a selection and the full inbox as separate concurrent runs', async () => {
    const harness = createTestApp({
      googleOAuth: true,
      runClaude: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5))
        return JSON.stringify({ decisions: [] })
      }
    })
    try {
      const account = seedInbox(harness, 'Offerte', 'g1')
      seedInbox(harness, 'Newsletter', 'g2')

      const [scoped, whole] = await Promise.all([
        harness.app.api['settle:analyze']([`${account.id}:t:g1`]),
        harness.app.api['settle:analyze']()
      ])

      expect(scoped.scanned).toBe(1)
      expect(whole.scanned).toBe(2)
    } finally {
      harness.dispose()
    }
  })

  it('runs one analysis at a time even when the button is clicked twice', async () => {
    let calls = 0
    const harness = createTestApp({
      googleOAuth: true,
      runClaude: async () => {
        calls += 1
        await new Promise((resolve) => setTimeout(resolve, 10))
        return JSON.stringify({ decisions: [] })
      }
    })
    try {
      seedInbox(harness, 'Offerte', 'g1')
      const [first, second] = await Promise.all([
        harness.app.api['settle:analyze'](),
        harness.app.api['settle:analyze']()
      ])
      expect(calls).toBe(1)
      expect(first).toBe(second)
    } finally {
      harness.dispose()
    }
  })

  it('undoes a settle exactly, label off and inbox back', async () => {
    const harness = createTestApp({
      googleOAuth: true,
      runClaude: async () => JSON.stringify({ decisions: [] })
    })
    try {
      const account = seedInbox(harness, 'Offerte', 'g1')
      const label = harness.app.store.labels.upsert(account.id, {
        remoteId: 'Label_7',
        name: 'Kunden',
        type: 'user'
      })
      const messageId = `${account.id}:g1`
      const inbox = labelKey(account.id, SYSTEM_LABELS.inbox)
      const decision = {
        threadId: `${account.id}:t:g1`,
        action: 'label' as const,
        labelName: 'Kunden',
        labelId: label.id,
        archive: true
      }

      await harness.app.api['settle:apply']([decision])
      expect(harness.app.store.messages.labelIdsOf(messageId)).not.toContain(inbox)

      const undone = await harness.app.api['settle:undo']([decision])
      expect(undone.applied).toBe(1)
      const labels = harness.app.store.messages.labelIdsOf(messageId)
      expect(labels).toContain(inbox)
      expect(labels).not.toContain(label.id)
      // The label itself survives — other mail may already sit under it.
      expect(harness.app.store.labels.list(account.id).some((l) => l.id === label.id)).toBe(true)
    } finally {
      harness.dispose()
    }
  })

  it('undoes a trash back into the inbox', async () => {
    const harness = createTestApp({
      googleOAuth: true,
      runClaude: async () => JSON.stringify({ decisions: [] })
    })
    try {
      const account = seedInbox(harness, 'Werbung', 'g1')
      const messageId = `${account.id}:g1`
      const decision = {
        threadId: `${account.id}:t:g1`,
        action: 'trash' as const,
        labelName: null,
        labelId: null,
        archive: true
      }

      await harness.app.api['settle:apply']([decision])
      expect(harness.app.store.messages.labelIdsOf(messageId)).toContain(
        labelKey(account.id, SYSTEM_LABELS.trash)
      )

      await harness.app.api['settle:undo']([decision])
      const labels = harness.app.store.messages.labelIdsOf(messageId)
      expect(labels).not.toContain(labelKey(account.id, SYSTEM_LABELS.trash))
      expect(labels).toContain(labelKey(account.id, SYSTEM_LABELS.inbox))
    } finally {
      harness.dispose()
    }
  })

  it('applies nothing for a decision list of kept threads', async () => {
    const harness = createTestApp({
      googleOAuth: true,
      runClaude: async () => JSON.stringify({ decisions: [] })
    })
    try {
      const account = seedInbox(harness, 'Offerte', 'g1')
      const messageId = `${account.id}:g1`
      const before = harness.app.store.messages.labelIdsOf(messageId)

      const result = await harness.app.api['settle:apply']([
        {
          threadId: `${account.id}:t:g1`,
          action: 'keep',
          labelName: null,
          labelId: null,
          archive: false
        }
      ])

      expect(result.applied).toBe(0)
      expect(harness.app.store.messages.labelIdsOf(messageId)).toEqual(before)
    } finally {
      harness.dispose()
    }
  })
})
