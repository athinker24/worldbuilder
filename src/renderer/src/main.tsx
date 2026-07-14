import './assets/main.css'
import '@fontsource/cinzel'
import '@fontsource/im-fell-english'
import '@fontsource/medievalsharp'
import '@fontsource/uncial-antiqua'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
