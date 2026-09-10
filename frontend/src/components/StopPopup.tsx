/**
 * What a stop shows when you tap it.
 *
 * It used to show the stop's name and "Stop ID: 4" — the identifier is
 * developer output, and the name was already legible on the map. Tapping a
 * stop asks one of two questions: when is the next bus from here, and can I
 * go from or to here. This answers both.
 *
 * ETAs are fetched per stop on open rather than held for all 24, because 24
 * idle requests to the operator on every map load is a cost paid for
 * information nobody asked for.
 */

import { useEffect, useState } from 'react';
import { API_BASE_URL } from '@/config';
import { Button } from './ui/Button';

interface StopEta {
    route_id: string;
    route_name: string | null;
    eta_minutes: number;
    destination?: string | null;
}

interface StopPopupProps {
    stopId: string;
    stopName: string;
    systemId: number | null;
    onPlanFrom?: (stopId: string) => void;
    onPlanTo?: (stopId: string) => void;
}

export const StopPopup = ({
    stopId, stopName, systemId, onPlanFrom, onPlanTo,
}: StopPopupProps) => {
    const [etas, setEtas] = useState<StopEta[] | null>(null);
    const [failed, setFailed] = useState(false);

    useEffect(() => {
        let cancelled = false;
        const params = new URLSearchParams({ stop_id: stopId });
        if (systemId) params.set('system_id', String(systemId));
        fetch(`${API_BASE_URL}/stop_etas?${params}`)
            .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
            .then((d) => {
                if (cancelled) return;
                // The operator's predictions when they have them, ours otherwise
                // — the same order of preference the rest of the app uses.
                const rows: StopEta[] = (d.vendor?.length ? d.vendor : d.ours) ?? [];
                setEtas(rows.slice(0, 4));
            })
            .catch(() => !cancelled && setFailed(true));
        return () => { cancelled = true; };
    }, [stopId, systemId]);

    return (
        <div className="min-w-[190px] text-neutral-100">
            <div className="mb-1.5 text-[13px] font-bold leading-tight">{stopName}</div>

            {failed ? (
                <p className="mb-2 text-[11px] text-neutral-400">Arrivals unavailable.</p>
            ) : etas === null ? (
                <p className="mb-2 text-[11px] text-neutral-400">Checking arrivals…</p>
            ) : etas.length === 0 ? (
                <p className="mb-2 text-[11px] text-neutral-400">No buses due here.</p>
            ) : (
                <ul className="mb-2 space-y-0.5">
                    {etas.map((e, i) => (
                        <li key={`${e.route_id}-${i}`} className="flex items-baseline gap-2">
                            <span className="w-11 shrink-0 text-[10px] font-bold text-neutral-300">
                                {e.route_id}
                            </span>
                            <span className="min-w-0 flex-1 truncate text-[11px] text-neutral-400">
                                {e.destination || e.route_name}
                            </span>
                            <span className="shrink-0 text-[12px] font-bold tabular-nums text-white">
                                {e.eta_minutes < 1 ? 'now' : `${Math.round(e.eta_minutes)} min`}
                            </span>
                        </li>
                    ))}
                </ul>
            )}

            <div className="flex gap-1.5">
                <Button variant="secondary" size="sm" block onClick={() => onPlanFrom?.(stopId)}>
                    From here
                </Button>
                <Button variant="primary" size="sm" block onClick={() => onPlanTo?.(stopId)}>
                    To here
                </Button>
            </div>
        </div>
    );
};
