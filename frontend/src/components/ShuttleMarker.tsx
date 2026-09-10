import { useEffect, useRef } from "react";
import { Marker, type MarkerInstance } from "react-map-gl/maplibre";
import { ARROW_PATH, NEUTRAL_ROUTE_COLOR, bearingDeg, lerp } from "./mapUtils";
import type { Vehicle } from "./types";

/** Ease in and out. A vehicle that starts and stops abruptly reads as a
 * teleport even when the path between is interpolated. */
const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (1 - t) * (1 - t) * 2);

const SIZE = 32;

/**
 * A vehicle marker: a solid arrow in its route's colour.
 *
 * Filled with the route colour, not outlined in it. An earlier version gave
 * every bus a white body with a coloured ring, on the theory that a shared
 * body would read as one fleet — it read as nine white darts instead, and the
 * thing that identifies a bus was reduced to a 2px edge. The grouped route
 * palette does that job properly.
 *
 * The dark outline is load-bearing: a bus sits on a route line of its own
 * colour, so without it the arrow dissolves into the line it is travelling
 * along.
 *
 * Position and heading are both animated over the poll interval. Position is
 * pushed straight to the MapLibre marker each frame rather than through React
 * state — sixty renders a second per bus for a coordinate change is the wrong
 * tool. Heading is a CSS transition on the inner element.
 */
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
    const markerRef = useRef<MarkerInstance>(null);
    const innerRef = useRef<HTMLDivElement>(null);
    const prevPosRef = useRef<[number, number] | null>(null);
    const rafRef = useRef<number | null>(null);
    // Unwrapped heading: kept as a continuous value rather than 0-360 so that
    // crossing north turns by 2 degrees instead of spinning 358 the long way.
    const rotRef = useRef<number | null>(null);

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

        const el = innerRef.current;
        if (el) {
            el.style.transitionDuration = `${durationMs}ms`;
            el.style.transform = `rotate(${rotRef.current}deg)`;
        }

        const start = performance.now();
        const tick = (now: number) => {
            const t = Math.min(1, (now - start) / durationMs);
            const e = easeInOut(t);
            marker.setLngLat([lerp(prev[1], next[1], e), lerp(prev[0], next[0], e)]);
            if (t < 1) rafRef.current = requestAnimationFrame(tick);
        };
        rafRef.current = requestAnimationFrame(tick);

        return () => {
            if (rafRef.current) cancelAnimationFrame(rafRef.current);
        };
    }, [v.lat, v.lng, v.heading, durationMs]);

    const color = v.color || NEUTRAL_ROUTE_COLOR;

    return (
        <Marker ref={markerRef} longitude={v.lng} latitude={v.lat} anchor="center" style={{ zIndex: 10 }}>
            <div
                ref={innerRef}
                className="vehicle-marker-inner"
                style={{ width: SIZE, height: SIZE, transformOrigin: '50% 50%' }}
            >
                <svg width={SIZE} height={SIZE} viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
                    <path
                        d={ARROW_PATH}
                        fill={color}
                        stroke="#0b0f17"
                        strokeWidth={5}
                        strokeLinejoin="round"
                        paintOrder="stroke"
                    />
                </svg>
            </div>
        </Marker>
    );
}
