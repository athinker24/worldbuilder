import './assets/main.css'
import '@fontsource/cinzel'
import '@fontsource/im-fell-english'
import '@fontsource/medievalsharp'
import '@fontsource/uncial-antiqua'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import ErrorBoundary from './ErrorBoundary'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* If a corrupt/hostile .dunya crashes the render, never strand a blank screen — see ErrorBoundary */}
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>
)
