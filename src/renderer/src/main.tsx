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

// Everything the renderer throws outside React's tree. ErrorBoundary only sees errors during
// render — an event handler, a timer or a rejected promise never reaches it, and those are
// exactly the faults that leave the app looking fine while doing nothing.
const ctx = (): Record<string, unknown> => ({
  url: location.hash || '/',
  view: document.querySelector('.page-title')?.textContent?.slice(0, 40),
  zoom: document.querySelector('.zoom-pct')?.textContent
})
window.addEventListener('error', (e) =>
  api.logError('window.onerror', e.message, e.error?.stack ?? `${e.filename}:${e.lineno}`, ctx())
)
window.addEventListener('unhandledrejection', (e) => {
  const r = e.reason as { message?: string; stack?: string }
  api.logError('unhandledRejection', r?.message ?? String(e.reason), r?.stack ?? '', ctx())
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* If a corrupt/hostile .dunya crashes the render, never strand a blank screen — see ErrorBoundary */}
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>
)
