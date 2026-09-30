import { describe, expect, it } from 'vitest'
import { SYSTEM_LABELS } from '@shared/types'
import type { Account, AiJob, AiRequest } from '@shared/types'
import { SPOT_CLOSE, SPOT_OPEN } from '@shared/types'
import type { ClaudeRunner } from '@main/claude'
import type { TestApp } from '../helpers/app'
import { createTestApp } from '../helpers/app'

function seed(harness: TestApp): Account {
  const account = harness.app.store.accounts.upsert({
    kind: 'google',
    email: 'max@muster-it.ch',
    displayName: 'max@muster-it.ch'
  })
  harness.app.store.labels.ensureSystemLabels(account.id)
  harness.app.store.identities.create({
    accountId: account.id,
    name: 'Max Muster',
    email: account.email,
    isDefault: true,
    signatureHtml: null
  })
  harness.app.store.messages.upsert({
    id: `${account.id}:g1`,
    accountId: account.id,
    threadId: `${account.id}:t:g1`,
    remoteId: 'g1',
    subject: 'Offerte Onlineshop',
    from: { name: 'Sandra Keller', email: 's.keller@keller-farben.ch' },
    to: [{ name: null, email: account.email }],
    date: Date.parse('2026-08-18T10:12:00.000Z'),
    labelRemoteIds: [SYSTEM_LABELS.inbox],
    body: { html: null, text: 'Wann können Sie mit dem Shop starten?' }
  })
  return account
}

function spotRequest(account: Account, patch: Partial<AiRequest['context']> = {}): AiRequest {
  return {
    mode: 'spot',
    instruction: 'Freundlicher.',
    context: {
      accountId: account.id,
      identityId: null,
      to: 's.keller@keller-farben.ch',
      cc: '',
      subject: 'Re: Offerte Onlineshop',
      replyToMessageId: `${account.id}:g1`,
      html: '<p>Hoi Sandra</p><p>Passt nicht.</p>',
      spot: {
        text: 'Passt nicht.',
        draft: `Hoi Sandra\n\n${SPOT_OPEN}Passt nicht.${SPOT_CLOSE}`
      },
      ...patch
    }
  }
}

async function finished(harness: TestApp, jobId: string): Promise<AiJob> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const job = harness.app.ai.get(jobId)
    if (job && job.state !== 'running') return job
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('Job wurde nicht fertig')
}

describe('assistant on one place in the draft', () => {
  it('marks the place in the draft and measures the answer against it', async () => {
    const prompts: string[] = []
    const runClaude: ClaudeRunner = async ({ prompt }) => {
      prompts.push(prompt)
      return 'Das passt bei mir leider nicht.'
    }
    const harness = createTestApp({ runClaude })
    try {
      const account = seed(harness)
      const started = await harness.app.api['ai:start'](spotRequest(account))
      const job = await finished(harness, started.id)

      expect(job.state).toBe('done')
      // The diff has the marked words on one side, not the whole mail — that is
      // what keeps the review about the place the user pointed at.
      expect(job.source).toBe('Passt nicht.')
      expect(prompts[0]).toContain('<stelle>Passt nicht.</stelle>')
      // The surroundings travel too, or the answer cannot be made to fit them.
      expect(prompts[0]).toContain('Hoi Sandra')
      expect(prompts[0]).toContain('Freundlicher.')
      // The control characters must never reach the model as themselves.
      expect(prompts[0]).not.toContain(SPOT_OPEN)
    } finally {
      harness.dispose()
    }
  })

  it('tells the model to write only that place, not a whole mail', async () => {
    const systems: string[] = []
    const runClaude: ClaudeRunner = async ({ systemPrompt }) => {
      systems.push(systemPrompt)
      return 'Gerne.'
    }
    const harness = createTestApp({ runClaude })
    try {
      const account = seed(harness)
      const started = await harness.app.api['ai:start'](spotRequest(account))
      await finished(harness, started.id)
      expect(systems[0]).toContain('markierte Stelle')
      expect(systems[0]).not.toContain('endet mit der Schlussformel')
    } finally {
      harness.dispose()
    }
  })

  it('asks for something new where the user only pointed at a gap', async () => {
    const prompts: string[] = []
    const runClaude: ClaudeRunner = async ({ prompt }) => {
      prompts.push(prompt)
      return 'Bis Ende September.'
    }
    const harness = createTestApp({ runClaude })
    try {
      const account = seed(harness)
      const started = await harness.app.api['ai:start'](
        spotRequest(account, {
          spot: { text: '', draft: `Hoi Sandra\n\n${SPOT_OPEN}${SPOT_CLOSE}` }
        })
      )
      const job = await finished(harness, started.id)
      // Nothing was replaced, so there is nothing to diff against: the answer
      // goes straight in.
      expect(job.source).toBe('')
      expect(prompts[0]).toContain('<stelle></stelle>')
    } finally {
      harness.dispose()
    }
  })

  it('falls back to filling the gap when the user typed no instruction', async () => {
    const prompts: string[] = []
    const runClaude: ClaudeRunner = async ({ prompt }) => {
      prompts.push(prompt)
      return 'Gerne.'
    }
    const harness = createTestApp({ runClaude })
    try {
      const account = seed(harness)
      const request = spotRequest(account, {
        spot: { text: '', draft: `Hoi Sandra\n\n${SPOT_OPEN}${SPOT_CLOSE}` }
      })
      const started = await harness.app.api['ai:start']({ ...request, instruction: '' })
      await finished(harness, started.id)
      expect(prompts[0]).toContain('Schreibe, was an die markierte Stelle gehört.')
    } finally {
      harness.dispose()
    }
  })
})
