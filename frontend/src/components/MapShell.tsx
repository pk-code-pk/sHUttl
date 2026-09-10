import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MapContainer, TileLayer, Popup, Polyline, useMap, Marker } from 'react-leaflet';
import { Moon, Navigation as NavigationIcon, Settings, Sun, X } from 'lucide-react';
import clsx from 'clsx';
import L from 'leaflet';
import type { LatLngExpression } from 'leaflet';
import { ShuttleMarker } from './ShuttleMarker';
import { relativeLuminance } from './mapUtils';
import { buttonVariants, cn } from './ui/styles';
import type { Stop, Vehicle, RoutePath, TripResponse, TripSegment } from './types';
import { API_BASE_URL, MAP_ATTRIBUTION, MAP_MAX_NATIVE_ZOOM, MAP_MAX_ZOOM, MAP_SUBDOMAINS, MAP_TILE_URL, MAP_TILE_URL_LIGHT, MAP_TILES_NEED_DIM } from '@/config';

/** The read-only status pill, shared by the mobile top bar and the desktop
 * bottom bar. They had drifted to different grounds, paddings and text sizes
 * while saying the same thing. It is not a Button — nothing here is
 * clickable — so it carries the `overlay` variant's surface by hand. */
const STATUS_PILL =
    'flex h-9 items-center justify-center rounded-full border border-white/10 ' +
    'bg-neutral-900/85 px-3.5 text-[11px] font-medium leading-none text-neutral-300 ' +
    'shadow-lg backdrop-blur-md';

/** "1 bus", "2 buses", "0 buses".
 *
 * The two status pills said "1 bus" on mobile and "1 vehicles" on desktop:
 * different nouns for the same number, and each wrong on one side of one.
 * One helper so both read the same and neither can drift again. */
const busCount = (n: number) => `${n} ${n === 1 ? 'bus' : 'buses'}`;

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
    /** A route to show and frame on its own, with no trip planned yet.
     *
     * Expanding a departure in Next Bus Out sets this. There is no destination
     * at that point — the rider is still deciding — so there is no trip to
     * draw, but the useful thing to see is the route that bus runs. It goes
     * through the same bounds-and-key path a trip does rather than a second
     * focus implementation; Next Bus Out had one of those and it drifted out
     * of step with the planner, which is why it was removed. */
    focusRouteId?: string | null;
}



/* Route ids arrive from two endpoints — /routes and /departures — and the
   backend has already been bitten once by comparing them case-sensitively,
   which reported every route dead. Compared loosely here for the same reason. */
const sameRoute = (a: string | null | undefined, b: string | null | undefined) =>
    a != null && b != null && String(a).trim().toLowerCase() === String(b).trim().toLowerCase();

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
    systemId,
    systemBounds,
    activeTripBounds,
    tripKey,
    setMap,
    onZoom,
}: {
    systemId: number | null;
    systemBounds: L.LatLngBounds | null;
    activeTripBounds: L.LatLngBounds | null;
    tripKey: string | null;
    setMap: (map: L.Map) => void;
    onZoom: (zoom: number) => void;
}) {
    const map = useMap();

    useEffect(() => {
        if (map) setMap(map);
    }, [map, setMap]);

    // Report the zoom so line weights can follow it (see routeWeight).
    useEffect(() => {
        if (!map) return;
        const report = () => onZoom(map.getZoom());
        report();
        map.on('zoomend', report);
        return () => { map.off('zoomend', report); };
    }, [map, onZoom]);

    // The bottom sheet covers roughly the lower 45% of the screen on mobile,
    // and Leaflet fits to the whole container — so a symmetric fit puts the
    // bottom of the bounds underneath the panel. Reserve that space instead,
    // or half of every fitted route is hidden behind the UI.
    const fitOptions = useCallback((): L.FitBoundsOptions => {
        const isNarrow = window.innerWidth < 768;
        // maxZoom keeps a fit on a short ride from slamming into the deepest
        // zoom, where the upscaled basemap is blurriest and the surroundings
        // are lost. A two-stop hop frames at neighbourhood scale, not doorstep.
        const common = { maxZoom: Math.min(MAP_MAX_NATIVE_ZOOM, 16) };
        return isNarrow
            ? {
                  ...common,
                  paddingTopLeft: [30, 40],
                  paddingBottomRight: [30, Math.round(window.innerHeight * 0.48)],
              }
            : { ...common, paddingTopLeft: [430, 60], paddingBottomRight: [60, 60] };
    }, []);

    // Fit the whole network on launch, so the opening view shows every route
    // and every bus in service rather than an arbitrary crop.
    const hasInitialSystemFit = useRef(false);
    useEffect(() => {
        if (map && systemBounds && !hasInitialSystemFit.current) {
            map.fitBounds(systemBounds, fitOptions());
            hasInitialSystemFit.current = true;
        }
    }, [map, systemBounds, fitOptions]);

    // Reset the initial fit on a system change only. Keying this on the bounds
    // object would refit the map every time the bounds are recomputed, which
    // now happens on each vehicle poll — the map would snap back while
    // someone was panning it.
    useEffect(() => {
        hasInitialSystemFit.current = false;
    }, [systemId]);

    // Trip / departure centering, and the return trip back to the overview.
    const lastCenteredTripKey = useRef<string | null>(null);
    useEffect(() => {
        if (!map) return;

        if (activeTripBounds && tripKey) {
            // Only recentre when this is a different trip or departure than
            // last time, so live updates do not fight the user's panning.
            if (tripKey !== lastCenteredTripKey.current) {
                map.fitBounds(activeTripBounds, fitOptions());
                lastCenteredTripKey.current = tripKey;
            }
            return;
        }

        // Nothing selected any more. If something was, deselecting is a request
        // to see the whole network again — otherwise the map stays zoomed into
        // wherever the last route happened to go.
        if (lastCenteredTripKey.current !== null) {
            lastCenteredTripKey.current = null;
            if (systemBounds) {
                map.fitBounds(systemBounds, fitOptions());
            }
        }
    }, [map, activeTripBounds, tripKey, systemBounds, fitOptions]);

    return null;
}

export const MapShell = ({ systemId, trip, userLocation, focusRouteId }: MapShellProps) => {
    const [stops, setStops] = useState<Stop[]>([]);
    const [vehicles, setVehicles] = useState<Vehicle[]>([]);
    const [routes, setRoutes] = useState<RoutePath[]>([]);
    const [showRoutes, setShowRoutes] = useState(false);
    const [loading, setLoading] = useState(false);
    const [loadingRoutes, setLoadingRoutes] = useState(false);
    const [vehiclesError, setVehiclesError] = useState(false);
    const [routesError, setRoutesError] = useState(false);
    const [routeVisibility, setRouteVisibility] = useState<Record<string, boolean>>({});
    const [showRouteSettings, setShowRouteSettings] = useState(false);
    const routeSettingsRef = useRef<HTMLDivElement>(null);

    const [systemBounds, setSystemBounds] = useState<L.LatLngBounds | null>(null);
    // The launch/overview view. Stops define the network, but a bus can sit
    // just outside their envelope — north of the Quad, or out past Barry's
    // Corner — so vehicles are folded in to guarantee every bus in service is
    // on screen.
    const overviewBounds = useMemo(() => {
        if (!systemBounds) return null;
        if (vehicles.length === 0) return systemBounds;
        const b = L.latLngBounds(systemBounds.getSouthWest(), systemBounds.getNorthEast());
        for (const v of vehicles) {
            if (typeof v.lat === 'number' && typeof v.lng === 'number') {
                b.extend([v.lat, v.lng]);
            }
        }
        return b;
    }, [systemBounds, vehicles]);

    const tripBounds = useMemo(() => computeTripBounds(trip), [trip]);

    const focusRoute = useMemo(
        () => (focusRouteId ? routes.find((r) => sameRoute(r.route_id, focusRouteId)) ?? null : null),
        [routes, focusRouteId],
    );

    const focusRouteBounds = useMemo(() => {
        const path = focusRoute?.path;
        if (!path?.length) return null;
        return L.latLngBounds(path.map((p) => [p.lat, p.lng] as [number, number]));
    }, [focusRoute]);

    // A planned trip wins: it is the more specific answer, and it is what the
    // rider asked for last.
    const activeTripBounds = tripBounds ?? focusRouteBounds;
    const [mapInstance, setMapInstance] = useState<L.Map | null>(null);
    const [zoom, setZoom] = useState(15);

    // Basemap ground: dark by default, light on request. Only the tiles
    // change — chrome and route colours stay — and the choice is remembered.
    const [basemap, setBasemap] = useState<'dark' | 'light'>(() => {
        try { return localStorage.getItem('shuttl:basemap') === 'light' ? 'light' : 'dark'; }
        catch { return 'dark'; }
    });
    const toggleBasemap = useCallback(() => {
        setBasemap((b) => {
            const next = b === 'dark' ? 'light' : 'dark';
            try { localStorage.setItem('shuttl:basemap', next); } catch { /* private mode */ }
            return next;
        });
    }, []);
    const isLight = basemap === 'light';

    // Line weight follows zoom. Leaflet animates a zoom by CSS-scaling the
    // overlay pane, so a 4px line is already 8px on screen by the end of a
    // one-level zoom in — the map grew and the line grew with it. If it then
    // redraws at 4px it visibly snaps thin; if it redraws at 8px the
    // animation lands exactly where it was heading and nothing pops. So the
    // weight doubles per level around z16, the working zoom. Clamped so it
    // stays a line at either extreme; the clamp is the only place a snap can
    // still occur, at the ends of the zoom range, where it is small.
    const routeWeight = useCallback(
        (base: number) => Math.min(base * 2.2, Math.max(base * 0.5, base * 2 ** (zoom - 16))),
        [zoom],
    );

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


    // Geometry is needed whenever anything wants to draw a route: the Show
    // Routes toggle, or a single focused route. Fetching only for the toggle
    // meant a focused route had no path to draw and nothing to frame, because
    // `showRoutes` starts off.
    const needRoutes = showRoutes || Boolean(focusRouteId);
    useEffect(() => {
        if (!systemId || !needRoutes) {
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
    }, [systemId, needRoutes]);

    // Initialize route visibility when routes load
    useEffect(() => {
        if (routes.length > 0) {
            // eslint-disable-next-line react-hooks/set-state-in-effect
            setRouteVisibility(prev => {
                const next = { ...prev };
                for (const r of routes) {
                    if (!(r.route_id in next)) {
                        next[r.route_id] = true;
                    }
                }
                return next;
            });
        }
    }, [routes]);

    // Close route settings on outside click
    useEffect(() => {
        if (!showRouteSettings) return;
        const handler = (e: MouseEvent) => {
            const target = e.target as HTMLElement;
            if (
                routeSettingsRef.current &&
                !routeSettingsRef.current.contains(target) &&
                !target.closest('[data-route-settings-trigger]')
            ) {
                setShowRouteSettings(false);
            }
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, [showRouteSettings]);

    const toggleRouteVisibility = (routeId: string) => {
        setRouteVisibility(prev => ({
            ...prev,
            [routeId]: prev[routeId] === false,
        }));
    };

    const handleRouteSettingsClick = () => {
        if (!showRouteSettings && !showRoutes) {
            setShowRoutes(true);
        }
        setShowRouteSettings(prev => !prev);
    };

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

    // Compute trip key for smart centering
    // The key is what tells MapController "this is a new thing to frame".
    // A focused route needs one too, or expanding a departure would compute
    // bounds that never get fitted.
    const tripKey = useMemo(
        () => computeTripKey(trip) ?? (focusRouteId ? `route:${focusRouteId}` : null),
        [trip, focusRouteId],
    );

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
        <div className={cn('relative h-full w-full bg-neutral-900', MAP_TILES_NEED_DIM && !isLight && 'map-tiles-dim', isLight && 'map-light')}>
            {systemId ? (
                <MapContainer
                    key={systemId}
                    center={center}
                    zoom={15}
                    maxZoom={MAP_MAX_ZOOM}
                    className="h-full w-full bg-neutral-900"
                    scrollWheelZoom={true}
                    zoomControl={false}
                    // Cached tiles still fade in from transparent over 200 ms
                    // by default, which looks like a network load on every
                    // zoom even when nothing was fetched — measured: 30 tiles
                    // per zoom step, all from cache, 0 bytes, and still a
                    // visible fade. With the campus preloaded there is nothing
                    // to hide behind a fade, so tiles appear the instant they
                    // are placed.
                    fadeAnimation={false}
                >
                    <MapController
                        systemId={systemId}
                        systemBounds={overviewBounds}
                        activeTripBounds={activeTripBounds}
                        tripKey={tripKey}
                        setMap={setMapInstance}
                        onZoom={setZoom}
                    />

                    {/* Basemap. Provider is configurable; see config.ts for why
                        the CARTO URL that used to be hardcoded here had to go. */}
                    <TileLayer
                        key={basemap}
                        attribution={MAP_ATTRIBUTION}
                        url={isLight ? MAP_TILE_URL_LIGHT : MAP_TILE_URL}
                        maxZoom={MAP_MAX_ZOOM}
                        // Keep a wide ring of offscreen tiles alive. Leaflet
                        // prunes to 2 screens by default, so panning walked
                        // straight onto tiles that had been thrown away and had
                        // to be refetched — the gaps are what flashed. Six is
                        // the whole campus at working zooms, which is small
                        // enough to just hold.
                        keepBuffer={6}
                        // updateWhenZooming is deliberately left on. Turning it
                        // off stops the layer loading the new level during a
                        // zoom, so Leaflet stretches the old tiles to fill —
                        // measured at 256px scaled to 909 — while the markers
                        // move to their true projected positions. The stops
                        // then visibly slide against the map. A brief gap is
                        // a far smaller fault than the whole basemap drifting
                        // out from under the pins.
                        // Request tiles with CORS. Leaflet's img tiles are
                        // no-cors by default, which makes every response
                        // opaque: status 0, ok false, headers unreadable. The
                        // tile-cache worker then cannot tell a real tile from
                        // Esri's light "not available" placeholder, and cannot
                        // even see that the fetch succeeded. Esri serves
                        // Access-Control-Allow-Origin, so asking for CORS costs
                        // nothing and makes the responses inspectable.
                        crossOrigin="anonymous"
                        maxNativeZoom={MAP_MAX_NATIVE_ZOOM}
                        {...(MAP_SUBDOMAINS ? { subdomains: MAP_SUBDOMAINS } : {})}
                    />

                    {/* Route polylines, one solid line each.

                        Which routes draw: all visible ones when Show Routes is
                        on; otherwise only the focused route, if there is one.
                        Being told a bus is coming is not useful without seeing
                        where it goes, so the focused route draws whether or
                        not the toggle is on.

                        How they draw: with no focus, every route is a solid
                        4px line. With a focus, that route is heavier and the
                        rest step back to thin and translucent, so the one you
                        tapped is the one you read. Once a trip is planned on
                        top of it the trip line takes over and the route drops
                        to a thin context line underneath — the whole loop for
                        orientation, the ridden stretch in bold.

                        The translucent glow underlay that used to sit beneath
                        every route muddied adjacent routes into a haze; the
                        colour carries its own brightness now. */}
                    {routes
                        .filter((r) => {
                            const isFocus = focusRoute != null && sameRoute(r.route_id, focusRoute.route_id);
                            if (isFocus) return true;
                            return showRoutes && routeVisibility[r.route_id] !== false;
                        })
                        // Draw order is stacking order, and routes share roads:
                        // AL, XSEC and QSTA run the same Allston corridor. Light
                        // colours draw first as ground and saturated ones last
                        // as figure, so crimson sits on cream where they overlap
                        // rather than under it. Luminance, not a route list, so
                        // the rule survives a palette change. The focused route
                        // always draws last regardless.
                        .sort((a, b) => {
                            const af = focusRoute != null && sameRoute(a.route_id, focusRoute.route_id);
                            const bf = focusRoute != null && sameRoute(b.route_id, focusRoute.route_id);
                            if (af !== bf) return af ? 1 : -1;
                            return (relativeLuminance(b.color) ?? 0) - (relativeLuminance(a.color) ?? 0);
                        })
                        .map((r) => {
                            if (!r.path || r.path.length === 0) return null;

                            const positions: LatLngExpression[] = r.path.map((p) => [p.lat, p.lng]);
                            const color = r.color || '#a51c30';
                            const isFocus = focusRoute != null && sameRoute(r.route_id, focusRoute.route_id);

                            let weight = 4;
                            let opacity = 1;
                            if (focusRoute) {
                                if (!isFocus) { weight = 3; opacity = 0.3; }
                                else if (trip) { weight = 2; opacity = 0.4; }
                                else { weight = 5; }
                            }

                            return (
                                <Polyline
                                    key={r.route_id}
                                    positions={positions}
                                    pathOptions={{ color, weight: routeWeight(weight), opacity }}
                                />
                            );
                        })}

                    {/* Planned trip path, solid in the route colour. This drew
                        a 14px translucent layer under a 5px core, both running
                        an opacity animation — the pulse read as a glow and made
                        the colour look washed out at every point in the cycle. */}
                    {tripPolylines.map((line) => (
                        <Polyline
                            key={`trip-${line.idx}`}
                            positions={line.positions}
                            pathOptions={{
                                color: line.color,
                                weight: routeWeight(6),
                                opacity: 1,
                            }}
                        />
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
                            <ShuttleMarker key={v.id} v={v} durationMs={3000} />
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
                grid grid-cols-[1fr_auto_1fr] items-center
                pointer-events-none
            ">
                {/* Left: Status Pill */}
                <div className={cn(STATUS_PILL, 'justify-self-start pointer-events-auto min-w-[32px]')}>
                    {systemId
                        ? loading
                            ? '…'
                            : <span className="whitespace-nowrap">{stops.length} stops • {busCount(vehicles.length)}</span>
                        : 'Select system'}
                </div>

                {/* Center: Recenter + Route Settings Buttons */}
                {systemId ? (
                    <div className="pointer-events-auto flex items-center gap-1.5">
                        <button
                            type="button"
                            onClick={() => {
                                if (!mapInstance) return;
                                if (activeTripBounds) {
                                    mapInstance.fitBounds(activeTripBounds, { padding: [80, 80] });
                                } else if (overviewBounds) {
                                    mapInstance.fitBounds(overviewBounds, { padding: [50, 50] });
                                }
                            }}
                            className={cn(buttonVariants({ variant: 'overlay', size: 'icon' }), 'text-white')}
                            aria-label="Recenter map"
                        >
                            <NavigationIcon size={14} className="fill-current -translate-x-[1px] translate-y-[1px]" />
                        </button>
                        <button
                            type="button"
                            data-route-settings-trigger
                            onClick={handleRouteSettingsClick}
                            className={buttonVariants({
                                variant: showRouteSettings ? 'selected' : 'overlay',
                                size: 'icon',
                            })}
                            aria-label="Filter routes"
                        >
                            <Settings size={14} />
                        </button>
                        <button
                            type="button"
                            onClick={toggleBasemap}
                            className={buttonVariants({ variant: 'overlay', size: 'icon' })}
                            aria-label={isLight ? 'Switch to dark map' : 'Switch to light map'}
                        >
                            {isLight ? <Moon size={14} /> : <Sun size={14} />}
                        </button>
                    </div>
                ) : <div />}

                {/* Right: Show Routes Toggle */}
                <button
                    type="button"
                    onClick={() => setShowRoutes((prev) => !prev)}
                    className={cn(
                        buttonVariants({ variant: showRoutes ? 'selected' : 'overlay', size: 'md' }),
                        'justify-self-end pointer-events-auto min-w-[32px]',
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
                        className={cn(
                            buttonVariants({ variant: showRoutes ? 'selected' : 'overlay', size: 'md' }),
                            'rounded-full',
                        )}
                    >
                        {showRoutes ? 'Hide Routes' : 'Show Routes'}
                        {loadingRoutes && showRoutes && (
                            <div className="h-3 w-3 animate-spin rounded-full border-2 border-white/25 border-t-white" />
                        )}
                    </button>
                </div>

                {/* Route Settings Button */}
                <div className="pointer-events-auto order-2 md:order-2">
                    <button
                        type="button"
                        data-route-settings-trigger
                        onClick={handleRouteSettingsClick}
                        className={cn(
                            buttonVariants({ variant: showRouteSettings ? 'selected' : 'overlay', size: 'md' }),
                            'rounded-full',
                        )}
                    >
                        <Settings size={12} />
                        {/* Named "Filter", not "Routes". It sat next to a
                            "Show Routes" toggle doing an unrelated job, and two
                            buttons a thumb apart called Routes and Show Routes
                            gave no way to guess which did what. */}
                        <span>Filter</span>
                    </button>
                </div>

                {/* Basemap toggle */}
                <div className="pointer-events-auto order-2 md:order-2">
                    <button
                        type="button"
                        onClick={toggleBasemap}
                        className={buttonVariants({ variant: 'overlay', size: 'icon' })}
                        aria-label={isLight ? 'Switch to dark map' : 'Switch to light map'}
                        title={isLight ? 'Dark map' : 'Light map'}
                    >
                        {isLight ? <Moon size={13} /> : <Sun size={13} />}
                    </button>
                </div>

                {/* Status pill */}
                <div className="pointer-events-none order-1 md:order-3 flex flex-col items-center gap-1.5">
                    <div className={STATUS_PILL}>
                        {systemId
                            ? loading
                                ? 'Loading stops…'
                                : `${stops.length} stops • ${busCount(vehicles.length)}`
                            : 'Select a system to begin'}
                    </div>
                    {/* Was yellow — the app's only use of it, and a third
                        accent beside crimson and the route colours. Crimson
                        already means "attention" everywhere else here. */}
                    {(vehiclesError || routesError) && (
                        <p className="animate-pulse-subtle rounded-full border border-crimson-mid/40 bg-crimson-deep/30 px-3 py-1 text-[10px] font-medium text-crimson-light backdrop-blur-sm">
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
                        } else if (overviewBounds) {
                            mapInstance.fitBounds(overviewBounds, { padding: [50, 50] });
                        }
                    }}
                    className={cn(
                        buttonVariants({ variant: 'overlay', size: 'md' }),
                        'pointer-events-auto absolute right-6 bottom-32 z-[1000] hidden rounded-full shadow-xl md:flex',
                    )}
                >
                    Recenter
                </button>
            )}

            {/* Route Settings Panel */}
            {showRouteSettings && (
                <div
                    ref={routeSettingsRef}
                    className="fixed z-[1001] top-16 left-4 right-4 md:absolute md:top-auto md:bottom-24 md:left-1/2 md:-translate-x-1/2 md:w-72 md:right-auto rounded-xl bg-black/80 backdrop-blur-xl border border-white/10 shadow-2xl p-3 max-h-[60vh] overflow-y-auto"
                >
                    <div className="mb-2 flex items-center justify-between px-1">
                        {/* Every other section label in the app is a small,
                            bold, tracked cap line — FROM, TO, ITINERARY,
                            DEPARTURES FROM. This one alone was sentence case at
                            a different size and weight. */}
                        <span className="text-[10px] font-bold uppercase tracking-wider text-neutral-500">
                            Filter routes
                        </span>
                        <button
                            type="button"
                            onClick={() => setShowRouteSettings(false)}
                            aria-label="Close route filter"
                            className={buttonVariants({ variant: 'ghost', size: 'iconSm' })}
                        >
                            <X size={12} />
                        </button>
                    </div>
                    {loadingRoutes ? (
                        <div className="flex items-center gap-2 py-3 px-1">
                            <div className="h-3 w-3 animate-spin rounded-full border-2 border-crimson/30 border-t-crimson" />
                            <span className="text-[11px] text-neutral-500">Loading routes...</span>
                        </div>
                    ) : routes.length === 0 ? (
                        <p className="text-[11px] text-neutral-500 py-2 px-1">No routes available</p>
                    ) : (
                        <div className="space-y-0.5">
                            {routes.map(r => {
                                const isVisible = routeVisibility[r.route_id] !== false;
                                const color = r.color || '#a51c30';
                                return (
                                    <button
                                        key={r.route_id}
                                        type="button"
                                        onClick={() => toggleRouteVisibility(r.route_id)}
                                        className="flex items-center gap-2.5 w-full py-2 px-2 rounded-lg hover:bg-white/5 transition-colors"
                                    >
                                        <div
                                            className="h-2.5 w-2.5 rounded-full flex-shrink-0"
                                            style={{
                                                backgroundColor: isVisible ? color : 'transparent',
                                                border: isVisible ? 'none' : `2px solid ${color}`,
                                            }}
                                        />
                                        <span className={clsx(
                                            'text-[11px] flex-1 text-left truncate transition-colors',
                                            isVisible ? 'text-neutral-200' : 'text-neutral-500'
                                        )}>
                                            {r.route_name || r.short_name || `Route ${r.route_id}`}
                                        </span>
                                        {/* Nine routes are on by default, so nine
                                            switches are lit at once. A bright
                                            crimson track and a bright crimson
                                            knob made the panel a column of red
                                            and drowned out the route colour dot
                                            beside it, which is the part worth
                                            reading. On is carried by the knob's
                                            position and a quiet deep-crimson
                                            track; the knob is white so it stays
                                            the crisp part at 14px. */}
                                        <div className={clsx(
                                            'flex h-5 w-9 flex-shrink-0 items-center rounded-full border px-0.5 transition-colors duration-200',
                                            isVisible
                                                ? 'border-crimson-mid/60 bg-crimson-deep/60'
                                                : 'border-white/5 bg-neutral-700'
                                        )}>
                                            <div className={clsx(
                                                'h-3.5 w-3.5 rounded-full transition-transform duration-200',
                                                isVisible
                                                    ? 'translate-x-[14px] bg-white'
                                                    : 'translate-x-0 bg-neutral-400'
                                            )} />
                                        </div>
                                    </button>
                                );
                            })}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
};
