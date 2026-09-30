import { describe, expect, it } from 'vitest'
import { ResendClient } from '@main/resend/client'
import { MxConflictError, ResendDomainService } from '@main/resend/domains'
import type { MxResolver } from '@main/resend/mx'
import { analyzeMx, inboundMxHost, resolveMxSafely } from '@main/resend/mx'
import { FakeResend } from '../helpers/fake-resend'
import { makeStore } from '../helpers/store'

function setup(): {
  store: ReturnType<typeof makeStore>
  resend: FakeResend
  service: ResendDomainService
} {
  const store = makeStore()
  const resend = new FakeResend()
  const client = new ResendClient({
    apiKey: () => 're_test',
    fetch: resend.fetch,
    baseUrl: 'https://api.resend.test',
    sleep: async () => undefined
  })
  const service = new ResendDomainService(store, { client, resolveMx: resend.resolveMx })
  return { store, resend, service }
}

describe('MX analysis', () => {
  it('accepts Resend as the highest-priority host', () => {
    const analysis = analyzeMx(
      [{ exchange: inboundMxHost('eu-west-1'), priority: 10 }],
      'eu-west-1'
    )
    expect(analysis.verified).toBe(true)
    expect(analysis.conflicting).toEqual([])
  })

  it('reports foreign hosts as conflicts', () => {
    const analysis = analyzeMx(
      [
        { exchange: 'aspmx.l.google.com', priority: 1 },
        { exchange: 'alt1.aspmx.l.google.com', priority: 5 }
      ],
      'eu-west-1'
    )
    expect(analysis.verified).toBe(false)
    expect(analysis.conflicting).toEqual(['aspmx.l.google.com', 'alt1.aspmx.l.google.com'])
  })

  it('does not count Resend as verified when another host wins the priority', () => {
    const analysis = analyzeMx(
      [
        { exchange: inboundMxHost('eu-west-1'), priority: 20 },
        { exchange: 'aspmx.l.google.com', priority: 1 }
      ],
      'eu-west-1'
    )
    expect(analysis.verified).toBe(false)
  })
})

describe('domain listing', () => {
  it('lists every domain of the account with its MX state', async () => {
    const { resend, service } = setup()
    resend.addDomain('beispielweb.ch', true)
    resend.addDomain('nordwind.ch')
    resend.mx.set('beispielweb.ch', [{ exchange: inboundMxHost('eu-west-1'), priority: 10 }])

    const domains = await service.list()
    expect(domains.map((d) => d.name)).toEqual(['beispielweb.ch', 'nordwind.ch'])
    expect(domains[0]?.receivingEnabled).toBe(true)
    expect(domains[0]?.mxVerified).toBe(true)
    expect(domains[1]?.mxVerified).toBe(false)
    expect(domains[1]?.requiredMxRecord).toBe('nordwind.ch  MX  10  inbound-smtp.eu-west-1.amazonaws.com')
  })

  it('adopts a domain whose receiving is already on at Resend', async () => {
    const { store, resend, service } = setup()
    resend.addDomain('beispielweb.ch', true)
    resend.addDomain('nordwind.ch')

    const domains = await service.list()
    const account = store.accounts.findByEmail('resend', 'beispielweb.ch')!
    expect(account.receivingEnabled).toBe(true)
    expect(domains[0]?.connectedAccountId).toBe(account.id)
    expect(store.labels.list(account.id).length).toBeGreaterThan(0)
    // A domain that is off at Resend must not turn into an account.
    expect(store.accounts.findByEmail('resend', 'nordwind.ch')).toBeNull()
    expect(domains[1]?.connectedAccountId).toBeNull()
  })

  it('marks an account inactive when receiving was switched off elsewhere', async () => {
    const { store, resend, service } = setup()
    const domain = resend.addDomain('nordwind.ch', true)
    await service.list()
    expect(store.accounts.findByResendDomainId(domain.id)?.receivingEnabled).toBe(true)

    domain.capabilities = { receiving: 'disabled' }
    await service.list()
    expect(store.accounts.findByResendDomainId(domain.id)?.receivingEnabled).toBe(false)
  })
})

describe('receiving toggle', () => {
  it('enables receiving and creates the matching account', async () => {
    const { store, resend, service } = setup()
    const domain = resend.addDomain('nordwind.ch')
    resend.mx.set('nordwind.ch', [])

    const info = await service.enableReceiving(domain.id)
    expect(resend.updates).toEqual([{ id: domain.id, body: { capabilities: { receiving: 'enabled' } } }])
    expect(info.receivingEnabled).toBe(true)
    const account = store.accounts.findByResendDomainId(domain.id)!
    expect(account.email).toBe('nordwind.ch')
    expect(account.kind).toBe('resend')
    expect(store.labels.list(account.id).length).toBeGreaterThan(0)
  })

  it('refuses activation while a foreign MX record is in place', async () => {
    const { resend, service } = setup()
    const domain = resend.addDomain('muster-it.ch')
    resend.mx.set('muster-it.ch', [{ exchange: 'aspmx.l.google.com', priority: 1 }])

    const info = await service.inspect(domain.id)
    expect(info.conflictingMx).toEqual(['aspmx.l.google.com'])

    await expect(service.enableReceiving(domain.id)).rejects.toBeInstanceOf(MxConflictError)
    expect(resend.updates).toHaveLength(0)

    await service.enableReceiving(domain.id, true)
    expect(resend.updates).toHaveLength(1)
  })

  it('mentions the redirect consequence in the warning', async () => {
    const { resend, service } = setup()
    const domain = resend.addDomain('muster-it.ch')
    resend.mx.set('muster-it.ch', [{ exchange: 'aspmx.l.google.com', priority: 1 }])
    const error = await service.enableReceiving(domain.id).catch((e: unknown) => e)
    expect(String((error as Error).message)).toContain('Mail-Zustellung zu Resend um')
    expect(String((error as Error).message)).toContain('aspmx.l.google.com')
  })

  it('re-checks verification on demand', async () => {
    const { resend, service } = setup()
    const domain = resend.addDomain('nordwind.ch', true)
    resend.mx.set('nordwind.ch', [])
    expect((await service.refreshVerification(domain.id)).mxVerified).toBe(false)

    resend.mx.set('nordwind.ch', [{ exchange: inboundMxHost('eu-west-1'), priority: 10 }])
    expect((await service.refreshVerification(domain.id)).mxVerified).toBe(true)
    expect(resend.verified).toEqual([domain.id, domain.id])
  })

  it('disables receiving again', async () => {
    const { store, resend, service } = setup()
    const domain = resend.addDomain('nordwind.ch')
    resend.mx.set('nordwind.ch', [])
    await service.enableReceiving(domain.id)
    await service.disableReceiving(domain.id)
    expect(store.accounts.findByResendDomainId(domain.id)?.receivingEnabled).toBe(false)
  })
})

describe('api key handling', () => {
  it('surfaces an unauthorized key instead of retrying', async () => {
    const resend = new FakeResend()
    resend.invalidKey = true
    const client = new ResendClient({
      apiKey: () => 're_bad',
      fetch: resend.fetch,
      baseUrl: 'https://api.resend.test',
      sleep: async () => undefined
    })
    await expect(client.listDomains()).rejects.toMatchObject({ status: 401 })
  })

  it('retries rate limits with backoff', async () => {
    const resend = new FakeResend()
    resend.addDomain('beispielweb.ch')
    resend.rateLimitFor = 2
    const client = new ResendClient({
      apiKey: () => 're_test',
      fetch: resend.fetch,
      baseUrl: 'https://api.resend.test',
      sleep: async () => undefined
    })
    expect((await client.listDomains()).data).toHaveLength(1)
  })
})

describe('MX lookup robustness', () => {
  it('gives up on a hanging resolver instead of stalling the domain list', async () => {
    const never: MxResolver = () => new Promise(() => undefined)
    const start = Date.now()
    const records = await resolveMxSafely(never, 'beispielweb.ch', 20)
    expect(records).toEqual([])
    expect(Date.now() - start).toBeLessThan(1_000)
  })

  it('treats a failing lookup as no records', async () => {
    const failing: MxResolver = async () => {
      throw new Error('ENODATA')
    }
    expect(await resolveMxSafely(failing, 'swisscaravans.ch')).toEqual([])
  })
})
