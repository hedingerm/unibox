import { describe, expect, it } from 'vitest'
import { SYSTEM_LABELS } from '@shared/types'
import type { Account } from '@shared/types'
import { GmailClient } from '@main/google/client'
import { MutationService } from '@main/mutations'
import { SettleService } from '@main/settle'
import { parseDecisions } from '@main/settle/parse'
import { labelKey } from '@main/db/ids'
import type { Store } from '@main/db/store'
import { FakeGmail } from '../helpers/fake-gmail'
import { addGoogleAccount, makeStore, seedMessage } from '../helpers/store'

interface Harness {
  store: Store
  gmail: FakeGmail
  account: Account
  prompts: string[]
  settle: SettleService
}

function setup(answer: (prompt: string) => string): Harness {
  const store = makeStore()
  const gmail = new FakeGmail()
  const account = addGoogleAccount(store)
  const client = new GmailClient({
    baseUrl: 'https://gmail.test/gmail/v1',
    accessToken: async () => 'token',
    fetch: (input, init) => gmail.fetch(String(input), init),
    sleep: async () => {}
  })
  const mutations = new MutationService(store, { gmailClientFor: () => client })
  const prompts: string[] = []
  const settle = new SettleService(store, mutations, {
    runClaude: async ({ prompt }) => {
      prompts.push(prompt)
      return answer(prompt)
    },
    gmailClientFor: () => client
  })
  return { store, gmail, account, prompts, settle }
}

function answerWith(decisions: unknown[]): string {
  return JSON.stringify({ decisions })
}

describe('parseDecisions', () => {
  it('reads a fenced answer', () => {
    const parsed = parseDecisions(
      '```json\n{"decisions":[{"ref":"m1","action":"label","label":"Kunden","new_label":false,"confidence":"high","reason":"Kundenmail"}]}\n```'
    )
    expect(parsed).toEqual([
      {
        ref: 'm1',
        action: 'label',
        label: 'Kunden',
        newLabel: false,
        confidence: 'high',
        reason: 'Kundenmail'
      }
    ])
  })

  it('falls back to keep for unknown actions and label-less label calls', () => {
    const parsed = parseDecisions(
      answerWith([
        { ref: 'm1', action: 'delete_everything', confidence: 'high' },
        { ref: 'm2', action: 'label', label: '', confidence: 'high' }
      ])
    )
    expect(parsed.map((d) => d.action)).toEqual(['keep', 'keep'])
    expect(parsed.every((d) => d.label === null)).toBe(true)
  })

  it('ignores duplicate refs and unparsable output', () => {
    const duplicated = parseDecisions(
      answerWith([
        { ref: 'm1', action: 'trash', confidence: 'high' },
        { ref: 'm1', action: 'label', label: 'X', confidence: 'high' }
      ])
    )
    expect(duplicated).toHaveLength(1)
    expect(duplicated[0]?.action).toBe('trash')
    expect(parseDecisions('sorry, I cannot help with that')).toEqual([])
  })
})

describe('SettleService.analyze', () => {
  it('suggests a known label and marks it as existing', async () => {
    const { store, account, settle, prompts } = setup(() =>
      answerWith([
        {
          ref: 'm1',
          action: 'label',
          label: 'Kunden',
          new_label: false,
          confidence: 'high',
          reason: 'Offerte einer Kundin'
        }
      ])
    )
    store.labels.upsert(account.id, { remoteId: 'Label_1', name: 'Kunden', type: 'user' })
    seedMessage(store, account, { remoteId: 'a1', subject: 'Offerte' })

    const report = await settle.analyze(10, 'sonnet')
    expect(report.scanned).toBe(1)
    expect(report.suggestions).toHaveLength(1)
    const suggestion = report.suggestions[0]!
    expect(suggestion.action).toBe('label')
    expect(suggestion.labelName).toBe('Kunden')
    expect(suggestion.labelId).toBe(labelKey(account.id, 'Label_1'))
    expect(suggestion.archive).toBe(true)
    // The prompt has to carry the account's own labels, not just the mail.
    expect(prompts[0]).toContain('Kunden')
    expect(prompts[0]).toContain('Offerte')
  })

  it('reports an unknown label as new and never as an existing id', async () => {
    const { store, account, settle } = setup(() =>
      answerWith([
        {
          ref: 'm1',
          action: 'label',
          label: 'Rechnungen/2026',
          new_label: true,
          confidence: 'medium',
          reason: 'Rechnung'
        }
      ])
    )
    seedMessage(store, account, { remoteId: 'a1', subject: 'Rechnung 42' })

    const report = await settle.analyze(10, 'sonnet')
    expect(report.suggestions[0]?.labelName).toBe('Rechnungen/2026')
    expect(report.suggestions[0]?.labelId).toBeNull()
  })

  it('counts mails the model left out instead of inventing a decision', async () => {
    const { store, account, settle } = setup(() => answerWith([]))
    seedMessage(store, account, { remoteId: 'a1' })
    seedMessage(store, account, { remoteId: 'a2' })

    const report = await settle.analyze(10, 'sonnet')
    expect(report.suggestions).toHaveLength(0)
    expect(report.skipped).toBe(2)
  })

  it('keeps the batches that worked when one call fails', async () => {
    const { store, account, settle } = setup((prompt) => {
      if (prompt.includes('Zweite')) throw new Error('CLI weg')
      return answerWith([{ ref: 'm1', action: 'trash', confidence: 'high', reason: 'Werbung' }])
    })
    seedMessage(store, account, { remoteId: 'a1', subject: 'Erste', date: 2000 })
    seedMessage(store, account, { remoteId: 'a2', subject: 'Zweite', date: 1000 })

    const report = await settle.analyze(1, 'sonnet')
    expect(report.suggestions).toHaveLength(1)
    expect(report.warning).toContain('CLI weg')
  })
})

describe('SettleService.apply', () => {
  it('labels, archives and queues the write-back for Gmail', async () => {
    const { store, account, settle } = setup(() => answerWith([]))
    const label = store.labels.upsert(account.id, {
      remoteId: 'Label_1',
      name: 'Kunden',
      type: 'user'
    })
    const messageId = seedMessage(store, account, { remoteId: 'a1' })

    const result = await settle.apply([
      { threadId: store.messages.get(messageId)!.threadId, action: 'label', labelName: 'Kunden', labelId: label.id, archive: true }
    ])

    expect(result.applied).toBe(1)
    expect(result.createdLabels).toEqual([])
    const labels = store.messages.labelIdsOf(messageId)
    expect(labels).toContain(label.id)
    expect(labels).not.toContain(labelKey(account.id, SYSTEM_LABELS.inbox))
    expect(store.queue.pending(Date.now() + 1000).length).toBeGreaterThan(0)
  })

  it('creates a missing label in Gmail before using it', async () => {
    const { store, gmail, account, settle } = setup(() => answerWith([]))
    const messageId = seedMessage(store, account, { remoteId: 'a1' })

    const result = await settle.apply([
      {
        threadId: store.messages.get(messageId)!.threadId,
        action: 'label',
        labelName: 'Rechnungen/2026',
        labelId: null,
        archive: true
      }
    ])

    expect(result.applied).toBe(1)
    expect(result.createdLabels).toEqual(['Rechnungen/2026'])
    expect(gmail.labels.some((l) => l.name === 'Rechnungen/2026')).toBe(true)
    expect(store.labels.list(account.id).some((l) => l.name === 'Rechnungen/2026')).toBe(true)
  })

  it('leaves a kept thread untouched', async () => {
    const { store, account, settle } = setup(() => answerWith([]))
    const messageId = seedMessage(store, account, { remoteId: 'a1' })
    const before = store.messages.labelIdsOf(messageId)

    const result = await settle.apply([
      { threadId: store.messages.get(messageId)!.threadId, action: 'keep', labelName: null, labelId: null, archive: false }
    ])

    expect(result.applied).toBe(0)
    expect(store.messages.labelIdsOf(messageId)).toEqual(before)
  })

  it('records a failure per thread instead of aborting the run', async () => {
    const { store, account, settle } = setup(() => answerWith([]))
    const messageId = seedMessage(store, account, { remoteId: 'a1' })
    const threadId = store.messages.get(messageId)!.threadId

    const result = await settle.apply([
      { threadId: 'gibt-es-nicht', action: 'trash', labelName: null, labelId: null, archive: true },
      { threadId, action: 'trash', labelName: null, labelId: null, archive: true }
    ])

    expect(result.applied).toBe(1)
    expect(result.failed).toHaveLength(1)
    expect(store.messages.labelIdsOf(messageId)).toContain(labelKey(account.id, SYSTEM_LABELS.trash))
  })
})
