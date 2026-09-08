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

/** Stable short hash of a colour, for building unique SVG element ids.
 * Gradients are referenced by document id, so two markers sharing an id would
 * both paint with whichever definition the browser saw first — every bus would
 * come out the same colour. */
function colorKey(hex: string): string {
  let h = 0;
  for (let i = 0; i < hex.length; i++) h = (h * 31 + hex.charCodeAt(i)) & 0xffff;
  return h.toString(36);
}

// A top-down car, nose up, in the same 64-unit frame as the arrow.
//
// Traced to match a top-down vehicle illustration: rounded nose, widest at the
// cabin, tapered tail, with wheels standing slightly proud of the body. What
// makes it read as a vehicle at map size is the glass — a pale windscreen and
// rear window either side of a near-black roof — because that is the only cue
// that separates front from back.
// Proportions matter more than detail here. A first pass at 24 units wide by
// 55 long read as a phone rather than a car at map size; a top-down hatchback
// is closer to 1.7:1. The flanks are straight rather than curved, because a
// fully curved outline reads as a bean, and the wheels stand proud of them.
const CAR_BODY =
  "M32 6 C36.5 6 40 7.6 42 11 C44 14.5 45 20 45 26 L45 40 " +
  "C45 47 44 52 42 55 C40 57.6 36.5 59 32 59 " +
  "C27.5 59 24 57.6 22 55 C20 52 19 47 19 40 L19 26 " +
  "C19 20 20 14.5 22 11 C24 7.6 27.5 6 32 6 Z";
// Pale windscreen, dark cabin, smaller rear glass. This contrast is the only
// thing that says which end is the front once the icon is small, which is why
// the headlights and tail lights that were here came out — at 36px they were
// two pixels of noise each, invisible on a red car and confusing on a yellow.
const CAR_WINDSCREEN = "M25.5 17 L38.5 17 C40 17 40.6 18 41 20 L41.8 27 L22.2 27 L23 20 C23.4 18 24 17 25.5 17 Z";
const CAR_REAR_GLASS = "M24 45.5 L40 45.5 L38.5 53 L25.5 53 Z";

/**
 * A car-shaped vehicle marker in the route colour.
 *
 * The body carries a gradient across its axis rather than a hard two-tone
 * split: the split read as two flat halves at this size, where a gradient
 * reads as a curved surface. Gradient ids are keyed by colour so markers on
 * different routes cannot inherit each other's paint.
 */
export function makeVehicleCarIcon(rotationDeg: number, color: string | null | undefined) {
  const safeColor = color || "#ffffff";
  const lit = shade(safeColor, 1.32);
  const mid = safeColor;
  const shaded = shade(safeColor, 0.55);
  const id = `shuttlCar${colorKey(safeColor)}`;
  // Larger than the arrow: a car needs the pixels to stay legible.
  const size = 40;
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
            <linearGradient id="${id}" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0" stop-color="${lit}" />
              <stop offset="0.45" stop-color="${mid}" />
              <stop offset="1" stop-color="${shaded}" />
            </linearGradient>
            <clipPath id="${id}clip"><path d="${CAR_BODY}" /></clipPath>
          </defs>

          <!-- Wheels sit under the body so only their outer edge shows. -->
          <g fill="#101012">
            <rect x="14.8" y="17" width="5.4" height="10" rx="2.6" />
            <rect x="43.8" y="17" width="5.4" height="10" rx="2.6" />
            <rect x="14.8" y="40" width="5.4" height="10" rx="2.6" />
            <rect x="43.8" y="40" width="5.4" height="10" rx="2.6" />
          </g>

          <path d="${CAR_BODY}" fill="none" stroke="#0b0b0c" stroke-width="3.6" />
          <path d="${CAR_BODY}" fill="url(#${id})" />

          <g clip-path="url(#${id}clip)">
            <rect x="23" y="28.5" width="18" height="15.5" rx="2.5" fill="#17181c" />
            <path d="${CAR_WINDSCREEN}" fill="#cfe7f5" />
            <path d="${CAR_REAR_GLASS}" fill="#9fbccd" />
            <!-- Headlights and tail lights: two pixels each at final size, but
                 they are what stop the shape reading as symmetrical. -->
            <!-- Roof ridge: a single highlight along the axis, which survives
                 downscaling where small features do not. -->
            <path d="M32 29.5 L32 43" stroke="#ffffff" stroke-width="1.2"
                  opacity="0.16" />
          </g>
        </svg>
      </div>
    `,
  });
}

/** The marker builder in use. Cars by default; VITE_VEHICLE_ICON=arrow gives
 * the arrowhead, which conveys heading more clearly at small sizes. */
export function makeVehicleIcon(rotationDeg: number, color: string | null | undefined) {
  const style = import.meta.env.VITE_VEHICLE_ICON;
  return style === "arrow"
    ? makeVehicleChevronIcon(rotationDeg, color)
    : makeVehicleCarIcon(rotationDeg, color);
}
