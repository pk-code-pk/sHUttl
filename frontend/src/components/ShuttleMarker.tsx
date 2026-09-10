import { useEffect, useRef, useState } from "react";
import { Marker, type MarkerInstance } from "react-map-gl/maplibre";
import { ARROW_PATH, NEUTRAL_ROUTE_COLOR, bearingDeg, lerp, textOnRouteColor } from "./mapUtils";
import type { Vehicle } from "./types";

/** Ease in and out. A vehicle that starts and stops abruptly reads as a
 * teleport even when the path between is interpolated. */
const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (1 - t) * (1 - t) * 2);

// 40px: the 32px arrow was legible but a poor tap target, and it is now also
// the thing you tap to find out which bus this is.
const SIZE = 40;


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
    // Tap a bus to learn which one it is. The label is a child of the marker
    // element rather than a map popup, so it rides along with the animated
    // position for free and needs no binding to the map. Closes on a tap
    // anywhere else.
    const [open, setOpen] = useState(false);
    const rootRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
        if (!open) return;
        const away = (e: PointerEvent) => { if (!rootRef.current?.contains(e.target as Node)) setOpen(false); };
        document.addEventListener('pointerdown', away, true);
        return () => document.removeEventListener('pointerdown', away, true);
    }, [open]);

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

    const code = v.route_id ? String(v.route_id) : '';
    const name = v.route_name || code || 'Unknown route';

    return (
        <Marker ref={markerRef} longitude={v.lng} latitude={v.lat} anchor="center" style={{ zIndex: open ? 20 : 10 }}>
            <div ref={rootRef} className="relative" style={{ width: SIZE, height: SIZE }}>
                <button
                    type="button"
                    aria-label={`${name}, shuttle ${v.id}`}
                    aria-expanded={open}
                    onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}
                    className="block h-full w-full cursor-pointer bg-transparent p-0"
                >
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
                </button>

                {open && (
                    <div
                        role="tooltip"
                        className="vehicle-label absolute left-1/2 bottom-full mb-2 -translate-x-1/2 whitespace-nowrap rounded-xl border border-white/10 bg-neutral-900/95 px-3 py-2 text-sm shadow-2xl backdrop-blur-md"
                    >
                        <div className="flex items-center gap-2">
                            {code && (
                                <span className="rounded-md px-1.5 py-0.5 text-[10px] font-black" style={{ backgroundColor: color, color: textOnRouteColor(v.color) }}>
                                    {code}
                                </span>
                            )}
                            <span className="font-semibold text-white">{name}</span>
                        </div>
                        <div className="mt-0.5 text-xs text-neutral-400">Shuttle #{String(v.id)}</div>
                        <div className="vehicle-label-tip" />
                    </div>
                )}
            </div>
        </Marker>
    );
}
