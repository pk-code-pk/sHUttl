/**
 * Shareable trip links.
 *
 * A link is the one distribution advantage a web app has over Citymapper: it
 * can be pasted into a group chat and opened, with no install. So a planned
 * trip has to be addressable, and the address has to be legible enough that
 * someone will actually paste it:
 *
 *   shuttl.live/?from=sec&to=law-school
 *   shuttl.live/?from=42.3701,-71.1189&to=quad        (dropped pin / my location)
 *
 * Query parameters rather than a path segment (/t/sec/law-school) on purpose:
 * path routing needs an SPA rewrite on whatever host is serving the build, and
 * a link that 404s for the person you sent it to is worse than a slightly
 * uglier one that always works.
 */

export interface TripEndpointRef {
    /** Stop id, when the endpoint is a known stop. */
    stopId?: string;
    /** Coordinates, when it is a pin or the sharer's location. */
    coords?: { lat: number; lng: number };
}

export interface ParsedTripLink {
    origin: TripEndpointRef | null;
    destination: TripEndpointRef | null;
}

export interface StopRef {
    id: string;
    name: string;
    lat: number;
    lng: number;
}

/** "Harvard Square (Northbound)" -> "harvard-square-northbound" */
export function slugify(name: string): string {
    return name
        .toLowerCase()
        .replace(/['’]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

/** Coordinates are rounded: 5 decimals is ~1 m, and the full float makes the
 * link look like a machine wrote it. */
function formatCoords(lat: number, lng: number): string {
    return `${lat.toFixed(5)},${lng.toFixed(5)}`;
}

const COORD_RE = /^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/;

function parseCoords(value: string): { lat: number; lng: number } | null {
    const m = COORD_RE.exec(value.trim());
    if (!m) return null;
    const lat = Number(m[1]);
    const lng = Number(m[2]);
    // Reject anything off-planet; a malformed link should fall through to the
    // empty planner rather than sending the map somewhere absurd.
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
    return { lat, lng };
}

/**
 * Resolve one link parameter against the stop list.
 *
 * Accepts, in order: coordinates, a stop id, a slugified stop name. Stop ids
 * are accepted because they are stable, but names are what get shared, and
 * they are matched by slug so that a route rename that only changes
 * punctuation does not break existing links.
 */
function resolveEndpoint(value: string | null, stops: StopRef[]): TripEndpointRef | null {
    if (!value) return null;
    const raw = value.trim();
    if (!raw) return null;

    const coords = parseCoords(raw);
    if (coords) return { coords };

    const byId = stops.find((s) => s.id === raw);
    if (byId) return { stopId: byId.id };

    const wanted = slugify(raw);
    const byName = stops.find((s) => slugify(s.name) === wanted);
    if (byName) return { stopId: byName.id };

    // Shortened links should still land, so fall back to prefix and then
    // substring matching — but only when the match is unique. Two stops
    // matching means we cannot know which was meant, and guessing would send
    // someone to the wrong side of campus.
    const prefixed = stops.filter((s) => slugify(s.name).startsWith(wanted));
    if (prefixed.length === 1) return { stopId: prefixed[0].id };

    // Substring catches the shorthand people actually use: "quad" for
    // Radcliffe Quad, "stadium" for Stadium (Northbound).
    const contained = stops.filter((s) => slugify(s.name).includes(wanted));
    if (contained.length === 1) return { stopId: contained[0].id };

    return null;
}

export function parseTripLink(search: string, stops: StopRef[]): ParsedTripLink {
    const params = new URLSearchParams(search);
    return {
        origin: resolveEndpoint(params.get('from'), stops),
        destination: resolveEndpoint(params.get('to'), stops),
    };
}

/** True when the URL is asking for a specific trip. Checked before the stop
 * list has loaded, so it cannot resolve names — only whether to try. */
export function hasTripLink(search: string): boolean {
    const params = new URLSearchParams(search);
    return Boolean(params.get('from') && params.get('to'));
}

function endpointParam(ref: TripEndpointRef, stops: StopRef[]): string | null {
    if (ref.stopId) {
        const stop = stops.find((s) => s.id === ref.stopId);
        // Prefer the readable name; fall back to the id if the stop has gone
        // away, which keeps the link working rather than silently dropping it.
        return stop ? slugify(stop.name) : ref.stopId;
    }
    if (ref.coords) return formatCoords(ref.coords.lat, ref.coords.lng);
    return null;
}

/** The query string for a trip, e.g. "?from=sec&to=law-school". */
export function buildTripQuery(
    origin: TripEndpointRef,
    destination: TripEndpointRef,
    stops: StopRef[],
): string {
    const from = endpointParam(origin, stops);
    const to = endpointParam(destination, stops);
    if (!from || !to) return '';
    return `?${new URLSearchParams({ from, to }).toString()}`;
}

/** Absolute URL for sharing. */
export function buildTripUrl(
    origin: TripEndpointRef,
    destination: TripEndpointRef,
    stops: StopRef[],
): string {
    const query = buildTripQuery(origin, destination, stops);
    if (!query) return window.location.origin;
    return `${window.location.origin}${window.location.pathname}${query}`;
}

/**
 * Copy text to the clipboard, reporting whether it worked.
 *
 * navigator.clipboard is unavailable on insecure origins and in some in-app
 * browsers — which is exactly where a shared link gets opened — so there is a
 * fallback, and the caller is told when both fail so it can show the URL for
 * manual copying instead of claiming success.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
    try {
        if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(text);
            return true;
        }
    } catch {
        // fall through to the legacy path
    }

    try {
        const el = document.createElement('textarea');
        el.value = text;
        el.setAttribute('readonly', '');
        el.style.position = 'fixed';
        el.style.opacity = '0';
        document.body.appendChild(el);
        el.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(el);
        return ok;
    } catch {
        return false;
    }
}
