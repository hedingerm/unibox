import { SYSTEM_LABELS } from '@shared/types'
import type { Db } from '../db/index'
import { escapeLike } from '../db/sql'

/** How often mail of a kind ended up under one label. */
export interface LabelTally {
  /** Label name, or `TRASH` / `SPAM` for the two system destinations. */
  name: string
  count: number
}

export interface SenderHistory {
  /** Whether the tally is for the exact address or the whole domain. */
  scope: 'address' | 'domain'
  /** The address or `@domain` the tally was taken over. */
  key: string
  tallies: LabelTally[]
  /** Mails from that sender that were filed nowhere in particular. */
  unfiled: number
  total: number
}

export interface SettleEvidence {
  sender: SenderHistory | null
  /** Where mails with a similar subject ended up. */
  similar: LabelTally[]
}

/** bm25 weights: a matching subject counts far more than a matching body. */
const BM25 = 'bm25(messages_fts, 0.0, 0.0, 8.0, 2.0, 1.0)'

/** Top matches whose labels are tallied — enough to see a pattern, not a census. */
const SIMILAR_HITS = 20

const MAX_TALLIES = 4

/**
 * Words that match everything and therefore say nothing about where a mail
 * belongs. Deliberately short: the bm25 ranking handles the rest.
 */
const STOPWORDS = new Set([
  'aus',
  'bei',
  'das',
  'dein',
  'den',
  'der',
  'des',
  'die',
  'ein',
  'eine',
  'für',
  'ihr',
  'ihre',
  'mit',
  'und',
  'von',
  'für',
  'and',
  'for',
  'from',
  'the',
  'you',
  'your',
  'via',
  'new',
  'neu',
  'info',
  'mail',
  'email'
])

interface TallyRow {
  name: string
  remote_id: string
  type: string
  count: number
}

/** Only user labels and the two junk destinations carry filing information. */
const LABEL_FILTER = `(l.type = 'user' OR l.remote_id IN ('${SYSTEM_LABELS.trash}', '${SYSTEM_LABELS.spam}'))`

function toTallies(rows: TallyRow[]): LabelTally[] {
  return rows.map((row) => ({
    name: row.type === 'user' ? row.name : row.remote_id,
    count: row.count
  }))
}

/**
 * Turns a subject into an FTS5 query. `Re:`/`AW:` prefixes and stopwords are
 * dropped, every token is quoted so nothing in a subject line can act as an
 * FTS operator, and the rest is OR-ed — the ranking decides what matters.
 */
export function subjectMatchExpression(subject: string): string | null {
  const cleaned = subject.replace(/^((re|aw|fwd|wg)\s*:\s*)+/i, '')
  const tokens = cleaned
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length >= 3 && !STOPWORDS.has(token) && !/^\d+$/.test(token))
    .slice(0, 6)
  if (tokens.length === 0) return null
  return [...new Set(tokens)].map((token) => `"${token.replace(/"/g, '')}"`).join(' OR ')
}

/**
 * Answers "where did this mail's kind end up last time?" straight from the
 * local history — the filing the user did themselves, not a guess. Read-only.
 */
export class EvidenceRepo {
  constructor(private readonly db: Db) {}

  private tallyForSender(
    accountId: string,
    threadId: string,
    where: string,
    params: Record<string, unknown>
  ): { tallies: LabelTally[]; total: number; filed: number } {
    const total = (
      this.db
        .prepare(
          `SELECT COUNT(DISTINCT m.id) AS n FROM message_addresses ma
           JOIN messages m ON m.id = ma.message_id
           WHERE ma.kind = 'from' AND ${where}
             AND m.account_id = @accountId AND m.thread_id <> @threadId`
        )
        .get({ ...params, accountId, threadId }) as { n: number }
    ).n
    if (total === 0) return { tallies: [], total: 0, filed: 0 }

    const rows = this.db
      .prepare(
        `SELECT l.name AS name, l.remote_id AS remote_id, l.type AS type,
                COUNT(DISTINCT m.id) AS count
         FROM message_addresses ma
         JOIN messages m ON m.id = ma.message_id
         JOIN message_labels ml ON ml.message_id = m.id
         JOIN labels l ON l.id = ml.label_id
         WHERE ma.kind = 'from' AND ${where}
           AND m.account_id = @accountId AND m.thread_id <> @threadId
           AND ${LABEL_FILTER}
         GROUP BY l.id ORDER BY count DESC, l.name ASC LIMIT @limit`
      )
      .all({ ...params, accountId, threadId, limit: MAX_TALLIES }) as TallyRow[]

    const filed = (
      this.db
        .prepare(
          `SELECT COUNT(DISTINCT m.id) AS n FROM message_addresses ma
           JOIN messages m ON m.id = ma.message_id
           JOIN message_labels ml ON ml.message_id = m.id
           JOIN labels l ON l.id = ml.label_id
           WHERE ma.kind = 'from' AND ${where}
             AND m.account_id = @accountId AND m.thread_id <> @threadId
             AND ${LABEL_FILTER}`
        )
        .get({ ...params, accountId, threadId }) as { n: number }
    ).n

    return { tallies: toTallies(rows), total, filed }
  }

  /**
   * How previous mail from this sender was filed. Falls back to the sending
   * domain when the exact address has next to no history — `billing@` and
   * `noreply@` of the same company usually belong in the same place.
   */
  senderHistory(accountId: string, threadId: string, email: string): SenderHistory | null {
    const address = email.trim().toLowerCase()
    if (!address.includes('@')) return null

    const exact = this.tallyForSender(accountId, threadId, 'ma.email = @email', { email: address })
    if (exact.total >= 2 && exact.tallies.length > 0) {
      return {
        scope: 'address',
        key: address,
        tallies: exact.tallies,
        unfiled: exact.total - exact.filed,
        total: exact.total
      }
    }

    const domain = address.slice(address.lastIndexOf('@') + 1)
    if (!domain) return null
    const byDomain = this.tallyForSender(
      accountId,
      threadId,
      "ma.email LIKE @pattern ESCAPE '\\'",
      { pattern: `%@${escapeLike(domain)}` }
    )
    if (byDomain.total === 0 || byDomain.tallies.length === 0) return null
    return {
      scope: 'domain',
      key: `@${domain}`,
      tallies: byDomain.tallies,
      unfiled: byDomain.total - byDomain.filed,
      total: byDomain.total
    }
  }

  /** Where the mails with the most similar subjects ended up. */
  similarSubjects(accountId: string, threadId: string, subject: string): LabelTally[] {
    const match = subjectMatchExpression(subject)
    if (!match) return []
    const rows = this.db
      .prepare(
        `WITH hits AS (
           SELECT m.id AS id FROM messages_fts f
           JOIN messages m ON m.id = f.message_id
           WHERE messages_fts MATCH @match
             AND m.account_id = @accountId AND m.thread_id <> @threadId
           ORDER BY ${BM25} ASC LIMIT @hits
         )
         SELECT l.name AS name, l.remote_id AS remote_id, l.type AS type, COUNT(*) AS count
         FROM hits
         JOIN message_labels ml ON ml.message_id = hits.id
         JOIN labels l ON l.id = ml.label_id
         WHERE ${LABEL_FILTER}
         GROUP BY l.id ORDER BY count DESC, l.name ASC LIMIT @limit`
      )
      .all({ match, accountId, threadId, hits: SIMILAR_HITS, limit: MAX_TALLIES }) as TallyRow[]
    return toTallies(rows)
  }

  /**
   * Both signals for one mail. A malformed FTS expression must never take the
   * whole run down, so a failing similarity lookup degrades to "no evidence".
   */
  for(accountId: string, threadId: string, email: string, subject: string): SettleEvidence {
    let similar: LabelTally[] = []
    try {
      similar = this.similarSubjects(accountId, threadId, subject)
    } catch {
      similar = []
    }
    return { sender: this.senderHistory(accountId, threadId, email), similar }
  }
}
