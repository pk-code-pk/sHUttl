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

// Esri caches this style only to z16. Past that the endpoint still answers
// 200, but with a light "Map data not yet available" placeholder tile — which
// is why over-zooming turned the dark map into grey squares rather than simply
// failing. MAX_NATIVE_ZOOM tells Leaflet to stop requesting new tiles at 16
// and upscale the ones it has, so deeper zoom is blurry basemap with crisp
// stops, routes and vehicles on top instead of broken imagery.
const MAP_MAX_NATIVE_ZOOM = Number(import.meta.env.VITE_MAP_MAX_NATIVE_ZOOM ?? 16)

// Two levels of upscaling past native. Enough to separate stop pairs that sit
// ~30 m apart (Barry's Corner northbound/southbound are unclickable at z16),
// while stopping before the blur gets embarrassing.
const MAP_MAX_ZOOM = Number(import.meta.env.VITE_MAP_MAX_ZOOM ?? 18)

// Only OSM-lineage URLs use {s}; passing subdomains to a provider that does not
// expect them produces broken requests.
const MAP_SUBDOMAINS = import.meta.env.VITE_MAP_SUBDOMAINS ?? ''

export {
    API_BASE_URL,
    MAP_TILE_URL,
    MAP_ATTRIBUTION,
    MAP_MAX_ZOOM,
    MAP_MAX_NATIVE_ZOOM,
    MAP_SUBDOMAINS,
}
