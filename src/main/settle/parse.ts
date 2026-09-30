import type { SettleActionKind, SettleConfidence } from '@shared/types'

export interface RawDecision {
  ref: string
  action: SettleActionKind
  label: string | null
  newLabel: boolean
  confidence: SettleConfidence
  reason: string
}

const ACTIONS = new Set<SettleActionKind>(['label', 'trash', 'spam', 'keep'])
const CONFIDENCES = new Set<SettleConfidence>(['high', 'medium', 'low'])

/** Pulls the JSON object out of an answer that may carry a code fence or prose. */
function extractJson(text: string): string | null {
  const trimmed = text.trim()
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed)
  const body = fenced?.[1]?.trim() ?? trimmed
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  return body.slice(start, end + 1)
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * Reads the model's answer defensively: anything unknown degrades to `keep`
 * rather than to a move the user did not ask for.
 */
export function parseDecisions(text: string): RawDecision[] {
  const json = extractJson(text)
  if (!json) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return []
  }
  const list = (parsed as { decisions?: unknown }).decisions
  if (!Array.isArray(list)) return []

  const seen = new Set<string>()
  const decisions: RawDecision[] = []
  for (const entry of list) {
    if (typeof entry !== 'object' || entry === null) continue
    const row = entry as Record<string, unknown>
    const ref = asString(row.ref)
    if (!ref || seen.has(ref)) continue
    seen.add(ref)

    const action = asString(row.action) as SettleActionKind
    const confidence = asString(row.confidence) as SettleConfidence
    const label = asString(row.label)
    const safeAction: SettleActionKind = ACTIONS.has(action) ? action : 'keep'
    decisions.push({
      ref,
      // A label action without a label name is not actionable.
      action: safeAction === 'label' && !label ? 'keep' : safeAction,
      label: safeAction === 'label' && label ? label : null,
      newLabel: row.new_label === true || row.newLabel === true,
      confidence: CONFIDENCES.has(confidence) ? confidence : 'low',
      reason: asString(row.reason).slice(0, 200)
    })
  }
  return decisions
}
