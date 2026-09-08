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
// Simplified from a detailed illustration on purpose: at map size, wheels,
// mirrors, gradients and a drop shadow collapse into noise. Four features
// survive and carry the whole read — silhouette, a windscreen wide enough to
// mark the front, a roof panel that separates body from glass, and colour.
const BUS_BODY =
  "M24 8 h16 a6 6 0 0 1 6 6 v36 a6 6 0 0 1 -6 6 h-16 a6 6 0 0 1 -6 -6 v-36 a6 6 0 0 1 6 -6 z";
// Trapezoid, wider at the base: reads as a raked windscreen rather than a
// second roof panel, which is what tells you which end is the front.
const BUS_WINDSCREEN = "M26 11 h12 l4 8 h-20 z";
const BUS_ROOF = "M22 22 h20 v22 h-20 z";
const BUS_ROOF_RIBS = "M22 28 h20 M22 34 h20 M22 40 h20";
const BUS_REAR = "M22 47 h20 v5 a4 4 0 0 1 -4 4 h-12 a4 4 0 0 1 -4 -4 z";

/**
 * A bus-shaped vehicle marker, route-coloured, with the same lit and shaded
 * facets as the arrow so a bus and its route line are obviously related.
 *
 * Heading is the weak point of any rectangle: the windscreen and the roof
 * ribs are the only cues, where an arrow's direction is unmistakable. Slightly
 * larger than the arrow to compensate.
 */
export function makeVehicleBusIcon(rotationDeg: number, color: string | null | undefined) {
  const safeColor = color || "#ffffff";
  const lit = shade(safeColor, 1.3);
  const shaded = shade(safeColor, 0.58);
  const roof = shade(safeColor, 0.85);
  const size = 34;
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
            <!-- Everything inside the body is clipped to it, so the roof and
                 windscreen cannot spill over the rounded corners. -->
            <clipPath id="shuttlBusBody"><path d="${BUS_BODY}" /></clipPath>
          </defs>

          <path d="${BUS_BODY}" fill="none" stroke="#0b0b0c" stroke-width="6"
                stroke-linejoin="round" />

          <g clip-path="url(#shuttlBusLit)">
            <path d="${BUS_BODY}" fill="${lit}" />
          </g>
          <g clip-path="url(#shuttlBusShade)">
            <path d="${BUS_BODY}" fill="${shaded}" />
          </g>

          <g clip-path="url(#shuttlBusBody)">
            <path d="${BUS_ROOF}" fill="${roof}" />
            <path d="${BUS_ROOF_RIBS}" stroke="#0b0b0c" stroke-width="1.4"
                  opacity="0.35" fill="none" />
            <path d="${BUS_REAR}" fill="#0b0b0c" opacity="0.5" />
            <path d="${BUS_WINDSCREEN}" fill="#eaf7ff" opacity="0.95" />
          </g>
        </svg>
      </div>
    `,
  });
}

/** The marker builder in use. Buses by default; set VITE_VEHICLE_ICON=arrow
 * for the arrowhead, which conveys heading more clearly at small sizes. */
export function makeVehicleIcon(rotationDeg: number, color: string | null | undefined) {
  const style = import.meta.env.VITE_VEHICLE_ICON;
  return style === "arrow"
    ? makeVehicleChevronIcon(rotationDeg, color)
    : makeVehicleBusIcon(rotationDeg, color);
}
