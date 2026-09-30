import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface ClaudeRequest {
  systemPrompt: string
  prompt: string
  model: string
}

/** Runs one headless Claude Code turn and returns its final text. */
export type ClaudeRunner = (request: ClaudeRequest) => Promise<string>

export class ClaudeUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ClaudeUnavailableError'
  }
}

/**
 * Places the CLI installs itself into. An Electron app launched from Finder
 * inherits a bare `PATH`, so `which claude` alone would find nothing — the
 * usual locations are probed explicitly.
 */
function candidatePaths(): string[] {
  const home = homedir()
  return [
    join(home, '.local', 'bin', 'claude'),
    join(home, '.claude', 'local', 'claude'),
    join(home, 'bin', 'claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    '/usr/bin/claude'
  ]
}

export function resolveClaudeBinary(explicit?: string | null): string | null {
  if (explicit) return existsSync(explicit) ? explicit : null
  const fromEnv = process.env.UNIBOX_CLAUDE_PATH
  if (fromEnv && existsSync(fromEnv)) return fromEnv
  for (const candidate of candidatePaths()) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

interface ClaudeResultEnvelope {
  is_error?: boolean
  subtype?: string
  result?: string
  error?: string
}

/** Maximum bytes of CLI output accepted; classification answers are small. */
const MAX_OUTPUT = 8 * 1024 * 1024

export interface ClaudeRunnerOptions {
  /**
   * Explicit binary path, or a getter for it — the settings can change while
   * the app runs, so it is read per call rather than captured at startup.
   * `null` means auto-detect.
   */
  binaryPath?: string | null | (() => string | null)
  /** Empty directory the CLI runs in, so no project context is picked up. */
  cwd: string
  timeoutMs?: number
}

/**
 * Drives the locally installed Claude Code CLI in print mode. Nothing but the
 * prompt goes in: no tools, no MCP servers, no user or project settings — the
 * classification must not be able to touch the machine, and the mail text it
 * reads is untrusted input.
 */
export function createClaudeRunner(options: ClaudeRunnerOptions): ClaudeRunner {
  const timeout = options.timeoutMs ?? 10 * 60_000
  return async ({ systemPrompt, prompt, model }) => {
    const configured =
      typeof options.binaryPath === 'function' ? options.binaryPath() : options.binaryPath
    const binary = resolveClaudeBinary(configured)
    if (!binary) {
      throw new ClaudeUnavailableError(
        'Claude Code wurde nicht gefunden. Pfad in den Einstellungen hinterlegen.'
      )
    }
    const args = [
      '-p',
      '--output-format',
      'json',
      '--model',
      model,
      '--system-prompt',
      systemPrompt,
      '--allowedTools',
      '',
      '--strict-mcp-config',
      '--setting-sources',
      '',
      '--max-turns',
      '1'
    ]
    const stdout = await new Promise<string>((resolve, reject) => {
      const child = execFile(
        binary,
        args,
        { cwd: options.cwd, timeout, maxBuffer: MAX_OUTPUT, env: process.env },
        (error, out, err) => {
          if (error) {
            const detail = (err || out || error.message).toString().trim().slice(0, 500)
            reject(new Error(`Claude Code fehlgeschlagen: ${detail}`))
            return
          }
          resolve(out)
        }
      )
      child.stdin?.end(prompt)
    })

    let envelope: ClaudeResultEnvelope
    try {
      envelope = JSON.parse(stdout) as ClaudeResultEnvelope
    } catch {
      throw new Error('Claude Code lieferte keine verwertbare Antwort.')
    }
    if (envelope.is_error || typeof envelope.result !== 'string') {
      throw new Error(`Claude Code meldet einen Fehler: ${envelope.error ?? envelope.subtype ?? ''}`)
    }
    return envelope.result
  }
}
