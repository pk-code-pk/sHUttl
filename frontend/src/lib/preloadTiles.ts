/**
 * Preloads the whole campus basemap.
 *
 * Every other fix for the map going blank treated a symptom — keeping more
 * tiles alive, not fading them in, making whatever shows through dark rather
 * than light. They all helped and none of them removed the cause, which is
 * that the map sometimes needs a tile it does not have yet and has to wait for
 * the network.
 *
 * That is avoidable here in a way it would not be for a city-wide map: the
 * whole campus at every zoom level the app allows is 79 tiles, about 0.7 MB.
 * Fetching all of them up front puts them in the browser's HTTP cache, so
 * Leaflet's own requests are served locally and there is nothing to wait for.
 *
 * Deliberately fire-and-forget: nothing awaits this, failures are ignored, and
 * it runs after first paint at low concurrency so it never competes with the
 * tiles actually on screen or with the API calls that populate the panel.
 */

import { MAP_MAX_NATIVE_ZOOM, MAP_SUBDOMAINS, MAP_TILE_URL } from '@/config';

// The stops span roughly 42.363–42.382 N and -71.128 – -71.114 W. This is that
// with enough margin to cover a pan to the edge of campus in any direction.
const BOUNDS = { south: 42.356, west: -71.135, north: 42.389, east: -71.105 };

// Below z12 the whole campus is one tile and nobody zooms out that far in
// practice.
const MIN_ZOOM = 12;

// Deepest level to warm. Tile count quadruples per level: the campus box is
// ~80 tiles through z16 and ~660 at z18 alone, and retina tiles are four
// times the bytes. z16 is the working zoom for the overview and every trip
// fit (MapController caps fits there), so it is where a blank tile would
// actually be seen. Past it the provider's CDN serves on demand and
// keepBuffer holds what has been fetched.
const PRELOAD_MAX_ZOOM = Math.min(16, MAP_MAX_NATIVE_ZOOM);

// Enough to be quick without saturating the connection the visible tiles and
// the API are sharing.
const CONCURRENCY = 6;

function tileRange(zoom: number) {
    const n = 2 ** zoom;
    const lonToX = (lon: number) => Math.floor(((lon + 180) / 360) * n);
    const latToY = (lat: number) => {
        const r = (lat * Math.PI) / 180;
        return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n);
    };
    return {
        x0: lonToX(BOUNDS.west),
        x1: lonToX(BOUNDS.east),
        // Latitude runs the other way in tile space.
        y0: latToY(BOUNDS.north),
        y1: latToY(BOUNDS.south),
    };
}

// A preload only helps if it produces the exact URL Leaflet will later ask
// for; a near miss is a cache miss. Two substitutions have to match Leaflet's:
//
//   {r} is '@2x' on a retina screen — Leaflet decides by devicePixelRatio, so
//   preloading the 1x tile on a phone warms a file the map never requests.
//
//   {s} is chosen per tile as subdomains[(x + y) % n], not a fixed letter.
//   With 'abcd', a fixed 'a' warmed the right host for one tile in four.
const RETINA_SUFFIX =
    typeof window !== 'undefined' && window.devicePixelRatio > 1 ? '@2x' : '';

function subdomainFor(x: number, y: number): string {
    if (!MAP_SUBDOMAINS) return '';
    return MAP_SUBDOMAINS[Math.abs(x + y) % MAP_SUBDOMAINS.length];
}

/** Fill the URL template. Providers differ in axis order, so both {x}/{y} and
 * the ArcGIS {z}/{y}/{x} form work from the same template. */
function tileUrl(z: number, x: number, y: number): string {
    return MAP_TILE_URL
        .replace('{s}', subdomainFor(x, y))
        .replace('{z}', String(z))
        .replace('{x}', String(x))
        .replace('{y}', String(y))
        .replace('{r}', RETINA_SUFFIX);
}

function campusTileUrls(): string[] {
    const urls: string[] = [];
    for (let z = MIN_ZOOM; z <= PRELOAD_MAX_ZOOM; z++) {
        const { x0, x1, y0, y1 } = tileRange(z);
        for (let x = x0; x <= x1; x++) {
            for (let y = y0; y <= y1; y++) urls.push(tileUrl(z, x, y));
        }
    }
    return urls;
}

export function preloadCampusTiles(): void {
    if (typeof window === 'undefined') return;

    const start = () => {
        const urls = campusTileUrls();
        let next = 0;

        const loadOne = () => {
            if (next >= urls.length) return;
            const url = urls[next++];
            const img = new Image();
            // Same CORS mode the tile layer uses, so this warms the entry
            // Leaflet will actually ask for rather than a separate one.
            img.crossOrigin = 'anonymous';
            // A failed preload is not worth reporting: the tile layer will
            // request it again and handle the failure itself.
            img.onload = loadOne;
            img.onerror = loadOne;
            img.src = url;
        };

        for (let i = 0; i < CONCURRENCY; i++) loadOne();
    };

    // After first paint, and idle if the browser will tell us.
    const idle = (window as Window & {
        requestIdleCallback?: (cb: () => void) => number;
    }).requestIdleCallback;

    const defer = () => (idle ? idle(start) : window.setTimeout(start, 1200));

    if (document.readyState === 'complete') defer();
    else window.addEventListener('load', defer, { once: true });
}
