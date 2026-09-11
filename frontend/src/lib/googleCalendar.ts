/**
 * Google Calendar, read-only, from the browser.
 *
 * Google Identity Services' token client rather than the full OAuth code flow:
 * there is no backend session to bind a refresh token to, and the app has no
 * accounts of its own. An access token good for an hour, held in this tab, is
 * exactly the shape of the need — "show me today's classes" — and when it
 * lapses the rider taps Connect again.
 *
 * The GIS script is loaded on demand, not in index.html. Most riders never
 * open the Classes tab, and a third-party script on every page load is a cost
 * (and a tracker) paid for nothing.
 *
 * The token sits in sessionStorage as well as memory so a reload inside the
 * hour does not force another consent popup, and dies with the tab so a
 * shared or public machine does not keep it.
 */

const GSI_SRC = 'https://accounts.google.com/gsi/client';
const SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';
const CALENDAR_API = 'https://www.googleapis.com/calendar/v3';
const STORAGE_KEY = 'shuttl.gcal.token';

export const GOOGLE_CLIENT_ID: string | undefined =
    import.meta.env.VITE_GOOGLE_CLIENT_ID || undefined;

export const isCalendarConfigured = () => Boolean(GOOGLE_CLIENT_ID);

// The slice of GIS actually used. Google does not ship types for the script,
// and @types/google.accounts would add a dependency for five fields.
interface TokenResponse {
    access_token?: string;
    expires_in?: string | number;
    error?: string;
    error_description?: string;
}
interface TokenClient {
    requestAccessToken: (overrides?: { prompt?: string }) => void;
}
interface GoogleAccounts {
    accounts: {
        oauth2: {
            initTokenClient: (config: {
                client_id: string;
                scope: string;
                callback: (resp: TokenResponse) => void;
                error_callback?: (err: { type?: string; message?: string }) => void;
            }) => TokenClient;
            revoke: (token: string, done?: () => void) => void;
        };
    };
}
declare global {
    interface Window {
        google?: GoogleAccounts;
    }
}

interface StoredToken {
    token: string;
    /** Epoch ms. */
    expiresAt: number;
}

let current: StoredToken | null = null;
let gsiLoading: Promise<void> | null = null;

function readStored(): StoredToken | null {
    try {
        const raw = sessionStorage.getItem(STORAGE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as StoredToken;
        if (!parsed.token || typeof parsed.expiresAt !== 'number') return null;
        return parsed;
    } catch {
        return null;
    }
}

function store(t: StoredToken | null) {
    current = t;
    try {
        if (t) sessionStorage.setItem(STORAGE_KEY, JSON.stringify(t));
        else sessionStorage.removeItem(STORAGE_KEY);
    } catch {
        // Storage blocked: the in-memory copy still carries the session.
    }
}

/** A token with at least a minute left, or null. The minute margin means a
 * request started now does not fail mid-flight on a token that was valid when
 * checked. */
export function getAccessToken(): string | null {
    const t = current ?? readStored();
    if (!t) return null;
    if (Date.now() > t.expiresAt - 60_000) {
        store(null);
        return null;
    }
    current = t;
    return t.token;
}

export const isSignedIn = () => getAccessToken() !== null;

function loadGsi(): Promise<void> {
    if (window.google?.accounts?.oauth2) return Promise.resolve();
    if (gsiLoading) return gsiLoading;
    gsiLoading = new Promise<void>((resolve, reject) => {
        const s = document.createElement('script');
        s.src = GSI_SRC;
        s.async = true;
        s.defer = true;
        s.onload = () => resolve();
        s.onerror = () => {
            gsiLoading = null;
            reject(new Error('Could not load Google sign-in.'));
        };
        document.head.appendChild(s);
    });
    return gsiLoading;
}

/**
 * Open the Google consent popup and resolve with an access token.
 *
 * Must be called from a user gesture: browsers block the popup otherwise, and
 * GIS reports that as a generic error rather than telling us why.
 */
export async function signIn(): Promise<string> {
    if (!GOOGLE_CLIENT_ID) throw new Error('Google Calendar is not configured.');
    await loadGsi();
    const oauth2 = window.google?.accounts?.oauth2;
    if (!oauth2) throw new Error('Google sign-in did not initialise.');

    return new Promise<string>((resolve, reject) => {
        const client = oauth2.initTokenClient({
            client_id: GOOGLE_CLIENT_ID!,
            scope: SCOPE,
            callback: (resp) => {
                if (resp.error || !resp.access_token) {
                    reject(new Error(resp.error_description ?? resp.error ?? 'Sign-in failed.'));
                    return;
                }
                const seconds = Number(resp.expires_in ?? 3600);
                store({
                    token: resp.access_token,
                    expiresAt: Date.now() + seconds * 1000,
                });
                resolve(resp.access_token);
            },
            error_callback: (err) => {
                // "popup_closed" is the rider changing their mind, not a fault.
                reject(new Error(err.type === 'popup_closed' ? 'Sign-in cancelled.' : (err.message ?? 'Sign-in failed.')));
            },
        });
        client.requestAccessToken();
    });
}

/** Forget the token here and revoke it at Google, so Connect asks again. */
export function signOut(): void {
    const token = current?.token ?? readStored()?.token;
    store(null);
    if (token && window.google?.accounts?.oauth2) {
        try {
            window.google.accounts.oauth2.revoke(token);
        } catch {
            // Revocation is a courtesy; the token is already gone locally.
        }
    }
}

async function calendarFetch<T>(path: string, params?: Record<string, string>): Promise<T> {
    const token = getAccessToken();
    if (!token) throw new NotSignedInError();
    const qs = params ? `?${new URLSearchParams(params)}` : '';
    const res = await fetch(`${CALENDAR_API}${path}${qs}`, {
        headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 401 || res.status === 403) {
        // Revoked in Google's settings, or expired on their clock before ours.
        store(null);
        throw new NotSignedInError();
    }
    if (!res.ok) throw new Error(`Google Calendar request failed (${res.status}).`);
    return (await res.json()) as T;
}

export class NotSignedInError extends Error {
    constructor() {
        super('Not signed in to Google.');
        this.name = 'NotSignedInError';
    }
}

/** The account behind the token. The primary calendar's id is the account's
 * email, which is the one identity fact calendar.readonly can reach without
 * asking for a second scope. */
export async function getAccountEmail(): Promise<string | null> {
    try {
        const cal = await calendarFetch<{ id?: string }>('/calendars/primary');
        return cal.id ?? null;
    } catch (e) {
        if (e instanceof NotSignedInError) throw e;
        return null;
    }
}

export interface CalendarEvent {
    id: string;
    title: string;
    /** ISO 8601 with offset, as Google returns it. */
    start: string;
    end: string | null;
    location: string | null;
    htmlLink: string | null;
}

interface RawEvent {
    id: string;
    status?: string;
    summary?: string;
    location?: string;
    htmlLink?: string;
    start?: { dateTime?: string; date?: string };
    end?: { dateTime?: string; date?: string };
}

// "CS 50", "MATH 21a", "ECON1010", "Gened 1080" — a department code followed
// by a course number — or a word that names a meeting format. Titles alone
// are kept because many students' calendars carry the room in the title and
// leave the location field empty.
const CLASS_PATTERN =
    /\b[A-Za-z]{2,8}\s?-?\d{2,4}[A-Za-z]?\b|\b(lecture|section|seminar|lab|class|recitation|tutorial|office hours)\b/i;

export const looksLikeClass = (title: string) => CLASS_PATTERN.test(title);

/**
 * Timed events in the next `hours` that have somewhere to go: a location, or
 * a title that reads as a class. All-day events are dropped — there is no
 * moment to be at a stop for.
 */
export async function listUpcomingEvents(hours = 36): Promise<CalendarEvent[]> {
    const now = new Date();
    const max = new Date(now.getTime() + hours * 60 * 60 * 1000);
    const data = await calendarFetch<{ items?: RawEvent[] }>('/calendars/primary/events', {
        timeMin: now.toISOString(),
        timeMax: max.toISOString(),
        singleEvents: 'true',
        orderBy: 'startTime',
        maxResults: '50',
    });

    return (data.items ?? [])
        .filter((e) => e.status !== 'cancelled')
        .filter((e) => Boolean(e.start?.dateTime))
        .filter((e) => Boolean(e.location) || looksLikeClass(e.summary ?? ''))
        // timeMin is compared against event end, so something in progress
        // still comes back; nobody needs a shuttle to a class they are in.
        .filter((e) => new Date(e.start!.dateTime!).getTime() > now.getTime())
        .map((e) => ({
            id: e.id,
            title: e.summary?.trim() || '(No title)',
            start: e.start!.dateTime!,
            end: e.end?.dateTime ?? null,
            location: e.location?.trim() || null,
            htmlLink: e.htmlLink ?? null,
        }));
}
