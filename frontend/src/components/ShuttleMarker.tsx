import { useEffect, useMemo, useRef } from "react";
import { Marker } from "react-leaflet";
import type L from "leaflet";
import { bearingDeg, lerp, makeVehicleChevronIcon } from "./mapUtils";
import type { Vehicle } from "./types";

export function ShuttleMarker({
    v,
    durationMs = 1200,
}: {
    v: Vehicle & { lat: number; lng: number };
    durationMs?: number;
}) {
    const markerRef = useRef<L.Marker>(null);
    const prevPosRef = useRef<[number, number] | null>(null);
    const rafRef = useRef<number | null>(null);
    const rotRef = useRef<number>(0);

    // initial icon
    const icon = useMemo(() => makeVehicleChevronIcon(0, v.color), [v.color]);

    useEffect(() => {
        const marker = markerRef.current;
        if (!marker) return;

        const next: [number, number] = [v.lat, v.lng];
        const prev = prevPosRef.current ?? next;
        prevPosRef.current = next;

        // cancel old animation
        if (rafRef.current) cancelAnimationFrame(rafRef.current);

        // compute rotation
        const rotation = v.heading != null ? v.heading : bearingDeg(prev, next);
        rotRef.current = rotation;
        marker.setIcon(makeVehicleChevronIcon(rotation, v.color));

        const start = performance.now();
        const tick = (now: number) => {
            const t = Math.min(1, (now - start) / durationMs);
            const lat = lerp(prev[0], next[0], t);
            const lng = lerp(prev[1], next[1], t);
            marker.setLatLng([lat, lng]);
            if (t < 1) rafRef.current = requestAnimationFrame(tick);
        };
        rafRef.current = requestAnimationFrame(tick);

        return () => {
            if (rafRef.current) cancelAnimationFrame(rafRef.current);
        };
    }, [v.lat, v.lng, v.heading, v.color, durationMs]);

    return <Marker ref={markerRef} position={[v.lat, v.lng]} icon={icon} zIndexOffset={1000} />;
}
