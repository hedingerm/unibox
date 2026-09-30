import { DOMAIN_REGIONS, normalizeDomainName } from '@shared/admin'
import type {
  DomainCreateInput,
  DomainDetails,
  DomainDmarc,
  DomainRecordCheck,
  DomainRecordKind,
  DomainRecordStatus
} from '@shared/admin'
import type { ResendDomainInfo } from '@shared/types'
import type { Store } from '../db/store'
import type { ResendClient, ResendDnsRecord, ResendDomain } from './client'
import type { MxResolver, TxtResolver } from './mx'
import {
  analyzeMx,
  findDmarc,
  inboundMxHost,
  requiredMxRecord,
  resolveMxSafely,
  resolveTxtSafely
} from './mx'

/** A policy that only reports: safe to publish before anything is tuned. */
export const SUGGESTED_DMARC = 'v=DMARC1; p=none;'

/** Which job a record Resend lists does, from its label and type. */
export function classifyRecord(record: ResendDnsRecord): DomainRecordKind {
  const label = (record.record ?? '').toLowerCase()
  const type = record.type.toUpperCase()
  if (label === 'dkim') return 'dkim'
  if (label === 'receiving' || label === 'inbound') return 'mx_receiving'
  if (type === 'MX' && record.value.toLowerCase().includes('inbound-smtp')) return 'mx_receiving'
  if (label === 'spf' && type === 'MX') return 'return_path'
  if (label === 'spf') return 'spf'
  if (label === 'dmarc') return 'dmarc'
  return 'other'
}

/** Resend's record states, folded into the three the panel shows. */
export function recordStatus(status: string | undefined): DomainRecordStatus {
  switch ((status ?? '').toLowerCase()) {
    case 'verified':
      return 'found'
    case 'failed':
      return 'missing'
    default:
      // not_started, pending, temporary_failure: Resend has not decided yet.
      return 'pending'
  }
}

export class MxConflictError extends Error {
  constructor(
    readonly domain: string,
    readonly conflicting: string[]
  ) {
    super(
      `Für ${domain} ist bereits ein fremder MX-Record gesetzt (${conflicting.join(', ')}). ` +
        'Empfang zu aktivieren leitet die bestehende Mail-Zustellung zu Resend um.'
    )
    this.name = 'MxConflictError'
  }
}

export interface DomainServiceDeps {
  client: ResendClient
  resolveMx: MxResolver
  /** For the DMARC check; without one DMARC always reads as missing. */
  resolveTxt?: TxtResolver
}

export class ResendDomainService {
  constructor(
    private readonly store: Store,
    private readonly deps: DomainServiceDeps
  ) {}

  private async describe(domain: ResendDomain): Promise<ResendDomainInfo> {
    const region = domain.region ?? 'us-east-1'
    const records = await resolveMxSafely(this.deps.resolveMx, domain.name)
    const analysis = analyzeMx(records, region)
    const receivingEnabled = domain.capabilities?.receiving === 'enabled'
    return {
      id: domain.id,
      name: domain.name,
      status: domain.status,
      region,
      receivingEnabled,
      mxVerified: analysis.verified,
      requiredMxRecord: requiredMxRecord(domain.name, region),
      conflictingMx: analysis.conflicting,
      connectedAccountId: this.reconcile(domain.id, domain.name, region, receivingEnabled)
    }
  }

  /**
   * Resend is the source of truth for "is receiving on". A domain that was
   * switched on elsewhere — in the Resend dashboard, in an earlier install, or
   * before this database existed — must appear as an account without the user
   * toggling anything, so every describe() converges the local account with
   * what the API just reported.
   */
  private reconcile(
    domainId: string,
    name: string,
    region: string,
    receivingEnabled: boolean
  ): string | null {
    const existing = this.store.accounts.findByResendDomainId(domainId)
    if (!receivingEnabled) {
      // The account (and its mail) stays; it just stops being polled.
      if (existing?.receivingEnabled) {
        this.store.accounts.update(existing.id, { receivingEnabled: false })
      }
      return existing?.id ?? null
    }
    const account = this.store.accounts.upsert({
      kind: 'resend',
      email: name,
      displayName: name,
      resendDomainId: domainId,
      resendRegion: region,
      receivingEnabled: true
    })
    this.store.labels.ensureSystemLabels(account.id)
    return account.id
  }

  async list(): Promise<ResendDomainInfo[]> {
    const page = await this.deps.client.listDomains()
    return Promise.all((page.data ?? []).map((domain) => this.describe(domain)))
  }

  async inspect(domainId: string): Promise<ResendDomainInfo> {
    return this.describe(await this.deps.client.getDomain(domainId))
  }

  /**
   * Turning on receiving rewrites where the domain's mail is delivered, so a
   * foreign MX record is refused unless the caller explicitly acknowledged the
   * warning shown in the UI.
   */
  async enableReceiving(domainId: string, acknowledgeMxConflict = false): Promise<ResendDomainInfo> {
    const info = await this.inspect(domainId)
    if (info.conflictingMx.length > 0 && !acknowledgeMxConflict) {
      throw new MxConflictError(info.name, info.conflictingMx)
    }
    await this.deps.client.updateDomain(domainId, { capabilities: { receiving: 'enabled' } })
    // The re-inspect reconciles: it creates the account and its system labels.
    return this.inspect(domainId)
  }

  async disableReceiving(domainId: string): Promise<ResendDomainInfo> {
    await this.deps.client.updateDomain(domainId, { capabilities: { receiving: 'disabled' } })
    return this.inspect(domainId)
  }

  /**
   * The full authentication panel: every record Resend wants, each with its
   * state, plus the inbound MX and DMARC looked up here. The list endpoint
   * carries no records, so this always reads the single domain.
   */
  async details(domainId: string): Promise<DomainDetails> {
    const domain = await this.deps.client.getDomain(domainId)
    const info = await this.describe(domain)
    const records = (domain.records ?? []).map((record): DomainRecordCheck => {
      const kind = classifyRecord(record)
      const base = {
        kind,
        type: record.type.toUpperCase(),
        name: record.name ?? '@',
        value: record.value,
        priority: record.priority ?? null,
        ttl: record.ttl ?? null
      }
      if (kind === 'mx_receiving') {
        // The live DNS answer beats Resend's last check, which may be hours old.
        return {
          ...base,
          status: info.mxVerified ? 'found' : 'missing',
          source: 'dns',
          required: info.receivingEnabled
        }
      }
      return {
        ...base,
        status: recordStatus(record.status),
        source: 'resend',
        required: kind !== 'other' && kind !== 'dmarc'
      }
    })
    if (!records.some((record) => record.kind === 'mx_receiving')) {
      records.push({
        kind: 'mx_receiving',
        type: 'MX',
        name: '@',
        value: inboundMxHost(info.region),
        priority: 10,
        ttl: null,
        status: info.mxVerified ? 'found' : 'missing',
        source: 'dns',
        required: info.receivingEnabled
      })
    }
    const dmarc = await this.dmarc(domain.name)
    records.push({
      kind: 'dmarc',
      type: 'TXT',
      name: '_dmarc',
      value: dmarc.value ?? dmarc.suggested,
      priority: null,
      ttl: null,
      status: dmarc.status,
      source: 'dns',
      required: false
    })
    const createdAt = domain.created_at ? Date.parse(domain.created_at) : Number.NaN
    return {
      ...info,
      sendingEnabled: domain.capabilities?.sending !== 'disabled',
      verified: domain.status === 'verified',
      records,
      dmarc,
      createdAt: Number.isFinite(createdAt) ? createdAt : null
    }
  }

  async detailsAll(): Promise<DomainDetails[]> {
    const page = await this.deps.client.listDomains()
    return Promise.all((page.data ?? []).map((domain) => this.details(domain.id)))
  }

  private async dmarc(name: string): Promise<DomainDmarc> {
    const records = this.deps.resolveTxt
      ? await resolveTxtSafely(this.deps.resolveTxt, `_dmarc.${name}`)
      : []
    const found = findDmarc(records)
    return found
      ? { status: 'found', value: found.value, policy: found.policy, suggested: SUGGESTED_DMARC }
      : { status: 'missing', value: null, policy: null, suggested: SUGGESTED_DMARC }
  }

  /**
   * The "Prüfen" button: asks Resend to check the records again. Unlike the
   * older inspect path a refusal is not swallowed — the user asked for it.
   */
  async verify(domainId: string): Promise<DomainDetails> {
    await this.deps.client.verifyDomain(domainId)
    return this.details(domainId)
  }

  /**
   * Adds the domain at Resend and reads back its panel, which lists the DNS
   * records the user now has to publish.
   */
  async create(input: DomainCreateInput): Promise<DomainDetails> {
    const name = normalizeDomainName(input.name)
    if (!name) throw new Error(`«${input.name}» ist kein gültiger Domainname`)
    if (!DOMAIN_REGIONS.includes(input.region)) throw new Error(`Unbekannte Region ${input.region}`)
    const created = await this.deps.client.createDomain({ name, region: input.region })
    return this.details(created.id)
  }

  /** Polls DNS until Resend's inbound MX record is live. */
  async refreshVerification(domainId: string): Promise<ResendDomainInfo> {
    await this.deps.client.verifyDomain(domainId).catch(() => undefined)
    return this.inspect(domainId)
  }
}
