import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { UniboxProvider } from './state'
import { applyTheme, storedTheme } from './lib/theme'
// Bundled, not fetched: the app has to look the same offline.
import '@fontsource-variable/geist'
import '@fontsource-variable/geist-mono'
import './styles.css'

if (import.meta.env.DEV) void import('react-grab')

/**
 * Chromium's default for a file dropped on a page is to navigate to it — the
 * app would be replaced by the file, taking the open draft with it. The
 * composer's own handler runs first and keeps what it wants; this only refuses
 * the fallback, for drops that land anywhere else.
 */
for (const name of ['dragover', 'drop'] as const) {
  window.addEventListener(name, (event) => event.preventDefault())
}

// The last known theme goes on before the first paint; the App re-applies the
// stored setting once it has loaded.
applyTheme(storedTheme())

const container = document.getElementById('root')
if (!container) throw new Error('Root-Element fehlt')

createRoot(container).render(
  <StrictMode>
    <UniboxProvider>
      <App />
    </UniboxProvider>
  </StrictMode>
)
