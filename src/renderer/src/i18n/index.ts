import { de } from './de'

export type Locale = 'de'

const dictionaries = { de }

let current: Locale = 'de'

export function setLocale(locale: Locale): void {
  current = locale
}

export function getLocale(): Locale {
  return current
}

type Params = Record<string, string | number>

function lookup(key: string): unknown {
  let node: unknown = dictionaries[current]
  for (const part of key.split('.')) {
    if (typeof node !== 'object' || node === null) return undefined
    node = (node as Record<string, unknown>)[part]
  }
  return node
}

/**
 * Translates a dotted key. Missing keys fall back to the key itself so a typo
 * is visible in the UI instead of rendering an empty element.
 */
export function t(key: string, params?: Params): string {
  const value = lookup(key)
  if (typeof value !== 'string') return key
  if (!params) return value
  return value.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in params ? String(params[name]) : match
  )
}

export function tArray(key: string): readonly string[] {
  const value = lookup(key)
  return Array.isArray(value) ? (value as readonly string[]) : []
}

/** Gmail system label names are translated; user labels keep their own name. */
export function labelName(remoteId: string, fallback: string): string {
  const translated = lookup(`labels.${remoteId}`)
  return typeof translated === 'string' ? translated : fallback
}
