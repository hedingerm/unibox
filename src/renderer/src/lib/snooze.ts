/** The fixed offers in the snooze menu, in the order they are shown. */
export type SnoozePresetKey = 'laterToday' | 'tomorrow' | 'weekend' | 'nextWeek'

export interface SnoozePreset {
  key: SnoozePresetKey
  /** When the conversation comes back. */
  at: number
}

/** The hour a "morning" offer lands on. */
const MORNING_HOUR = 8

/** The hour "later today" lands on — late enough to be a second pass at the day. */
const EVENING_HOUR = 18

/**
 * "Later today" is only worth offering while there is a later today left. Past
 * this hour the evening slot is too close to now to mean anything.
 */
const LATER_TODAY_CUTOFF_HOUR = 16

function at(now: number, addDays: number, hour: number): number {
  const date = new Date(now)
  date.setDate(date.getDate() + addDays)
  date.setHours(hour, 0, 0, 0)
  return date.getTime()
}

/** Days until the next given weekday, never 0 — today is already under way. */
function daysUntil(now: number, weekday: number): number {
  const today = new Date(now).getDay()
  return ((weekday - today + 7) % 7) || 7
}

/**
 * What the menu offers, given the current time. Offers that have gone stale are
 * left out rather than shown pointing backwards: "tomorrow morning" is always
 * ahead, but "later today" and "this weekend" are not, and an entry that would
 * fire immediately is worse than no entry.
 */
export function snoozePresets(now = Date.now()): SnoozePreset[] {
  const presets: SnoozePreset[] = []
  const hour = new Date(now).getHours()

  if (hour < LATER_TODAY_CUTOFF_HOUR) presets.push({ key: 'laterToday', at: at(now, 0, EVENING_HOUR) })
  presets.push({ key: 'tomorrow', at: at(now, 1, MORNING_HOUR) })

  // Saturday. On the weekend itself the offer would mean "in a week", which is
  // what the next entry already says.
  const weekday = new Date(now).getDay()
  if (weekday >= 1 && weekday <= 4) presets.push({ key: 'weekend', at: at(now, daysUntil(now, 6), MORNING_HOUR) })

  presets.push({ key: 'nextWeek', at: at(now, daysUntil(now, 1), MORNING_HOUR) })
  return presets
}

/** The offer the keyboard shortcut takes — tomorrow morning, always present. */
export function defaultSnoozeAt(now = Date.now()): number {
  return at(now, 1, MORNING_HOUR)
}

/**
 * Turns a `datetime-local` value into a timestamp. The input has no timezone,
 * so it is read as local time — which is what the user typed.
 */
export function parseCustomSnooze(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value.trim())
  if (!match) return null
  const [, year, month, day, hour, minute] = match
  const date = new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    0,
    0
  )
  return Number.isNaN(date.getTime()) ? null : date.getTime()
}

/** The value a `datetime-local` input starts on: the default offer, prefilled. */
export function customSnoozeDefault(now = Date.now()): string {
  const date = new Date(defaultSnoozeAt(now))
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours()
  )}:${pad(date.getMinutes())}`
}
