import { useCallback, useState } from 'react'

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

function write(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    // Storage unavailable — the layout still works, it just isn't remembered.
  }
}

/**
 * A pane size that survives restarts. A stored value from an older, wider
 * clamp — or garbage — is pulled back into range instead of trusted.
 */
export function useStoredSize(
  key: string,
  fallback: number,
  min: number,
  max: number
): [number, (value: number) => void] {
  const [size, setSize] = useState(() => {
    const stored = Number(read(key))
    return clamp(Number.isFinite(stored) && stored > 0 ? stored : fallback, min, max)
  })
  const update = useCallback(
    (value: number) => {
      const next = clamp(Math.round(value), min, max)
      setSize(next)
      write(key, String(next))
    },
    [key, min, max]
  )
  return [size, update]
}

export function useStoredFlag(key: string, fallback: boolean): [boolean, (value: boolean) => void] {
  const [flag, setFlag] = useState(() => {
    const stored = read(key)
    return stored === null ? fallback : stored === '1'
  })
  const update = useCallback(
    (value: boolean) => {
      setFlag(value)
      write(key, value ? '1' : '0')
    },
    [key]
  )
  return [flag, update]
}
