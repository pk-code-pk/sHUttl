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

/**
 * A vehicle marker: one light arrow, ringed in its route's colour.
 *
 * Filling the whole arrow with the route colour made nine differently-coloured
 * darts on one map — the buses read as nine unrelated things rather than one
 * fleet, and against a darkened basemap the muted fills lost contrast exactly
 * where a moving vehicle most needs it.
 *
 * Inverting it fixes both. A near-white body is the same for every bus, so they
 * read as one system and stay the brightest moving thing on the map; the route
 * colour moves to a ring around it, which is enough to identify at a glance
 * while agreeing with the app's dark-and-crimson surfaces rather than competing
 * with them. It matches the route line the bus is travelling along, so a bus
 * and its route still visibly belong together.
 *
 * The outer dark edge is what keeps a light arrow legible over the lighter
 * patches of basemap — road fills and the river.
 */
export function makeVehicleIcon(rotationDeg: number, color: string | null | undefined) {
    const routeColor = color || "#d4737f";
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
      ">
        <svg width="${size}" height="${size}" viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
          <!-- Painted outward: dark separator, route ring, light body. Drawing
               them as three strokes of the same path keeps them concentric,
               which hand-offsetting three outlines would not. -->
          <path d="M32 8 L54 52 L32 41 L10 52 Z" fill="none"
                stroke="#0b0f17" stroke-width="9"
                stroke-linejoin="round" stroke-linecap="round" />
          <path d="M32 8 L54 52 L32 41 L10 52 Z" fill="none"
                stroke="${routeColor}" stroke-width="6"
                stroke-linejoin="round" stroke-linecap="round" />
          <path d="M32 8 L54 52 L32 41 L10 52 Z"
                fill="#eef1f5" stroke="#eef1f5" stroke-width="1.5"
                stroke-linejoin="round" stroke-linecap="round" />
        </svg>
      </div>
    `,
    });
}
