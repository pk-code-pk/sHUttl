import React, { useEffect, useMemo, useRef, useState } from 'react';
import { MapContainer, TileLayer, Popup, Polyline, useMap, Marker } from 'react-leaflet';
import { Navigation as NavigationIcon } from 'lucide-react';
import clsx from 'clsx';
import L from 'leaflet';
import type { LatLngExpression } from 'leaflet';
import { ShuttleMarker } from './ShuttleMarker';
import type { Stop, Vehicle, RoutePath, TripResponse, TripSegment } from './types';
import { API_BASE_URL } from '@/config';

// Fallback color palette for routes without a defined color
const FALLBACK_ROUTE_COLORS = [
    '#ef4444', // red
    '#22c55e', // green
    '#3b82f6', // blue
    '#f59e0b', // amber
    '#a855f7', // purple
    '#14b8a6', // teal
    '#f97316', // orange
    '#ec4899', // pink
];

interface MapShellProps {
    systemId: number | null;
    trip: TripResponse | null;
    userLocation?: { lat: number; lng: number } | null;
}


function computeTripBounds(trip: TripResponse | null): L.LatLngBounds | null {
    if (!trip) return null;

    const pts: [number, number][] = [];

    const o = trip.origin.nearest_stop;
    const d = trip.destination.nearest_stop;
    if (o) pts.push([o.lat, o.lng]);
    if (d) pts.push([d.lat, d.lng]);

    for (const segment of trip.segments ?? []) {
        for (const s of segment.stops ?? []) {
            pts.push([s.lat, s.lng]);
        }
    }

    if (pts.length === 0) return null;

    return L.latLngBounds(pts);
}

// Compute a unique key for a trip based on system and endpoints
function computeTripKey(trip: TripResponse | null): string | null {
    if (!trip) return null;
    const systemId = trip.system_id;
    const originId = trip.origin?.nearest_stop?.id ?? '';
    const destId = trip.destination?.nearest_stop?.id ?? '';
    return `${systemId}:${originId}:${destId}`;
}

// Separate component to safely use useMap()
function MapController({
    systemBounds,
    activeTripBounds,
    tripKey,
    setMap,
}: {
    systemBounds: L.LatLngBounds | null;
    activeTripBounds: L.LatLngBounds | null;
    tripKey: string | null;
    setMap: (map: L.Map) => void;
}) {
    const map = useMap();

    useEffect(() => {
        if (map) setMap(map);
    }, [map, setMap]);

    // Fit to system bounds when it first becomes available
    const hasInitialSystemFit = useRef(false);
    useEffect(() => {
        if (map && systemBounds && !hasInitialSystemFit.current) {
            map.fitBounds(systemBounds, { padding: [80, 80] });
            hasInitialSystemFit.current = true;
        }
    }, [map, systemBounds]);

    // Reset initial fit if system changes
    useEffect(() => {
        hasInitialSystemFit.current = false;
    }, [systemBounds]);

    // Smart trip centering: only fit bounds when trip key changes (new trip)
    const lastCenteredTripKey = useRef<string | null>(null);
    useEffect(() => {
        if (map && activeTripBounds && tripKey) {
            // Only center if this is a different trip than last time
            if (tripKey !== lastCenteredTripKey.current) {
                map.fitBounds(activeTripBounds, { padding: [80, 80] });
                lastCenteredTripKey.current = tripKey;
            }
        }
        // Reset when trip is cancelled
        if (!tripKey) {
            lastCenteredTripKey.current = null;
        }
    }, [map, activeTripBounds, tripKey]);

    return null;
}

export const MapShell = ({ systemId, trip, userLocation }: MapShellProps) => {
    const [stops, setStops] = useState<Stop[]>([]);
    const [vehicles, setVehicles] = useState<Vehicle[]>([]);
    const [routes, setRoutes] = useState<RoutePath[]>([]);
    const [showRoutes, setShowRoutes] = useState(false);
    const [loading, setLoading] = useState(false);
    const [loadingRoutes, setLoadingRoutes] = useState(false);
    const [vehiclesError, setVehiclesError] = useState(false);
    const [routesError, setRoutesError] = useState(false);

    const [systemBounds, setSystemBounds] = useState<L.LatLngBounds | null>(null);
    const [activeTripBounds, setActiveTripBounds] = useState<L.LatLngBounds | null>(null);
    const [mapInstance, setMapInstance] = useState<L.Map | null>(null);

    // Stop Icon with larger hitbox (white default)
    const stopIcon = useMemo(() => L.divIcon({
        className: 'stop-marker-container',
        html: `<div class="stop-marker-dot"></div>`,
        iconSize: [28, 28],
        iconAnchor: [14, 14],
    }), []);

    // White pulsing icon for trip origin/destination stops (larger, radar glow)
    const tripEndpointIcon = useMemo(() => L.divIcon({
        className: 'trip-endpoint-container',
        html: `<div class="trip-endpoint-dot"></div>`,
        iconSize: [40, 40],
        iconAnchor: [20, 20],
    }), []);

    // Blue pulsing icon for user's current location
    const userLocationIcon = useMemo(() => L.divIcon({
        className: 'user-location-container',
        html: `<div class="user-location-dot"></div>`,
        iconSize: [24, 24],
        iconAnchor: [12, 12],
    }), []);

    // Get origin/destination stop IDs from trip for special styling
    const tripStopIds = useMemo(() => {
        if (!trip) return new Set<string | number>();
        const ids = new Set<string | number>();
        if (trip.origin?.nearest_stop?.id) ids.add(trip.origin.nearest_stop.id);
        if (trip.destination?.nearest_stop?.id) ids.add(trip.destination.nearest_stop.id);
        return ids;
    }, [trip]);

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
        fetch(`${API_BASE_URL}/stops?system_id=${systemId}`)
            .then((res) => res.json())
            .then((data: Stop[]) => {
                setStops(data);
                if (data.length > 0) {
                    const points = data.map((s) => [s.lat, s.lng] as [number, number]);
                    setSystemBounds(L.latLngBounds(points));
                }
            })
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
            fetch(`${API_BASE_URL}/vehicles?system_id=${systemId}`)
                .then((res) => {
                    if (!res.ok) throw new Error();
                    return res.json();
                })
                .then((data) => {
                    if (!cancelled) {
                        setVehicles(data);
                        setVehiclesError(false);
                    }
                })
                .catch(() => {
                    if (!cancelled) setVehiclesError(true);
                });
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
        fetch(`${API_BASE_URL}/route_paths?system_id=${systemId}`)
            .then((res) => res.json())
            .then((data: RoutePath[]) => {
                setRoutes(Array.isArray(data) ? data : []);
                setRoutesError(false);
            })
            .catch(() => {
                setRoutes([]);
                setRoutesError(true);
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

    // Compute active trip bounds when trip changes
    useEffect(() => {
        setActiveTripBounds(computeTripBounds(trip));
    }, [trip]);

    // Compute trip key for smart centering
    const tripKey = useMemo(() => computeTripKey(trip), [trip]);

    // Auto-off "Show Routes" on first trip only
    const previousTripRef = useRef<TripResponse | null>(null);
    const hasAutoDisabledRoutes = useRef(false);
    useEffect(() => {
        const hadTripBefore = previousTripRef.current !== null;
        const hasTripNow = trip !== null;

        // If transitioning from no trip → first trip, auto-off showRoutes (once)
        if (!hadTripBefore && hasTripNow && showRoutes && !hasAutoDisabledRoutes.current) {
            setShowRoutes(false);
            hasAutoDisabledRoutes.current = true;
        }

        previousTripRef.current = trip;
    }, [trip, showRoutes]);



    const tripPolylines = useMemo(() => {
        if (!trip || !trip.segments || trip.segments.length === 0) return [];

        return trip.segments.map((seg: TripSegment, idx: number) => {
            let positions: LatLngExpression[];

            if (seg.polyline && seg.polyline.length > 0) {
                // Use the sliced GTFS shape polyline if available
                positions = seg.polyline.map(p => [p.lat, p.lng] as [number, number]);
            } else {
                // Fallback to connecting stops
                positions = (seg.stops || []).map(s => [s.lat, s.lng] as [number, number]);
            }

            // Always use segment's route color with pulsing animation
            const color = seg.color || FALLBACK_ROUTE_COLORS[idx % FALLBACK_ROUTE_COLORS.length];

            return { positions, color, idx };
        });
    }, [trip]);

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
                    <MapController
                        systemBounds={systemBounds}
                        activeTripBounds={activeTripBounds}
                        tripKey={tripKey}
                        setMap={setMapInstance}
                    />

                    {/* Carto Dark Matter - no auth required */}
                    <TileLayer
                        attribution='&copy; <a href="https://carto.com/">CARTO</a>, &copy; <a href="http://openstreetmap.org">OpenStreetMap</a> contributors'
                        url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
                        maxZoom={20}
                        subdomains="abcd"
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

                    {/* Planned trip path (if any) - Route-colored with pulsing glow */}
                    {tripPolylines.map((line) => (
                        <React.Fragment key={`trip-${line.idx}`}>
                            {/* Outer glow layer */}
                            <Polyline
                                positions={line.positions}
                                pathOptions={{
                                    color: line.color,
                                    weight: 14,
                                    opacity: 0.35,
                                    className: 'trip-segment-active'
                                }}
                            />
                            {/* Core line */}
                            <Polyline
                                positions={line.positions}
                                pathOptions={{
                                    color: line.color,
                                    weight: 5,
                                    opacity: 0.95,
                                    className: 'trip-segment-active'
                                }}
                            />
                        </React.Fragment>
                    ))}

                    {/* Stops: Glowing Dots with larger hitboxes */}
                    {stops.map((stop) => {
                        const isTripStop = tripStopIds.has(stop.id);
                        return (
                            <Marker
                                key={stop.id}
                                position={[stop.lat, stop.lng]}
                                icon={isTripStop ? tripEndpointIcon : stopIcon}
                                zIndexOffset={isTripStop ? 100 : 0}
                            >
                                <Popup>
                                    <div className="text-sm text-neutral-800">
                                        <div className="font-semibold">{stop.name}</div>
                                        <div className="text-xs text-neutral-500">
                                            Stop ID: {stop.id}
                                        </div>
                                    </div>
                                </Popup>
                            </Marker>
                        );
                    })}

                    {/* User's current location marker */}
                    {userLocation && (
                        <Marker
                            position={[userLocation.lat, userLocation.lng]}
                            icon={userLocationIcon}
                            zIndexOffset={200}
                        >
                            <Popup>
                                <div className="text-sm text-neutral-800 font-medium">
                                    Your Location
                                </div>
                            </Popup>
                        </Marker>
                    )}

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

            {/* 
              Map Controls Container 
              
              MOBILE LAYOUT:
              - Fixed at top (top-4)
              - Flex row, space-between
              - Symmetrical elements
              
              DESKTOP LAYOUT (md:):
              - Absolute at bottom (bottom-8)
              - Recenter button separate at bottom-32
            */}

            {/* 1. Mobile Top Bar Container (Hidden on Desktop) */}
            <div className="
                md:hidden
                fixed top-4 inset-x-4 z-[1000]
                flex items-center justify-between gap-2
                pointer-events-none
            ">
                {/* Left: Status Pill */}
                <div className="pointer-events-auto h-9 rounded-full bg-black/60 backdrop-blur-md px-3 py-1.5 text-[10px] font-medium leading-none text-neutral-300 border border-white/10 shadow-lg flex items-center justify-center min-w-[32px]">
                    {systemId
                        ? loading
                            ? '...'
                            : <span className="whitespace-nowrap">{stops.length} stops • {vehicles.length} bus</span>
                        : 'Select system'}
                </div>

                {/* Center: Recenter Button */}
                {systemId && (
                    <button
                        type="button"
                        onClick={() => {
                            if (!mapInstance) return;
                            if (activeTripBounds) {
                                mapInstance.fitBounds(activeTripBounds, { padding: [80, 80] });
                            } else if (systemBounds) {
                                mapInstance.fitBounds(systemBounds, { padding: [80, 80] });
                            }
                        }}
                        // Absolute positioning to center it relative to screen
                        // Removed manual offset (-ml-2) to restore true center
                        className="pointer-events-auto absolute left-1/2 -translate-x-1/2 top-0 rounded-full bg-neutral-900/90 w-9 h-9 flex items-center justify-center text-white shadow-xl backdrop-blur-md border border-white/10 hover:bg-neutral-800 active:scale-95 transition-all"
                        aria-label="Recenter map"
                    >
                        {/* Optically centered icon (slightly shifted) */}
                        <NavigationIcon size={14} className="fill-current -translate-x-[1px] translate-y-[1px]" />
                    </button>
                )}

                {/* Right: Show Routes Toggle */}
                <button
                    type="button"
                    onClick={() => setShowRoutes((prev) => !prev)}
                    className={clsx(
                        'pointer-events-auto h-9 rounded-full border px-3 py-1.5 text-[10px] font-medium leading-none transition-all backdrop-blur-md shadow-lg flex items-center justify-center whitespace-nowrap min-w-[32px]',
                        showRoutes
                            ? 'border-crimson bg-crimson/20 text-crimson animate-pulse-subtle'
                            : 'border-white/10 bg-black/60 text-neutral-300 hover:border-white/20'
                    )}
                >
                    {showRoutes ? 'Hide Routes' : 'Show Routes'}
                </button>
            </div>


            {/* 2. Desktop Bottom Controls (Hidden on Mobile) */}
            <div className="hidden md:flex pointer-events-none absolute bottom-8 inset-x-0 flex-col md:flex-row items-center justify-center gap-3 px-6 z-[1000]">
                {/* Route toggle button */}
                <div className="pointer-events-auto order-2 md:order-1">
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

                {/* Status pill */}
                <div className="pointer-events-none order-1 md:order-2 flex flex-col items-center gap-1.5">
                    <div className="rounded-full bg-black/60 backdrop-blur-md px-4 py-1.5 text-xs text-neutral-300 border border-white/10 shadow-lg">
                        {systemId
                            ? loading
                                ? 'Loading stops…'
                                : `${stops.length} stops • ${vehicles.length} vehicles`
                            : 'Select a system to begin'}
                    </div>
                    {(vehiclesError || routesError) && (
                        <p className="text-[10px] text-yellow-500/90 font-medium bg-black/40 backdrop-blur-sm px-3 py-1 rounded-full border border-yellow-500/20 animate-pulse-subtle">
                            {vehiclesError && routesError
                                ? 'Real-time data unavailable'
                                : vehiclesError
                                    ? 'Vehicle tracking unavailable'
                                    : 'Route information unavailable'}
                        </p>
                    )}
                </div>
            </div>

            {/* Desktop Recenter Button (Hidden on Mobile) */}
            {systemId && (
                <button
                    type="button"
                    title="Recenter visible area"
                    onClick={() => {
                        if (!mapInstance) return;
                        if (activeTripBounds) {
                            mapInstance.fitBounds(activeTripBounds, { padding: [80, 80] });
                        } else if (systemBounds) {
                            mapInstance.fitBounds(systemBounds, { padding: [80, 80] });
                        }
                    }}
                    className="hidden md:block pointer-events-auto absolute right-6 bottom-32 z-[1000] rounded-full bg-neutral-900/90 px-4 py-2 text-xs font-bold text-white shadow-xl backdrop-blur-md border border-white/10 hover:bg-neutral-800 transition-all active:scale-95"
                >
                    Recenter
                </button>
            )}
        </div>
    );
};
