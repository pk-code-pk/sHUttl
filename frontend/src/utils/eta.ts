import type { TripResponse, TripSegment } from '../components/types';

function etaForSegmentMinutes(seg: TripSegment): number | null {
    const nb = seg.next_bus;
    if (!nb) return null;

    if (nb.eta_to_origin_stop_minutes != null) {
        return nb.eta_to_origin_stop_minutes;
    }
    if (nb.eta_to_origin_stop != null) {
        return nb.eta_to_origin_stop / 60;
    }
    return null;
}

export function computeOverallEtaLabel(trip: TripResponse | null): string {
    if (!trip || !trip.segments || trip.segments.length === 0) {
        return 'No ETA';
    }

    const mins: number[] = [];
    for (const seg of trip.segments) {
        const m = etaForSegmentMinutes(seg);
        if (m != null && m > 0) mins.push(m);
    }

    if (mins.length === 0) return 'No ETA';

    const min = Math.min(...mins);

    if (min < 1) return '< 1 min';
    if (min < 10) return `${min.toFixed(1)} min`;
    return `${Math.round(min)} min`;
}
