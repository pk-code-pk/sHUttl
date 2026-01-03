// src/utils/timeAndDistance.ts

export const WALKING_SPEED_MS = 1.4 // ~5 km/h

export function metersToMinutes(distanceM?: number | null): number | null {
    if (distanceM == null || !Number.isFinite(distanceM) || distanceM <= 0) return null
    return distanceM / WALKING_SPEED_MS / 60
}

export function formatMinutesLabel(mins?: number | null): string {
    if (mins == null || !Number.isFinite(mins) || mins <= 0) return '<1 min'
    if (mins < 1) return '<1 min'
    return `${Math.round(mins)} min`
}

/**
 * Decide if a walking step is reasonable to show.
 * For now:
 * - Hide if > 5 km (5000 m).
 */
export function isWalkReasonable(distanceM?: number | null): boolean {
    if (distanceM == null || !Number.isFinite(distanceM)) return false
    return distanceM > 20 && distanceM <= 5000
}

/**
 * Normalize an ETA in seconds from backend.
 * Returns minutes or null if unusable.
 * - Null if undefined/NaN
 * - Null if > 1 hour (3600s) – treat as "No ETA"
 */
export function etaSecondsToMinutes(etaSeconds?: number | null): number | null {
    if (etaSeconds == null || !Number.isFinite(etaSeconds) || etaSeconds <= 0) {
        return null
    }
    return etaSeconds / 60
}
