import { execFile, spawn } from 'node:child_process'
import { existsSync, openSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Where the release artifacts and the installer script come from. */
export const UPDATE_REPO = 'hedingerm/unibox'

/**
 * The GUI process inherits a bare `PATH` when launched from Finder, so the
 * usual install locations of the GitHub CLI are probed explicitly — same
 * reasoning as `resolveClaudeBinary`.
 */
function candidateGhPaths(): string[] {
  return [
    '/opt/homebrew/bin/gh',
    '/usr/local/bin/gh',
    '/usr/bin/gh',
    join(homedir(), '.local', 'bin', 'gh'),
    join(homedir(), 'bin', 'gh')
  ]
}

export function resolveGhBinary(): string | null {
  const fromEnv = process.env.UNIBOX_GH_PATH
  if (fromEnv && existsSync(fromEnv)) return fromEnv
  return candidateGhPaths().find((path) => existsSync(path)) ?? null
}

/**
 * Compares two `major.minor.patch` versions. Anything unparseable counts as
 * "not newer": a broken tag must never push an update at the user.
 */
export function isNewerVersion(current: string, candidate: string): boolean {
  const parse = (value: string): [number, number, number] | null => {
    const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(value.trim())
    return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null
  }
  const a = parse(current)
  const b = parse(candidate)
  if (!a || !b) return false
  if (b[0] !== a[0]) return b[0] > a[0]
  if (b[1] !== a[1]) return b[1] > a[1]
  return b[2] > a[2]
}

export interface UpdateCheckDeps {
  /** Version of the running app, `app.getVersion()`. */
  currentVersion: string
  /** Runs the GitHub CLI and resolves its stdout, or null if it failed. */
  runGh: (args: string[]) => Promise<string | null>
  /** Asks the user; only called when a newer release exists. */
  confirm: (version: string) => Promise<boolean>
  /** Hands over to the installer script — the app quits right after. */
  install: () => void
}

export interface UpdateCheckResult {
  latest: string | null
  installing: boolean
}

/**
 * Asks GitHub for the newest release and offers to install it. The check runs
 * through the user's own `gh` CLI, so no token ever ships in the bundle.
 * Every failure is silent — a missing CLI or a dropped connection is not
 * something to interrupt reading mail for.
 */
export async function checkForUpdate(deps: UpdateCheckDeps): Promise<UpdateCheckResult> {
  const tag = await deps.runGh([
    'release',
    'view',
    '--repo',
    UPDATE_REPO,
    '--json',
    'tagName',
    '-q',
    '.tagName'
  ])
  if (!tag) return { latest: null, installing: false }
  const latest = tag.trim().replace(/^v/, '')
  if (!isNewerVersion(deps.currentVersion, latest)) return { latest, installing: false }
  if (!(await deps.confirm(latest))) return { latest, installing: false }
  deps.install()
  return { latest, installing: true }
}

export function createGhRunner(binary: string): (args: string[]) => Promise<string | null> {
  return (args) =>
    new Promise((resolve) => {
      execFile(binary, args, { timeout: 20_000 }, (error, stdout) => {
        resolve(error ? null : stdout)
      })
    })
}

export interface InstallerOptions {
  /** Handed to the script: a GUI process has no `gh` on its `PATH`. */
  ghPath: string
  /** Everything the script says lands here — it is the only witness left. */
  logPath: string
}

/**
 * Starts the installer detached: it outlives the app it is about to replace,
 * waits for it to exit, swaps the bundle and starts it again.
 */
export function runInstaller(scriptPath: string, options: InstallerOptions): void {
  const log = openSync(options.logPath, 'a')
  const child = spawn('/bin/bash', [scriptPath, '--relaunch'], {
    detached: true,
    stdio: ['ignore', log, log],
    env: { ...process.env, UNIBOX_GH_PATH: options.ghPath }
  })
  child.unref()
}
