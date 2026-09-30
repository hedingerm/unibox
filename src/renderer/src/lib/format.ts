import type { EmailAddress } from '@shared/types'
import { t, tArray } from '../i18n'

const timeFormatter = new Intl.DateTimeFormat('de-CH', { hour: '2-digit', minute: '2-digit' })
const dateFormatter = new Intl.DateTimeFormat('de-CH', { day: '2-digit', month: '2-digit', year: 'numeric' })
const monthFormatter = new Intl.DateTimeFormat('de-CH', { month: 'long', year: 'numeric' })
const fullFormatter = new Intl.DateTimeFormat('de-CH', {
  day: '2-digit',
  month: 'long',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit'
})

function startOfDay(value: Date): number {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime()
}

/** Clock time alone, for things that happened just now («Gesichert 14:02»). */
export function formatTime(timestamp: number): string {
  return timeFormatter.format(new Date(timestamp))
}

/** Mail-client style relative timestamps: time today, weekday this week, date beyond. */
export function formatListDate(timestamp: number, now = Date.now()): string {
  const date = new Date(timestamp)
  const today = startOfDay(new Date(now))
  const day = startOfDay(date)
  const dayMs = 24 * 3600 * 1000
  if (day === today) return timeFormatter.format(date)
  if (day === today - dayMs) return t('time.yesterday')
  if (day > today - 7 * dayMs) return tArray('time.weekdays')[date.getDay()] ?? dateFormatter.format(date)
  return dateFormatter.format(date)
}

/** Monday-based, because the list groups by the week a Swiss reader sees. */
function startOfWeek(value: Date): number {
  const day = new Date(value.getFullYear(), value.getMonth(), value.getDate())
  day.setDate(day.getDate() - ((day.getDay() + 6) % 7))
  return day.getTime()
}

/**
 * Section label for the message list. Only meaningful on a date-sorted list —
 * the sections are contiguous runs, not buckets that get revisited.
 */
export function listSection(timestamp: number, now = Date.now()): string {
  const date = new Date(timestamp)
  const current = new Date(now)
  const today = startOfDay(current)
  const day = startOfDay(date)
  const dayMs = 24 * 3600 * 1000
  if (day >= today) return t('time.today')
  if (day === today - dayMs) return t('time.yesterday')
  const week = startOfWeek(current)
  if (day >= week) return t('time.thisWeek')
  if (day >= week - 7 * dayMs) return t('time.lastWeek')
  if (date.getFullYear() === current.getFullYear() && date.getMonth() === current.getMonth())
    return t('time.thisMonth')
  return monthFormatter.format(date)
}

/**
 * When a put-aside conversation comes back. Unlike the list's timestamps this
 * looks forward, so the day is always named: "18:00" alone would read as a time
 * today even when it is next Monday.
 */
export function formatSnoozeUntil(timestamp: number, now = Date.now()): string {
  const date = new Date(timestamp)
  const today = startOfDay(new Date(now))
  const day = startOfDay(date)
  const dayMs = 24 * 3600 * 1000
  const time = timeFormatter.format(date)
  if (day === today) return `${t('time.today')} ${time}`
  if (day === today + dayMs) return `${t('time.tomorrow')} ${time}`
  if (day < today + 7 * dayMs)
    return `${tArray('time.weekdays')[date.getDay()] ?? dateFormatter.format(date)} ${time}`
  return `${dateFormatter.format(date)} ${time}`
}

const shortDayFormatter = new Intl.DateTimeFormat('de-CH', { day: 'numeric', month: 'short' })
const shortDayYearFormatter = new Intl.DateTimeFormat('de-CH', {
  day: 'numeric',
  month: 'short',
  year: 'numeric'
})

/** "vor 2 Std." — only for the last week; beyond that the date says enough. */
export function formatAgo(timestamp: number, now = Date.now()): string | null {
  const minutes = Math.floor((now - timestamp) / 60_000)
  if (minutes < 0) return null
  if (minutes < 1) return t('reading.justNow')
  if (minutes < 60) return t('reading.minutesAgo', { count: minutes })
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return t('reading.hoursAgo', { count: hours })
  const days = Math.floor(hours / 24)
  if (days === 1) return t('reading.oneDayAgo')
  if (days < 7) return t('reading.daysAgo', { count: days })
  return null
}

/**
 * The date on a message header, the way Gmail writes it: "10:24 (vor 2 Std.)"
 * today, "12. Sept., 10:24 (vor 3 Tagen)" this week, and the plain date for
 * anything older — how long ago stops mattering once it is weeks.
 */
export function formatMessageDate(timestamp: number, now = Date.now()): string {
  const date = new Date(timestamp)
  const current = new Date(now)
  const time = timeFormatter.format(date)
  const day =
    startOfDay(date) === startOfDay(current)
      ? time
      : `${(date.getFullYear() === current.getFullYear() ? shortDayFormatter : shortDayYearFormatter).format(date)}, ${time}`
  const ago = formatAgo(timestamp, now)
  return ago ? `${day} (${ago})` : day
}

export function formatFullDate(timestamp: number): string {
  return fullFormatter.format(new Date(timestamp))
}

export function displayName(address: EmailAddress): string {
  return address.name && address.name.trim() ? address.name : address.email
}

export function initials(address: EmailAddress): string {
  const source = displayName(address)
  const parts = source.split(/[\s.@]+/).filter(Boolean)
  const letters = parts.slice(0, 2).map((part) => part[0] ?? '')
  return letters.join('').toUpperCase() || '?'
}

/** Stable pastel avatar colour derived from the address. */
export function avatarColors(address: EmailAddress): { background: string; color: string } {
  let hash = 0
  for (const char of address.email) hash = (hash * 31 + char.charCodeAt(0)) % 360
  return { background: `hsl(${hash} 60% 90%)`, color: `hsl(${hash} 55% 35%)` }
}

export function formatRecipients(addresses: EmailAddress[]): string {
  return addresses.map(displayName).join(', ')
}

/** Human-readable file size for attachment chips and the preview footer. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}
