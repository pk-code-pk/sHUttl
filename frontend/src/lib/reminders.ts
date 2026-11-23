/**
 * Push reminders: "leave for the stop now".
 *
 * The browser holds the subscription and the server holds the schedule. The
 * client's only jobs are to hand the server a push endpoint and, every time
 * the class list changes, the list of things worth waking someone up for. The
 * server decides when to send, because it is the thing that knows where the
 * buses are at that moment; a reminder computed at subscribe time would be
 * planned against a bus that has since fallen ten minutes behind.
 *
 * `client_id` is a random id kept in localStorage rather than anything tied to
 * the Google account: the server never sees who the rider is, only that the
 * same browser is speaking again.
 *
 * The iOS app is the same code with a different transport. A WKWebView has no
 * service worker and no PushManager, so there the endpoint is an APNs device
 * token (see nativePush.ts) and the server's readiness comes from
 * /push/config rather than from a VAPID key. Everything else — the client id,
 * the enabled flag, the reminder list — is shared, and every native branch
 * sits behind isNativeApp() so a browser runs exactly what it always has.
 */

import { API_BASE_URL } from '@/config';
import { nativePushPermission, nativePushToken, nativePushUnregister } from '@/lib/nativePush';
import { isNativeApp } from '@/lib/platform';

const CLIENT_ID_KEY = 'shuttl.push.client_id';
const ENABLED_KEY = 'shuttl.push.enabled';
const SW_PATH = '/sw.js';

export interface Reminder {
    id: string;
    title: string;
    /** ISO 8601. */
    arrive_by: string;
    dest: string;
    /** Where the rider is coming from, in words — the previous class's room,
     * when one ends shortly before this one starts. The server resolves it the
     * same way it resolves a destination, and prefers it over the stop. */
    origin_place?: string | null;
    /** Either a chosen stop or a GPS fix; the server plans from whichever is
     * present, preferring the stop. */
    origin_stop_id?: string | null;
    origin_lat: number | null;
    origin_lng: number | null;
    lead_minutes: number;
}

/** Push needs all three; a browser with Notification but no PushManager
 * (Safari before 16.4, most in-app webviews) cannot receive anything. */
export const isPushSupported = () =>
    typeof window !== 'undefined' &&
    'Notification' in window &&
    'serviceWorker' in navigator &&
    'PushManager' in window;

export function getClientId(): string {
    try {
        const existing = localStorage.getItem(CLIENT_ID_KEY);
        if (existing) return existing;
        const fresh = crypto.randomUUID();
        localStorage.setItem(CLIENT_ID_KEY, fresh);
        return fresh;
    } catch {
        // Storage blocked: a per-session id still lets this tab work, at the
        // cost of the server seeing a new client after a reload.
        return crypto.randomUUID();
    }
}

export function isReminderEnabled(): boolean {
    try {
        return localStorage.getItem(ENABLED_KEY) === '1';
    } catch {
        return false;
    }
}

export function setReminderEnabled(on: boolean) {
    try {
        if (on) localStorage.setItem(ENABLED_KEY, '1');
        else localStorage.removeItem(ENABLED_KEY);
    } catch {
        // Nothing to do: the toggle just will not survive a reload.
    }
}

/** The server's VAPID public key, or null when push is not configured there
 * (404) or the server is unreachable. Null hides the toggle entirely — a
 * switch that cannot work is worse than no switch. */
export async function fetchPublicKey(): Promise<string | null> {
    try {
        const res = await fetch(`${API_BASE_URL}/push/public_key`);
        if (!res.ok) return null;
        const data = (await res.json()) as { public_key?: string };
        return data.public_key ?? null;
    } catch {
        return null;
    }
}

/** Whether the server can send through APNs. False when it has no Apple
 * credentials or cannot be reached, which hides the toggle for the same reason
 * a missing VAPID key does. */
async function fetchApnsConfigured(): Promise<boolean> {
    try {
        const res = await fetch(`${API_BASE_URL}/push/config`);
        if (!res.ok) return false;
        const data = (await res.json()) as { apns?: boolean };
        return data.apns === true;
    } catch {
        return false;
    }
}

/**
 * How this client can be reached. A browser needs the server's VAPID key to
 * subscribe; the app needs nothing from the server but the knowledge that it
 * can send, because iOS mints the token on its own.
 */
export type PushChannel = { kind: 'web'; publicKey: string } | { kind: 'apns' };

/** The channel reminders would use here, or null when there is none — which
 * hides the toggle. One question for the panel to ask, whichever platform it
 * is running on. */
export async function fetchPushChannel(): Promise<PushChannel | null> {
    if (isNativeApp()) {
        return (await fetchApnsConfigured()) ? { kind: 'apns' } : null;
    }
    if (!isPushSupported()) return null;
    const publicKey = await fetchPublicKey();
    return publicKey ? { kind: 'web', publicKey } : null;
}

/** VAPID keys arrive base64url-encoded; PushManager wants raw bytes. */
export function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
    const padding = '='.repeat((4 - (base64.length % 4)) % 4);
    const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(b64);
    const out = new Uint8Array(new ArrayBuffer(raw.length));
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
}

export type SubscribeFailure = 'denied' | 'unsupported' | 'error';

export class SubscribeError extends Error {
    readonly reason: SubscribeFailure;
    constructor(reason: SubscribeFailure, message: string) {
        super(message);
        this.name = 'SubscribeError';
        this.reason = reason;
    }
}

/**
 * Ask permission, register the worker, subscribe, and tell the server.
 *
 * Order matters: permission first, because the prompt has to come from the
 * click that got us here, and a service-worker registration in between can be
 * slow enough to lose the gesture on some browsers.
 */
export async function enablePush(channel: PushChannel): Promise<void> {
    if (channel.kind === 'apns') {
        await enableNativePush();
        return;
    }
    const { publicKey } = channel;
    if (!isPushSupported()) {
        throw new SubscribeError('unsupported', 'This browser cannot receive push notifications.');
    }
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
        throw new SubscribeError('denied', 'Notifications are blocked for this site.');
    }

    const reg = await navigator.serviceWorker.register(SW_PATH);
    await navigator.serviceWorker.ready;

    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
        sub = await reg.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: urlBase64ToUint8Array(publicKey),
        });
    }

    const res = await fetch(`${API_BASE_URL}/push/subscribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscription: sub.toJSON(), client_id: getClientId() }),
    });
    if (!res.ok) throw new SubscribeError('error', `Could not register for reminders (${res.status}).`);
}

/** Get a device token from iOS and hand it to the server. Assumes permission
 * has already been settled; register() never prompts on its own. */
async function sendNativeToken(): Promise<void> {
    let token: string;
    try {
        token = await nativePushToken();
    } catch (e) {
        // The reason iOS gives is for a developer, not a rider; keep it in
        // the log and say something that can be acted on.
        console.warn('APNs registration failed', e);
        throw new SubscribeError(
            'error',
            'Could not set up notifications on this device. Check your connection and try again.',
        );
    }
    const res = await fetch(`${API_BASE_URL}/push/subscribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apns: { token }, client_id: getClientId() }),
    });
    if (!res.ok) throw new SubscribeError('error', `Could not register for reminders (${res.status}).`);
}

/**
 * The app's enablePush: the system permission dialog, then a device token,
 * then the server.
 *
 * iOS shows its dialog once per install. After a refusal the same call just
 * reports "denied" without showing anything, and the only way back is the
 * Settings app — which is what the 'denied' reason tells the panel to say.
 */
async function enableNativePush(): Promise<void> {
    let granted: boolean;
    try {
        granted = await nativePushPermission(true);
    } catch (e) {
        console.warn('Notification permission request failed', e);
        throw new SubscribeError('error', 'Could not ask for notification permission.');
    }
    if (!granted) {
        throw new SubscribeError('denied', 'Notifications are turned off for Crimson Shuttl.');
    }
    await sendNativeToken();
}

/**
 * App start: if reminders are on, quietly re-register and re-send the token.
 *
 * An APNs token is not permanent — a restore from backup, a reinstall or an
 * OS update can each change it — and the server may have dropped its record
 * after Apple rejected the old one. Apple's guidance is to register on every
 * launch for exactly this reason. Re-sending unconditionally is one small
 * request per launch and repairs both cases.
 *
 * Nothing here may prompt or surface an error: the rider did not ask for
 * anything. If permission has since been revoked in Settings this does
 * nothing, and the toggle will explain itself the next time it is pressed.
 */
export async function refreshNativePush(): Promise<void> {
    if (!isNativeApp() || !isReminderEnabled()) return;
    try {
        if (!(await nativePushPermission(false))) return;
        await sendNativeToken();
    } catch (e) {
        console.warn('Could not refresh the push token', e);
    }
}

/** Drop the server's record first, then the browser's. If the server call
 * fails the browser subscription is kept, so a retry can re-send it rather
 * than leaving the server pushing to an endpoint nobody listens on. */
export async function disablePush(): Promise<void> {
    const res = await fetch(
        `${API_BASE_URL}/push/subscribe?client_id=${encodeURIComponent(getClientId())}`,
        { method: 'DELETE' },
    );
    if (!res.ok && res.status !== 404) {
        throw new SubscribeError('error', `Could not turn reminders off (${res.status}).`);
    }
    if (isNativeApp()) {
        // The server has already forgotten the token, which is what actually
        // stops the reminders. Unregistering is tidying up; if it fails the
        // toggle should still read "off", because it is.
        await nativePushUnregister().catch((e: unknown) => {
            console.warn('Could not unregister from APNs', e);
        });
        return;
    }
    if (!isPushSupported()) return;
    const reg = await navigator.serviceWorker.getRegistration(SW_PATH);
    const sub = await reg?.pushManager.getSubscription();
    await sub?.unsubscribe();
}

/** Replace this client's reminder list wholesale. The server keeps nothing
 * else per client, so a full PUT is simpler than diffing and cannot leave a
 * cancelled class behind. */
export async function putReminders(reminders: Reminder[]): Promise<void> {
    const res = await fetch(`${API_BASE_URL}/reminders`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: getClientId(), reminders }),
    });
    if (!res.ok) throw new Error(`Could not save reminders (${res.status}).`);
}
