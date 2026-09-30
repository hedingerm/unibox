import { describe, expect, it } from 'vitest'
import {
  batchBoundary,
  buildBatchBody,
  parseBatchResponse,
  parseBoundary,
  partIndex
} from '@main/google/batch'
import { GmailClient, QuotaLimiter } from '@main/google/client'
import { FakeGmail } from '../helpers/fake-gmail'

describe('batch request body', () => {
  it('stacks one HTTP request per message, CRLF separated', () => {
    const boundary = batchBoundary(1)
    const body = buildBatchBody(
      [
        { id: 'm1', path: '/gmail/v1/users/me/messages/m1?format=full' },
        { id: 'm2', path: '/gmail/v1/users/me/messages/m2?format=full' }
      ],
      boundary
    )

    expect(body.split(`--${boundary}`).length - 1).toBe(3) // two parts plus the closer
    expect(body).toContain('Content-Type: application/http')
    expect(body).toContain('Content-ID: <item-0>')
    expect(body).toContain('Content-ID: <item-1>')
    expect(body).toContain('GET /gmail/v1/users/me/messages/m2?format=full')
    expect(body.endsWith(`--${boundary}--\r\n`)).toBe(true)
    expect(body).not.toContain('\n\n')
  })
})

describe('batch response parsing', () => {
  const boundary = 'batch_abc'
  const part = (index: number, status: number, json: string): string =>
    [
      `--${boundary}`,
      'Content-Type: application/http',
      `Content-ID: <response-item-${index}>`,
      '',
      `HTTP/1.1 ${status} ${status === 200 ? 'OK' : 'Error'}`,
      'Content-Type: application/json',
      '',
      json,
      ''
    ].join('\r\n')

  it('reads status and body of every part independently', () => {
    const text = `${part(0, 200, '{"id":"m1"}')}${part(1, 404, '{"error":{"code":404}}')}--${boundary}--\r\n`
    const parts = parseBatchResponse(text, boundary)

    expect(parts).toHaveLength(2)
    expect(parts[0]).toMatchObject({ id: 'item-0', status: 200 })
    expect(JSON.parse(parts[0]!.body)).toEqual({ id: 'm1' })
    expect(parts[1]).toMatchObject({ id: 'item-1', status: 404 })
  })

  it('reports an unreadable part as a server error instead of throwing', () => {
    const broken = [`--${boundary}`, 'Content-Type: application/http', '', 'not an http response', ''].join('\r\n')
    const parts = parseBatchResponse(`${broken}--${boundary}--\r\n`, boundary)
    expect(parts[0]?.status).toBe(500)
  })

  it('reads the boundary out of the content type, quoted or not', () => {
    expect(parseBoundary('multipart/mixed; boundary=batch_xyz')).toBe('batch_xyz')
    expect(parseBoundary('multipart/mixed; boundary="batch_xyz"')).toBe('batch_xyz')
    expect(parseBoundary(null)).toBeNull()
  })

  it('pairs answers back by content id, falling back to order', () => {
    expect(partIndex('item-7', 0)).toBe(7)
    expect(partIndex(null, 3)).toBe(3)
  })
})

describe('quota limiter', () => {
  it('spreads spend so the average stays inside the per-second budget', async () => {
    let clock = 0
    const limiter = new QuotaLimiter(
      250,
      async (ms) => {
        clock += ms
      },
      () => clock
    )

    // Four batches of 100 messages: 2000 quota units at 250/s = 8 seconds.
    for (let index = 0; index < 4; index += 1) await limiter.take(100 * 5)
    expect(clock).toBe(6_000) // the first batch does not wait for itself
  })

  it('backs off further after a rate-limit answer', async () => {
    let clock = 0
    const limiter = new QuotaLimiter(
      250,
      async (ms) => {
        clock += ms
      },
      () => clock
    )
    await limiter.take(250)
    limiter.penalise(5_000)
    await limiter.take(250)
    expect(clock).toBe(5_000)
  })
})

describe('batched message fetch', () => {
  function client(gmail: FakeGmail): GmailClient {
    return new GmailClient({
      fetch: gmail.fetch,
      baseUrl: 'https://gmail.test/gmail/v1',
      accessToken: async () => 'token',
      sleep: async () => undefined
    })
  }

  it('fetches many messages in one round trip', async () => {
    const gmail = new FakeGmail()
    const ids = Array.from({ length: 40 }, (_, index) => `m${index}`)
    for (const id of ids) gmail.addMessage({ id, subject: `Betreff ${id}` })

    const results = await client(gmail).batchGetMessages(ids)
    expect(gmail.batchRequests).toBe(1)
    expect(gmail.largestBatch).toBe(40)
    expect(results).toHaveLength(40)
    expect(results.every((result) => result.message !== null)).toBe(true)
    expect(results[7]?.message?.id).toBe('m7')
  })

  it('keeps the good answers when a single sub-request fails', async () => {
    const gmail = new FakeGmail()
    for (const id of ['m1', 'm2', 'm3']) gmail.addMessage({ id })
    gmail.partFailures.set('m2', { status: 404, reason: 'notFound', message: 'Not Found' })

    const results = await client(gmail).batchGetMessages(['m1', 'm2', 'm3'])
    expect(results.map((result) => result.message?.id ?? null)).toEqual(['m1', null, 'm3'])
    expect(results[1]?.error?.status).toBe(404)
    expect(results[1]?.error?.isRetryable).toBe(false)
  })

  it('marks a throttled sub-request as retryable rather than failing the batch', async () => {
    const gmail = new FakeGmail()
    for (const id of ['m1', 'm2']) gmail.addMessage({ id })
    gmail.rateLimitedOnce.add('m2')

    const results = await client(gmail).batchGetMessages(['m1', 'm2'])
    expect(results[0]?.message?.id).toBe('m1')
    expect(results[1]?.error?.isRateLimited).toBe(true)
    expect(results[1]?.error?.isRetryable).toBe(true)
  })

  it('retries the whole batch when Gmail throttles the request itself', async () => {
    const gmail = new FakeGmail()
    gmail.addMessage({ id: 'm1' })
    gmail.rateLimitFor = 2

    const results = await client(gmail).batchGetMessages(['m1'])
    expect(results[0]?.message?.id).toBe('m1')
    // Two refusals, then the batch that actually ran.
    expect(gmail.requestCount).toBe(3)
    expect(gmail.batchRequests).toBe(1)
  })

  it('refuses more than the Gmail limit of 100 sub-requests', async () => {
    const gmail = new FakeGmail()
    const ids = Array.from({ length: 101 }, (_, index) => `m${index}`)
    await expect(client(gmail).batchGetMessages(ids)).rejects.toThrow(/100/)
  })
})
