// src/config.ts
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL

if (!API_BASE_URL) {
    // eslint-disable-next-line no-console
    console.warn(
        'VITE_API_BASE_URL is not set. Frontend will not be able to reach the backend API.'
    )
}

// ---------------------------------------------------------------------------
// Basemap
//
// Vector styles rendered by MapLibre GL, not raster tiles. The raster map had
// three faults that no amount of tuning removed, because they are how a raster
// map zooms: it animates by scaling the previous zoom's bitmap and swapping in
// the next level's tiles (a hole until they arrive — measured at up to half the
// viewport for several frames, from cache), the route lines are an SVG that
// scales with that bitmap and snaps on redraw, and there is one tile download
// per zoom level per screen. A GL renderer draws every frame from vector data
// at the exact zoom: no levels to swap, lines at the width they are told, one
// vector tile covering z14 through z20.
//
// CARTO publishes the same two looks as GL styles, keyless. The raster
// endpoint needed an API key and watermarked without one; these do not.
// ---------------------------------------------------------------------------

const MAP_STYLE_DARK =
    import.meta.env.VITE_MAP_STYLE_DARK ??
    'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json'

const MAP_STYLE_LIGHT =
    import.meta.env.VITE_MAP_STYLE_LIGHT ??
    'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json'

// Building scale. Vector data is crisp at any zoom, so the ceiling is about
// usefulness, not tile availability: past 19 a stop is a dot on an empty block.
const MAP_MAX_ZOOM = Number(import.meta.env.VITE_MAP_MAX_ZOOM ?? 19)

// Below this the whole network is a few pixels and the surroundings are the
// point; nobody plans a shuttle trip from Providence.
const MAP_MIN_ZOOM = Number(import.meta.env.VITE_MAP_MIN_ZOOM ?? 11)

export {
    API_BASE_URL,
    MAP_STYLE_DARK,
    MAP_STYLE_LIGHT,
    MAP_MAX_ZOOM,
    MAP_MIN_ZOOM,
}
