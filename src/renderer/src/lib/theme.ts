import type { ThemePreference } from '@shared/types'

const STORAGE_KEY = 'unibox.theme'
const DARK_QUERY = '(prefers-color-scheme: dark)'

export type ResolvedTheme = 'light' | 'dark'

function isPreference(value: unknown): value is ThemePreference {
  return value === 'system' || value === 'light' || value === 'dark'
}

/**
 * The last theme the settings asked for. Settings arrive over IPC after the
 * first paint; remembering the choice here is what keeps a dark app from
 * flashing white on every start.
 */
export function storedTheme(): ThemePreference {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY)
    return isPreference(value) ? value : 'system'
  } catch {
    return 'system'
  }
}

function rememberTheme(preference: ThemePreference): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, preference)
  } catch {
    // Storage unavailable — the theme still applies, it just may flash once.
  }
}

function darkQuery(): MediaQueryList | null {
  return typeof window.matchMedia === 'function' ? window.matchMedia(DARK_QUERY) : null
}

export function resolveTheme(preference: ThemePreference, prefersDark: boolean): ResolvedTheme {
  if (preference === 'system') return prefersDark ? 'dark' : 'light'
  return preference
}

/**
 * Puts the resolved theme on `<html data-theme>`, where the stylesheet swaps
 * its tokens. "system" follows the OS live; the returned function stops that.
 */
export function applyTheme(preference: ThemePreference): () => void {
  rememberTheme(preference)
  const root = document.documentElement
  const query = darkQuery()
  const update = (): void => {
    root.dataset.theme = resolveTheme(preference, query?.matches ?? false)
  }
  update()
  if (preference !== 'system' || !query) return () => undefined
  query.addEventListener('change', update)
  return () => query.removeEventListener('change', update)
}
