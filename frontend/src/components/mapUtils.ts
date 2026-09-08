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

/** Parse #rgb or #rrggbb into components. Returns null for anything else, so a
 * malformed colour degrades to a flat marker rather than throwing. */
function parseHex(hex: string): { r: number; g: number; b: number } | null {
  const h = hex.trim().replace(/^#/, "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return null;
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16),
  };
}

const toHex = (n: number) =>
  Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");

/** Scale a colour's brightness. `factor` below 1 darkens, above 1 lightens. */
function shade(hex: string, factor: number): string {
  const c = parseHex(hex);
  if (!c) return hex;
  if (factor <= 1) {
    return `#${toHex(c.r * factor)}${toHex(c.g * factor)}${toHex(c.b * factor)}`;
  }
  // Lighten toward white rather than multiplying past 255, which would just
  // clip channels and shift the hue.
  const t = factor - 1;
  return `#${toHex(c.r + (255 - c.r) * t)}${toHex(c.g + (255 - c.g) * t)}${toHex(
    c.b + (255 - c.b) * t,
  )}`;
}

// The arrowhead, as a sharp polygon. Corners are rounded by stroking the same
// path with a round linejoin instead of hand-authoring bezier curves — the
// stroke width becomes the corner radius, which is easier to tune and keeps
// the outline, the light facet and the dark facet perfectly concentric.
const ARROW_PATH = "M32 12 L55 51 L32 41 L9 51 Z";
const CORNER_RADIUS = 7;
const OUTLINE_WIDTH = CORNER_RADIUS + 5;

/**
 * A vehicle marker: a rounded arrowhead, split down its axis into a lit and a
 * shaded facet of the route colour, with a dark outline.
 *
 * The two-tone facets are what make it readable. A single flat fill of the
 * route colour disappears against a route line of the same colour — which is
 * exactly where buses sit — and gives no cue about which way the arrow points
 * once it is small. Lighting one side reads as a three-dimensional object and
 * survives being 28px on a grey basemap.
 *
 * The split is applied in the icon's own unrotated frame, so the highlight
 * stays on the same side of the arrow as it turns, rather than appearing to be
 * lit from a fixed direction on screen.
 */
export function makeVehicleChevronIcon(rotationDeg: number, color: string | null | undefined) {
  const safeColor = color || "#ffffff";
  const lit = shade(safeColor, 1.28);
  const shaded = shade(safeColor, 0.62);
  const size = 30;
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
        --vehicle-color: ${safeColor};
      ">
        <svg width="${size}" height="${size}" viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
          <defs>
            <!-- Half-width clips split the arrow along its axis. The geometry
                 is identical for every marker, so sharing these ids across
                 instances is harmless. -->
            <clipPath id="shuttlArrowLit">
              <rect x="0" y="0" width="32" height="64" />
            </clipPath>
            <clipPath id="shuttlArrowShade">
              <rect x="32" y="0" width="32" height="64" />
            </clipPath>
          </defs>

          <!-- Outline first, widest, so the facets sit inside it. -->
          <path d="${ARROW_PATH}" fill="none" stroke="#0b0b0c"
                stroke-width="${OUTLINE_WIDTH}" stroke-linejoin="round"
                stroke-linecap="round" />

          <g clip-path="url(#shuttlArrowLit)">
            <path d="${ARROW_PATH}" fill="${lit}" stroke="${lit}"
                  stroke-width="${CORNER_RADIUS}" stroke-linejoin="round"
                  stroke-linecap="round" />
          </g>
          <g clip-path="url(#shuttlArrowShade)">
            <path d="${ARROW_PATH}" fill="${shaded}" stroke="${shaded}"
                  stroke-width="${CORNER_RADIUS}" stroke-linejoin="round"
                  stroke-linecap="round" />
          </g>
        </svg>
      </div>
    `,
  });
}

// A top-down bus, pointing up, in the same 64-unit frame as the arrow.
//
// Deliberately simplified from a detailed illustration: at 30px on a phone,
// wheels, mirrors, gradients and a drop shadow collapse into noise. What
// survives at that size is the silhouette, the windscreen that says which end
// is the front, and the colour. Everything else is cost.
const BUS_BODY = "M23 9 h18 a7 7 0 0 1 7 7 v32 a7 7 0 0 1 -7 7 h-18 a7 7 0 0 1 -7 -7 v-32 a7 7 0 0 1 7 -7 z";
const BUS_WINDSCREEN = "M24 13 h16 a4 4 0 0 1 4 4 v4 h-24 v-4 a4 4 0 0 1 4 -4 z";
const BUS_REAR = "M20 47 h24 v4 a4 4 0 0 1 -4 4 h-16 a4 4 0 0 1 -4 -4 z";

/**
 * A bus-shaped vehicle marker, route-coloured with the same lit/shaded split
 * as the arrow.
 *
 * Reads as a vehicle rather than a cursor, at the cost of heading legibility:
 * an arrow's direction is unmistakable at a glance, a rectangle's is not, and
 * the windscreen is the only cue about which way it faces. Selected with
 * VITE_VEHICLE_ICON=bus.
 */
export function makeVehicleBusIcon(rotationDeg: number, color: string | null | undefined) {
  const safeColor = color || "#ffffff";
  const lit = shade(safeColor, 1.28);
  const shaded = shade(safeColor, 0.62);
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
        --vehicle-color: ${safeColor};
      ">
        <svg width="${size}" height="${size}" viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
          <defs>
            <clipPath id="shuttlBusLit"><rect x="0" y="0" width="32" height="64" /></clipPath>
            <clipPath id="shuttlBusShade"><rect x="32" y="0" width="32" height="64" /></clipPath>
          </defs>

          <path d="${BUS_BODY}" fill="none" stroke="#0b0b0c" stroke-width="6"
                stroke-linejoin="round" />

          <g clip-path="url(#shuttlBusLit)">
            <path d="${BUS_BODY}" fill="${lit}" />
          </g>
          <g clip-path="url(#shuttlBusShade)">
            <path d="${BUS_BODY}" fill="${shaded}" />
          </g>

          <path d="${BUS_WINDSCREEN}" fill="#e8f6ff" opacity="0.92" />
          <path d="${BUS_REAR}" fill="#0b0b0c" opacity="0.45" />
        </svg>
      </div>
    `,
  });
}

/** The marker builder in use. Arrow by default: heading is the single most
 * useful thing a moving vehicle can convey on a map, and an arrow says it
 * unambiguously at any size. */
export function makeVehicleIcon(rotationDeg: number, color: string | null | undefined) {
  const style = import.meta.env.VITE_VEHICLE_ICON;
  return style === "bus"
    ? makeVehicleBusIcon(rotationDeg, color)
    : makeVehicleChevronIcon(rotationDeg, color);
}
