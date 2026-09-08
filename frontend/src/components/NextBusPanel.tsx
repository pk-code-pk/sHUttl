/**
 * Next Bus Out.
 *
 * The trip planner answers "how do I get from A to B". This answers the
 * question people ask far more often while standing on a sidewalk: "what is
 * leaving from here, and when". Location in, departures out — no inputs.
 *
 * It lists stops within a short walk, not just the nearest one, because the
 * nearest stop is regularly the wrong answer: a bus in 2 minutes from a stop
 * 200 m away beats a bus in 14 minutes from the one you are standing at. The
 * walk is shown on every row so that trade-off is visible, and a bus that will
 * be gone before you could reach its stop is separated out rather than
 * presented as something you can catch.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { ChevronDown, Footprints, LocateFixed, MapPin, RefreshCw, TriangleAlert } from 'lucide-react';
import clsx from 'clsx';
import { API_BASE_URL } from '@/config';

interface DepartureStop {
    id: string;
    name: string;
    lat: number;
    lng: number;
}

export interface ToStop {
    id: string;
    name: string;
    lat: number;
    lng: number;
    minutes: number;
    arrives_at: string;
    source: string;
}

export interface Departure {
    route_id: string;
    route_name: string | null;
    short_name: string | null;
    color: string | null;
    headsign: string | null;
    eta_minutes: number;
    eta_source: string;
    stop: DepartureStop;
    walk_m: number;
    walk_minutes: number;
    catchable: boolean;
    following_minutes: number[];
    to_stops: ToStop[];
}

interface DeparturesResponse {
    nearest_stop: DepartureStop;
    nearest_stop_distance_m: number;
    out_of_range: boolean;
    departures: Departure[];
    generated_at: string;
}

interface NextBusPanelProps {
    systemId: number | undefined;
    /** Draws the selected departure's route and downstream stops on the map. */
    onFocusDeparture?: (departure: Departure | null) => void;
}

const REFRESH_MS = 15000;

/** "3 min" reads better than "3.4 min", and sub-minute is "now" — a rider
 * cannot act on 40 seconds of precision. */
function formatEta(minutes: number): string {
    if (minutes < 1) return 'now';
    return `${Math.round(minutes)} min`;
}

function formatWalk(minutes: number, meters: number): string {
    if (meters < 40) return 'here';
    const m = Math.max(1, Math.round(minutes));
    return `${m} min walk`;
}

export const NextBusPanel = ({ systemId, onFocusDeparture }: NextBusPanelProps) => {
    // Which row is open. Selecting one both expands its stop list and asks the
    // map to draw the route, because "when does it come" and "where does it go"
    // are the same question for someone who does not already know the route.
    const [openKey, setOpenKey] = useState<string | null>(null);
    const [data, setData] = useState<DeparturesResponse | null>(null);
    const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [locating, setLocating] = useState(false);
    const coordsRef = useRef<{ lat: number; lng: number } | null>(null);

    // Manual stop fallback. Geolocation fails often enough on desktop —
    // Location Services disabled for the browser, or no Wi-Fi to trilaterate
    // from, which surfaces as kCLErrorLocationUnknown on macOS — that a mode
    // built entirely on location needs a way to work without it. Picking a
    // stop by hand is the same query from a chosen origin.
    const [stops, setStops] = useState<{ id: string; name: string; lat: number; lng: number }[]>([]);
    const [manualStopId, setManualStopId] = useState('');
    const [showStopPicker, setShowStopPicker] = useState(false);

    const locate = useCallback(() => {
        if (!navigator.geolocation) {
            setError('This browser cannot share your location.');
            return;
        }
        setLocating(true);
        setError(null);
        navigator.geolocation.getCurrentPosition(
            (pos) => {
                const next = { lat: pos.coords.latitude, lng: pos.coords.longitude };
                coordsRef.current = next;
                setCoords(next);
                setLocating(false);
            },
            (err) => {
                setLocating(false);
                // Distinguish the causes, because the fix differs: denied is a
                // browser prompt, unavailable is usually the OS withholding
                // location from the browser entirely, and neither is helped by
                // a generic "could not get your location".
                if (err.code === err.PERMISSION_DENIED) {
                    setError('Location permission denied. Allow it, or pick a stop below.');
                } else if (err.code === err.TIMEOUT) {
                    setError('Location is taking too long. Pick a stop below instead.');
                } else {
                    setError(
                        'Your browser could not determine your location. On macOS, ' +
                        'enable Location Services for it in System Settings — or just ' +
                        'pick a stop below.',
                    );
                }
                setShowStopPicker(true);
            },
            // High accuracy is not worth much here: stops are hundreds of
            // metres apart, and requesting it makes failures more likely on
            // desktops with no GPS.
            { enableHighAccuracy: false, timeout: 8000, maximumAge: 60000 },
        );
    }, []);

    // Ask on mount: the whole point of this mode is that it needs no input.
    useEffect(() => {
        locate();
    }, [locate]);

    // Stops are only needed for the fallback picker, so they are fetched once
    // the picker is actually wanted rather than on every mount.
    useEffect(() => {
        if (!showStopPicker || !systemId || stops.length > 0) return;
        fetch(`${API_BASE_URL}/stops?system_id=${systemId}`)
            .then((r) => (r.ok ? r.json() : []))
            .then((d) => setStops(d || []))
            .catch(() => setStops([]));
    }, [showStopPicker, systemId, stops.length]);

    const chooseStop = useCallback((stopId: string) => {
        setManualStopId(stopId);
        const stop = stops.find((s) => s.id.toString() === stopId);
        if (!stop) return;
        // Same query, just from a stated origin instead of a measured one.
        coordsRef.current = { lat: stop.lat, lng: stop.lng };
        setCoords({ lat: stop.lat, lng: stop.lng });
        setError(null);
    }, [stops]);

    const fetchDepartures = useCallback(
        async (silent = false) => {
            const at = coordsRef.current;
            if (!at || !systemId) return;
            if (!silent) setLoading(true);
            try {
                const params = new URLSearchParams({
                    lat: at.lat.toString(),
                    lng: at.lng.toString(),
                    system_id: String(systemId),
                });
                const res = await fetch(`${API_BASE_URL}/departures?${params}`);
                if (!res.ok) throw new Error(`Departures failed (${res.status})`);
                setData(await res.json());
                setError(null);
            } catch (e) {
                // A failed silent refresh keeps the last good list on screen;
                // stale departures beat an empty panel.
                if (!silent) {
                    setError(e instanceof Error ? e.message : 'Could not load departures.');
                }
            } finally {
                if (!silent) setLoading(false);
            }
        },
        [systemId],
    );

    useEffect(() => {
        if (!coords) return;
        void fetchDepartures();
        const id = window.setInterval(() => void fetchDepartures(true), REFRESH_MS);
        return () => window.clearInterval(id);
    }, [coords, fetchDepartures]);

    const catchable = data?.departures.filter((d) => d.catchable) ?? [];
    const missed = data?.departures.filter((d) => !d.catchable) ?? [];

    const keyFor = (d: Departure, i: number) => `${d.route_id}-${d.stop.id}-${i}`;

    const toggleRow = (d: Departure, key: string) => {
        const next = openKey === key ? null : key;
        setOpenKey(next);
        onFocusDeparture?.(next ? d : null);
    };

    return (
        <div className="flex flex-col flex-1 min-h-0 pt-1">
            {/* Where we think you are */}
            <div className="flex items-center justify-between shrink-0 pb-2">
                <div className="flex items-center gap-1.5 min-w-0">
                    <LocateFixed size={12} className="text-neutral-300 shrink-0" />
                    <span className="text-[11px] text-neutral-300 truncate">
                        {locating
                            ? 'Finding you…'
                            : data
                              ? <>{manualStopId ? 'From: ' : 'Nearest: '}<span className="font-semibold text-white">{data.nearest_stop.name}</span></>
                              : 'Location needed'}
                    </span>
                </div>
                <button
                    type="button"
                    onClick={() => setShowStopPicker((v) => !v)}
                    aria-label="Choose a stop manually"
                    className="ml-auto mr-1 rounded-full bg-neutral-800/50 p-1.5 text-neutral-400 hover:bg-neutral-800 hover:text-white transition-colors"
                >
                    <MapPin size={12} />
                </button>
                <button
                    type="button"
                    onClick={() => (coords ? void fetchDepartures() : locate())}
                    aria-label="Refresh departures"
                    className="rounded-full bg-neutral-800/50 p-1.5 text-neutral-400 hover:bg-neutral-800 hover:text-white transition-colors"
                >
                    <RefreshCw size={12} className={clsx(loading && 'animate-spin')} />
                </button>
            </div>

            {error && (
                <div className="mb-2 flex items-start gap-2 rounded-lg bg-amber-500/10 px-2.5 py-2">
                    <TriangleAlert size={12} className="mt-0.5 shrink-0 text-amber-400" />
                    <div className="min-w-0">
                        <p className="text-[10px] leading-relaxed text-amber-200">{error}</p>
                        <button
                            type="button"
                            onClick={locate}
                            className="mt-1 text-[10px] font-bold uppercase tracking-wider text-amber-300 hover:text-amber-100"
                        >
                            Try again
                        </button>
                    </div>
                </div>
            )}

            {showStopPicker && (
                <div className="mb-2 shrink-0">
                    <label className="mb-1 flex items-center gap-1 px-0.5 text-[9px] font-bold uppercase tracking-wider text-neutral-500">
                        <MapPin size={9} /> Departures from
                    </label>
                    <select
                        value={manualStopId}
                        onChange={(e) => chooseStop(e.target.value)}
                        className="w-full rounded-lg border border-white/5 bg-neutral-800/60 px-2.5 py-2 text-[11px] text-white outline-none focus:border-neutral-400/60"
                    >
                        <option value="">Choose a stop…</option>
                        {stops.map((s) => (
                            <option key={s.id} value={s.id}>{s.name}</option>
                        ))}
                    </select>
                </div>
            )}

            {data?.out_of_range && (
                <div className="rounded-lg bg-neutral-800/50 px-3 py-4 text-center">
                    <p className="text-[11px] text-neutral-300">
                        You are {(data.nearest_stop_distance_m / 1000).toFixed(1)} km from the
                        nearest stop ({data.nearest_stop.name}).
                    </p>
                    <p className="mt-1 text-[10px] text-neutral-500">
                        Next Bus Out works on campus. Use Plan Trip to route from here.
                    </p>
                </div>
            )}

            <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain touch-pan-y custom-scrollbar pr-1 pb-2 space-y-1.5">
                {!data && !error && !locating && (
                    <div className="py-6 text-center">
                        <p className="text-[11px] text-neutral-500">
                            Share your location to see what is leaving nearby.
                        </p>
                        <button
                            type="button"
                            onClick={() => setShowStopPicker(true)}
                            className="mt-2 text-[10px] font-bold uppercase tracking-wider text-neutral-300 hover:text-white"
                        >
                            Or pick a stop
                        </button>
                    </div>
                )}

                {data && !data.out_of_range && catchable.length === 0 && (
                    <div className="py-6 text-center">
                        <p className="text-[11px] text-neutral-400">No buses running nearby.</p>
                        <p className="mt-1 text-[10px] text-neutral-500">
                            Shuttles may be out of service right now.
                        </p>
                    </div>
                )}

                {catchable.map((d, i) => {
                    const key = keyFor(d, i);
                    return (
                        <DepartureRow
                            key={key}
                            departure={d}
                            open={openKey === key}
                            onClick={() => toggleRow(d, key)}
                        />
                    );
                })}

                {missed.length > 0 && (
                    <>
                        <p className="pt-2 text-[9px] font-bold uppercase tracking-wider text-neutral-600">
                            Too soon to reach
                        </p>
                        {missed.map((d, i) => {
                            const key = `missed-${keyFor(d, i)}`;
                            return (
                                <DepartureRow
                                    key={key}
                                    departure={d}
                                    dimmed
                                    open={openKey === key}
                                    onClick={() => toggleRow(d, key)}
                                />
                            );
                        })}
                    </>
                )}
            </div>
        </div>
    );
};

const DepartureRow = ({
    departure: d,
    dimmed = false,
    open = false,
    onClick,
}: {
    departure: Departure;
    dimmed?: boolean;
    open?: boolean;
    onClick?: () => void;
}) => (
    <motion.div
        initial={{ opacity: 0, y: 4 }}
        animate={{ opacity: dimmed && !open ? 0.45 : 1, y: 0 }}
        transition={{ duration: 0.18 }}
        className={clsx(
            'overflow-hidden rounded-xl transition-colors',
            open ? 'bg-neutral-800/80 ring-1 ring-neutral-100/30' : 'bg-neutral-800/40',
        )}
    >
        <button
            type="button"
            onClick={onClick}
            aria-expanded={open}
            className="w-full px-3 py-2.5 text-left hover:bg-white/5"
        >
            <div className="flex items-center gap-2.5">
                <span
                    className="shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-black text-white"
                    style={{ backgroundColor: d.color ?? '#525252' }}
                >
                    {d.short_name ?? d.route_id}
                </span>

                <div className="min-w-0 flex-1">
                    <p className="truncate text-[12px] font-semibold leading-tight text-white">
                        {d.headsign ?? d.route_name ?? d.route_id}
                    </p>
                    <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-neutral-400">
                        <span className="truncate">{d.stop.name}</span>
                        <span className="text-neutral-600">·</span>
                        <span className="inline-flex shrink-0 items-center gap-0.5">
                            <Footprints size={9} />
                            {formatWalk(d.walk_minutes, d.walk_m)}
                        </span>
                    </div>
                </div>

                <div className="shrink-0 text-right">
                    <p
                        className={clsx(
                            'text-[13px] font-bold leading-tight',
                            d.eta_minutes < 1 ? 'text-emerald-400' : 'text-white',
                        )}
                    >
                        {formatEta(d.eta_minutes)}
                    </p>
                    {d.following_minutes.length > 0 && (
                        <p className="text-[9px] text-neutral-500">
                            then {d.following_minutes.map((m) => Math.round(m)).join(', ')}
                        </p>
                    )}
                </div>

                <ChevronDown
                    size={12}
                    className={clsx(
                        'shrink-0 text-neutral-500 transition-transform',
                        open && 'rotate-180',
                    )}
                />
            </div>
        </button>

        {/* Where this bus takes you. The route code and headsign are useless to
            anyone who does not already know the route, which is most people. */}
        <AnimatePresence initial={false}>
            {open && (
                <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.2, ease: 'circOut' }}
                >
                    <div className="border-t border-white/5 px-3 py-2">
                        {d.to_stops.length === 0 ? (
                            <p className="py-1 text-[10px] text-neutral-500">
                                Onward stops unavailable for this route.
                            </p>
                        ) : (
                            <ol className="space-y-1">
                                {d.to_stops.map((t) => (
                                    <li key={t.id} className="flex items-center gap-2">
                                        <span
                                            className="h-1.5 w-1.5 shrink-0 rounded-full"
                                            style={{ backgroundColor: d.color ?? '#525252' }}
                                        />
                                        <span className="min-w-0 flex-1 truncate text-[11px] text-neutral-300">
                                            {t.name}
                                        </span>
                                        <span className="shrink-0 text-[10px] tabular-nums text-neutral-500">
                                            {t.arrives_at}
                                        </span>
                                        <span className="w-12 shrink-0 text-right text-[10px] tabular-nums text-neutral-400">
                                            {Math.round(t.minutes)} min
                                        </span>
                                    </li>
                                ))}
                            </ol>
                        )}
                    </div>
                </motion.div>
            )}
        </AnimatePresence>
    </motion.div>
);
