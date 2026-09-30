import type { IpcApi, IpcChannel, IpcEventName, IpcEvents } from '@shared/ipc'
import type { UniboxApp } from '@main/app'

type Listener = (payload: unknown) => void

export interface InstalledBridge {
  emit: <E extends IpcEventName>(event: E, payload: IpcEvents[E]) => void
  openThread: (threadId: string) => void
  calls: Array<{ channel: IpcChannel; args: unknown[] }>
  /** Channels that should reject, with the exact message the UI must show. */
  failures: Map<IpcChannel, string>
  uninstall: () => void
}

/**
 * Installs `window.unibox` on top of the real application kernel, so renderer
 * tests exercise the same code path as production instead of a stub.
 */
export function installBridge(app: UniboxApp): InstalledBridge {
  const listeners = new Map<string, Set<Listener>>()
  const calls: Array<{ channel: IpcChannel; args: unknown[] }> = []
  const failures = new Map<IpcChannel, string>()
  const api = app.api as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>

  const on = (event: string, listener: Listener): (() => void) => {
    const set = listeners.get(event) ?? new Set<Listener>()
    set.add(listener)
    listeners.set(event, set)
    return () => set.delete(listener)
  }

  window.unibox = {
    invoke: ((channel: IpcChannel, ...args: unknown[]) => {
      calls.push({ channel, args })
      const failure = failures.get(channel)
      if (failure !== undefined) return Promise.reject(new Error(failure))
      return api[channel]!(...args)
    }) as <C extends IpcChannel>(channel: C, ...args: Parameters<IpcApi[C]>) => ReturnType<IpcApi[C]>,
    on: on as <E extends IpcEventName>(
      event: E,
      listener: (payload: IpcEvents[E]) => void
    ) => () => void,
    onOpenThread: (listener: (threadId: string) => void) =>
      on('notification:open', (payload) => listener(payload as string)),
    onMailto: (listener: (url: string) => void) =>
      on('compose:mailto', (payload) => listener(payload as string))
  }

  return {
    emit: (event, payload) => {
      for (const listener of listeners.get(event) ?? []) listener(payload)
    },
    openThread: (threadId) => {
      for (const listener of listeners.get('notification:open') ?? []) listener(threadId)
    },
    calls,
    failures,
    uninstall: () => {
      delete window.unibox
      listeners.clear()
    }
  }
}
