import { describe, expect, it } from 'vitest'
import { SYSTEM_LABELS } from '@shared/types'
import type { Account, AiJob, AiRequest } from '@shared/types'
import { cleanAnswer } from '@main/ai'
import type { ClaudeRunner } from '@main/claude'
import type { TestApp } from '../helpers/app'
import { createTestApp } from '../helpers/app'

function seedThread(harness: TestApp): Account {
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

function request(account: Account, patch: Partial<AiRequest> = {}): AiRequest {
  return {
    mode: 'draft',
    instruction: 'Sag zu und schlage nächste Woche vor.',
    context: {
      accountId: account.id,
      identityId: null,
      to: 's.keller@keller-farben.ch',
      cc: '',
      subject: 'Re: Offerte Onlineshop',
      replyToMessageId: `${account.id}:g1`,
      html: ''
    },
    ...patch
  }
}

/** Waits for the job's terminal `ai:job` event instead of polling the clock. */
async function finished(harness: TestApp, jobId: string): Promise<AiJob> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const job = harness.app.ai.get(jobId)
    if (job && job.state !== 'running') return job
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('Job wurde nicht fertig')
}

describe('compose assistant', () => {
  it('fails the job instead of the call when Claude Code is missing', async () => {
    const harness = createTestApp()
    try {
      const account = seedThread(harness)
      const started = await harness.app.api['ai:start'](request(account))
      expect(started.state).toBe('running')
      const job = await finished(harness, started.id)
      expect(job.state).toBe('error')
      expect(job.error).toBeTruthy()
    } finally {
      harness.dispose()
    }
  })

  it('hands the conversation and the style to the model and keeps the result', async () => {
    const prompts: Array<{ system: string; user: string; model: string }> = []
    const runClaude: ClaudeRunner = async ({ systemPrompt, prompt, model }) => {
      prompts.push({ system: systemPrompt, user: prompt, model })
      return 'Hoi Sandra\n\nGerne, nächste Woche passt.\n\nGruass\nMax'
    }
    const harness = createTestApp({ runClaude })
    try {
      const account = seedThread(harness)
      await harness.app.api['settings:set']({ aiStylePrompt: 'Immer ss statt ß.', aiModel: 'opus' })

      const started = await harness.app.api['ai:start'](request(account))
      const job = await finished(harness, started.id)

      expect(job.state).toBe('done')
      expect(job.result).toContain('Gruass')
      expect(prompts).toHaveLength(1)
      expect(prompts[0]!.model).toBe('opus')
      expect(prompts[0]!.system).toContain('Immer ss statt ß.')
      // The conversation being answered has to travel with the prompt.
      expect(prompts[0]!.user).toContain('Wann können Sie mit dem Shop starten?')
      expect(prompts[0]!.user).toContain('Sag zu und schlage nächste Woche vor.')
      // The sender identity, so the model knows which side it writes for.
      expect(prompts[0]!.user).toContain('max@muster-it.ch')

      const announced = harness.events.filter((event) => event.name === 'ai:job')
      expect(announced).toHaveLength(1)
      expect((announced[0]!.payload as AiJob).state).toBe('done')
    } finally {
      harness.dispose()
    }
  })

  it('carries the draft into a correction and keeps it as the source', async () => {
    let seen = ''
    const harness = createTestApp({
      runClaude: async ({ prompt, systemPrompt }) => {
        seen = `${systemPrompt}\n${prompt}`
        return 'Ich melde mich nächste Woche.'
      }
    })
    try {
      const account = seedThread(harness)
      const started = await harness.app.api['ai:start'](
        request(account, {
          mode: 'correct',
          instruction: '',
          context: {
            ...request(account).context,
            html: '<p>Ich melde mich nächsti Woche.</p>'
          }
        })
      )
      const job = await finished(harness, started.id)

      expect(job.source).toBe('Ich melde mich nächsti Woche.')
      expect(job.result).toBe('Ich melde mich nächste Woche.')
      expect(seen).toContain('Ich melde mich nächsti Woche.')
      // A correction must not be allowed to rewrite the mail.
      expect(seen).toContain('Nicht erlaubt')
    } finally {
      harness.dispose()
    }
  })

  it('lists jobs until they are dismissed', async () => {
    const harness = createTestApp({ runClaude: async () => 'Kurzer Text' })
    try {
      const account = seedThread(harness)
      const started = await harness.app.api['ai:start'](request(account))
      await finished(harness, started.id)

      expect(await harness.app.api['ai:jobs']()).toHaveLength(1)
      await harness.app.api['ai:dismiss'](started.id)
      expect(await harness.app.api['ai:jobs']()).toHaveLength(0)
    } finally {
      harness.dispose()
    }
  })
})

/** Correspondence with someone outside the thread being answered. */
function seedHistory(
  harness: TestApp,
  account: Account,
  options: {
    email: string
    name?: string | null
    outgoing?: string
    incoming?: string
    date?: string
  }
): void {
  const date = Date.parse(options.date ?? '2026-08-15T09:00:00.000Z')
  const person = { name: options.name ?? null, email: options.email }
  const me = { name: 'Max Muster', email: account.email }
  if (options.incoming) {
    harness.app.store.messages.upsert({
      id: `${account.id}:h-in-${options.email}`,
      accountId: account.id,
      threadId: `${account.id}:t:h-${options.email}`,
      remoteId: `h-in-${options.email}`,
      subject: 'Wartung Website',
      from: person,
      to: [me],
      date: date - 60_000,
      direction: 'incoming',
      labelRemoteIds: [SYSTEM_LABELS.inbox],
      body: { html: null, text: options.incoming }
    })
  }
  if (options.outgoing) {
    harness.app.store.messages.upsert({
      id: `${account.id}:h-out-${options.email}`,
      accountId: account.id,
      threadId: `${account.id}:t:h-${options.email}`,
      remoteId: `h-out-${options.email}`,
      subject: 'Re: Wartung Website',
      from: me,
      to: [person],
      date,
      direction: 'outgoing',
      labelRemoteIds: [SYSTEM_LABELS.sent],
      body: { html: null, text: options.outgoing }
    })
  }
}

/** Runs one job and returns the user prompt the model saw. */
async function promptFor(harness: TestApp, input: AiRequest): Promise<string> {
  const started = await harness.app.api['ai:start'](input)
  await finished(harness, started.id)
  return seenPrompts.at(-1) ?? ''
}

const seenPrompts: string[] = []

function recording(): ClaudeRunner {
  return async ({ prompt }) => {
    seenPrompts.push(prompt)
    return 'Hoi\n\nPasst.'
  }
}

describe('recipient dossier', () => {
  it('tells the model who the recipient is when no conversation exists', async () => {
    const harness = createTestApp({ runClaude: recording() })
    try {
      const account = seedThread(harness)
      seedHistory(harness, account, {
        email: 'marco@bauer-gmbh.ch',
        name: 'Marco Bauer',
        incoming: 'Hoi Max, chasch du mir die Offerte no schicke?',
        outgoing: 'Hoi Marco\n\nKlar, ich schicke dir die Offerte morgen.\n\nGruass\nMax'
      })

      const prompt = await promptFor(
        harness,
        request(account, {
          instruction: 'Frag ihn wegen der Offerte.',
          context: {
            ...request(account).context,
            to: 'marco@bauer-gmbh.ch',
            subject: '',
            replyToMessageId: null
          }
        })
      )

      expect(prompt).toContain('Marco Bauer')
      expect(prompt).toContain('Anrede: Du')
      expect(prompt).toContain('Meine Anrede zuletzt: Hoi Marco')
      expect(prompt).toContain('Mails insgesamt')
      // The old mail itself, so the tone is visible and not just asserted.
      expect(prompt).toContain('Klar, ich schicke dir die Offerte morgen.')
    } finally {
      harness.dispose()
    }
  })

  it('reads Sie off the user\'s own mail, not off the quoted original', async () => {
    const harness = createTestApp({ runClaude: recording() })
    try {
      const account = seedThread(harness)
      seedHistory(harness, account, {
        email: 'a.frei@treuhand-frei.ch',
        name: 'Andrea Frei',
        outgoing: [
          'Guten Tag Frau Frei',
          '',
          'Besten Dank, ich schicke Ihnen die Unterlagen bis Freitag.',
          '',
          'Freundliche Grüsse',
          'Max Muster',
          '',
          'Am 12.08.2026 schrieb Andrea Frei:',
          '> Hoi Max, chasch du mir dini Unterlage schicke? Danke dir!'
        ].join('\n')
      })

      const prompt = await promptFor(
        harness,
        request(account, {
          context: {
            ...request(account).context,
            to: 'Andrea Frei <a.frei@treuhand-frei.ch>',
            replyToMessageId: null
          }
        })
      )

      expect(prompt).toContain('Anrede: Sie')
      expect(prompt).not.toContain('Anrede: Du')
    } finally {
      harness.dispose()
    }
  })

  it('keeps the dossier to the facts when a conversation travels with it', async () => {
    const harness = createTestApp({ runClaude: recording() })
    try {
      const account = seedThread(harness)
      seedHistory(harness, account, {
        email: 's.keller@keller-farben.ch',
        name: 'Sandra Keller',
        outgoing: 'Guten Tag Frau Keller\n\nGerne melde ich mich bei Ihnen zur Fassade.'
      })

      const prompt = await promptFor(harness, request(account))

      // The relationship still travels …
      expect(prompt).toContain('Anrede: Sie')
      // … the older mail does not: the thread is the concrete context.
      expect(prompt).not.toContain('Gerne melde ich mich bei Ihnen zur Fassade.')
      expect(prompt).toContain('Wann können Sie mit dem Shop starten?')
    } finally {
      harness.dispose()
    }
  })

  it('leaves a correction without any context to improve the mail with', async () => {
    const harness = createTestApp({ runClaude: recording() })
    try {
      const account = seedThread(harness)
      seedHistory(harness, account, {
        email: 's.keller@keller-farben.ch',
        name: 'Sandra Keller',
        outgoing: 'Guten Tag Frau Keller\n\nGerne melde ich mich bei Ihnen zur Fassade.'
      })

      const prompt = await promptFor(
        harness,
        request(account, { mode: 'correct', instruction: '' })
      )

      expect(prompt).not.toContain('Was ich im Archiv')
      expect(prompt).not.toContain('Anrede:')
    } finally {
      harness.dispose()
    }
  })

  it('builds no dossier for a mailbox that never reads what it gets', async () => {
    const harness = createTestApp({ runClaude: recording() })
    try {
      const account = seedThread(harness)
      seedHistory(harness, account, {
        email: 'no-reply@stripe.com',
        name: 'Stripe',
        incoming: 'Ihre Zahlung ist eingegangen. Antworten Sie nicht auf diese Mail.'
      })

      const prompt = await promptFor(
        harness,
        request(account, {
          context: {
            ...request(account).context,
            to: 'no-reply@stripe.com',
            replyToMessageId: null
          }
        })
      )

      expect(prompt).not.toContain('Was ich im Archiv')
    } finally {
      harness.dispose()
    }
  })

  it('says nothing about someone the archive has never seen', async () => {
    const harness = createTestApp({ runClaude: recording() })
    try {
      const account = seedThread(harness)

      const prompt = await promptFor(
        harness,
        request(account, {
          context: {
            ...request(account).context,
            to: 'neu@fremde-firma.ch',
            replyToMessageId: null
          }
        })
      )

      expect(prompt).not.toContain('Was ich im Archiv')
      expect(prompt).toContain('neu@fremde-firma.ch')
    } finally {
      harness.dispose()
    }
  })

  it('finds the user\'s own mail even when it fell out of the newest few', async () => {
    const harness = createTestApp({ runClaude: recording() })
    try {
      const account = seedThread(harness)
      const person = { name: 'Marco Bauer', email: 'marco@bauer-gmbh.ch' }
      // The counterparty writes weekly reports; the user answered once, long ago.
      for (let index = 0; index < 6; index += 1) {
        harness.app.store.messages.upsert({
          id: `${account.id}:rap${index}`,
          accountId: account.id,
          threadId: `${account.id}:t:rap${index}`,
          remoteId: `rap${index}`,
          subject: `Wochenrapport ${index}`,
          from: person,
          to: [{ name: null, email: account.email }],
          date: Date.parse('2026-08-10T08:00:00.000Z') + index * 86_400_000,
          direction: 'incoming',
          labelRemoteIds: [SYSTEM_LABELS.inbox],
          body: { html: null, text: 'Guten Tag, anbei finden Sie den Rapport. Ihre Unterlagen folgen.' }
        })
      }
      harness.app.store.messages.upsert({
        id: `${account.id}:alt`,
        accountId: account.id,
        threadId: `${account.id}:t:alt`,
        remoteId: 'alt',
        subject: 'Rapporte',
        from: { name: 'Max Muster', email: account.email },
        to: [person],
        date: Date.parse('2026-07-01T08:00:00.000Z'),
        direction: 'outgoing',
        labelRemoteIds: [SYSTEM_LABELS.sent],
        body: { html: null, text: 'Hoi Marco\n\nMerci, schick mir die Rapporte gern weiterhin.' }
      })

      const prompt = await promptFor(
        harness,
        request(account, {
          context: { ...request(account).context, to: 'marco@bauer-gmbh.ch', replyToMessageId: null }
        })
      )

      // Six incoming mails would have filled the window on their own.
      expect(prompt).toContain('Anrede: Du')
      expect(prompt).toContain('schick mir die Rapporte gern weiterhin.')
    } finally {
      harness.dispose()
    }
  })

  it('describes nobody when the mail is a circular', async () => {
    const harness = createTestApp({ runClaude: recording() })
    try {
      const account = seedThread(harness)
      for (const email of ['a@firma.ch', 'b@firma.ch', 'c@firma.ch', 'd@firma.ch']) {
        seedHistory(harness, account, { email, outgoing: 'Hoi\n\nMerci dir.' })
      }

      const prompt = await promptFor(
        harness,
        request(account, {
          context: {
            ...request(account).context,
            to: 'a@firma.ch, b@firma.ch, c@firma.ch',
            cc: 'd@firma.ch',
            replyToMessageId: null
          }
        })
      )

      expect(prompt).not.toContain('Was ich im Archiv')
    } finally {
      harness.dispose()
    }
  })

  it('counts an address once and never counts the sender', async () => {
    const harness = createTestApp({ runClaude: recording() })
    try {
      const account = seedThread(harness)
      seedHistory(harness, account, {
        email: 'marco@bauer-gmbh.ch',
        name: 'Marco Bauer',
        outgoing: 'Hoi Marco\n\nMerci dir.'
      })

      const prompt = await promptFor(
        harness,
        request(account, {
          context: {
            ...request(account).context,
            to: `marco@bauer-gmbh.ch, ${account.email}`,
            cc: 'Marco Bauer <marco@bauer-gmbh.ch>',
            replyToMessageId: null
          }
        })
      )

      expect(prompt.match(/<person>/g)).toHaveLength(1)
      expect(prompt).not.toContain(`Adresse: ${account.email}`)
    } finally {
      harness.dispose()
    }
  })
})

describe('answer cleaning', () => {
  it('takes the text out of a code fence', () => {
    expect(cleanAnswer('```\nHoi Marco\n```')).toBe('Hoi Marco')
  })

  it('drops a line that announces the mail instead of being it', () => {
    expect(cleanAnswer('Hier ist dein Entwurf:\n\nHoi Marco')).toBe('Hoi Marco')
  })

  it('leaves an ordinary answer untouched', () => {
    expect(cleanAnswer('Hoi Marco\n\nPasst so.')).toBe('Hoi Marco\n\nPasst so.')
  })
})
