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
 */

import { API_BASE_URL } from '@/config';

const CLIENT_ID_KEY = 'shuttl.push.client_id';
const ENABLED_KEY = 'shuttl.push.enabled';
const SW_PATH = '/sw.js';

export interface Reminder {
    id: string;
    title: string;
    /** ISO 8601. */
    arrive_by: string;
    dest: string;
    origin_lat: number;
    origin_lng: number;
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
export async function enablePush(publicKey: string): Promise<void> {
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
