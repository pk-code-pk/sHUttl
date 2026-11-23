/**
 * Routes: pick a route, see where it goes and when its buses get there.
 *
 * Next Bus Out answers "what is leaving near me" and Plan Trip answers "how do
 * I get there". Neither answers "where does the Quad Express go, and when does
 * it reach each stop", which is how people who already ride a route think
 * about it. The full map (every bus, every line) is untouched; this is a second
 * way in, and leaving the tab puts the map back as it was.
 *
 * The list shows every route with how many buses are on it now. Choosing one
 * isolates it on the map (only its line and its buses) and frames it, and the
 * sheet becomes that route's stops in travel order, each with the next two
 * arrivals and where the next bus is heading. Tapping a stop flies the map to
 * it.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { ChevronLeft, ChevronRight, RefreshCw } from 'lucide-react';
import clsx from 'clsx';
import { API_BASE_URL } from '@/config';
import { tapHaptic } from '@/lib/nativeHaptics';
import { textOnRouteColor } from './mapUtils';
import { buttonVariants } from './ui/styles';
import type { RoutePath, Vehicle } from './types';

interface RouteStopArrival {
    minutes: number;
    headsign: string | null;
    scheduled: boolean;
}

interface RouteStop {
    id: string;
    name: string;
    lat: number;
    lng: number;
    arrivals: RouteStopArrival[];
}

interface RouteDetail {
    route_id: string;
    route_name: string;
    short_name: string | null;
    color: string | null;
    buses: number | null;
    stops: RouteStop[];
}

interface RoutesPanelProps {
    systemId?: number;
    /** The route being viewed, or null for the list. The map isolates it. */
    onSelectRoute?: (routeId: string | null) => void;
    /** A stop tapped in the list: fly the map there. */
    onShowStop?: (stop: { lat: number; lng: number }) => void;
}

// Operator predictions are cached for 20 s server-side; refreshing faster
// would only fetch the same numbers.
const DETAIL_REFRESH_MS = 20 * 1000;
const LIST_REFRESH_MS = 15 * 1000;

const sameRoute = (a: string | null | undefined, b: string | null | undefined) =>
    (a ?? '').trim().toLowerCase() === (b ?? '').trim().toLowerCase();

const RouteChip = ({ label, color }: { label: string; color: string | null }) => (
    <span
        className="shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-black"
        style={{ backgroundColor: color ?? '#525252', color: textOnRouteColor(color) }}
    >
        {label}
    </span>
);

export const RoutesPanel = ({ systemId, onSelectRoute, onShowStop }: RoutesPanelProps) => {
    const [routes, setRoutes] = useState<RoutePath[]>([]);
    const [vehicles, setVehicles] = useState<Vehicle[]>([]);
    const [listError, setListError] = useState<string | null>(null);

    const [selected, setSelected] = useState<string | null>(null);
    const [detail, setDetail] = useState<RouteDetail | null>(null);
    const [detailError, setDetailError] = useState<string | null>(null);
    const [loadingDetail, setLoadingDetail] = useState(false);

    // ------------------------------------------------------------- the list

    useEffect(() => {
        if (!systemId) return;
        let cancelled = false;
        fetch(`${API_BASE_URL}/route_paths?system_id=${systemId}`)
            .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
            .then((d: RoutePath[]) => { if (!cancelled) { setRoutes(d || []); setListError(null); } })
            .catch(() => { if (!cancelled) setListError('Routes are unavailable right now.'); });
        return () => { cancelled = true; };
    }, [systemId]);

    useEffect(() => {
        if (!systemId) return;
        let cancelled = false;
        const load = () =>
            fetch(`${API_BASE_URL}/vehicles?system_id=${systemId}`)
                .then((r) => (r.ok ? r.json() : []))
                .then((d: Vehicle[]) => { if (!cancelled) setVehicles(Array.isArray(d) ? d : []); })
                .catch(() => undefined);
        void load();
        const id = setInterval(load, LIST_REFRESH_MS);
        return () => { cancelled = true; clearInterval(id); };
    }, [systemId]);

    const busesOn = useCallback(
        (routeId: string) => vehicles.filter((v) => sameRoute(v.route_id, routeId)).length,
        [vehicles],
    );

    // Running routes first, then by code, so what you can ride now is on top.
    const sortedRoutes = useMemo(
        () =>
            [...routes].sort((a, b) => {
                const ra = busesOn(a.route_id) > 0 ? 0 : 1;
                const rb = busesOn(b.route_id) > 0 ? 0 : 1;
                if (ra !== rb) return ra - rb;
                return (a.short_name ?? a.route_id).localeCompare(b.short_name ?? b.route_id);
            }),
        [routes, busesOn],
    );

    // ----------------------------------------------------------- the detail

    const loadDetail = useCallback(
        async (routeId: string, quiet = false) => {
            if (!systemId) return;
            if (!quiet) setLoadingDetail(true);
            try {
                const r = await fetch(
                    `${API_BASE_URL}/route_stops?system_id=${systemId}&route_id=${encodeURIComponent(routeId)}`,
                );
                if (!r.ok) throw new Error(String(r.status));
                const d = (await r.json()) as RouteDetail;
                setDetail((cur) => (cur && !sameRoute(cur.route_id, routeId) && quiet ? cur : d));
                setDetailError(null);
            } catch {
                if (!quiet) setDetailError('Could not load this route. Try again in a moment.');
            } finally {
                if (!quiet) setLoadingDetail(false);
            }
        },
        [systemId],
    );

    useEffect(() => {
        if (!selected) return;
        void loadDetail(selected);
        const id = setInterval(() => void loadDetail(selected, true), DETAIL_REFRESH_MS);
        return () => clearInterval(id);
    }, [selected, loadDetail]);

    const open = (routeId: string) => {
        tapHaptic();
        setDetail(null);
        setDetailError(null);
        setSelected(routeId);
        onSelectRoute?.(routeId);
    };

    const close = () => {
        tapHaptic();
        setSelected(null);
        setDetail(null);
        onSelectRoute?.(null);
    };

    // Leaving the tab returns the map to the full view.
    useEffect(() => () => onSelectRoute?.(null), [onSelectRoute]);

    const selectedPath = selected ? routes.find((r) => sameRoute(r.route_id, selected)) : null;

    // ---------------------------------------------------------------- views

    return (
        <div className="flex min-h-0 flex-1 flex-col pt-1">
            <AnimatePresence mode="wait" initial={false}>
                {!selected ? (
                    <motion.div
                        key="list"
                        initial={{ opacity: 0, x: -8 }}
                        animate={{ opacity: 1, x: 0 }}
                        exit={{ opacity: 0, x: -8 }}
                        transition={{ duration: 0.15 }}
                        className="custom-scrollbar flex-1 min-h-0 space-y-1.5 overflow-y-auto overscroll-contain touch-pan-y pb-2 pr-1"
                    >
                        {listError && <p className="py-6 text-center text-[11px] text-neutral-400">{listError}</p>}
                        {!listError && routes.length === 0 && (
                            <p className="py-6 text-center text-[11px] text-neutral-500">Loading routes…</p>
                        )}
                        {sortedRoutes.map((r) => {
                            const n = busesOn(r.route_id);
                            return (
                                <button
                                    key={r.route_id}
                                    type="button"
                                    onClick={() => open(r.route_id)}
                                    className={clsx(
                                        'flex w-full items-center gap-2.5 rounded-xl bg-neutral-800/40 px-3 py-2.5 text-left transition-colors hover:bg-white/5',
                                        n === 0 && 'opacity-60',
                                    )}
                                >
                                    <RouteChip label={r.short_name ?? r.route_id} color={r.color} />
                                    <span className="min-w-0 flex-1 truncate text-[12px] font-semibold text-white">
                                        {r.route_name ?? r.short_name ?? r.route_id}
                                    </span>
                                    <span className="shrink-0 text-[10px] tabular-nums text-neutral-400">
                                        {n === 0 ? 'Not running' : n === 1 ? '1 bus' : `${n} buses`}
                                    </span>
                                    <ChevronRight size={13} className="shrink-0 text-neutral-500" />
                                </button>
                            );
                        })}
                    </motion.div>
                ) : (
                    <motion.div
                        key={`detail-${selected}`}
                        initial={{ opacity: 0, x: 8 }}
                        animate={{ opacity: 1, x: 0 }}
                        exit={{ opacity: 0, x: 8 }}
                        transition={{ duration: 0.15 }}
                        className="flex min-h-0 flex-1 flex-col"
                    >
                        <div className="mb-2 flex shrink-0 items-center gap-2">
                            <button
                                type="button"
                                onClick={close}
                                aria-label="All routes"
                                className={buttonVariants({ variant: 'ghost', size: 'iconSm' })}
                            >
                                <ChevronLeft size={16} />
                            </button>
                            <RouteChip
                                label={detail?.short_name ?? selectedPath?.short_name ?? selected}
                                color={detail?.color ?? selectedPath?.color ?? null}
                            />
                            <div className="min-w-0 flex-1">
                                <p className="truncate text-[13px] font-semibold leading-tight text-white">
                                    {detail?.route_name ?? selectedPath?.route_name ?? selected}
                                </p>
                                <p className="text-[10px] text-neutral-400">
                                    {detail?.buses == null
                                        ? ' '
                                        : detail.buses === 0
                                            ? 'No buses running right now'
                                            : detail.buses === 1
                                                ? '1 bus running'
                                                : `${detail.buses} buses running`}
                                </p>
                            </div>
                            <button
                                type="button"
                                onClick={() => selected && void loadDetail(selected)}
                                aria-label="Refresh"
                                className={buttonVariants({ variant: 'ghost', size: 'iconSm' })}
                            >
                                <RefreshCw size={13} className={clsx(loadingDetail && 'animate-spin')} />
                            </button>
                        </div>

                        <div className="custom-scrollbar flex-1 min-h-0 overflow-y-auto overscroll-contain touch-pan-y pb-2 pr-1">
                            {detailError && <p className="py-6 text-center text-[11px] text-neutral-400">{detailError}</p>}
                            {!detail && !detailError && (
                                <p className="py-6 text-center text-[11px] text-neutral-500">Loading stops…</p>
                            )}
                            {detail && (
                                <ol className="relative">
                                    {detail.stops.map((s, i) => (
                                        <StopRow
                                            key={`${s.id}-${i}`}
                                            stop={s}
                                            color={detail.color}
                                            first={i === 0}
                                            last={i === detail.stops.length - 1}
                                            onClick={() => { tapHaptic(); onShowStop?.(s); }}
                                        />
                                    ))}
                                </ol>
                            )}
                            {detail && (
                                <p className="px-1 pt-2 text-[9px] text-neutral-600">
                                    Times are the operator's predictions. "To" is where the next bus is heading.
                                </p>
                            )}
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
};

const formatMinutes = (m: number) => (m < 1 ? 'now' : `${Math.round(m)} min`);

const StopRow = ({
    stop,
    color,
    first,
    last,
    onClick,
}: {
    stop: RouteStop;
    color: string | null;
    first: boolean;
    last: boolean;
    onClick: () => void;
}) => {
    const [next, following] = stop.arrivals;
    const line = color ?? '#525252';
    return (
        <li>
            <button
                type="button"
                onClick={onClick}
                className="flex w-full items-stretch gap-3 rounded-lg px-1 text-left transition-colors hover:bg-white/5"
            >
                {/* The route drawn down the side, a dot per stop, so the list
                    reads as the line the bus runs. */}
                <span className="relative flex w-3 shrink-0 justify-center">
                    <span
                        className={clsx('absolute w-[3px]', first ? 'top-1/2' : 'top-0', last ? 'bottom-1/2' : 'bottom-0')}
                        style={{ backgroundColor: line }}
                    />
                    <span
                        className="relative z-[1] my-auto h-2.5 w-2.5 rounded-full border-2 bg-neutral-900"
                        style={{ borderColor: line }}
                    />
                </span>
                <span className="min-w-0 flex-1 py-2">
                    <span className="block truncate text-[12px] font-medium text-white">{stop.name}</span>
                    {next?.headsign && (
                        <span className="block truncate text-[10px] text-neutral-500">to {next.headsign}</span>
                    )}
                </span>
                <span className="shrink-0 py-2 text-right">
                    {next ? (
                        <>
                            <span className="block text-[13px] font-bold tabular-nums text-white">
                                {formatMinutes(next.minutes)}
                            </span>
                            {following && (
                                <span className="block text-[9px] tabular-nums text-neutral-500">
                                    then {Math.round(following.minutes)}
                                </span>
                            )}
                        </>
                    ) : (
                        <span className="block text-[10px] text-neutral-600">no bus due</span>
                    )}
                </span>
            </button>
        </li>
    );
};
