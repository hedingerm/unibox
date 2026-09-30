import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { promises as dns } from 'node:dns'
import { copyFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  BrowserWindow,
  Menu,
  Notification,
  app,
  clipboard,
  dialog,
  ipcMain,
  nativeImage,
  nativeTheme,
  safeStorage,
  session,
  shell
} from 'electron'
import type { IpcChannel, IpcEventName, IpcEvents } from '@shared/ipc'
import type { ThemePreference } from '@shared/types'
import { IPC_CHANNELS } from '@shared/ipc'
import type { GoogleOAuthConfig } from './google/auth'
import { EncryptedFileSecretStore } from './secrets'
import { createClaudeRunner } from './claude'
import {
  checkForUpdate,
  createGhRunner,
  isNewerVersion,
  resolveGhBinary,
  runInstaller
} from './update'
import { UniboxApp } from './app'
import type { NotificationAction } from './app'

let mainWindow: BrowserWindow | null = null
let unibox: UniboxApp | null = null
/** Set on the way out, so closing the window hides it only while the app runs on. */
let quitting = false
/**
 * Shown notifications stay referenced until they are dealt with: a collected
 * one still sits in the Notification Center, but its clicks go nowhere.
 */
const liveNotifications = new Set<Notification>()
const NOTIFICATION_ACTIONS: Record<NotificationAction, string> = {
  archive: 'Archivieren',
  read: 'Als gelesen markieren'
}

function loadGoogleOAuthConfig(userDataPath: string): GoogleOAuthConfig | null {
  const fromEnv = process.env.UNIBOX_GOOGLE_CLIENT_ID
  if (fromEnv && process.env.UNIBOX_GOOGLE_CLIENT_SECRET) {
    return { clientId: fromEnv, clientSecret: process.env.UNIBOX_GOOGLE_CLIENT_SECRET }
  }
  const file = join(userDataPath, 'google-oauth.json')
  if (!existsSync(file)) return null
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as {
      client_id?: string
      client_secret?: string
      installed?: { client_id?: string; client_secret?: string }
    }
    const clientId = parsed.client_id ?? parsed.installed?.client_id
    const clientSecret = parsed.client_secret ?? parsed.installed?.client_secret
    return clientId && clientSecret ? { clientId, clientSecret } : null
  } catch {
    return null
  }
}

/**
 * Remote mail images are loaded straight from the sender's host once the user
 * allows them, so keep the request anonymous: no cookies, no referrer, no
 * response cookies written back into the session.
 */
function hardenRemoteImageRequests(): void {
  const target = session.defaultSession
  target.webRequest.onBeforeSendHeaders((details, callback) => {
    if (details.resourceType !== 'image') return callback({ requestHeaders: details.requestHeaders })
    const headers = { ...details.requestHeaders }
    delete headers.Cookie
    delete headers.cookie
    delete headers.Referer
    delete headers.referer
    callback({ requestHeaders: headers })
  })
  target.webRequest.onHeadersReceived((details, callback) => {
    if (details.resourceType !== 'image') return callback({ responseHeaders: details.responseHeaders })
    const headers = { ...details.responseHeaders }
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === 'set-cookie') delete headers[key]
    }
    callback({ responseHeaders: headers })
  })
}

async function showMessage(options: Electron.MessageBoxOptions): Promise<number> {
  const result = mainWindow
    ? await dialog.showMessageBox(mainWindow, options)
    : await dialog.showMessageBox(options)
  return result.response
}

let updateCheckRunning = false

/**
 * Looks for a newer release and offers to install it. The check goes through
 * the user's own `gh` login instead of a token in the bundle. The automatic
 * check at start stays quiet whenever the CLI is missing or not logged in —
 * nagging would be worse than silence. Asked for from the menu, it says what
 * it found, failures included. Only packaged builds check; in development the
 * running code is the newer one by definition.
 */
async function runUpdateCheck(manual: boolean): Promise<void> {
  if (updateCheckRunning) return
  const report = (message: string, detail?: string): void => {
    if (manual) void showMessage({ type: 'info', message, detail })
  }
  if (!app.isPackaged) return report('Updates gibt es nur in der installierten App.')
  const gh = resolveGhBinary()
  if (!gh) {
    return report(
      'Die GitHub-CLI fehlt',
      'Die Suche nach Updates läuft über `gh`. Installieren mit `brew install gh`, danach `gh auth login`.'
    )
  }
  const installer = join(process.resourcesPath, 'install.sh')
  if (!existsSync(installer)) {
    // Ohne Skript gibt es keinen Weg zurück: sichtbar machen, sonst sucht man
    // den fehlenden Dialog in der Prüfung statt in der Paketierung.
    console.warn(`[update] Installationsskript fehlt: ${installer}`)
    return report('Das Installationsskript fehlt im App-Bundle.')
  }

  updateCheckRunning = true
  try {
    const currentVersion = app.getVersion()
    const result = await checkForUpdate({
      currentVersion,
      runGh: createGhRunner(gh),
      confirm: async (version) =>
        (await showMessage({
          type: 'question',
          buttons: ['Jetzt aktualisieren', 'Später'],
          defaultId: 0,
          cancelId: 1,
          message: `Unibox ${version} ist verfügbar`,
          detail: 'Die App wird ersetzt und danach neu gestartet.'
        })) === 0,
      install: () => {
        runInstaller(installer, {
          ghPath: gh,
          logPath: join(app.getPath('home'), 'Library', 'Logs', 'unibox-update.log')
        })
        app.quit()
      }
    })
    if (!result.latest) {
      report('Keine Verbindung zu GitHub', 'Prüfe das Netz und ob `gh auth status` eingeloggt ist.')
    } else if (!isNewerVersion(currentVersion, result.latest)) {
      report('Unibox ist aktuell', `Version ${currentVersion} ist die neueste.`)
    }
  } finally {
    updateCheckRunning = false
  }
}

/** Long enough for the window to be up and the first sync to matter more. */
const UPDATE_CHECK_DELAY_MS = 10_000

/**
 * The default menu with one addition: *Nach Updates suchen…* in the app menu,
 * where macOS apps keep it. The rest is spelled out by role because the app
 * menu cannot be extended without replacing it whole.
 */
function installAppMenu(): void {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: app.name,
        submenu: [
          { role: 'about' },
          {
            label: 'Nach Updates suchen…',
            click: () => void runUpdateCheck(true)
          },
          { type: 'separator' },
          { role: 'services' },
          { type: 'separator' },
          { role: 'hide' },
          { role: 'hideOthers' },
          { role: 'unhide' },
          { type: 'separator' },
          { role: 'quit' }
        ]
      },
      { role: 'fileMenu' },
      { role: 'editMenu' },
      { role: 'viewMenu' },
      { role: 'windowMenu' }
    ])
  )
}

function settleWorkdir(userDataPath: string): string {
  const dir = join(userDataPath, 'settle')
  mkdirSync(dir, { recursive: true })
  return dir
}

function emit<K extends IpcEventName>(name: K, payload: IpcEvents[K]): void {
  mainWindow?.webContents.send(name, payload)
}

function createWindow(show = true): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    show: false,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 9 },
    // The first frame before the page paints; matches --bg-app of the theme.
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1b1b1f' : '#f6f8fc',
    webPreferences: {
      // electron-vite emits an ESM preload (.mjs) because the package is type: module.
      preload: join(__dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // Chromium's built-in PDF viewer is a plugin; the attachment preview
      // embeds PDFs in an iframe and needs it enabled.
      plugins: true
    }
  })

  if (show) window.once('ready-to-show', () => window.show())

  // On macOS closing the window only hides it: the app keeps syncing either
  // way, and a notification click then finds a loaded window to open into.
  window.on('close', (event) => {
    if (quitting || process.platform !== 'darwin') return
    event.preventDefault()
    if (!window.isFullScreen()) return window.hide()
    window.once('leave-full-screen', () => window.hide())
    window.setFullScreen(false)
  })
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null
  })

  // Smoke check for CI: optionally drive the UI, report what mounted, capture
  // a screenshot, then quit. Enabled only via UNIBOX_SMOKE.
  if (process.env.UNIBOX_SMOKE) {
    window.webContents.once('did-finish-load', () => {
      void (async () => {
        const settle = (ms: number): Promise<unknown> =>
          window.webContents.executeJavaScript(
            `new Promise((resolve) => setTimeout(resolve, ${ms}))`
          )
        await settle(1200)
        if (process.env.UNIBOX_SMOKE_SCRIPT) {
          await window.webContents
            .executeJavaScript(`(async () => { ${process.env.UNIBOX_SMOKE_SCRIPT} })()`)
            .catch((error: unknown) => console.error('UNIBOX_SMOKE_SCRIPT', error))
          await settle(1200)
        }
        const report = (await window.webContents.executeJavaScript(
          `JSON.stringify({
             chrome: document.querySelectorAll('.sidebar, .toolbar, .list').length,
             dialogs: document.querySelectorAll('[role="dialog"]').length
           })`
        )) as string
        const { chrome, dialogs } = JSON.parse(report) as { chrome: number; dialogs: number }
        console.info(`UNIBOX_SMOKE chrome=${chrome} dialogs=${dialogs}`)
        const target = process.env.UNIBOX_SMOKE_SCREENSHOT
        if (target) writeFileSync(target, (await window.webContents.capturePage()).toPNG())
        app.exit(chrome >= 3 ? 0 : 1)
      })().catch((error: unknown) => {
        console.error('UNIBOX_SMOKE', error)
        app.exit(1)
      })
    })
  }

  window.webContents.setWindowOpenHandler(({ url }) => {
    openLink(window, url)
    return { action: 'deny' }
  })

  // Second line of defence behind the renderer's drop guard: whatever the
  // reason, navigating away from the app would discard the open draft and any
  // unsaved state with it. Only the app's own document may load here; a link
  // that gets this far goes to the browser instead.
  window.webContents.on('will-navigate', (event, url) => {
    const current = window.webContents.getURL()
    if (current && new URL(url).origin === new URL(current).origin) return
    event.preventDefault()
    if (url.startsWith('http://') || url.startsWith('https://')) void shell.openExternal(url)
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }
  return window
}

/**
 * A link the user clicked in a message. `mailto:` stays in the app — handing it
 * to the OS would open whatever other mail client is installed and write the
 * answer somewhere this inbox never sees it. Everything else goes to the
 * browser.
 */
function openLink(window: BrowserWindow, url: string): void {
  if (/^mailto:/i.test(url)) {
    window.show()
    window.webContents.send('compose:mailto', { url })
    return
  }
  void shell.openExternal(url)
}

/**
 * The app's theme setting drives Chromium's too: native menus, scrollbars and
 * `prefers-color-scheme` then agree with what the renderer draws.
 */
function applyNativeTheme(theme: ThemePreference | undefined): void {
  nativeTheme.themeSource = theme ?? 'system'
}

function registerIpc(instance: UniboxApp): void {
  const api = instance.api as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>
  for (const channel of IPC_CHANNELS as IpcChannel[]) {
    ipcMain.handle(channel, async (_event, ...args: unknown[]) => {
      const handler = api[channel]
      if (!handler) throw new Error(`Unbekannter Kanal ${channel}`)
      const result = await handler(...args)
      if (channel === 'settings:set') {
        const settings = instance.store.settings.get()
        applyNativeTheme(settings.theme)
        applyLoginItem(settings.openAtLogin ?? false)
      }
      return result
    })
  }
}

/**
 * Only the installed app registers itself: in development the login item would
 * point at the bare Electron binary.
 */
function applyLoginItem(openAtLogin: boolean): void {
  if (!app.isPackaged || app.getLoginItemSettings().openAtLogin === openAtLogin) return
  app.setLoginItemSettings({ openAtLogin })
}

/**
 * macOS ignores BrowserWindow's `icon`, so an unpackaged run shows the stock
 * Electron icon in the Dock. Packaged builds take theirs from build/icon.icns
 * via electron-builder; here we point the Dock at the same artwork by hand.
 */
function applyDockIcon(): void {
  if (process.platform !== 'darwin' || app.isPackaged) return
  const icon = nativeImage.createFromPath(join(app.getAppPath(), 'build', 'icon.png'))
  if (!icon.isEmpty()) app.dock?.setIcon(icon)
}

app.whenReady().then(() => {
  app.setAppUserModelId('ch.hedinger.unibox')
  applyDockIcon()
  const userDataPath = app.getPath('userData')

  unibox = new UniboxApp({
    userDataPath,
    secrets: new EncryptedFileSecretStore(join(userDataPath, 'secrets.json'), safeStorage),
    googleOAuth: loadGoogleOAuthConfig(userDataPath),
    resolveMx: (hostname) => dns.resolveMx(hostname),
    resolveTxt: (hostname) => dns.resolveTxt(hostname),
    openExternal: (url) => shell.openExternal(url),
    readClipboard: () => clipboard.readText(),
    writeClipboard: (text) => clipboard.writeText(text),
    notify: ({ title, body, threadId, actions = [] }) => {
      if (!Notification.isSupported()) return
      const notification = new Notification({
        title,
        body,
        actions: actions.map((action) => ({ type: 'button', text: NOTIFICATION_ACTIONS[action] }))
      })
      const release = (): void => void liveNotifications.delete(notification)
      notification.on('click', () => {
        release()
        if (!mainWindow) mainWindow = createWindow()
        mainWindow.show()
        emit('data:changed', { accountIds: [] })
        mainWindow.webContents.send('notification:open', { threadId })
      })
      notification.on('action', (_event, index) => {
        release()
        const action = actions[index]
        if (action) unibox?.notificationAction(threadId, action)
      })
      notification.on('close', release)
      liveNotifications.add(notification)
      notification.show()
    },
    emit,
    pickFiles: async () => {
      if (!mainWindow) return []
      const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openFile', 'multiSelections']
      })
      return result.canceled ? [] : result.filePaths
    },
    openPath: async (path) => {
      const error = await shell.openPath(path)
      if (error) throw new Error(error)
    },
    saveFileAs: async (defaultName, sourcePath) => {
      if (!mainWindow) return null
      const result = await dialog.showSaveDialog(mainWindow, {
        defaultPath: join(app.getPath('downloads'), defaultName)
      })
      if (result.canceled || !result.filePath) return null
      await copyFile(sourcePath, result.filePath)
      return result.filePath
    },
    chooseSavePath: async (defaultName) => {
      if (!mainWindow) return null
      const result = await dialog.showSaveDialog(mainWindow, {
        defaultPath: join(app.getPath('downloads'), defaultName)
      })
      return result.canceled || !result.filePath ? null : result.filePath
    },
    readFile: (path) => readFile(path),
    // The CLI runs in an empty directory of ours: no project files, no
    // CLAUDE.md, nothing of the user's to pick up while it reads mail.
    runClaude: createClaudeRunner({
      cwd: settleWorkdir(userDataPath),
      binaryPath: () => unibox?.store.settings.get().claudePath ?? null
    })
  })

  registerIpc(unibox)
  applyNativeTheme(unibox.store.settings.get().theme)
  hardenRemoteImageRequests()
  // Started at login, the app belongs in the background: the window loads, so
  // it is ready for a notification click, but stays hidden until asked for.
  mainWindow = createWindow(!(app.isPackaged && app.getLoginItemSettings().wasOpenedAtLogin))
  unibox.start()
  installAppMenu()
  setTimeout(() => void runUpdateCheck(false), UPDATE_CHECK_DELAY_MS)

  app.on('activate', () => {
    if (mainWindow) mainWindow.show()
    else mainWindow = createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  quitting = true
  unibox?.stop()
  unibox = null
})
