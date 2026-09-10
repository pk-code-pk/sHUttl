import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Map, { Layer, Marker, Popup, Source, type MapRef } from 'react-map-gl/maplibre';
import type { LngLatBoundsLike } from 'maplibre-gl';
import { Moon, Navigation as NavigationIcon, Route as RouteIcon, Settings, Sun, X } from 'lucide-react';
import clsx from 'clsx';
import { ShuttleMarker } from './ShuttleMarker';
import { buttonVariants, cn } from './ui/styles';
import { NEUTRAL_ROUTE_COLOR, bboxOf, relativeLuminance } from './mapUtils';
import type { Stop, Vehicle, RoutePath, TripResponse, TripSegment } from './types';
import { API_BASE_URL, MAP_MAX_ZOOM, MAP_MIN_ZOOM, MAP_STYLE_DARK, MAP_STYLE_LIGHT } from '@/config';

/** The read-only status pill, shared by the mobile top bar and the desktop
 * bottom bar. They had drifted to different grounds, paddings and text sizes
 * while saying the same thing. It is not a Button — nothing here is
 * clickable — so it carries the `overlay` variant's surface by hand. */
const STATUS_PILL =
    'flex h-9 items-center justify-center rounded-full border border-white/10 ' +
    'bg-neutral-900/85 px-3.5 text-[11px] font-medium leading-none text-neutral-300 ' +
    'shadow-lg backdrop-blur-md';

/** "1 bus", "2 buses", "0 buses". One helper so the two status pills cannot
 * drift apart again. */
const busCount = (n: number) => `${n} ${n === 1 ? 'bus' : 'buses'}`;

// Fallback palette for trip segments whose route carries no colour.
const FALLBACK_ROUTE_COLORS = ['#ef4444', '#22c55e', '#3b82f6', '#f59e0b', '#a855f7', '#14b8a6', '#f97316', '#ec4899'];

type Bbox = [number, number, number, number];

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
     * focus implementation. */
    focusRouteId?: string | null;
}

/* Route ids arrive from two endpoints — /routes and /departures — and the
   backend has already been bitten once by comparing them case-sensitively.
   Compared loosely here for the same reason. */
const sameRoute = (a: string | null | undefined, b: string | null | undefined) =>
    a != null && b != null && String(a).trim().toLowerCase() === String(b).trim().toLowerCase();

function tripBbox(trip: TripResponse | null): Bbox | null {
    if (!trip) return null;
    const pts: [number, number][] = [];
    const o = trip.origin.nearest_stop;
    const d = trip.destination.nearest_stop;
    if (o) pts.push([o.lng, o.lat]);
    if (d) pts.push([d.lng, d.lat]);
    for (const segment of trip.segments ?? []) {
        for (const s of segment.stops ?? []) pts.push([s.lng, s.lat]);
        for (const p of segment.polyline ?? []) pts.push([p.lng, p.lat]);
    }
    return bboxOf(pts);
}

function tripKeyOf(trip: TripResponse | null): string | null {
    if (!trip) return null;
    return `${trip.system_id}:${trip.origin?.nearest_stop?.id ?? ''}:${trip.destination?.nearest_stop?.id ?? ''}`;
}

/** Padding that keeps a fitted view clear of the UI. The bottom sheet covers
 * roughly the lower 45% of the screen on mobile and the panel the left 424px
 * on desktop; fitting to the whole viewport would put half of every route
 * behind them. maxZoom keeps a two-stop hop at neighbourhood scale rather than
 * doorstep. */
function fitOptions() {
    const narrow = window.innerWidth < 768;
    return narrow
        ? { padding: { top: 40, left: 30, right: 30, bottom: Math.round(window.innerHeight * 0.48) }, maxZoom: 16, duration: 650 }
        : { padding: { top: 60, left: 430, right: 60, bottom: 60 }, maxZoom: 16, duration: 650 };
}

const toLngLatBounds = (b: Bbox): LngLatBoundsLike => [[b[0], b[1]], [b[2], b[3]]];

export const MapShell = ({ systemId, trip, userLocation, focusRouteId }: MapShellProps) => {
    const mapRef = useRef<MapRef>(null);
    const [mapReady, setMapReady] = useState(false);

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
    const [selectedStop, setSelectedStop] = useState<Stop | null>(null);
    const routeSettingsRef = useRef<HTMLDivElement>(null);

    // Basemap ground: dark by default, light on request. Only the style
    // changes — chrome and route colours stay — and the choice is remembered.
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

    // ------------------------------------------------------------------ data

    useEffect(() => {
        if (!systemId) {
            // eslint-disable-next-line react-hooks/set-state-in-effect
            setStops([]);
            setVehicles([]);
            setRoutes([]);
            return;
        }
        setLoading(true);
        fetch(`${API_BASE_URL}/stops?system_id=${systemId}`)
            .then((res) => res.json())
            .then((data: Stop[]) => setStops(Array.isArray(data) ? data : []))
            .catch((err) => console.error('Failed to fetch stops', err))
            .finally(() => setLoading(false));
    }, [systemId]);

    // Poll vehicles every few seconds.
    useEffect(() => {
        if (!systemId) return;
        let cancelled = false;
        const fetchVehicles = () => {
            fetch(`${API_BASE_URL}/vehicles?system_id=${systemId}`)
                .then((res) => { if (!res.ok) throw new Error(); return res.json(); })
                .then((data) => { if (!cancelled) { setVehicles(Array.isArray(data) ? data : []); setVehiclesError(false); } })
                .catch(() => { if (!cancelled) setVehiclesError(true); });
        };
        fetchVehicles();
        const id = setInterval(fetchVehicles, 3000);
        return () => { cancelled = true; clearInterval(id); };
    }, [systemId]);

    // Geometry is needed whenever anything wants to draw a route: the Show
    // Routes toggle, or a single focused route.
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
            .then((data: RoutePath[]) => { setRoutes(Array.isArray(data) ? data : []); setRoutesError(false); })
            .catch(() => { setRoutes([]); setRoutesError(true); })
            .finally(() => setLoadingRoutes(false));
    }, [systemId, needRoutes]);

    useEffect(() => {
        if (routes.length === 0) return;
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setRouteVisibility((prev) => {
            const next = { ...prev };
            for (const r of routes) if (!(r.route_id in next)) next[r.route_id] = true;
            return next;
        });
    }, [routes]);

    // Close the filter on outside click.
    useEffect(() => {
        if (!showRouteSettings) return;
        const handler = (e: MouseEvent) => {
            const target = e.target as HTMLElement;
            if (routeSettingsRef.current && !routeSettingsRef.current.contains(target) && !target.closest('[data-route-settings-trigger]')) {
                setShowRouteSettings(false);
            }
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, [showRouteSettings]);

    // Auto-off "Show Routes" the first time a trip is drawn, so the trip is
    // the only line on the map.
    const previousTripRef = useRef<TripResponse | null>(null);
    const hasAutoDisabledRoutes = useRef(false);
    useEffect(() => {
        const hadTripBefore = previousTripRef.current !== null;
        const hasTripNow = trip !== null;
        if (!hadTripBefore && hasTripNow && showRoutes && !hasAutoDisabledRoutes.current) {
            setShowRoutes(false);
            hasAutoDisabledRoutes.current = true;
        }
        previousTripRef.current = trip;
    }, [trip, showRoutes]);

    const toggleRouteVisibility = (routeId: string) =>
        setRouteVisibility((prev) => ({ ...prev, [routeId]: prev[routeId] === false }));

    const handleRouteSettingsClick = () => {
        if (!showRouteSettings && !showRoutes) setShowRoutes(true);
        setShowRouteSettings((prev) => !prev);
    };

    // ---------------------------------------------------------------- bounds

    const systemBbox = useMemo(() => bboxOf(stops.map((s) => [s.lng, s.lat] as [number, number])), [stops]);

    // The launch/overview view. Stops define the network, but a bus can sit
    // just outside their envelope, so vehicles are folded in to guarantee
    // every bus in service is on screen.
    const overviewBbox = useMemo<Bbox | null>(() => {
        if (!systemBbox) return null;
        const pts: [number, number][] = [[systemBbox[0], systemBbox[1]], [systemBbox[2], systemBbox[3]]];
        for (const v of vehicles) if (typeof v.lat === 'number' && typeof v.lng === 'number') pts.push([v.lng, v.lat]);
        return bboxOf(pts);
    }, [systemBbox, vehicles]);

    const focusRoute = useMemo(
        () => (focusRouteId ? routes.find((r) => sameRoute(r.route_id, focusRouteId)) ?? null : null),
        [routes, focusRouteId],
    );
    const focusRouteBbox = useMemo(
        () => (focusRoute?.path?.length ? bboxOf(focusRoute.path.map((p) => [p.lng, p.lat] as [number, number])) : null),
        [focusRoute],
    );
    const tripBox = useMemo(() => tripBbox(trip), [trip]);

    // A planned trip wins: it is the more specific answer, and it is what the
    // rider asked for last.
    const activeBbox = tripBox ?? focusRouteBbox;
    const activeKey = useMemo(
        () => tripKeyOf(trip) ?? (focusRouteId ? `route:${focusRouteId}` : null),
        [trip, focusRouteId],
    );

    // Fit the whole network on launch, once per system.
    const hasInitialFit = useRef(false);
    useEffect(() => { hasInitialFit.current = false; }, [systemId]);
    useEffect(() => {
        const map = mapRef.current;
        if (!map || !mapReady || !overviewBbox || hasInitialFit.current) return;
        map.fitBounds(toLngLatBounds(overviewBbox), { ...fitOptions(), duration: 0 });
        hasInitialFit.current = true;
    }, [mapReady, overviewBbox]);

    // Trip / departure framing, and the return to the overview.
    const lastFramedKey = useRef<string | null>(null);
    useEffect(() => {
        const map = mapRef.current;
        if (!map || !mapReady) return;
        if (activeBbox && activeKey) {
            // Only reframe for a different trip or departure, so live updates
            // do not fight the user's panning.
            if (activeKey !== lastFramedKey.current) {
                map.fitBounds(toLngLatBounds(activeBbox), fitOptions());
                lastFramedKey.current = activeKey;
            }
            return;
        }
        // Nothing selected any more. If something was, deselecting is a request
        // to see the whole network again.
        if (lastFramedKey.current !== null) {
            lastFramedKey.current = null;
            if (overviewBbox) map.fitBounds(toLngLatBounds(overviewBbox), fitOptions());
        }
    }, [mapReady, activeBbox, activeKey, overviewBbox]);

    const recenter = () => {
        const map = mapRef.current;
        if (!map) return;
        const target = activeBbox ?? overviewBbox;
        if (target) map.fitBounds(toLngLatBounds(target), fitOptions());
    };

    // ------------------------------------------------------------- geometry

    // Which routes draw: all visible ones when Show Routes is on; otherwise
    // only the focused route. Being told a bus is coming is not useful without
    // seeing where it goes, so the focused route draws whether or not the
    // toggle is on.
    //
    // How they draw: with no focus, every route at the same weight. With a
    // focus, that route is heavier and the rest step back thin and translucent.
    // Once a trip is planned on top, the trip line takes over and the route
    // drops to a thin context line underneath.
    //
    // Draw order is stacking order, and routes share roads: light colours
    // first as ground, saturated last as figure, so crimson sits on cream where
    // they overlap. Luminance, not a route list, so the rule survives a palette
    // change. The focused route always draws last.
    const routesGeoJson = useMemo(() => {
        const features = routes
            .filter((r) => {
                if (!r.path?.length) return false;
                const isFocus = focusRoute != null && sameRoute(r.route_id, focusRoute.route_id);
                return isFocus || (showRoutes && routeVisibility[r.route_id] !== false);
            })
            .sort((a, b) => {
                const af = focusRoute != null && sameRoute(a.route_id, focusRoute.route_id);
                const bf = focusRoute != null && sameRoute(b.route_id, focusRoute.route_id);
                if (af !== bf) return af ? 1 : -1;
                return (relativeLuminance(b.color) ?? 0) - (relativeLuminance(a.color) ?? 0);
            })
            .map((r, order) => {
                const isFocus = focusRoute != null && sameRoute(r.route_id, focusRoute.route_id);
                let weight = 4, opacity = 1;
                if (focusRoute) {
                    if (!isFocus) { weight = 3; opacity = 0.3; }
                    else if (trip) { weight = 2; opacity = 0.4; }
                    else { weight = 5; }
                }
                return {
                    type: 'Feature' as const,
                    properties: { color: r.color || NEUTRAL_ROUTE_COLOR, weight, opacity, order },
                    geometry: { type: 'LineString' as const, coordinates: r.path.map((p) => [p.lng, p.lat]) },
                };
            });
        return { type: 'FeatureCollection' as const, features };
    }, [routes, focusRoute, showRoutes, routeVisibility, trip]);

    const tripGeoJson = useMemo(() => {
        const segments = trip?.segments ?? [];
        const features = segments.map((seg: TripSegment, idx: number) => {
            const pts = seg.polyline?.length ? seg.polyline : (seg.stops ?? []);
            return {
                type: 'Feature' as const,
                properties: { color: seg.color || FALLBACK_ROUTE_COLORS[idx % FALLBACK_ROUTE_COLORS.length], weight: 6, opacity: 1, order: idx },
                geometry: { type: 'LineString' as const, coordinates: pts.map((p) => [p.lng, p.lat]) },
            };
        });
        return { type: 'FeatureCollection' as const, features };
    }, [trip]);

    const tripStopIds = useMemo(() => {
        const ids = new Set<string | number>();
        if (trip?.origin?.nearest_stop?.id) ids.add(trip.origin.nearest_stop.id);
        if (trip?.destination?.nearest_stop?.id) ids.add(trip.destination.nearest_stop.id);
        return ids;
    }, [trip]);

    // Line width follows zoom gently — a touch thinner zoomed out, a touch
    // heavier at building scale — and is otherwise the weight the feature
    // asks for. Rendered by the GPU every frame, so there is nothing to snap.
    const lineWidth = [
        'interpolate', ['linear'], ['zoom'],
        13, ['*', ['get', 'weight'], 0.6],
        16, ['get', 'weight'],
        19, ['*', ['get', 'weight'], 1.5],
    ];

    // ------------------------------------------------------------------- ui

    return (
        <div className={cn('relative h-full w-full bg-neutral-900', isLight && 'map-light')}>
            {systemId ? (
                <Map
                    key={systemId}
                    ref={mapRef}
                    mapStyle={isLight ? MAP_STYLE_LIGHT : MAP_STYLE_DARK}
                    initialViewState={{ longitude: -71.1167, latitude: 42.3736, zoom: 14 }}
                    minZoom={MAP_MIN_ZOOM}
                    maxZoom={MAP_MAX_ZOOM}
                    // North-up. Rotation and pitch add nothing to a campus
                    // shuttle map and a two-finger gesture that rotates by
                    // accident is a map you cannot read.
                    dragRotate={false}
                    pitchWithRotate={false}
                    touchPitch={false}
                    attributionControl={{ compact: true }}
                    // MapLibre reports style, tile and WebGL failures as map
                    // events, not console errors. Without this a broken
                    // basemap is a silent dark rectangle.
                    onError={(e) => console.error('[map]', e.error?.message ?? e.error ?? e)}
                    style={{ width: '100%', height: '100%' }}
                    onLoad={(e) => {
                        e.target.touchZoomRotate.disableRotation();
                        // Dev only: a handle for poking the live map from the
                        // console or a test harness. Stripped from production.
                        if (import.meta.env.DEV) (window as unknown as { __map?: unknown }).__map = e.target;
                        setMapReady(true);
                    }}
                >
                    {/* Route lines. One source, one layer; per-feature colour,
                        weight and opacity from properties, draw order from
                        line-sort-key. */}
                    <Source id="routes" type="geojson" data={routesGeoJson}>
                        <Layer
                            id="routes-line"
                            type="line"
                            layout={{ 'line-cap': 'round', 'line-join': 'round', 'line-sort-key': ['get', 'order'] }}
                            paint={{ 'line-color': ['get', 'color'], 'line-width': lineWidth as never, 'line-opacity': ['get', 'opacity'] }}
                        />
                    </Source>

                    {/* Planned trip, solid in the route colour, above the routes. */}
                    <Source id="trip" type="geojson" data={tripGeoJson}>
                        <Layer
                            id="trip-line"
                            type="line"
                            layout={{ 'line-cap': 'round', 'line-join': 'round', 'line-sort-key': ['get', 'order'] }}
                            paint={{ 'line-color': ['get', 'color'], 'line-width': lineWidth as never, 'line-opacity': ['get', 'opacity'] }}
                        />
                    </Source>

                    {/* Stops: dots with a generous tap target. */}
                    {stops.map((stop) => {
                        const isTripStop = tripStopIds.has(stop.id);
                        return (
                            <Marker
                                key={stop.id}
                                longitude={stop.lng}
                                latitude={stop.lat}
                                anchor="center"
                                style={{ zIndex: isTripStop ? 5 : 1 }}
                                onClick={(e) => { e.originalEvent.stopPropagation(); setSelectedStop(stop); }}
                            >
                                {isTripStop
                                    ? <div className="trip-endpoint-container"><div className="trip-endpoint-dot" /></div>
                                    : <div className="stop-marker-container"><div className="stop-marker-dot" /></div>}
                            </Marker>
                        );
                    })}

                    {selectedStop && (
                        <Popup
                            longitude={selectedStop.lng}
                            latitude={selectedStop.lat}
                            anchor="bottom"
                            offset={14}
                            closeButton={false}
                            onClose={() => setSelectedStop(null)}
                        >
                            <div className="text-sm">
                                <div className="font-semibold text-white">{selectedStop.name}</div>
                                <div className="text-xs text-neutral-400">Stop ID: {selectedStop.id}</div>
                            </div>
                        </Popup>
                    )}

                    {userLocation && (
                        <Marker longitude={userLocation.lng} latitude={userLocation.lat} anchor="center" style={{ zIndex: 6 }}>
                            <div className="user-location-container"><div className="user-location-dot" /></div>
                        </Marker>
                    )}

                    {vehicles
                        .filter((v): v is Vehicle & { lat: number; lng: number } => typeof v.lat === 'number' && typeof v.lng === 'number')
                        .map((v) => <ShuttleMarker key={v.id} v={v} durationMs={3000} />)}
                </Map>
            ) : (
                <div className="flex h-full w-full items-center justify-center text-neutral-400">
                    Select a system to view map
                </div>
            )}

            {/* 1. Mobile Top Bar (hidden on desktop) */}
            <div className="md:hidden fixed top-4 inset-x-4 z-[1000] grid grid-cols-[1fr_auto_1fr] items-center pointer-events-none">
                <div className={cn(STATUS_PILL, 'justify-self-start pointer-events-auto min-w-[32px]')}>
                    {systemId
                        ? loading ? '…' : <span className="whitespace-nowrap">{busCount(vehicles.length)}</span>
                        : 'Select system'}
                </div>

                {systemId ? (
                    <div className="pointer-events-auto flex items-center gap-1.5">
                        <button type="button" onClick={recenter} className={cn(buttonVariants({ variant: 'overlay', size: 'icon' }), 'text-white')} aria-label="Recenter map">
                            <NavigationIcon size={14} className="fill-current -translate-x-[1px] translate-y-[1px]" />
                        </button>
                        <button
                            type="button"
                            data-route-settings-trigger
                            onClick={handleRouteSettingsClick}
                            className={buttonVariants({ variant: showRouteSettings ? 'selected' : 'overlay', size: 'icon' })}
                            aria-label="Filter routes"
                        >
                            <Settings size={14} />
                        </button>
                        <button type="button" onClick={toggleBasemap} className={buttonVariants({ variant: 'overlay', size: 'icon' })} aria-label={isLight ? 'Switch to dark map' : 'Switch to light map'}>
                            {isLight ? <Moon size={14} /> : <Sun size={14} />}
                        </button>
                    </div>
                ) : <div />}

                <button
                    type="button"
                    onClick={() => setShowRoutes((prev) => !prev)}
                    aria-pressed={showRoutes}
                    aria-label={showRoutes ? 'Hide routes' : 'Show routes'}
                    className={cn(buttonVariants({ variant: showRoutes ? 'selected' : 'overlay', size: 'icon' }), 'justify-self-end pointer-events-auto')}
                >
                    <RouteIcon size={14} />
                </button>
            </div>

            {/* 2. Desktop bottom controls (hidden on mobile). Centred in the map
                area beside the 400px panel, not the full width — centred in the
                full width they landed under the panel at tablet widths. */}
            <div className="hidden md:flex pointer-events-none absolute bottom-8 left-[424px] right-0 flex-row flex-wrap items-center justify-center gap-3 px-6 z-[1000]">
                <div className="pointer-events-auto">
                    <button
                        type="button"
                        onClick={() => setShowRoutes((prev) => !prev)}
                        className={cn(buttonVariants({ variant: showRoutes ? 'selected' : 'overlay', size: 'md' }), 'rounded-full')}
                    >
                        {showRoutes ? 'Hide Routes' : 'Show Routes'}
                        {loadingRoutes && showRoutes && <div className="h-3 w-3 animate-spin rounded-full border-2 border-white/25 border-t-white" />}
                    </button>
                </div>
                <div className="pointer-events-auto">
                    <button
                        type="button"
                        data-route-settings-trigger
                        onClick={handleRouteSettingsClick}
                        className={cn(buttonVariants({ variant: showRouteSettings ? 'selected' : 'overlay', size: 'md' }), 'rounded-full')}
                    >
                        <Settings size={12} />
                        <span>Filter</span>
                    </button>
                </div>
                <div className="pointer-events-auto">
                    <button type="button" onClick={toggleBasemap} className={buttonVariants({ variant: 'overlay', size: 'icon' })} aria-label={isLight ? 'Switch to dark map' : 'Switch to light map'} title={isLight ? 'Dark map' : 'Light map'}>
                        {isLight ? <Moon size={13} /> : <Sun size={13} />}
                    </button>
                </div>
                <div className="pointer-events-none flex flex-col items-center gap-1.5">
                    <div className={STATUS_PILL}>
                        {systemId ? (loading ? 'Loading stops…' : `${stops.length} stops • ${busCount(vehicles.length)}`) : 'Select a system to begin'}
                    </div>
                    {(vehiclesError || routesError) && (
                        <p className="animate-pulse-subtle rounded-full border border-crimson-mid/40 bg-crimson-deep/30 px-3 py-1 text-[10px] font-medium text-crimson-light backdrop-blur-sm">
                            {vehiclesError && routesError ? 'Real-time data unavailable' : vehiclesError ? 'Vehicle tracking unavailable' : 'Route information unavailable'}
                        </p>
                    )}
                </div>
            </div>

            {/* Desktop Recenter */}
            {systemId && (
                <button
                    type="button"
                    title="Recenter visible area"
                    onClick={recenter}
                    className={cn(buttonVariants({ variant: 'overlay', size: 'md' }), 'pointer-events-auto absolute right-6 bottom-32 z-[1000] hidden rounded-full shadow-xl md:flex')}
                >
                    Recenter
                </button>
            )}

            {/* Route filter */}
            {showRouteSettings && (
                <div
                    ref={routeSettingsRef}
                    className="fixed z-[1001] top-16 left-4 right-4 md:absolute md:top-auto md:bottom-24 md:left-1/2 md:-translate-x-1/2 md:w-72 md:right-auto rounded-xl bg-black/80 backdrop-blur-xl border border-white/10 shadow-2xl p-3 max-h-[60vh] overflow-y-auto"
                >
                    <div className="mb-2 flex items-center justify-between px-1">
                        <span className="text-[10px] font-bold uppercase tracking-wider text-neutral-500">Filter routes</span>
                        <button type="button" onClick={() => setShowRouteSettings(false)} aria-label="Close route filter" className={buttonVariants({ variant: 'ghost', size: 'iconSm' })}>
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
                            {routes.map((r) => {
                                const isVisible = routeVisibility[r.route_id] !== false;
                                const color = r.color || '#a51c30';
                                return (
                                    <button key={r.route_id} type="button" onClick={() => toggleRouteVisibility(r.route_id)} className="flex items-center gap-2.5 w-full py-2 px-2 rounded-lg hover:bg-white/5 transition-colors">
                                        <div className="h-2.5 w-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: isVisible ? color : 'transparent', border: isVisible ? 'none' : `2px solid ${color}` }} />
                                        <span className={clsx('text-[11px] flex-1 text-left truncate transition-colors', isVisible ? 'text-neutral-200' : 'text-neutral-500')}>
                                            {r.route_name || r.short_name || `Route ${r.route_id}`}
                                        </span>
                                        {/* Quiet track, white knob: nine of these are on by default and a
                                            bright crimson track drowned out the route colour dot beside it. */}
                                        <div className={clsx('flex h-5 w-9 flex-shrink-0 items-center rounded-full border px-0.5 transition-colors duration-200', isVisible ? 'border-crimson-mid/60 bg-crimson-deep/60' : 'border-white/5 bg-neutral-700')}>
                                            <div className={clsx('h-3.5 w-3.5 rounded-full transition-transform duration-200', isVisible ? 'translate-x-[14px] bg-white' : 'translate-x-0 bg-neutral-400')} />
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
