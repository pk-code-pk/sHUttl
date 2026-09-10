import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Analytics } from '@vercel/analytics/react'
// Leaflet first: its stylesheet sets .leaflet-container { background: #ddd },
// and imported after ours it won on cascade order — so every uncovered patch
// of map flashed light grey while tiles loaded.
import 'leaflet/dist/leaflet.css'
import './index.css'
import App from './App.tsx'
import { preloadCampusTiles } from './lib/preloadTiles'

// Warm the basemap before the map can need it. See lib/preloadTiles.
preloadCampusTiles()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
    <Analytics />
  </StrictMode>,
)
