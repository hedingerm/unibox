import { contextBridge, ipcRenderer } from 'electron'
import type { IpcApi, IpcChannel, IpcEventName, IpcEvents } from '@shared/ipc'
import { IPC_CHANNELS, IPC_EVENTS } from '@shared/ipc'
import { unwrapIpcError } from '@shared/ipc-error'

type Unsubscribe = () => void

export interface UniboxBridge {
  invoke: <C extends IpcChannel>(
    channel: C,
    ...args: Parameters<IpcApi[C]>
  ) => ReturnType<IpcApi[C]>
  on: <E extends IpcEventName>(
    event: E,
    listener: (payload: IpcEvents[E]) => void
  ) => Unsubscribe
  onOpenThread: (listener: (threadId: string) => void) => Unsubscribe
  /** A `mailto:` link the user clicked in a message, for the composer to take. */
  onMailto: (listener: (url: string) => void) => Unsubscribe
}

const bridge: UniboxBridge = {
  invoke: (channel, ...args) => {
    if (!IPC_CHANNELS.includes(channel)) {
      throw new Error(`Unbekannter Kanal ${String(channel)}`)
    }
    return (ipcRenderer.invoke(channel, ...args) as Promise<unknown>).catch((error: unknown) => {
      throw unwrapIpcError(error)
    }) as ReturnType<IpcApi[typeof channel]>
  },
  on: (event, listener) => {
    if (!IPC_EVENTS.includes(event)) throw new Error(`Unbekanntes Ereignis ${String(event)}`)
    const handler = (_event: unknown, payload: IpcEvents[typeof event]): void => listener(payload)
    ipcRenderer.on(event, handler)
    return () => ipcRenderer.removeListener(event, handler)
  },
  onOpenThread: (listener) => {
    const handler = (_event: unknown, payload: { threadId: string }): void =>
      listener(payload.threadId)
    ipcRenderer.on('notification:open', handler)
    return () => ipcRenderer.removeListener('notification:open', handler)
  },
  onMailto: (listener) => {
    const handler = (_event: unknown, payload: { url: string }): void => listener(payload.url)
    ipcRenderer.on('compose:mailto', handler)
    return () => ipcRenderer.removeListener('compose:mailto', handler)
  }
}

contextBridge.exposeInMainWorld('unibox', bridge)
