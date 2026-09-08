// src/config.ts
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL

if (!API_BASE_URL) {
    // eslint-disable-next-line no-console
    console.warn(
        'VITE_API_BASE_URL is not set. Frontend will not be able to reach the backend API.'
    )
}

// ---------------------------------------------------------------------------
// Basemap tiles
//
// CARTO used to serve its basemaps to anyone. It now stamps "API KEY REQUIRED"
// diagonally across every tile it returns — on all styles, light and dark —
// so the previous hardcoded CARTO URL renders a defaced map rather than
// failing outright, which is why it looked like a broken map instead of a
// blocked one.
//
// The default below is Esri's Dark Gray Canvas: keyless, unwatermarked, and
// close to the dark aesthetic the app is designed around. Override it to use a
// keyed provider (CARTO or Stadia both have free tiers) by setting
// VITE_MAP_TILE_URL and VITE_MAP_ATTRIBUTION, with the key embedded in the URL.
//
// Note the axis order if you change providers: Esri's ArcGIS endpoint takes
// {z}/{y}/{x}, while OSM-lineage providers take {z}/{x}/{y}.
// ---------------------------------------------------------------------------

const MAP_TILE_URL =
    import.meta.env.VITE_MAP_TILE_URL ??
    'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}'

const MAP_ATTRIBUTION =
    import.meta.env.VITE_MAP_ATTRIBUTION ??
    '&copy; <a href="https://www.esri.com/">Esri</a>, &copy; <a href="http://openstreetmap.org">OpenStreetMap</a> contributors'

// Esri's dark canvas has no tiles past z19; going further shows blank squares.
const MAP_MAX_ZOOM = Number(import.meta.env.VITE_MAP_MAX_ZOOM ?? 19)

// Only OSM-lineage URLs use {s}; passing subdomains to a provider that does not
// expect them produces broken requests.
const MAP_SUBDOMAINS = import.meta.env.VITE_MAP_SUBDOMAINS ?? ''

export { API_BASE_URL, MAP_TILE_URL, MAP_ATTRIBUTION, MAP_MAX_ZOOM, MAP_SUBDOMAINS }
