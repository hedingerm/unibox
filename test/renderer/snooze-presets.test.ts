import { describe, expect, it } from 'vitest'
import {
  customSnoozeDefault,
  defaultSnoozeAt,
  parseCustomSnooze,
  snoozePresets
} from '@renderer/lib/snooze'

/** Local time, so the tests read the same way the menu does. */
function at(iso: string): number {
  return new Date(iso).getTime()
}

function keys(now: number): string[] {
  return snoozePresets(now).map((preset) => preset.key)
}

describe('what the snooze menu offers', () => {
  it('offers the evening while there is still an evening left', () => {
    // Wednesday, 09:00.
    const now = at('2026-08-19T09:00:00')
    expect(keys(now)).toEqual(['laterToday', 'tomorrow', 'weekend', 'nextWeek'])
    expect(snoozePresets(now)[0]!.at).toBe(at('2026-08-19T18:00:00'))
  })

  it('drops the evening once it is nearly here', () => {
    // Wednesday, 17:30 — "heute Abend" would be half an hour away.
    expect(keys(at('2026-08-19T17:30:00'))).toEqual(['tomorrow', 'weekend', 'nextWeek'])
  })

  it('drops the weekend on the weekend, where it would mean "in a week"', () => {
    // Saturday and Sunday.
    expect(keys(at('2026-08-22T09:00:00'))).not.toContain('weekend')
    expect(keys(at('2026-08-23T09:00:00'))).not.toContain('weekend')
    // Friday too: Saturday is what "tomorrow" already says.
    expect(keys(at('2026-08-21T09:00:00'))).not.toContain('weekend')
  })

  it('always points forward, whichever day it is asked', () => {
    for (const day of ['17', '18', '19', '20', '21', '22', '23']) {
      const now = at(`2026-08-${day}T09:00:00`)
      for (const preset of snoozePresets(now)) {
        expect(preset.at, `${day} · ${preset.key}`).toBeGreaterThan(now)
      }
    }
  })

  it('lands the weekend on Saturday and the new week on Monday', () => {
    const now = at('2026-08-19T09:00:00') // Wednesday
    const presets = new Map(snoozePresets(now).map((preset) => [preset.key, preset.at]))
    expect(new Date(presets.get('weekend')!).getDay()).toBe(6)
    expect(new Date(presets.get('nextWeek')!).getDay()).toBe(1)
    expect(presets.get('nextWeek')).toBe(at('2026-08-24T08:00:00'))
  })

  it('sends the keyboard shortcut to tomorrow morning', () => {
    expect(defaultSnoozeAt(at('2026-08-19T22:45:00'))).toBe(at('2026-08-20T08:00:00'))
  })
})

describe('a moment the user types', () => {
  it('reads the input as local time, the way it was typed', () => {
    expect(parseCustomSnooze('2026-09-01T14:30')).toBe(at('2026-09-01T14:30:00'))
  })

  it('rejects anything that is not a complete moment', () => {
    expect(parseCustomSnooze('')).toBeNull()
    expect(parseCustomSnooze('2026-09-01')).toBeNull()
    expect(parseCustomSnooze('morgen')).toBeNull()
  })

  it('prefills the input with the default offer', () => {
    expect(customSnoozeDefault(at('2026-08-19T09:00:00'))).toBe('2026-08-20T08:00')
  })
})
