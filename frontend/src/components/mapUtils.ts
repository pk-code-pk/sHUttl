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
 * A vehicle marker: a solid arrow in its route's colour.
 *
 * Filled with the route colour, not outlined in it. An earlier version gave
 * every bus a white body with a coloured ring, on the theory that a shared
 * body would read as one fleet — it read as nine white darts instead, and the
 * thing that identifies a bus was reduced to a 2px edge. The grouped route
 * palette does that job properly: two amber buses are visibly going the same
 * way without making the marker do the work.
 *
 * The dark outline is the only other element and it is load-bearing: a bus
 * sits on a route line of its own colour, so without it the arrow dissolves
 * into the line it is travelling along.
 */
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
        <svg width="${size}" height="${size}" viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
          <path d="M32 9 L53 51 L32 41 L11 51 Z"
                fill="${routeColor}" stroke="#0b0f17" stroke-width="5"
                stroke-linejoin="round" paint-order="stroke" />
        </svg>
      </div>
    `,
    });
}
