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
    {/* Bozuk/düşman bir .dunya render'ı patlatırsa beyaz ekranda kalınmasın — bkz. ErrorBoundary */}
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>
)
