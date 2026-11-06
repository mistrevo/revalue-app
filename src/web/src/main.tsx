import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { pruneExpiredDrafts } from './lib/drafts'
import { startPalette } from './lib/palette'

startPalette()
// 期限を過ぎた書きかけを、開いたときに端末から捨てる（discover-11（書きかけを残す））
pruneExpiredDrafts()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
