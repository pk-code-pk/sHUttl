import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { MapRef } from 'react-map-gl/maplibre';

/**
 * A card anchored to a point on the map, drawn above everything else.
 *
 * MapLibre renders popups and marker children inside the map container, and
 * the map sits in a z-0 wrapper under the panel. Nothing inside it can stack
 * above the panel, however high its own z-index — a stop's popup slid under
 * the sheet the moment the stop was near it. So this renders into <body>
 * through a portal, at a z-index above the panel, the controls and the
 * filter, and re-projects its anchor every frame so it stays pinned through
 * pans, zooms and a bus's animated glide.
 *
 * `getLngLat` is a function, not a value, so a moving anchor (a vehicle
 * marker mid-animation) is read fresh each frame without a React render.
 */
export function MapCard({
    mapRef,
    getLngLat,
    onClose,
    children,
}: {
    mapRef: React.RefObject<MapRef | null>;
    getLngLat: () => { lng: number; lat: number } | [number, number] | null;
    onClose: () => void;
    children: ReactNode;
}) {
    const el = useRef<HTMLDivElement>(null);

    // Position: project the anchor each animation frame.
    useLayoutEffect(() => {
        let raf = 0;
        const tick = () => {
            const map = mapRef.current?.getMap();
            const node = el.current;
            const ll = getLngLat();
            if (map && node && ll) {
                const p = map.project(ll as [number, number]);
                const rect = map.getContainer().getBoundingClientRect();
                node.style.transform = `translate(${Math.round(rect.left + p.x)}px, ${Math.round(rect.top + p.y)}px) translate(-50%, -100%)`;
                node.style.opacity = '1';
            }
            raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(raf);
    }, [mapRef, getLngLat]);

    // Dismiss on a tap anywhere outside the card. Capture phase, so a tap on
    // another marker closes this one before that marker's click opens its own.
    useEffect(() => {
        const away = (e: PointerEvent) => { if (!el.current?.contains(e.target as Node)) onClose(); };
        const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
        document.addEventListener('pointerdown', away, true);
        document.addEventListener('keydown', key);
        return () => { document.removeEventListener('pointerdown', away, true); document.removeEventListener('keydown', key); };
    }, [onClose]);

    return createPortal(
        <div
            ref={el}
            role="dialog"
            className="map-card pointer-events-auto fixed left-0 top-0 z-[2000] -mt-3 opacity-0 will-change-transform"
        >
            <div className="relative whitespace-nowrap rounded-xl border border-white/10 bg-neutral-900/95 px-3 py-2 text-sm shadow-2xl backdrop-blur-md">
                {children}
                <div className="map-card-tip" />
            </div>
        </div>,
        document.body,
    );
}
