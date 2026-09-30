import { describe, expect, it } from 'vitest'
import type { RoutingRule } from '@shared/admin'
import type { RuleSubject } from '@main/rules/engine'
import { compileMatcher, fieldValues, ruleMatches, selectRules } from '@main/rules/engine'

const subject: RuleSubject = {
  accountId: 'acc1',
  from: { name: 'Sandra Keller', email: 's.keller@keller-farben.ch' },
  recipients: ['offerten@beispielweb.ch', 'info@beispielweb.ch'],
  subject: 'Rechnung 2026-114',
  body: 'Guten Tag, anbei die Rechnung für den Relaunch.'
}

let sequence = 0
function rule(patch: Partial<RoutingRule>): RoutingRule {
  sequence += 1
  return {
    id: `r${sequence}`,
    accountId: null,
    name: `Regel ${sequence}`,
    enabled: true,
    priority: sequence,
    matchField: 'any',
    operator: 'contains',
    value: 'x',
    action: 'archive',
    actionArg: null,
    stopProcessing: true,
    matchCount: 0,
    lastMatchedAt: null,
    createdAt: sequence,
    ...patch
  }
}

describe('rule operators', () => {
  it.each([
    ['contains', 'KELLER', true],
    ['contains', 'meier', false],
    ['exact', 'S.Keller@keller-farben.ch', true],
    ['exact', 'keller-farben.ch', false],
    ['starts_with', 's.keller@', true],
    ['starts_with', 'keller', false],
    ['ends_with', '@KELLER-farben.ch', true],
    ['ends_with', '.de', false],
    ['regex', '^s\\.keller@.*\\.ch$', true],
    ['regex', '@gmail\\.com$', false]
  ] as const)('%s %s on the sender → %s', (operator, value, expected) => {
    expect(ruleMatches({ matchField: 'from', operator, value }, subject)).toBe(expected)
  })

  it('never lets an empty needle match everything', () => {
    for (const operator of ['contains', 'starts_with', 'ends_with'] as const) {
      expect(ruleMatches({ matchField: 'subject', operator, value: '  ' }, subject)).toBe(false)
    }
  })

  it('reports an invalid regex instead of throwing, and matches nothing with it', () => {
    const compiled = compileMatcher('regex', '([unclosed')
    expect(compiled.ok).toBe(false)
    expect(() => ruleMatches({ matchField: 'any', operator: 'regex', value: '([unclosed' }, subject)).not.toThrow()
    expect(ruleMatches({ matchField: 'any', operator: 'regex', value: '([unclosed' }, subject)).toBe(false)
    expect(compileMatcher('regex', 'a'.repeat(501)).ok).toBe(false)
    expect(compileMatcher('regex', '').ok).toBe(false)
  })

  it('bounds the body a pattern runs over', () => {
    const long = { ...subject, body: `${'a'.repeat(30_000)}NEEDLE` }
    expect(ruleMatches({ matchField: 'body', operator: 'contains', value: 'needle' }, long)).toBe(false)
    expect(fieldValues(long, 'body')[0]).toHaveLength(20_000)
  })
})

describe('rule fields', () => {
  it('matches the sender by address and by display name', () => {
    expect(ruleMatches({ matchField: 'from', operator: 'exact', value: 'sandra keller' }, subject)).toBe(true)
  })

  it('matches any To/Cc recipient', () => {
    expect(ruleMatches({ matchField: 'to', operator: 'exact', value: 'info@beispielweb.ch' }, subject)).toBe(true)
    expect(ruleMatches({ matchField: 'to', operator: 'contains', value: 'keller' }, subject)).toBe(false)
  })

  it('matches subject and body separately, and both under any', () => {
    expect(ruleMatches({ matchField: 'subject', operator: 'contains', value: 'relaunch' }, subject)).toBe(false)
    expect(ruleMatches({ matchField: 'body', operator: 'contains', value: 'relaunch' }, subject)).toBe(true)
    expect(ruleMatches({ matchField: 'any', operator: 'contains', value: 'relaunch' }, subject)).toBe(true)
    expect(ruleMatches({ matchField: 'any', operator: 'contains', value: 'offerten@' }, subject)).toBe(true)
  })
})

describe('rule selection', () => {
  it('fires only the first match by priority when it stops processing', () => {
    const late = rule({ priority: 5, value: 'rechnung', action: 'trash' })
    const early = rule({ priority: 1, value: 'rechnung', action: 'label', actionArg: 'l1' })
    expect(selectRules([late, early], subject).map((r) => r.id)).toEqual([early.id])
  })

  it('carries on past a match that does not stop processing', () => {
    const first = rule({ priority: 1, value: 'rechnung', action: 'mark_read', stopProcessing: false })
    const second = rule({ priority: 2, value: 'keller', action: 'archive' })
    const third = rule({ priority: 3, value: 'keller', action: 'trash' })
    expect(selectRules([third, second, first], subject).map((r) => r.id)).toEqual([first.id, second.id])
  })

  it('skips disabled rules and rules of another domain', () => {
    const disabled = rule({ priority: 1, value: 'rechnung', enabled: false })
    const other = rule({ priority: 2, value: 'rechnung', accountId: 'acc2' })
    const own = rule({ priority: 3, value: 'rechnung', accountId: 'acc1' })
    expect(selectRules([disabled, other, own], subject).map((r) => r.id)).toEqual([own.id])
  })

  it('treats a rule with a broken regex as a non-match', () => {
    const broken = rule({ priority: 1, operator: 'regex', value: '(' })
    const next = rule({ priority: 2, value: 'rechnung' })
    expect(selectRules([broken, next], subject).map((r) => r.id)).toEqual([next.id])
  })
})
