import type { RoutingRule, RuleMatchField, RuleOperator } from '@shared/admin'

/** What a rule looks at in a message — plain strings, nothing to parse. */
export interface RuleSubject {
  accountId: string
  from: { name: string | null; email: string }
  /** To and Cc, as addresses. */
  recipients: string[]
  subject: string
  /** Plain-text body. */
  body: string
}

/**
 * Bodies are cut here before matching: a regex over a megabyte of newsletter
 * html is where backtracking turns into a stalled sync.
 */
const MAX_BODY_CHARS = 20_000
const MAX_PATTERN_CHARS = 500

export type MatcherResult = { ok: true; test: (value: string) => boolean } | { ok: false; error: string }

/**
 * Compiles operator and value into a predicate. Never throws: an invalid
 * regular expression comes back as an error the UI can show, and a rule
 * holding one simply matches nothing.
 */
export function compileMatcher(operator: RuleOperator, value: string): MatcherResult {
  const needle = value.trim().toLowerCase()
  switch (operator) {
    case 'contains':
      return { ok: true, test: (hay) => needle.length > 0 && hay.toLowerCase().includes(needle) }
    case 'exact':
      return { ok: true, test: (hay) => hay.trim().toLowerCase() === needle }
    case 'starts_with':
      return {
        ok: true,
        test: (hay) => needle.length > 0 && hay.trim().toLowerCase().startsWith(needle)
      }
    case 'ends_with':
      return {
        ok: true,
        test: (hay) => needle.length > 0 && hay.trim().toLowerCase().endsWith(needle)
      }
    case 'regex': {
      if (value.length === 0) return { ok: false, error: 'Der Ausdruck ist leer.' }
      if (value.length > MAX_PATTERN_CHARS) {
        return { ok: false, error: `Der Ausdruck ist länger als ${MAX_PATTERN_CHARS} Zeichen.` }
      }
      let pattern: RegExp
      try {
        pattern = new RegExp(value, 'i')
      } catch (error) {
        return {
          ok: false,
          error: `Ungültiger regulärer Ausdruck: ${error instanceof Error ? error.message : String(error)}`
        }
      }
      return {
        ok: true,
        test: (hay) => {
          try {
            return pattern.test(hay)
          } catch {
            return false
          }
        }
      }
    }
    default:
      return { ok: false, error: 'Unbekannter Vergleich.' }
  }
}

/** The strings a field stands for; a rule matches when any one of them does. */
export function fieldValues(subject: RuleSubject, field: RuleMatchField): string[] {
  const from = [subject.from.email, ...(subject.from.name ? [subject.from.name] : [])]
  const body = subject.body.slice(0, MAX_BODY_CHARS)
  switch (field) {
    case 'from':
      return from
    case 'to':
      return subject.recipients
    case 'subject':
      return [subject.subject]
    case 'body':
      return [body]
    case 'any':
      return [...from, ...subject.recipients, subject.subject, body]
    default:
      return []
  }
}

export function ruleMatches(rule: Pick<RoutingRule, 'matchField' | 'operator' | 'value'>, subject: RuleSubject): boolean {
  const matcher = compileMatcher(rule.operator, rule.value)
  if (!matcher.ok) return false
  return fieldValues(subject, rule.matchField).some((value) => matcher.test(value))
}

/** Whether a rule applies to a message of this account at all. */
export function ruleInScope(rule: Pick<RoutingRule, 'accountId' | 'enabled'>, accountId: string): boolean {
  return rule.enabled && (rule.accountId === null || rule.accountId === accountId)
}

/**
 * The rules that fire for one message, in the order they run. Rules go by
 * ascending priority; a match ends the run unless it has `stopProcessing` off,
 * in which case the next matching rule fires too.
 */
export function selectRules(rules: RoutingRule[], subject: RuleSubject): RoutingRule[] {
  const ordered = [...rules].sort(
    (a, b) => a.priority - b.priority || a.createdAt - b.createdAt || a.id.localeCompare(b.id)
  )
  const fired: RoutingRule[] = []
  for (const rule of ordered) {
    if (!ruleInScope(rule, subject.accountId)) continue
    if (!ruleMatches(rule, subject)) continue
    fired.push(rule)
    if (rule.stopProcessing) break
  }
  return fired
}
