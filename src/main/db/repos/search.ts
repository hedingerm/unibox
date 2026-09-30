import type { SearchQuery } from '@shared/types'
import { SYSTEM_LABELS } from '@shared/types'
import type { ParsedQuery, SearchFilter } from '@shared/search-query'
import { IN_VALUES, isEmptyQuery, parseSearchQuery, resolveDate } from '@shared/search-query'
import type { Db } from '../index'
import { containsLike as contains, escapeLike } from '../sql'
import type { MessageRepo } from './messages'
import type { SearchResult } from '@shared/ipc'

/** bm25 column weights: subject beats participants beats body. */
const BM25 = 'bm25(messages_fts, 0.0, 0.0, 8.0, 4.0, 1.0)'


/**
 * Turns free text into a safe FTS5 MATCH expression. Every token is quoted so
 * that user input can never inject FTS operators; the final token gets a prefix
 * wildcard so search feels incremental while typing. Quoted runs stay phrases.
 */
export function toMatchExpression(parsed: Pick<ParsedQuery, 'terms' | 'phrases'>): string | null {
  const phrases = parsed.phrases
    .map((phrase) => phrase.replace(/"/g, '').trim())
    .filter((phrase) => phrase.length > 0)
    .map((phrase) => `"${phrase}"`)
  const terms = parsed.terms
    .map((token) => token.replace(/"/g, '').trim())
    .filter((token) => token.length > 0)
  const parts = [
    ...phrases,
    ...terms.map((token, index) =>
      index === terms.length - 1 ? `"${token}"*` : `"${token}"`
    )
  ]
  if (parts.length === 0) return null
  return parts.join(' AND ')
}

/** One compiled operator: a WHERE fragment plus the parameters it binds. */
interface Fragment {
  sql: string
  params: Record<string, unknown>
}

export class SearchRepo {
  constructor(
    private readonly db: Db,
    private readonly messages: MessageRepo
  ) {}

  /**
   * Every address that counts as "me" — account addresses plus the send-as
   * identities. Backs `from:me` / `to:me`, the query a unified inbox exists for.
   */
  private selfEmails(): string[] {
    const rows = this.db
      .prepare('SELECT email FROM accounts UNION SELECT email FROM identities')
      .all() as Array<{ email: string }>
    return rows.map((row) => row.email.toLowerCase()).filter((email) => email.includes('@'))
  }

  private compileFilter(filter: SearchFilter, key: string, now: number): Fragment | null {
    const params: Record<string, unknown> = {}
    const bind = (suffix: string, value: unknown): string => {
      const name = `${key}${suffix}`
      params[name] = value
      return `@${name}`
    }
    const value = filter.value
    let sql: string

    switch (filter.field) {
      case 'from':
      case 'to':
      case 'cc': {
        // Addresses live normalised in message_addresses, so these operators are
        // exact matches on an indexed column instead of substring tests against
        // a JSON blob. `to:` reads the Cc line too, the way Gmail does.
        const kinds = filter.field === 'from' ? ['from'] : filter.field === 'to' ? ['to', 'cc'] : ['cc']
        const kindList = kinds.map((kind, index) => bind(`k${index}`, kind)).join(', ')
        let test: string
        if (value.toLowerCase() === 'me') {
          const emails = this.selfEmails()
          if (emails.length === 0) return null
          const list = emails.map((email, index) => bind(`m${index}`, email)).join(', ')
          test = `ma.email IN (${list})`
        } else {
          const pattern = bind('v', contains(value))
          test = `(ma.email LIKE ${pattern} ESCAPE '\\' OR IFNULL(ma.name, '') LIKE ${pattern} ESCAPE '\\')`
        }
        sql = `EXISTS (SELECT 1 FROM message_addresses ma WHERE ma.message_id = m.id
               AND ma.kind IN (${kindList}) AND ${test})`
        break
      }
      case 'subject':
        sql = `m.subject LIKE ${bind('v', contains(value))} ESCAPE '\\'`
        break
      case 'has':
        sql = 'm.has_attachments = 1'
        break
      case 'filename':
        // `inline = 0` keeps signature logos out; they are not attachments the
        // user ever went looking for.
        sql = `EXISTS (SELECT 1 FROM attachments a WHERE a.message_id = m.id AND a.inline = 0
               AND a.filename LIKE ${bind('v', contains(value))} ESCAPE '\\')`
        break
      case 'is': {
        const kind = value.toLowerCase()
        const remote = kind === 'starred' ? SYSTEM_LABELS.starred : SYSTEM_LABELS.unread
        const exists = `EXISTS (SELECT 1 FROM message_labels ml WHERE ml.message_id = m.id
               AND ml.label_id = m.account_id || ':l:' || ${bind('v', remote)})`
        sql = kind === 'read' ? `NOT ${exists}` : exists
        break
      }
      case 'in': {
        const remote = IN_VALUES[value.toLowerCase()]!
        sql = `EXISTS (SELECT 1 FROM message_labels ml WHERE ml.message_id = m.id
               AND ml.label_id = m.account_id || ':l:' || ${bind('v', remote)})`
        break
      }
      case 'label':
        // Label names repeat across accounts on purpose, so the match is scoped
        // to each message's own account. `label:Kunden` also takes the children,
        // the way Gmail treats a nested path.
        sql = `EXISTS (SELECT 1 FROM message_labels ml JOIN labels l ON l.id = ml.label_id
               WHERE ml.message_id = m.id AND l.account_id = m.account_id
               AND (l.name = ${bind('v', value)} COLLATE NOCASE
                    OR l.name LIKE ${bind('c', `${escapeLike(value)}/%`)} ESCAPE '\\'))`
        break
      case 'account':
        // A Google account is addressed by its e-mail, a Resend account by its
        // domain — the suffix match lets `account:beispielweb.ch` hit both.
        sql = `m.account_id IN (SELECT id FROM accounts
               WHERE email = ${bind('v', value)} COLLATE NOCASE
                  OR email LIKE ${bind('s', `%${escapeLike(value)}`)} ESCAPE '\\')`
        break
      case 'after':
      case 'before':
      case 'newer_than':
      case 'older_than': {
        const timestamp = resolveDate(value, now)
        if (timestamp === null) return null
        const inclusive = filter.field === 'after' || filter.field === 'newer_than'
        sql = `m.date ${inclusive ? '>=' : '<'} ${bind('v', timestamp)}`
        break
      }
    }

    return { sql: filter.negated ? `NOT (${sql})` : sql, params }
  }

  query(query: SearchQuery, now: number = Date.now()): SearchResult[] {
    const parsed = parseSearchQuery(query.text)
    if (isEmptyQuery(parsed)) return []

    const match = toMatchExpression(parsed)
    const limit = query.limit ?? 100
    const params: Record<string, unknown> = { limit }
    const conditions: string[] = []

    if (match) {
      conditions.push('messages_fts MATCH @match')
      params.match = match
    }
    if (query.accountId) {
      conditions.push('m.account_id = @accountId')
      params.accountId = query.accountId
    }
    if (query.labelId) {
      conditions.push(
        'EXISTS (SELECT 1 FROM message_labels ml WHERE ml.message_id = m.id AND ml.label_id = @labelId)'
      )
      params.labelId = query.labelId
    }

    parsed.filters.forEach((filter, index) => {
      const fragment = this.compileFilter(filter, `f${index}`, now)
      if (!fragment) return
      conditions.push(fragment.sql)
      Object.assign(params, fragment.params)
    })

    // Deleted and junk mail stays out of results unless the query asks for it —
    // the same rule the folder listing follows.
    const opensFolder = (remote: string): boolean =>
      parsed.filters.some(
        (filter) =>
          !filter.negated && filter.field === 'in' && IN_VALUES[filter.value.toLowerCase()] === remote
      )
    const hidden = [
      ...(opensFolder(SYSTEM_LABELS.trash) ? [] : [SYSTEM_LABELS.trash]),
      ...(opensFolder(SYSTEM_LABELS.spam) ? [] : [SYSTEM_LABELS.spam])
    ]
    if (hidden.length > 0) {
      const list = hidden
        .map((remote, index) => {
          params[`hidden${index}`] = remote
          return `m.account_id || ':l:' || @hidden${index}`
        })
        .join(', ')
      conditions.push(
        `NOT EXISTS (SELECT 1 FROM message_labels x WHERE x.message_id = m.id AND x.label_id IN (${list}))`
      )
    }

    if (conditions.length === 0) return []

    // Threads, not messages, are what the list shows — so the LIMIT has to count
    // threads. Grouping in SQL keeps the result count stable; `from:hans` would
    // otherwise collapse 100 fetched messages into a handful of conversations.
    const source = match
      ? `SELECT m.thread_id AS thread_id, m.id AS message_id, m.date AS date, ${BM25} AS rank
         FROM messages_fts f JOIN messages m ON m.id = f.message_id
         WHERE ${conditions.join(' AND ')}`
      : `SELECT m.thread_id AS thread_id, m.id AS message_id, m.date AS date, 0 AS rank
         FROM messages m
         WHERE ${conditions.join(' AND ')}`

    const rows = this.db
      .prepare(
        `SELECT thread_id, message_id FROM (
           SELECT thread_id, message_id, rank,
                  ROW_NUMBER() OVER (PARTITION BY thread_id ORDER BY date DESC) AS rn,
                  MIN(rank) OVER (PARTITION BY thread_id) AS thread_rank,
                  MAX(date) OVER (PARTITION BY thread_id) AS last_date
           FROM (${source})
         )
         WHERE rn = 1
         ORDER BY thread_rank ASC, last_date DESC
         LIMIT @limit`
      )
      .all(params) as Array<{ message_id: string; thread_id: string }>

    const results: SearchResult[] = []
    for (const row of rows) {
      const summary = this.messages.threadSummary(row.thread_id)
      if (summary) results.push({ ...summary, matchedMessageId: row.message_id })
    }
    return results
  }
}
