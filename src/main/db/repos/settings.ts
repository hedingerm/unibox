import { DEFAULT_FOLLOW_UP_DAYS } from '@shared/followup'
import type { AppSettings } from '@shared/types'
import type { Db } from '../index'

/**
 * The voice the compose assistant writes in out of the box. Editable in the
 * settings — this is only the starting point, not a constant the code relies on.
 */
export const DEFAULT_STYLE_PROMPT = [
  'Schreibe in meinem Namen. Den Namen für den Gruss nimmst du aus der Absenderidentität.',
  '',
  'Ton: knapp und direkt, freundlich-pragmatisch.',
  'Gegenüber Kunden warm, gegenüber Anbietern sachlich-konstruktiv.',
  '',
  'Du oder Sie: spiegle, was die Gegenseite tut. Bei Erstkontakt oder Unklarheit "Sie".',
  'Anrede bei Du: "Hallo <Vorname>", "Guten Morgen <Vorname>".',
  'Anrede bei Sie: "Guten Tag Herr/Frau <Nachname>", "Sehr geehrte(r) …" beim Erstkontakt.',
  'Schluss bei Du: "Liebe Grüsse", darunter der Vorname.',
  'Schluss bei Sie: "Freundliche Grüsse", darunter der volle Name.',
  '',
  'Kürze schlägt Vollständigkeit: eine Bestätigung ist ein Satz, kein Absatz.',
  'Mehrere Punkte werden zur nummerierten Liste, nicht zum Schachtelsatz.',
  'Immer konkret: ein nächster Schritt, eine Frage oder ein klarer Status.',
  'Kein Marketing-Sprech, keine Buzzwords, keine Emojis, keine Ausrufzeichen-Inflation.',
  'Keine Mundart, ausser der Empfänger schreibt selbst Mundart.'
].join('\n')

export const DEFAULT_SETTINGS: AppSettings = {
  undoSendSeconds: 10,
  pollIntervalSeconds: 90,
  notificationsEnabled: true,
  onboardingComplete: false,
  settleModel: 'sonnet',
  settleBatchSize: 12,
  claudePath: null,
  aiModel: 'sonnet',
  aiStylePrompt: DEFAULT_STYLE_PROMPT,
  savedSearches: [],
  followUpEnabled: true,
  followUpDays: DEFAULT_FOLLOW_UP_DAYS,
  autoBackup: false,
  openAtLogin: false
}

export class SettingsRepo {
  constructor(private readonly db: Db) {}

  getRaw(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      | { value: string }
      | undefined
    return row?.value ?? null
  }

  setRaw(key: string, value: string): void {
    this.db
      .prepare(
        'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
      )
      .run(key, value)
  }

  get(): AppSettings {
    const raw = this.getRaw('app')
    if (!raw) return { ...DEFAULT_SETTINGS }
    try {
      return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<AppSettings>) }
    } catch {
      return { ...DEFAULT_SETTINGS }
    }
  }

  set(patch: Partial<AppSettings>): AppSettings {
    const next = { ...this.get(), ...patch }
    this.setRaw('app', JSON.stringify(next))
    return next
  }
}

export class CursorRepo {
  constructor(private readonly db: Db) {}

  get(accountId: string, kind: string): string | null {
    const row = this.db
      .prepare('SELECT cursor FROM sync_cursors WHERE account_id = ? AND kind = ?')
      .get(accountId, kind) as { cursor: string | null } | undefined
    return row?.cursor ?? null
  }

  set(accountId: string, kind: string, cursor: string | null): void {
    this.db
      .prepare(
        `INSERT INTO sync_cursors (account_id, kind, cursor, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(account_id, kind) DO UPDATE SET cursor = excluded.cursor, updated_at = excluded.updated_at`
      )
      .run(accountId, kind, cursor, Date.now())
  }
}
