import { describe, expect, it } from 'vitest'
import { replyRecipients } from '@renderer/lib/reply'

const me = 'max@example.com'
const incoming = {
  direction: 'incoming' as const,
  from: { name: 'Anna Muster', email: 'anna@example.com' },
  to: [
    { name: null, email: 'Max@Example.com' },
    { name: 'Peter Frei', email: 'peter@example.org' }
  ],
  cc: [
    { name: null, email: 'lisa@example.net' },
    { name: null, email: 'anna@example.com' },
    { name: null, email: 'peter@example.org' }
  ],
  replyTo: []
}

describe('reply recipients', () => {
  it('answers only the sender on a plain reply', () => {
    expect(replyRecipients(incoming, false, [me])).toEqual({ to: [incoming.from], cc: [] })
  })

  it('copies everyone else on reply-all, without us or duplicates', () => {
    const { to, cc } = replyRecipients(incoming, true, [me])
    expect(to.map((address) => address.email)).toEqual(['anna@example.com'])
    expect(cc.map((address) => address.email)).toEqual(['peter@example.org', 'lisa@example.net'])
  })

  it('answers the Reply-To address and still copies the sender list', () => {
    const { to, cc } = replyRecipients(
      { ...incoming, replyTo: [{ name: null, email: 'support@example.com' }] },
      true,
      [me]
    )
    expect(to.map((address) => address.email)).toEqual(['support@example.com'])
    expect(cc.map((address) => address.email)).toEqual([
      'peter@example.org',
      'lisa@example.net',
      'anna@example.com'
    ])
  })

  it('keeps the original addressing when answering our own mail', () => {
    const outgoing = {
      direction: 'outgoing' as const,
      from: { name: null, email: me },
      to: [{ name: null, email: 'anna@example.com' }],
      cc: [
        { name: null, email: me },
        { name: null, email: 'lisa@example.net' }
      ],
      replyTo: []
    }
    const { to, cc } = replyRecipients(outgoing, true, [me])
    expect(to.map((address) => address.email)).toEqual(['anna@example.com'])
    expect(cc.map((address) => address.email)).toEqual(['lisa@example.net'])
  })
})
