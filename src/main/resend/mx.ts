export interface MxRecord {
  exchange: string
  priority: number
}

export type MxResolver = (hostname: string) => Promise<MxRecord[]>

/** The inbound host Resend routes mail through, per region. */
export function inboundMxHost(region: string): string {
  return `inbound-smtp.${region}.amazonaws.com`
}

export function requiredMxRecord(domain: string, region: string): string {
  return `${domain}  MX  10  ${inboundMxHost(region)}`
}

export interface MxAnalysis {
  /** Resend's inbound host is present and has the best (lowest) priority. */
  verified: boolean
  /** MX hosts pointing somewhere other than Resend. */
  conflicting: string[]
  records: MxRecord[]
}

function normalize(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, '')
}

export function analyzeMx(records: MxRecord[], region: string): MxAnalysis {
  const expected = normalize(inboundMxHost(region))
  const ours = records.filter((r) => normalize(r.exchange) === expected)
  const others = records.filter((r) => normalize(r.exchange) !== expected)
  const bestOther = others.length > 0 ? Math.min(...others.map((r) => r.priority)) : Number.POSITIVE_INFINITY
  const bestOurs = ours.length > 0 ? Math.min(...ours.map((r) => r.priority)) : Number.POSITIVE_INFINITY
  return {
    verified: ours.length > 0 && bestOurs <= bestOther,
    conflicting: [...new Set(others.map((r) => normalize(r.exchange)))],
    records
  }
}

/**
 * Resolves MX records, treating "no records" as an empty list rather than an
 * error. A slow or unreachable resolver must never stall domain listing, so the
 * lookup is bounded.
 */
export async function resolveMxSafely(
  resolver: MxResolver,
  domain: string,
  timeoutMs = 5_000
): Promise<MxRecord[]> {
  try {
    return await Promise.race([
      resolver(domain),
      new Promise<MxRecord[]>((resolve) => {
        const timer = setTimeout(() => resolve([]), timeoutMs)
        timer.unref?.()
      })
    ])
  } catch {
    return []
  }
}

/** Node's `dns.resolveTxt` shape: each record arrives split into chunks. */
export type TxtResolver = (hostname: string) => Promise<string[][]>

/** TXT records with their chunks joined; empty on any failure or timeout. */
export async function resolveTxtSafely(
  resolver: TxtResolver,
  hostname: string,
  timeoutMs = 5_000
): Promise<string[]> {
  try {
    const records = await Promise.race([
      resolver(hostname),
      new Promise<string[][]>((resolve) => {
        const timer = setTimeout(() => resolve([]), timeoutMs)
        timer.unref?.()
      })
    ])
    return records.map((chunks) => chunks.join(''))
  } catch {
    return []
  }
}

/** The published DMARC policy of a domain, if it has one. */
export function findDmarc(records: string[]): { value: string; policy: string | null } | null {
  const record = records.find((entry) => /^v=DMARC1\b/i.test(entry.trim()))
  if (!record) return null
  const policy = /(?:^|;)\s*p\s*=\s*([a-z]+)/i.exec(record)?.[1]?.toLowerCase() ?? null
  return { value: record.trim(), policy }
}
