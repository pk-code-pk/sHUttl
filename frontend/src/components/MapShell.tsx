import React, { useEffect, useMemo, useRef, useState } from 'react';
import { MapContainer, TileLayer, CircleMarker, Popup, Polyline, useMap } from 'react-leaflet';
import type { LatLngExpression } from 'leaflet';
import { ShuttleMarker } from './ShuttleMarker';
import type { Stop, Vehicle, RoutePath } from './types';

interface MapShellProps {
    systemId: number | null;
}

const STOP_WHITE = "#FFFFFF";

function MapSystemRecenter({
    center,
    systemId,
}: {
    center: LatLngExpression;
    systemId: number | null;
}) {
    const map = useMap();
    const prevSystemId = useRef<number | null>(null);

    useEffect(() => {
        // Only recenter when systemId changes OR when center updates for that system
        if (!systemId) return;

        prevSystemId.current = systemId;

        // Fly to the new system center
        map.flyTo(center, 15, {
            duration: 0.8,
        });
    }, [center, systemId, map]);

    return null;
}

export const MapShell = ({ systemId }: MapShellProps) => {
    const [stops, setStops] = useState<Stop[]>([]);
    const [vehicles, setVehicles] = useState<Vehicle[]>([]);
    const [routes, setRoutes] = useState<RoutePath[]>([]);
    const [showRoutes, setShowRoutes] = useState(false);
    const [loading, setLoading] = useState(false);
    const [loadingRoutes, setLoadingRoutes] = useState(false);

    useEffect(() => {
        if (!systemId) {
            // eslint-disable-next-line react-hooks/set-state-in-effect
            setStops([]);
            // eslint-disable-next-line react-hooks/set-state-in-effect
            setVehicles([]);
            // eslint-disable-next-line react-hooks/set-state-in-effect
            setRoutes([]);
            return;
        }
        setLoading(true);
        fetch(`http://localhost:8000/stops?system_id=${systemId}`)
            .then((res) => res.json())
            .then((data) => setStops(data))
            .catch((err) => console.error("Failed to fetch stops", err))
            .finally(() => setLoading(false));
    }, [systemId]);

    // Poll vehicles every few seconds
    useEffect(() => {
        if (!systemId) {
            // eslint-disable-next-line react-hooks/set-state-in-effect
            setVehicles([]);
            return;
        }

        let cancelled = false;

        const fetchVehicles = () => {
            fetch(`http://localhost:8000/vehicles?system_id=${systemId}`)
                .then((res) => res.json())
                .then((data) => {
                    if (!cancelled) setVehicles(data);
                })
                .catch(() => { });
        };

        fetchVehicles();
        const id = setInterval(fetchVehicles, 3000);

        return () => {
            cancelled = true;
            clearInterval(id);
        };
    }, [systemId]);

    // Fetch routes when showRoutes is toggled
    useEffect(() => {
        if (!systemId || !showRoutes) {
            // eslint-disable-next-line react-hooks/set-state-in-effect
            setRoutes([]);
            return;
        }

        setLoadingRoutes(true);
        fetch(`http://localhost:8000/route_paths?system_id=${systemId}`)
            .then((res) => res.json())
            .then((data: RoutePath[]) => {
                setRoutes(Array.isArray(data) ? data : []);
            })
            .catch(() => {
                setRoutes([]);
            })
            .finally(() => setLoadingRoutes(false));
    }, [systemId, showRoutes]);

    // Compute center from stops, fallback to Harvard if none
    const center: LatLngExpression = useMemo(() => {
        if (stops.length === 0) {
            // Default: Harvard campus-ish
            return [42.3736, -71.1097];
        }
        const avgLat = stops.reduce((sum, s) => sum + s.lat, 0) / stops.length;
        const avgLng = stops.reduce((sum, s) => sum + s.lng, 0) / stops.length;
        return [avgLat, avgLng];
    }, [stops]);

    return (
        <div className="relative h-full w-full bg-neutral-900">
            {systemId ? (
                <MapContainer
                    key={systemId}
                    center={center}
                    zoom={15}
                    className="h-full w-full bg-neutral-900"
                    scrollWheelZoom={true}
                    zoomControl={false}
                >
                    {/* This will auto-fly the map whenever systemId/center changes */}
                    <MapSystemRecenter center={center} systemId={systemId} />

                    {/* Stadia Dark Theme */}
                    <TileLayer
                        attribution='&copy; <a href="https://stadiamaps.com/">Stadia Maps</a>, &copy; <a href="https://openmaptiles.org/">OpenMapTiles</a> &copy; <a href="http://openstreetmap.org">OpenStreetMap</a> contributors'
                        url="https://tiles.stadiamaps.com/tiles/alidade_smooth_dark/{z}/{x}/{y}{r}.png"
                        maxZoom={20}
                    />

                    {/* Route polylines (glowing) */}
                    {showRoutes &&
                        routes.map((r) => {
                            if (!r.path || r.path.length === 0) return null;

                            const positions: LatLngExpression[] = r.path.map((p) => [p.lat, p.lng]);
                            const color = r.color || '#a51c30'; // fallback to harvard crimson if missing

                            return (
                                <React.Fragment key={r.route_id}>
                                    {/* Glow layer (thicker, translucent) */}
                                    <Polyline
                                        positions={positions}
                                        pathOptions={{
                                            color,
                                            weight: 10,
                                            opacity: 0.28,
                                        }}
                                    />
                                    {/* Core line (thinner, bright) */}
                                    <Polyline
                                        positions={positions}
                                        pathOptions={{
                                            color,
                                            weight: 4,
                                            opacity: 0.95,
                                        }}
                                    />
                                </React.Fragment>
                            );
                        })}

                    {/* Stops: White Glowing Dots */}
                    {stops.map((stop) => (
                        <div key={stop.id}>
                            {/* Halo */}
                            <CircleMarker
                                center={[stop.lat, stop.lng]}
                                radius={8}
                                pathOptions={{
                                    stroke: false,
                                    fill: true,
                                    fillColor: STOP_WHITE,
                                    fillOpacity: 0.08,
                                    interactive: false,
                                    className: "stop-white-glow",
                                }}
                            />

                            {/* Core */}
                            <CircleMarker
                                center={[stop.lat, stop.lng]}
                                radius={2.5}
                                pathOptions={{
                                    stroke: true,
                                    color: "rgba(255,255,255,0.4)",
                                    weight: 1,
                                    opacity: 0.8,
                                    fill: true,
                                    fillColor: STOP_WHITE,
                                    fillOpacity: 1.0,
                                    className: "stop-white-glow",
                                }}
                            >
                                <Popup>
                                    <div className="text-sm text-neutral-800">
                                        <div className="font-semibold">{stop.name}</div>
                                        <div className="text-xs text-neutral-500">
                                            Stop ID: {stop.id}
                                        </div>
                                    </div>
                                </Popup>
                            </CircleMarker>
                        </div>
                    ))}

                    {/* Vehicles with Smooth Animation */}
                    {vehicles
                        .filter((v): v is Vehicle & { lat: number; lng: number } => v.lat !== null && v.lng !== null)
                        .map((v) => (
                            <ShuttleMarker key={v.id} v={v} durationMs={1200} />
                        ))}
                </MapContainer>
            ) : (
                <div className="flex h-full w-full items-center justify-center text-neutral-500">
                    <p>Select a system to view map</p>
                </div>
            )}

            {/* Status pill */}
            <div className="pointer-events-none absolute bottom-8 left-1/2 -translate-x-1/2 rounded-full bg-black/60 backdrop-blur-md px-4 py-1.5 text-xs text-neutral-300 z-[1000] border border-white/10 shadow-lg">
                {systemId
                    ? loading
                        ? 'Loading stops…'
                        : `${stops.length} stops • ${vehicles.length} vehicles`
                    : 'Select a system to begin'}
            </div>

            {/* Route toggle button */}
            <div className="pointer-events-auto absolute bottom-8 left-8 z-[1000]">
                <button
                    type="button"
                    onClick={() => setShowRoutes((prev) => !prev)}
                    className={[
                        'rounded-full border px-4 py-2 text-xs font-medium transition-all backdrop-blur-md shadow-lg',
                        showRoutes
                            ? 'border-crimson bg-crimson/20 text-crimson animate-pulse-subtle'
                            : 'border-white/10 bg-black/60 text-neutral-300 hover:border-white/20',
                    ].join(' ')}
                >
                    <div className="flex items-center gap-2">
                        <div className={`h-1.5 w-1.5 rounded-full ${showRoutes ? 'bg-crimson shadow-[0_0_8px_rgba(165,28,48,0.6)]' : 'bg-neutral-500'}`} />
                        {showRoutes ? 'Hide Routes' : 'Show Routes'}
                        {loadingRoutes && showRoutes && (
                            <div className="h-3 w-3 animate-spin rounded-full border-2 border-crimson/30 border-t-crimson" />
                        )}
                    </div>
                </button>
            </div>
        </div>
    );
};
