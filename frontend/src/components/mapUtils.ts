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

export function makeVehicleChevronIcon(rotationDeg: number, color: string | null | undefined) {
  const safeColor = color || '#ffffff';
  const size = 28;
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
          <!-- chevron arrow with notch, use currentColor for tinting -->
          <path d="M32 6 L58 46 L40 38 L32 58 L24 38 L6 46 Z"
                fill="currentColor" />
        </svg>
      </div>
    `,
  });
}
