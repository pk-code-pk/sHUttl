/**
 * One shared location request for the whole app.
 *
 * Two things made the browser hammer CoreLocation. Next Bus Out asks for a fix
 * when it mounts, and it unmounts whenever the user switches to Plan Trip — so
 * every mode toggle was a fresh request. React StrictMode then doubles each
 * mount effect in development. Two toggles produced six requests and six
 * `kCLErrorLocationUnknown` lines, all of them asking a question that had
 * already failed a second earlier.
 *
 * So a fix is cached and reused, a failure is remembered for long enough that
 * remounting cannot retry immediately, and concurrent callers share one
 * in-flight request rather than starting their own.
 */

export interface Coords {
    lat: number;
    lng: number;
}

export type GeolocationFailure =
    | "unsupported"
    | "denied"
    | "unavailable"
    | "timeout";

interface Attempt {
    coords?: Coords;
    failure?: GeolocationFailure;
    at: number;
}

// A campus fix stays useful for a few minutes: stops are hundreds of metres
// apart, so a slightly stale position still picks the right ones.
const FIX_TTL_MS = 3 * 60 * 1000;

// How long a failure suppresses automatic retries. Long enough that remounting
// a component cannot re-ask, short enough that a user who fixes their settings
// is not locked out. An explicit retry ignores this.
const FAILURE_COOLDOWN_MS = 30 * 1000;

let last: Attempt | null = null;
let inFlight: Promise<Attempt> | null = null;

function classify(err: GeolocationPositionError): GeolocationFailure {
    if (err.code === err.PERMISSION_DENIED) return "denied";
    if (err.code === err.TIMEOUT) return "timeout";
    return "unavailable";
}

function request(): Promise<Attempt> {
    if (inFlight) return inFlight;

    inFlight = new Promise<Attempt>((resolve) => {
        if (!navigator.geolocation) {
            resolve({ failure: "unsupported", at: Date.now() });
            return;
        }
        navigator.geolocation.getCurrentPosition(
            (pos) => resolve({
                coords: { lat: pos.coords.latitude, lng: pos.coords.longitude },
                at: Date.now(),
            }),
            (err) => resolve({ failure: classify(err), at: Date.now() }),
            // High accuracy is not worth much when stops are hundreds of metres
            // apart, and asking for it makes failures likelier on desktops with
            // no GPS — which is where kCLErrorLocationUnknown comes from.
            { enableHighAccuracy: false, timeout: 8000, maximumAge: FIX_TTL_MS },
        );
    }).then((result) => {
        last = result;
        inFlight = null;
        return result;
    });

    return inFlight;
}

/**
 * Current position, from cache when possible.
 *
 * `force` is for an explicit user action — a Retry button, or tapping "my
 * location" — which should override both the cache and the failure cooldown,
 * because the user may have just changed a setting.
 */
export function getLocation(force = false): Promise<Attempt> {
    if (force) {
        last = null;
        return request();
    }
    if (last?.coords && Date.now() - last.at < FIX_TTL_MS) {
        return Promise.resolve(last);
    }
    if (last?.failure && Date.now() - last.at < FAILURE_COOLDOWN_MS) {
        return Promise.resolve(last);
    }
    return request();
}

/** Human-readable cause, with the fix that actually applies to each. */
export function describeFailure(failure: GeolocationFailure): string {
    switch (failure) {
        case "unsupported":
            return "This browser cannot share your location. Pick a stop below.";
        case "denied":
            return "Location permission denied. Allow it, or pick a stop below.";
        case "timeout":
            return "Location is taking too long. Pick a stop below instead.";
        default:
            return (
                "Your browser could not determine your location. On macOS, enable " +
                "Location Services for it in System Settings — or just pick a stop below."
            );
    }
}
