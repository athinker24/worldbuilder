import './assets/main.css'
import '@fontsource/cinzel'
import '@fontsource/im-fell-english'
import '@fontsource/medievalsharp'
import '@fontsource/uncial-antiqua'

import { StrictMode } from 'react'
import { api } from './api'
import { createRoot } from 'react-dom/client'
import App from './App'
import ErrorBoundary from './ErrorBoundary'
import { flushEvents, logCrash } from './log'

// Everything the renderer throws outside React's tree. ErrorBoundary only sees errors during
// render — an event handler, a timer or a rejected promise never reaches it, and those are
// exactly the faults that leave the app looking fine while doing nothing.
const ctx = (): Record<string, unknown> => ({
  url: location.hash || '/',
  view: document.querySelector('.page-title')?.textContent?.slice(0, 40),
  zoom: document.querySelector('.zoom-pct')?.textContent
})
// One fault can fire every frame — a throw inside the map's animation loop repeats 144 times a
// second. Unguarded that is 144 identical records a second, which rotates the log past the useful
// part and buries the ONE record that explains anything. Identical reports inside the window are
// dropped; a different message always gets through, and the same message gets through again once
// the window has passed, so a fault that is still happening stays visible.
const REPEAT_MS = 5000
let lastKey = ''
let lastAt = 0
const report = (where: string, message: string, stack: string): void => {
  const key = where + ' ' + message
  const now = Date.now()
  if (key === lastKey && now - lastAt < REPEAT_MS) return
  lastKey = key
  lastAt = now
  logCrash(where, message, stack, ctx())
}

window.addEventListener('error', (e) =>
  report('window.onerror', e.message, e.error?.stack ?? `${e.filename}:${e.lineno}`)
)
window.addEventListener('unhandledrejection', (e) => {
  const r = e.reason as { message?: string; stack?: string }
  report('unhandledRejection', r?.message ?? String(e.reason), r?.stack ?? '')
})

// What the session header cannot know from main: which graphics backend the map actually got, and
// the screen it is being drawn on. Both are the first thing to check when a report is about the
// map looking wrong rather than behaving wrong.
// Guarded, and the reason is the LINE ORDER rather than the call. This runs at module scope,
// above createRoot — so a throw here means the module never finishes evaluating and React never
// mounts at all: a blank window with no ErrorBoundary in it, which is the one thing that boundary
// exists to make impossible. `window.api` is undefined whenever the preload threw, which it does
// on purpose when context isolation is lost (preload/index.ts), and `inv` reaches straight into
// it. A session-info line is the least important thing in this file; mounting is the most.
try {
  void api.logSessionInfo({
    renderer: (() => {
      try {
        const gl = document.createElement('canvas').getContext('webgl2')
        const info = gl?.getExtension('WEBGL_debug_renderer_info')
        return info ? String(gl?.getParameter(info.UNMASKED_RENDERER_WEBGL)).slice(0, 80) : 'webgl2'
      } catch {
        return 'unknown'
      }
    })(),
    screen: `${screen.width}x${screen.height}`,
    dpr: window.devicePixelRatio
  })
} catch {
  /* no bridge — the app still has to mount so the boundary can offer a way out */
}
// The batch queue is held in memory for half a second; a close in that window would drop the last
// few events, which are the ones that say how the session ended.
window.addEventListener('beforeunload', flushEvents)

// TRIAL — the Agentation annotation toolbar (try/agentation branch). Click a thing in the app,
// leave a note, and it reaches this agent through the MCP server on :4747.
//
// Mounted in its OWN root, outside the app's tree: it is a development tool and must not be able
// to affect App's rendering, and a second root is the cheapest way to say that. Dynamically
// imported inside `import.meta.env.DEV` so the whole thing — package included — is dead code the
// bundler drops from a packaged build, which is also why it is a devDependency.
if (import.meta.env.DEV)
  void import('agentation')
    .then(({ Agentation }) => {
      const host = document.createElement('div')
      document.body.appendChild(host)
      createRoot(host).render(<Agentation endpoint="http://localhost:4747" />)
    })
    .catch((err) => console.warn('agentation not loaded:', err))

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* If a corrupt/hostile .world crashes the render, never strand a blank screen — see ErrorBoundary */}
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>
)
