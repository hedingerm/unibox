import type { IpcApi, IpcChannel, IpcEventName, IpcEvents } from '@shared/ipc'

export interface UniboxBridge {
  invoke: <C extends IpcChannel>(channel: C, ...args: Parameters<IpcApi[C]>) => ReturnType<IpcApi[C]>
  on: <E extends IpcEventName>(event: E, listener: (payload: IpcEvents[E]) => void) => () => void
  onOpenThread: (listener: (threadId: string) => void) => () => void
  onMailto: (listener: (url: string) => void) => () => void
}

declare global {
  interface Window {
    unibox?: UniboxBridge
  }
}

const missing: UniboxBridge = {
  invoke: () => {
    throw new Error('Unibox-Bridge ist nicht verfügbar')
  },
  on: () => () => undefined,
  onOpenThread: () => () => undefined,
  onMailto: () => () => undefined
}

export function bridge(): UniboxBridge {
  return window.unibox ?? missing
}

export const api = {
  invoke: <C extends IpcChannel>(channel: C, ...args: Parameters<IpcApi[C]>): ReturnType<IpcApi[C]> =>
    bridge().invoke(channel, ...args),
  on: <E extends IpcEventName>(event: E, listener: (payload: IpcEvents[E]) => void): (() => void) =>
    bridge().on(event, listener),
  onOpenThread: (listener: (threadId: string) => void): (() => void) =>
    bridge().onOpenThread(listener),
  onMailto: (listener: (url: string) => void): (() => void) => bridge().onMailto(listener)
}
