import { describe, expect, it } from 'vitest'
import { SYSTEM_LABELS } from '@shared/types'
import type { Account } from '@shared/types'
import { EvidenceRepo, subjectMatchExpression } from '@main/settle/evidence'
import { renderEvidence } from '@main/settle/prompt'
import type { Store } from '@main/db/store'
import { addGoogleAccount, makeStore, seedMessage } from '../helpers/store'

interface Harness {
  store: Store
  account: Account
  evidence: EvidenceRepo
}

function setup(): Harness {
  const store = makeStore()
  const account = addGoogleAccount(store)
  store.labels.upsert(account.id, { remoteId: 'Label_1', name: 'Rechnungen', type: 'user' })
  store.labels.upsert(account.id, { remoteId: 'Label_2', name: 'Kunden', type: 'user' })
  return { store, account, evidence: new EvidenceRepo(store.db) }
}

/** Files a past mail from `from` under `label`, out of the inbox. */
function filed(
  harness: Harness,
  remoteId: string,
  from: string,
  subject: string,
  labelRemoteId: string
): void {
  seedMessage(harness.store, harness.account, {
    remoteId,
    subject,
    from: { name: null, email: from },
    labels: [labelRemoteId]
  })
}

describe('subjectMatchExpression', () => {
  it('drops reply prefixes, stopwords and numbers', () => {
    expect(subjectMatchExpression('Re: AW: Ihre Rechnung 12345')).toBe('"rechnung"')
  })

  it('quotes every token so a subject cannot inject FTS operators', () => {
    const expression = subjectMatchExpression('Angebot OR Vertrag "NEAR" bar*')
    expect(expression).toBe('"angebot" OR "vertrag" OR "near" OR "bar"')
  })

  it('returns null when nothing usable is left', () => {
    expect(subjectMatchExpression('Re: die und das')).toBeNull()
    expect(subjectMatchExpression('')).toBeNull()
  })
})

describe('sender history', () => {
  it('reports where past mail from the same address was filed', () => {
    const harness = setup()
    filed(harness, 'a1', 'billing@vercel.com', 'Your receipt', 'Label_1')
    filed(harness, 'a2', 'billing@vercel.com', 'Your receipt', 'Label_1')
    filed(harness, 'a3', 'billing@vercel.com', 'Your receipt', 'Label_1')

    const history = harness.evidence.senderHistory(
      harness.account.id,
      'anderer-thread',
      'billing@vercel.com'
    )
    expect(history?.scope).toBe('address')
    expect(history?.total).toBe(3)
    expect(history?.tallies).toEqual([{ name: 'Rechnungen', count: 3 }])
  })

  it('falls back to the domain when the exact address is new', () => {
    const harness = setup()
    filed(harness, 'a1', 'billing@hetzner.com', 'Rechnung', 'Label_1')
    filed(harness, 'a2', 'accounts@hetzner.com', 'Rechnung', 'Label_1')

    const history = harness.evidence.senderHistory(
      harness.account.id,
      'anderer-thread',
      'noreply@hetzner.com'
    )
    expect(history?.scope).toBe('domain')
    expect(history?.key).toBe('@hetzner.com')
    expect(history?.tallies).toEqual([{ name: 'Rechnungen', count: 2 }])
  })

  it('counts the trash as a destination of its own', () => {
    const harness = setup()
    filed(harness, 'a1', 'promo@shop.example', 'Sale', SYSTEM_LABELS.trash)
    filed(harness, 'a2', 'promo@shop.example', 'Sale', SYSTEM_LABELS.trash)

    const history = harness.evidence.senderHistory(
      harness.account.id,
      'anderer-thread',
      'promo@shop.example'
    )
    expect(history?.tallies).toEqual([{ name: SYSTEM_LABELS.trash, count: 2 }])
  })

  it('separates mail that was never filed anywhere', () => {
    const harness = setup()
    filed(harness, 'a1', 'anna@example.com', 'Frage', 'Label_2')
    // Two more from her that just sat in the inbox.
    seedMessage(harness.store, harness.account, {
      remoteId: 'a2',
      from: { name: null, email: 'anna@example.com' }
    })
    seedMessage(harness.store, harness.account, {
      remoteId: 'a3',
      from: { name: null, email: 'anna@example.com' }
    })

    const history = harness.evidence.senderHistory(
      harness.account.id,
      'anderer-thread',
      'anna@example.com'
    )
    expect(history?.total).toBe(3)
    expect(history?.tallies).toEqual([{ name: 'Kunden', count: 1 }])
    expect(history?.unfiled).toBe(2)
  })

  it('never cites the mail being sorted as its own precedent', () => {
    const harness = setup()
    filed(harness, 'a1', 'billing@vercel.com', 'Your receipt', 'Label_1')
    const own = harness.store.messages.get(`${harness.account.id}:a1`)!

    expect(
      harness.evidence.senderHistory(harness.account.id, own.threadId, 'billing@vercel.com')
    ).toBeNull()
  })

  it('has nothing to say about an unknown sender', () => {
    const harness = setup()
    filed(harness, 'a1', 'billing@vercel.com', 'Your receipt', 'Label_1')

    expect(
      harness.evidence.senderHistory(harness.account.id, 'anderer-thread', 'wer@unbekannt.test')
    ).toBeNull()
  })
})

describe('subject similarity', () => {
  it('finds where mails with a comparable subject were filed', () => {
    const harness = setup()
    filed(harness, 'a1', 'a@kunde-eins.ch', 'Anfrage neue Website', 'Label_2')
    filed(harness, 'a2', 'b@kunde-zwei.ch', 'Anfrage Website Relaunch', 'Label_2')
    filed(harness, 'a3', 'billing@vercel.com', 'Your receipt', 'Label_1')

    const similar = harness.evidence.similarSubjects(
      harness.account.id,
      'anderer-thread',
      'Anfrage für eine neue Website'
    )
    expect(similar[0]).toEqual({ name: 'Kunden', count: 2 })
  })

  it('returns nothing when no past mail resembles the subject', () => {
    const harness = setup()
    filed(harness, 'a1', 'billing@vercel.com', 'Your receipt', 'Label_1')

    expect(
      harness.evidence.similarSubjects(harness.account.id, 'anderer-thread', 'Gartenbau Offerte')
    ).toEqual([])
  })
})

describe('renderEvidence', () => {
  it('names the system destinations in words', () => {
    expect(
      renderEvidence({
        sender: {
          scope: 'address',
          key: 'promo@shop.example',
          tallies: [{ name: SYSTEM_LABELS.trash, count: 11 }],
          unfiled: 0,
          total: 11
        },
        similar: []
      })
    ).toContain('11× Papierkorb')
  })

  it('writes one line the model can act on', () => {
    expect(
      renderEvidence({
        sender: {
          scope: 'address',
          key: 'billing@vercel.com',
          tallies: [{ name: 'Rechnungen', count: 7 }],
          unfiled: 1,
          total: 8
        },
        similar: [{ name: 'Rechnungen', count: 4 }]
      })
    ).toBe(
      'Bisher abgelegt — gleicher Absender billing@vercel.com (8 Mails): 7× Rechnungen, 1× nirgends abgelegt · ähnliche Betreffe: 4× Rechnungen'
    )
  })

  it('stays silent when there is no history at all', () => {
    expect(renderEvidence({ sender: null, similar: [] })).toBeNull()
    expect(renderEvidence(null)).toBeNull()
  })
})
