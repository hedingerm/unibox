import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AppEnvironment, NotificationRequest } from '@main/app'
import { UniboxApp } from '@main/app'
import type { IpcEventName, IpcEvents } from '@shared/ipc'
import { InMemorySecretStore } from '@main/secrets'
import type { MxRecord } from '@main/resend/mx'
import type { ClaudeRunner } from '@main/claude'
import { FakeGmail } from './fake-gmail'
import { FakeResend } from './fake-resend'

export interface TestApp {
  app: UniboxApp
  gmail: FakeGmail
  resend: FakeResend
  secrets: InMemorySecretStore
  notifications: NotificationRequest[]
  events: Array<{ name: IpcEventName; payload: unknown }>
  /**
   * Subscribes to what the kernel pushes to the renderer. Renderer tests wire
   * this into the fake bridge; without it a main-process event never reaches
   * the React tree, which the app itself does not have the option of.
   */
  onEmit: (listener: (name: IpcEventName, payload: unknown) => void) => () => void
  openedUrls: string[]
  openedPaths: string[]
  /** The fake system clipboard, so a copy can be read back in a test. */
  clipboard: { text: string }
  pickedFiles: string[]
  /** Where the next "save as" lands; null makes the dialog look cancelled. */
  saveTarget: { path: string | null }
  files: Map<string, Buffer>
  mx: Map<string, MxRecord[]>
  dispose: () => void
}

/**
 * Boots the real application kernel against in-process fakes for Gmail, Resend
 * and the OS integration points.
 */
export interface TestAppOptions {
  googleOAuth?: boolean
  /** Plays the part of the browser: follows the OAuth redirect straight back. */
  autoCompleteOAuth?: boolean
  /** Stands in for the local Claude Code CLI; omitted = settling unavailable. */
  runClaude?: ClaudeRunner
}

export function createTestApp(options: TestAppOptions = {}): TestApp {
  const gmail = new FakeGmail()
  const resend = new FakeResend()
  const secrets = new InMemorySecretStore()
  const notifications: NotificationRequest[] = []
  const events: Array<{ name: IpcEventName; payload: unknown }> = []
  const emitListeners = new Set<(name: IpcEventName, payload: unknown) => void>()
  const openedUrls: string[] = []
  const clipboard = { text: '' }
  const openedPaths: string[] = []
  const pickedFiles: string[] = []
  const saveTarget: { path: string | null } = { path: null }
  const files = new Map<string, Buffer>()
  const userDataPath = mkdtempSync(join(tmpdir(), 'unibox-app-'))

  const routedFetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.toString())
    if (url.hostname.endsWith('googleapis.com') || url.hostname.endsWith('google.com')) {
      if (url.pathname === '/token') {
        return new Response(
          JSON.stringify({
            access_token: 'test-access',
            refresh_token: 'test-refresh',
            expires_in: 3600,
            scope: 'gmail.modify',
            token_type: 'Bearer'
          }),
          { status: 200 }
        )
      }
      return gmail.fetch(url.toString().replace(/^https:\/\/[^/]+/, 'https://gmail.test'), init)
    }
    return resend.fetch(url.toString().replace(/^https:\/\/api\.resend\.com/, 'https://api.resend.test'), init)
  }

  const env: AppEnvironment = {
    userDataPath,
    databaseFile: ':memory:',
    secrets,
    googleOAuth: options.googleOAuth
      ? { clientId: 'test-client', clientSecret: 'test-secret', tokenEndpoint: 'https://oauth2.googleapis.com/token' }
      : null,
    resolveMx: async (hostname) => resend.resolveMx(hostname),
    resolveTxt: async (hostname) => resend.resolveTxt(hostname),
    openExternal: async (url) => {
      openedUrls.push(url)
      if (!options.autoCompleteOAuth) return
      const parsed = new URL(url)
      const redirect = new URL(parsed.searchParams.get('redirect_uri') ?? '')
      redirect.searchParams.set('code', 'test-code')
      redirect.searchParams.set('state', parsed.searchParams.get('state') ?? '')
      void globalThis.fetch(redirect.toString()).catch(() => undefined)
    },
    notify: (request) => notifications.push(request),
    emit: <K extends IpcEventName>(name: K, payload: IpcEvents[K]) => {
      events.push({ name, payload })
      for (const listener of emitListeners) listener(name, payload)
    },
    pickFiles: async () => pickedFiles,
    openPath: async (path) => {
      openedPaths.push(path)
    },
    saveFileAs: async (_defaultName, sourcePath) => {
      if (!saveTarget.path) return null
      files.set(saveTarget.path, files.get(sourcePath) ?? Buffer.from(''))
      return saveTarget.path
    },
    chooseSavePath: async () => saveTarget.path,
    readClipboard: () => clipboard.text,
    writeClipboard: (text) => {
      clipboard.text = text
    },
    runClaude: options.runClaude ?? null,
    // The availability check must not depend on what is installed on the
    // machine running the tests.
    claudeBinaryPath: options.runClaude ? process.execPath : '/nicht/vorhanden',
    readFile: async (path) => files.get(path) ?? Buffer.from(''),
    fetch: routedFetch
  }

  const app = new UniboxApp(env)
  return {
    app,
    gmail,
    resend,
    secrets,
    notifications,
    events,
    onEmit: (listener) => {
      emitListeners.add(listener)
      return () => emitListeners.delete(listener)
    },
    openedUrls,
    openedPaths,
    clipboard,
    pickedFiles,
    saveTarget,
    files,
    mx: resend.mx,
    dispose: () => app.stop()
  }
}
