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
import { motion } from 'framer-motion';
import { Footprints, LocateFixed, RefreshCw, TriangleAlert } from 'lucide-react';
import clsx from 'clsx';
import { API_BASE_URL } from '@/config';

interface DepartureStop {
    id: string;
    name: string;
    lat: number;
    lng: number;
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
    /** Highlights the active stop on the map. */
    onFocusStop?: (stop: DepartureStop) => void;
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

export const NextBusPanel = ({ systemId, onFocusStop }: NextBusPanelProps) => {
    const [data, setData] = useState<DeparturesResponse | null>(null);
    const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [locating, setLocating] = useState(false);
    const coordsRef = useRef<{ lat: number; lng: number } | null>(null);

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
                setError(
                    err.code === err.PERMISSION_DENIED
                        ? 'Location permission denied. Allow it to see nearby departures.'
                        : 'Could not get your location.',
                );
            },
            { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 },
        );
    }, []);

    // Ask on mount: the whole point of this mode is that it needs no input.
    useEffect(() => {
        locate();
    }, [locate]);

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

    return (
        <div className="flex flex-col flex-1 min-h-0 pt-1">
            {/* Where we think you are */}
            <div className="flex items-center justify-between shrink-0 pb-2">
                <div className="flex items-center gap-1.5 min-w-0">
                    <LocateFixed size={12} className="text-crimson shrink-0" />
                    <span className="text-[11px] text-neutral-300 truncate">
                        {locating
                            ? 'Finding you…'
                            : data
                              ? <>Nearest: <span className="font-semibold text-white">{data.nearest_stop.name}</span></>
                              : 'Location needed'}
                    </span>
                </div>
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
                    <p className="py-6 text-center text-[11px] text-neutral-500">
                        Share your location to see what is leaving nearby.
                    </p>
                )}

                {data && !data.out_of_range && catchable.length === 0 && (
                    <div className="py-6 text-center">
                        <p className="text-[11px] text-neutral-400">No buses running nearby.</p>
                        <p className="mt-1 text-[10px] text-neutral-500">
                            Shuttles may be out of service right now.
                        </p>
                    </div>
                )}

                {catchable.map((d, i) => (
                    <DepartureRow
                        key={`${d.route_id}-${d.stop.id}-${i}`}
                        departure={d}
                        onClick={() => onFocusStop?.(d.stop)}
                    />
                ))}

                {missed.length > 0 && (
                    <>
                        <p className="pt-2 text-[9px] font-bold uppercase tracking-wider text-neutral-600">
                            Too soon to reach
                        </p>
                        {missed.map((d, i) => (
                            <DepartureRow
                                key={`missed-${d.route_id}-${d.stop.id}-${i}`}
                                departure={d}
                                dimmed
                                onClick={() => onFocusStop?.(d.stop)}
                            />
                        ))}
                    </>
                )}
            </div>
        </div>
    );
};

const DepartureRow = ({
    departure: d,
    dimmed = false,
    onClick,
}: {
    departure: Departure;
    dimmed?: boolean;
    onClick?: () => void;
}) => (
    <motion.button
        type="button"
        onClick={onClick}
        initial={{ opacity: 0, y: 4 }}
        animate={{ opacity: dimmed ? 0.45 : 1, y: 0 }}
        transition={{ duration: 0.18 }}
        className="w-full rounded-xl bg-neutral-800/40 px-3 py-2.5 text-left transition-colors hover:bg-neutral-800/70"
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
        </div>
    </motion.button>
);
