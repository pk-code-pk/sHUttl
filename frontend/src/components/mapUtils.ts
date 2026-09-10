import L from "leaflet";

export function bearingDeg(from: [number, number], to: [number, number]) {
  const [lat1, lon1] = from.map((x) => (x * Math.PI) / 180);
  const [lat2, lon2] = to.map((x) => (x * Math.PI) / 180);
  const dLon = lon2 - lon1;
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  const brng = (Math.atan2(y, x) * 180) / Math.PI;
  return (brng + 360) % 360;
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

/**
 * A vehicle marker: a solid arrow in its route's colour.
 *
 * Filled with the route colour, not outlined in it. An earlier version gave
 * every bus a white body with a coloured ring, on the theory that a shared
 * body would read as one fleet — it read as nine white darts instead, and the
 * thing that identifies a bus was reduced to a 2px edge. The grouped route
 * palette does that job properly: two amber buses are visibly going the same
 * way without making the marker do the work.
 *
 * The dark outline is load-bearing: a bus sits on a route line of its own
 * colour, so without it the arrow dissolves into the line it is travelling
 * along.
 *
 * Around the arrow, following its shape, sits a lit outline in the route
 * colour — the idea of the crimson ring on an expanded departure, animated,
 * and traced along the arrowhead rather than a circle around it. Three strokes
 * of the same path, drawn under the arrow so the dark outline stays crisp:
 * a wide, faint one that blurs into a glow; a dim full outline as the track;
 * and a bright dash that travels round the perimeter (stroke-dashoffset — the
 * path is ~140 units long, the dash 40). This is what makes a darker palette
 * workable: the outline supplies the eye-catch the fill no longer has to.
 * Motion lives in CSS (.vehicle-marker-sweep); only the colour is set here.
 */
// The arrowhead. Perimeter ≈ 140.4 units (two long edges of 46.96, two
// short of 23.26); the sweep's dash pattern is sized against that.
const ARROW = "M32 9 L53 51 L32 41 L11 51 Z";

export function makeVehicleIcon(rotationDeg: number, color: string | null | undefined) {
    const routeColor = color || "#93a3b5";
    const size = 32;
    const half = size / 2;

    return L.divIcon({
        className: "vehicle-marker",
        iconSize: [size, size],
        iconAnchor: [half, half],
        html: `
      <div class="vehicle-marker-inner" style="
        width:${size}px;height:${size}px;
        transform: rotate(${rotationDeg}deg);
        transform-origin: 50% 50%;
      ">
        <svg width="${size}" height="${size}" viewBox="-8 -8 80 80" overflow="visible"
             xmlns="http://www.w3.org/2000/svg" style="--route:${routeColor}">
          <path class="vehicle-marker-glow"  d="${ARROW}" />
          <path class="vehicle-marker-track" d="${ARROW}" />
          <path class="vehicle-marker-sweep" d="${ARROW}" />
          <path d="${ARROW}"
                fill="${routeColor}" stroke="#0b0f17" stroke-width="5"
                stroke-linejoin="round" paint-order="stroke" />
        </svg>
      </div>
    `,
    });
}
