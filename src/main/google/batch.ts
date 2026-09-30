/**
 * Gmail's batch endpoint speaks `multipart/mixed` rather than JSON: the request
 * body is a stack of raw HTTP requests, and the answer is a stack of raw HTTP
 * responses that can each succeed or fail on their own. Building and reading
 * that format is fiddly enough to keep it away from the client itself.
 */

export interface BatchRequest {
  /** Echoed back on the matching response so answers can be paired up. */
  id: string
  method?: string
  path: string
}

export interface BatchPart {
  id: string | null
  status: number
  body: string
}

const CRLF = '\r\n'

export function batchBoundary(seed: number): string {
  return `batch_unibox_${seed.toString(36)}`
}

/** Content-ID must be unique per part; the index is what pairs answers back. */
function contentId(index: number): string {
  return `item-${index}`
}

export function buildBatchBody(requests: BatchRequest[], boundary: string): string {
  const parts = requests.map((request, index) =>
    [
      `--${boundary}`,
      'Content-Type: application/http',
      `Content-ID: <${contentId(index)}>`,
      '',
      `${request.method ?? 'GET'} ${request.path}`,
      '',
      ''
    ].join(CRLF)
  )
  return `${parts.join('')}--${boundary}--${CRLF}`
}

export function parseBoundary(contentType: string | null): string | null {
  if (!contentType) return null
  const match = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType)
  return match?.[1] ?? match?.[2] ?? null
}

/**
 * Splits the answer into its parts and unwraps the HTTP response embedded in
 * each one. A part whose status line is unreadable is reported as a 500 rather
 * than throwing, so one malformed answer cannot lose the other 99.
 */
export function parseBatchResponse(text: string, boundary: string): BatchPart[] {
  const marker = `--${boundary}`
  const parts: BatchPart[] = []

  for (const chunk of text.split(marker)) {
    const trimmed = chunk.replace(/^\r?\n/, '')
    if (trimmed === '' || trimmed.startsWith('--')) continue

    // Part headers, then the embedded HTTP response, separated by a blank line.
    const split = /\r?\n\r?\n/.exec(trimmed)
    if (!split) continue
    const partHeaders = trimmed.slice(0, split.index)
    const embedded = trimmed.slice(split.index + split[0].length)

    const idMatch = /^content-id:\s*<?(?:response-)?([^>\r\n]+)>?/im.exec(partHeaders)
    const statusMatch = /^HTTP\/[\d.]+\s+(\d{3})/m.exec(embedded)

    const bodySplit = /\r?\n\r?\n/.exec(embedded)
    const body = bodySplit ? embedded.slice(bodySplit.index + bodySplit[0].length) : ''

    parts.push({
      id: idMatch?.[1]?.trim() ?? null,
      status: statusMatch ? Number(statusMatch[1]) : 500,
      body: body.replace(/\r?\n--\s*$/, '').trim()
    })
  }

  return parts
}

/** Maps `item-3` back to index 3; unlabelled parts fall back to their order. */
export function partIndex(id: string | null, fallback: number): number {
  const match = id ? /item-(\d+)/.exec(id) : null
  return match ? Number(match[1]) : fallback
}
