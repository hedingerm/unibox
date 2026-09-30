/**
 * Starts the built app against the demo profile, verifies that the renderer
 * mounted, and writes a screenshot. Run `bun run build && bun run seed:demo` first.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'

const userData = process.env.UNIBOX_SMOKE_PROFILE ?? '.tmp/demo'
const screenshot = process.env.UNIBOX_SMOKE_SCREENSHOT ?? '.tmp/unibox.png'
if (!existsSync(userData)) {
  console.error(`Kein Profil unter ${userData} — zuerst "bun run seed:demo" ausführen.`)
  process.exit(1)
}
mkdirSync('.tmp', { recursive: true })

const child = spawn('./node_modules/.bin/electron', ['.', `--user-data-dir=${userData}`], {
  env: {
    ...process.env,
    UNIBOX_SMOKE: '1',
    UNIBOX_SMOKE_SCREENSHOT: screenshot,
    ...(process.argv[2] ? { UNIBOX_SMOKE_SCRIPT: process.argv[2] } : {})
  },
  stdio: 'inherit'
})

const timeout = setTimeout(() => {
  child.kill('SIGKILL')
  console.error('Zeitüberschreitung beim Smoke-Test.')
  process.exit(1)
}, 60_000)

child.on('exit', (code) => {
  clearTimeout(timeout)
  console.info(code === 0 ? `Screenshot: ${screenshot}` : 'Smoke-Test fehlgeschlagen.')
  process.exit(code ?? 1)
})
