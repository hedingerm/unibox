import type {
  RoutingRule,
  RuleAction,
  RuleInput,
  RuleMatchField,
  RuleOperator
} from '@shared/admin'
import type { Db } from '../index'
import { newId } from '../ids'

interface RuleRow {
  id: string
  account_id: string | null
  name: string
  enabled: number
  priority: number
  match_field: RuleMatchField
  operator: RuleOperator
  value: string
  action: RuleAction
  action_arg: string | null
  stop_processing: number
  match_count: number
  last_matched_at: number | null
  created_at: number
}

function toRule(row: RuleRow): RoutingRule {
  return {
    id: row.id,
    accountId: row.account_id,
    name: row.name,
    enabled: row.enabled === 1,
    priority: row.priority,
    matchField: row.match_field,
    operator: row.operator,
    value: row.value,
    action: row.action,
    actionArg: row.action_arg,
    stopProcessing: row.stop_processing === 1,
    matchCount: row.match_count,
    lastMatchedAt: row.last_matched_at,
    createdAt: row.created_at
  }
}

export class RuleRepo {
  constructor(private readonly db: Db) {}

  /** In the order they run: priority first, then age. */
  list(): RoutingRule[] {
    const rows = this.db
      .prepare('SELECT * FROM routing_rules ORDER BY priority, created_at, id')
      .all() as RuleRow[]
    return rows.map(toRule)
  }

  get(id: string): RoutingRule | null {
    const row = this.db.prepare('SELECT * FROM routing_rules WHERE id = ?').get(id) as
      | RuleRow
      | undefined
    return row ? toRule(row) : null
  }

  countEnabled(): number {
    return (
      this.db.prepare('SELECT COUNT(*) AS n FROM routing_rules WHERE enabled = 1').get() as {
        n: number
      }
    ).n
  }

  create(input: Required<RuleInput>): RoutingRule {
    const id = newId()
    // A new rule runs last; the user moves it up if it should win.
    const next = this.db
      .prepare('SELECT COALESCE(MAX(priority), -1) + 1 AS n FROM routing_rules')
      .get() as { n: number }
    this.db
      .prepare(
        `INSERT INTO routing_rules (id, account_id, name, enabled, priority, match_field,
           operator, value, action, action_arg, stop_processing, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.accountId,
        input.name,
        input.enabled ? 1 : 0,
        next.n,
        input.matchField,
        input.operator,
        input.value,
        input.action,
        input.actionArg,
        input.stopProcessing ? 1 : 0,
        Date.now()
      )
    return this.get(id)!
  }

  update(id: string, next: Required<RuleInput>): RoutingRule {
    this.db
      .prepare(
        `UPDATE routing_rules SET account_id = ?, name = ?, enabled = ?, match_field = ?,
           operator = ?, value = ?, action = ?, action_arg = ?, stop_processing = ?
         WHERE id = ?`
      )
      .run(
        next.accountId,
        next.name,
        next.enabled ? 1 : 0,
        next.matchField,
        next.operator,
        next.value,
        next.action,
        next.actionArg,
        next.stopProcessing ? 1 : 0,
        id
      )
    return this.get(id)!
  }

  remove(id: string): void {
    this.db.prepare('DELETE FROM routing_rules WHERE id = ?').run(id)
  }

  /** Priorities follow the order given; rules not listed run after them. */
  reorder(ids: string[]): void {
    const listed = new Set(ids)
    const rest = this.list()
      .map((rule) => rule.id)
      .filter((id) => !listed.has(id))
    const update = this.db.prepare('UPDATE routing_rules SET priority = ? WHERE id = ?')
    this.db.transaction(() => {
      ;[...ids, ...rest].forEach((id, index) => update.run(index, id))
    })()
  }

  recordMatch(id: string, at: number): void {
    this.db
      .prepare(
        'UPDATE routing_rules SET match_count = match_count + 1, last_matched_at = ? WHERE id = ?'
      )
      .run(at, id)
  }
}
