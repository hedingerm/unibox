import { addWorkingDays } from '@shared/followup'
import { t } from '../i18n'

/** Whole days between two moments, counted by calendar day, not by hours. */
function daysBetween(from: number, to: number): number {
  const start = new Date(from)
  const end = new Date(to)
  const startDay = new Date(start.getFullYear(), start.getMonth(), start.getDate()).getTime()
  const endDay = new Date(end.getFullYear(), end.getMonth(), end.getDate()).getTime()
  return Math.round((endDay - startDay) / (24 * 3600 * 1000))
}

/**
 * How long a conversation has been waiting, or how long it still may. Reads as
 * a countdown rather than a date because the date is not the point — that the
 * answer is late is.
 */
export function formatFollowUpDue(dueAt: number, now = Date.now()): string {
  const days = daysBetween(now, dueAt)
  if (days > 1) return t('followup.dueInDays', { count: days })
  if (days === 1) return t('followup.dueTomorrow')
  if (days === 0) return dueAt > now ? t('followup.dueToday') : t('followup.overdueToday')
  if (days === -1) return t('followup.overdueYesterday')
  return t('followup.overdueDays', { count: Math.abs(days) })
}

/** Whether the wait has run out — what colours the badge and the sidebar row. */
export function isOverdue(dueAt: number, now = Date.now()): boolean {
  return dueAt <= now
}

/** The composer's offer, in working days from now. */
export function dueInWorkingDays(days: number, from = Date.now()): number {
  return addWorkingDays(from, days)
}
