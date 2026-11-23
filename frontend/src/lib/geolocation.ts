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
 *
 * The iOS app asks the system instead of the web view. A WKWebView's
 * `navigator.geolocation` puts its own website-style prompt on top of the
 * app's permission, and cannot say whether a refusal came from the rider or
 * from Location Services being off — which is the difference between the two
 * fixes describeFailure offers. Only where the fix comes from differs: the
 * cache, the cooldown and the shared request above apply to both.
 */

import { isNativeApp } from '@/lib/platform';

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

function requestFromBrowser(): Promise<Attempt> {
    return new Promise<Attempt>((resolve) => {
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
    });
}

// The plugin's own default, and longer than the browser gets: a phone's first
// fix after launch has to wake the radios, and iOS holds a single-shot request
// until the accuracy settles rather than returning the first rough answer.
const NATIVE_FIX_TIMEOUT_MS = 10 * 1000;

// The iOS permission prompt has no timeout of its own, and the plugin answers
// only when the authorisation status changes. If that answer never comes the
// request would stay in flight for the rest of the session, and every later
// caller — including an explicit Retry — would be handed the same dead
// promise. A minute is far longer than anyone reads the prompt for.
const PERMISSION_PROMPT_LIMIT_MS = 60 * 1000;

const DEADLINE_PASSED = Symbol("deadline passed");

function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(DEADLINE_PASSED), ms);
        work.then(
            (value) => { clearTimeout(timer); resolve(value); },
            (err) => { clearTimeout(timer); reject(err); },
        );
    });
}

/**
 * Map a rejection from @capacitor/geolocation onto the same four causes the
 * browser path reports. The codes are the plugin's (GeolocationError.swift).
 */
function classifyNative(err: unknown): GeolocationFailure {
    if (err === DEADLINE_PASSED) return "timeout";
    const code = typeof err === "object" && err !== null && "code" in err
        ? String((err as { code: unknown }).code)
        : "";
    switch (code) {
        case "OS-PLUG-GLOC-0003": // permission denied
        case "OS-PLUG-GLOC-0008": // restricted: Screen Time, device management
            return "denied";
        case "OS-PLUG-GLOC-0010":
            return "timeout";
        case "UNIMPLEMENTED": // the plugin is missing from this build
            return "unsupported";
        default:
            // 0002, no fix to be had, and 0007, Location Services switched off
            // for the whole phone. The second is not "denied": the app's own
            // setting may well say Allow, and sending the rider there would
            // send them to a switch that is already on.
            return "unavailable";
    }
}

async function requestFromApp(): Promise<Attempt> {
    try {
        // Loaded on demand rather than imported: the module registers a global
        // (window.CapacitorUtils) as a side effect of being evaluated, and the
        // website should not grow one for a code path it never takes.
        const { Geolocation } = await import("@capacitor/geolocation");

        // Permission is settled before the fix is asked for, so the fix's
        // timeout measures the radios and not how long the prompt was read.
        let permission = (await Geolocation.checkPermissions()).location;
        if (permission === "prompt" || permission === "prompt-with-rationale") {
            permission = (await withDeadline(
                Geolocation.requestPermissions(),
                PERMISSION_PROMPT_LIMIT_MS,
            )).location;
        }
        if (permission === "denied") return { failure: "denied", at: Date.now() };

        const pos = await withDeadline(
            Geolocation.getCurrentPosition({
                // Same reasoning as the browser: stops are hundreds of metres
                // apart, and a coarse fix arrives sooner.
                enableHighAccuracy: false,
                timeout: NATIVE_FIX_TIMEOUT_MS,
            }),
            // The plugin enforces the timeout itself; this is slack on top, for
            // the case where it does not answer at all.
            NATIVE_FIX_TIMEOUT_MS + 5 * 1000,
        );
        return {
            coords: { lat: pos.coords.latitude, lng: pos.coords.longitude },
            at: Date.now(),
        };
    } catch (err) {
        return { failure: classifyNative(err), at: Date.now() };
    }
}

function request(): Promise<Attempt> {
    if (inFlight) return inFlight;

    inFlight = (isNativeApp() ? requestFromApp() : requestFromBrowser()).then((result) => {
        last = result;
        inFlight = null;
        if (result.coords) {
            publish(result.coords);
            startFollowing();
        }
        return result;
    });

    return inFlight;
}

// ---------------------------------------------------------------------------
// Following the rider
//
// The map's you-are-here dot used to be drawn from whichever single fix Plan
// Trip had last been handed, so it was missing whenever the rider had only
// used Next Bus Out, and frozen where it was first placed once they walked
// off. Now every fix, from any caller, is published to subscribers, and once
// one fix has succeeded (so permission is already granted and watching cannot
// raise a prompt) the position is followed while the page is visible.
//
// The watch asks for high accuracy where the one-shot request does not: the
// one-shot picks stops hundreds of metres apart, the dot has to sit on the
// right side of the street. It stops whenever the page or app is hidden, and
// when nothing is subscribed, so it costs nothing in the background.
// ---------------------------------------------------------------------------

type LocationListener = (coords: Coords) => void;

const listeners = new Set<LocationListener>();
let latest: Coords | null = null;
let stopWatching: (() => void) | null = null;

function publish(coords: Coords) {
    latest = coords;
    listeners.forEach((listener) => listener(coords));
}

function onFollowedFix(coords: Coords) {
    // Keep the one-shot cache fresh too, so a panel asking for a fix gets the
    // position the dot is showing rather than one from minutes ago.
    last = { coords, at: Date.now() };
    publish(coords);
}

function startFollowing() {
    if (stopWatching || !latest || listeners.size === 0) return;
    if (typeof document !== "undefined" && document.hidden) return;

    if (!isNativeApp()) {
        if (!navigator.geolocation) return;
        const id = navigator.geolocation.watchPosition(
            (pos) => onFollowedFix({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
            // A watch error is not worth surfacing: the dot simply stays at the
            // last good fix, and the panels have their own error handling.
            () => undefined,
            { enableHighAccuracy: true, maximumAge: 10 * 1000, timeout: 30 * 1000 },
        );
        stopWatching = () => navigator.geolocation.clearWatch(id);
        return;
    }

    // The plugin hands back the watch id asynchronously. A stop requested
    // before it arrives is remembered and applied as soon as it does.
    let cancelled = false;
    let watchId: string | null = null;
    let clear: ((id: string) => void) | null = null;
    stopWatching = () => {
        cancelled = true;
        if (watchId && clear) clear(watchId);
    };
    void import("@capacitor/geolocation")
        .then(({ Geolocation }) => {
            clear = (id) => void Geolocation.clearWatch({ id }).catch(() => undefined);
            return Geolocation.watchPosition(
                { enableHighAccuracy: true, maximumAge: 10 * 1000, timeout: 30 * 1000 },
                (pos) => {
                    if (pos) onFollowedFix({ lat: pos.coords.latitude, lng: pos.coords.longitude });
                },
            );
        })
        .then((id) => {
            watchId = id;
            if (cancelled && clear) clear(id);
        })
        .catch(() => {
            // Watching failed to start. Allow a later attempt.
            if (!cancelled) stopWatching = null;
        });
}

function stopFollowing() {
    stopWatching?.();
    stopWatching = null;
}

if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", () => {
        if (document.hidden) stopFollowing();
        else startFollowing();
    });
}

/**
 * Be told the rider's position whenever it is known or changes. Never asks for
 * permission by itself: it starts reporting once some explicit request (a
 * panel, or the map's locate button) has produced a fix.
 *
 * Returns the unsubscribe function.
 */
export function subscribeToLocation(listener: LocationListener): () => void {
    listeners.add(listener);
    if (latest) listener(latest);
    startFollowing();
    return () => {
        listeners.delete(listener);
        if (listeners.size === 0) stopFollowing();
    };
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

/**
 * The same four causes for the iOS app, where there is no browser to blame and
 * the fix lives in the Settings app rather than in a site-permission popover.
 */
function describeAppFailure(failure: GeolocationFailure): string {
    switch (failure) {
        case "unsupported":
            return "This version of the app cannot share your location. Pick a stop below.";
        case "denied":
            return (
                "Location is off for sHUttl. Turn it on in Settings > sHUttl > " +
                "Location, or pick a stop below."
            );
        case "timeout":
            return "Location is taking too long. Pick a stop below instead.";
        default:
            return (
                "Your location could not be determined. Check that Location Services " +
                "is on in Settings > Privacy & Security — or just pick a stop below."
            );
    }
}

/** Human-readable cause, with the fix that actually applies to each. */
export function describeFailure(failure: GeolocationFailure): string {
    if (isNativeApp()) return describeAppFailure(failure);
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
