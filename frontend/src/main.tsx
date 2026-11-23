import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Analytics } from '@vercel/analytics/react'
// Library stylesheet first so ours wins on cascade order for anything both
// define.
import 'maplibre-gl/dist/maplibre-gl.css'
import './index.css'
import App from './App.tsx'
import { markNativeApp } from '@/lib/nativeShell'
import { isNativeApp } from '@/lib/platform'

// Before the first render, so the app-only rules in index.css apply to the
// first frame rather than arriving a frame late.
markNativeApp()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
    {/* Website only. The component injects /_vercel/insights/script.js,
        resolved against the page's origin — which in the iOS app is
        capacitor://localhost, where there is no such file to load. */}
    {!isNativeApp() && <Analytics />}
  </StrictMode>,
)
