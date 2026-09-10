/** Initial bearing from one point to another, in degrees clockwise from north. */
export function bearingDeg(from: [number, number], to: [number, number]) {
    const [lat1, lon1] = from.map((d) => (d * Math.PI) / 180);
    const [lat2, lon2] = to.map((d) => (d * Math.PI) / 180);
    const dLon = lon2 - lon1;
    const y = Math.sin(dLon) * Math.cos(lat2);
    const x =
        Math.cos(lat1) * Math.sin(lat2) -
        Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
    const brng = Math.atan2(y, x);
    return ((brng * 180) / Math.PI + 360) % 360;
}

export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Text colour for a label sitting on a route-coloured fill.
 *
 * The palette runs from crimson to cream, and white text on a cream badge is
 * not text. Relative luminance (WCAG) picks near-black above ~0.45 and white
 * below; the threshold is set so the mid-tones — teal, olive, warm grey —
 * keep white, and only the genuinely light fills (cream, light teal, tan)
 * flip to dark. Returns white for anything unparseable. */
export function textOnRouteColor(color: string | null | undefined): string {
    const L = relativeLuminance(color);
    return L != null && L > 0.45 ? '#111111' : '#ffffff';
}

/** WCAG relative luminance of a #rrggbb colour, 0 (black) to 1 (white).
 * null for anything unparseable. */
export function relativeLuminance(color: string | null | undefined): number | null {
    if (!color) return null;
    const m = /^#?([0-9a-f]{6})$/i.exec(color.trim());
    if (!m) return null;
    const n = parseInt(m[1], 16);
    const lin = (c: number) => {
        const v = c / 255;
        return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
}

/** The vehicle arrowhead, in a 64-unit box. Drawn by ShuttleMarker. */
export const ARROW_PATH = 'M32 9 L53 51 L32 41 L11 51 Z';

/** Fallback when a route carries no colour: the app's grey, not a random hue. */
export const NEUTRAL_ROUTE_COLOR = '#93a3b5';

/** Axis-aligned bounds of a set of [lng, lat] points as [west, south, east,
 * north] — the order MapLibre wants — or null for an empty set. */
export function bboxOf(points: [number, number][]): [number, number, number, number] | null {
    if (points.length === 0) return null;
    let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
    for (const [lng, lat] of points) {
        if (lng < w) w = lng;
        if (lng > e) e = lng;
        if (lat < s) s = lat;
        if (lat > n) n = lat;
    }
    return [w, s, e, n];
}
