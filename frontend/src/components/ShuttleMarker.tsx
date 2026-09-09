import { useEffect, useMemo, useRef } from "react";
import { Marker } from "react-leaflet";
import type L from "leaflet";
import { bearingDeg, lerp, makeVehicleIcon } from "./mapUtils";
import type { Vehicle } from "./types";

/** Ease in and out. A vehicle that starts and stops abruptly reads as a
 * teleport even when the path between is interpolated. */
const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (1 - t) * (1 - t) * 2);

export function ShuttleMarker({
    v,
    // Matched to the vehicle poll interval, not shorter than it. At 1.2s
    // against a 3s poll the bus lurched to its new position and then sat
    // still for two seconds; spending the whole interval in motion is what
    // makes it look like it is driving.
    durationMs = 3000,
}: {
    v: Vehicle & { lat: number; lng: number };
    durationMs?: number;
}) {
    const markerRef = useRef<L.Marker>(null);
    const prevPosRef = useRef<[number, number] | null>(null);
    const rafRef = useRef<number | null>(null);
    // Unwrapped heading: kept as a continuous value rather than 0-360 so that
    // crossing north turns by 2 degrees instead of spinning 358 the long way.
    const rotRef = useRef<number | null>(null);

    // The icon is rebuilt only when the colour changes. Rotation is applied to
    // the element's transform instead, because regenerating the icon HTML every
    // frame would reparse an SVG per vehicle per frame.
    const icon = useMemo(() => makeVehicleIcon(0, v.color), [v.color]);

    useEffect(() => {
        const marker = markerRef.current;
        if (!marker) return;

        const next: [number, number] = [v.lat, v.lng];
        const prev = prevPosRef.current ?? next;
        prevPosRef.current = next;

        if (rafRef.current) cancelAnimationFrame(rafRef.current);

        // Heading: prefer the operator-derived one, else infer from movement.
        // A stationary bus keeps its last heading rather than snapping to 0,
        // which would point every parked vehicle north.
        const moved = Math.abs(next[0] - prev[0]) > 1e-6 || Math.abs(next[1] - prev[1]) > 1e-6;
        let target = rotRef.current ?? 0;
        if (v.heading != null) target = v.heading;
        else if (moved) target = bearingDeg(prev, next);

        if (rotRef.current == null) {
            rotRef.current = target;
        } else {
            // Shortest angular path, accumulated onto the continuous value.
            const delta = ((target - (rotRef.current % 360)) + 540) % 360 - 180;
            rotRef.current += delta;
        }

        const rotation = rotRef.current;
        const el = marker.getElement()?.querySelector<HTMLElement>(".vehicle-marker-inner");
        if (el) {
            // The CSS transition on this element interpolates the turn; the
            // position is interpolated below. Both run over the same window.
            el.style.transitionDuration = `${durationMs}ms`;
            el.style.transform = `rotate(${rotation}deg)`;
        }

        const start = performance.now();
        const tick = (now: number) => {
            const t = Math.min(1, (now - start) / durationMs);
            const e = easeInOut(t);
            marker.setLatLng([lerp(prev[0], next[0], e), lerp(prev[1], next[1], e)]);
            if (t < 1) rafRef.current = requestAnimationFrame(tick);
        };
        rafRef.current = requestAnimationFrame(tick);

        return () => {
            if (rafRef.current) cancelAnimationFrame(rafRef.current);
        };
    }, [v.lat, v.lng, v.heading, v.color, durationMs]);

    return <Marker ref={markerRef} position={[v.lat, v.lng]} icon={icon} zIndexOffset={1000} />;
}
