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
// Default is CARTO Dark Matter, keyed. It was chosen over the keyless
// alternatives for two reasons that CSS cannot fake:
//
//   * Native tiles to z20. Esri's Dark Gray Canvas — the previous default —
//     stops at z16 and serves a light placeholder past it, so the app had to
//     cap requests at 16 and upscale, which is a blurry basemap under crisp
//     stops from z17 on.
//   * @2x retina tiles via {r}. On a 3x phone a 256px tile stretched to ~768
//     device pixels is most of what "low quality" meant; Esri has no @2x.
//
// It is also natively dark, so the per-tile brightness filter that darkened
// Esri is not applied when this provider is in use (see MAP_TILES_NEED_DIM).
//
// CARTO's basemaps used to be served to anyone and now stamp "API KEY
// REQUIRED" across every tile without one, so a key is mandatory here. With no
// key set the app falls back to Esri rather than rendering a defaced map: a
// fresh clone still works, just at the old quality, and the console says why.
//
// Axis order if you change providers: OSM-lineage URLs (CARTO included) take
// {z}/{x}/{y}; Esri's ArcGIS endpoint takes {z}/{y}/{x}.
// ---------------------------------------------------------------------------

const MAP_API_KEY = import.meta.env.VITE_MAP_API_KEY ?? ''

const ESRI_TILE_URL =
    'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}'
const ESRI_ATTRIBUTION =
    '&copy; <a href="https://www.esri.com/">Esri</a>, &copy; <a href="http://openstreetmap.org">OpenStreetMap</a> contributors'

const CARTO_TILE_URL =
    // `key`, not `api_key`. Tested against the CDN from a browser: every other
    // spelling — api_key, apikey, access_token — returns the same bytes as no
    // key at all, i.e. the "API KEY REQUIRED" watermarked tile. Only `key`
    // returns the clean one. The watermark text itself points at a docs page
    // that says api_key, which is how this was wrong the first time.
    `https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png?key=${MAP_API_KEY}`
const CARTO_ATTRIBUTION =
    '&copy; <a href="https://carto.com/attributions">CARTO</a>, &copy; <a href="http://openstreetmap.org">OpenStreetMap</a> contributors'

const usingCarto = Boolean(MAP_API_KEY) && !import.meta.env.VITE_MAP_TILE_URL

if (!MAP_API_KEY && !import.meta.env.VITE_MAP_TILE_URL) {
    // eslint-disable-next-line no-console
    console.warn(
        'VITE_MAP_API_KEY is not set. Falling back to the Esri basemap: no tiles past z16 and no retina tiles.'
    )
}

const MAP_TILE_URL =
    import.meta.env.VITE_MAP_TILE_URL ?? (usingCarto ? CARTO_TILE_URL : ESRI_TILE_URL)

const MAP_ATTRIBUTION =
    import.meta.env.VITE_MAP_ATTRIBUTION ?? (usingCarto ? CARTO_ATTRIBUTION : ESRI_ATTRIBUTION)

// The deepest zoom the provider has real tiles for. Leaflet stops requesting
// past this and upscales; the Esri figure is what forced that in the first
// place, and why the map blurred from z17.
const MAP_MAX_NATIVE_ZOOM = Number(
    import.meta.env.VITE_MAP_MAX_NATIVE_ZOOM ?? (usingCarto ? 20 : 16)
)

// How far the user may zoom. On CARTO this is building scale with native
// tiles the whole way. On Esri it is two levels of upscaling past native —
// enough to separate stop pairs ~30 m apart (Barry's Corner northbound and
// southbound are unclickable at z16) while stopping before the blur gets
// embarrassing.
// 18, not the provider's 20: every zoomable level is preloaded so no tile
// ever loads on screen, and z19 alone is ~2,600 tiles for the campus box.
const MAP_MAX_ZOOM = Number(import.meta.env.VITE_MAP_MAX_ZOOM ?? 18)

// Only OSM-lineage URLs use {s}; passing subdomains to a provider that does
// not expect them produces broken requests.
const MAP_SUBDOMAINS = import.meta.env.VITE_MAP_SUBDOMAINS ?? (usingCarto ? 'abcd' : '')

// Whether the tiles need darkening in CSS. CARTO's are already dark; Esri's
// Dark Gray Canvas is a mid grey that sits too light under crimson chrome.
const MAP_TILES_NEED_DIM = !usingCarto

export {
    API_BASE_URL,
    MAP_TILE_URL,
    MAP_ATTRIBUTION,
    MAP_MAX_ZOOM,
    MAP_MAX_NATIVE_ZOOM,
    MAP_SUBDOMAINS,
    MAP_TILES_NEED_DIM,
}
