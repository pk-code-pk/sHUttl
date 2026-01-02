// src/utils/walk.ts
const WALK_SPEED_M_S = 1.4; // ~5 km/h

export function formatWalkLeg(distance_m: number): { minutesLabel: string; rawMinutes: number } {
    if (!distance_m || distance_m <= 0) {
        return { minutesLabel: '0 min', rawMinutes: 0 };
    }

    const minutes = distance_m / (WALK_SPEED_M_S * 60);

    if (minutes < 1) return { minutesLabel: '< 1 min', rawMinutes: minutes };
    if (minutes < 10) return { minutesLabel: `${minutes.toFixed(1)} min`, rawMinutes: minutes };
    return { minutesLabel: `${Math.round(minutes)} min`, rawMinutes: minutes };
}
