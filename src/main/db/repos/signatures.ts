import type { Signature } from '@shared/types'
import type { Db } from '../index'
import { newId } from '../ids'

interface SignatureRow {
  id: string
  name: string
  html: string
  created_at: number
}

function toSignature(row: SignatureRow & { uses?: number }): Signature {
  return {
    id: row.id,
    name: row.name,
    html: row.html,
    usedBy: row.uses ?? 0
  }
}

export interface SignatureInput {
  name: string
  html: string
}

/**
 * The signature library. Entries belong to no account: the same footer under a
 * Gmail alias and a Resend address is one text, edited once.
 */
export class SignatureRepo {
  constructor(private readonly db: Db) {}

  private static readonly SELECT = `
    SELECT s.*, (SELECT count(*) FROM identities i WHERE i.signature_id = s.id) AS uses
      FROM signatures s`

  list(): Signature[] {
    const rows = this.db
      .prepare(`${SignatureRepo.SELECT} ORDER BY s.name COLLATE NOCASE`)
      .all() as Array<SignatureRow & { uses: number }>
    return rows.map(toSignature)
  }

  get(id: string): Signature | null {
    const row = this.db.prepare(`${SignatureRepo.SELECT} WHERE s.id = ?`).get(id) as
      | (SignatureRow & { uses: number })
      | undefined
    return row ? toSignature(row) : null
  }

  html(id: string): string | null {
    const row = this.db.prepare('SELECT html FROM signatures WHERE id = ?').get(id) as
      | { html: string }
      | undefined
    return row?.html ?? null
  }

  create(input: SignatureInput): Signature {
    const id = newId()
    this.db
      .prepare('INSERT INTO signatures (id, name, html, created_at) VALUES (?, ?, ?, ?)')
      .run(id, input.name, input.html, Date.now())
    return this.get(id)!
  }

  update(id: string, patch: Partial<SignatureInput>): Signature {
    const sets: string[] = []
    const values: string[] = []
    if (patch.name !== undefined) {
      sets.push('name = ?')
      values.push(patch.name)
    }
    if (patch.html !== undefined) {
      sets.push('html = ?')
      values.push(patch.html)
    }
    if (sets.length > 0) {
      this.db.prepare(`UPDATE signatures SET ${sets.join(', ')} WHERE id = ?`).run(...values, id)
    }
    const signature = this.get(id)
    if (!signature) throw new Error(`Unknown signature ${id}`)
    return signature
  }

  /** Identities pointing here lose their default; drafts keep what they hold. */
  remove(id: string): void {
    this.db.prepare('DELETE FROM signatures WHERE id = ?').run(id)
  }

  /**
   * The entry holding exactly this text, or a new one under `name`. Reusing the
   * match is what keeps an import from filling the library with copies of the
   * same block, one per alias that carries it.
   */
  findOrCreate(html: string, name: string): Signature {
    const row = this.db.prepare(`${SignatureRepo.SELECT} WHERE s.html = ?`).get(html) as
      | (SignatureRow & { uses: number })
      | undefined
    return row ? toSignature(row) : this.create({ name, html })
  }
}
