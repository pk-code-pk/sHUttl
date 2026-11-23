/**
 * The iOS half of push: permission, the APNs device token, and what happens
 * when a notification is tapped.
 *
 * A WKWebView has no Notification, no service worker and no PushManager, so
 * none of the web path in reminders.ts can run inside the app. This file is
 * the device-side replacement and nothing more: it knows about the plugin,
 * not about the server. reminders.ts decides when to call it and what to do
 * with the token, so the two transports stay side by side in one place.
 *
 * Every export here talks to a native plugin and must only be called behind
 * isNativeApp(); in a browser the plugin has no implementation and rejects.
 */

import { PushNotifications } from '@capacitor/push-notifications';
import type { PluginListenerHandle } from '@capacitor/core';

import { PUBLIC_WEB_ORIGIN } from '@/lib/platform';

/** How long to wait for iOS to answer register(). Normally it is well under a
 * second; the wait exists for the cases where no answer ever comes — no
 * network on first launch, or a build without the push entitlement, where the
 * app delegate is simply never called. */
const REGISTRATION_TIMEOUT_MS = 15_000;

/**
 * Whether the app may show notifications.
 *
 * With `prompt` the system dialog is shown if the rider has never been asked;
 * iOS shows it once per install, and after that the same call just reports
 * the standing answer. Without it nothing is ever shown — the app-start
 * refresh must not be the thing that springs a permission dialog on someone.
 */
export async function nativePushPermission(prompt: boolean): Promise<boolean> {
    const status = prompt
        ? await PushNotifications.requestPermissions()
        : await PushNotifications.checkPermissions();
    return status.receive === 'granted';
}

/**
 * Register with APNs and resolve with the device token, as lowercase hex.
 *
 * register() itself resolves immediately and says nothing; the token arrives
 * later as a 'registration' event, or a 'registrationError' — or, when iOS
 * never calls back, not at all, which is what the timeout is for. The events
 * are not replayed, so both listeners have to be attached before register()
 * is called.
 */
export async function nativePushToken(): Promise<string> {
    const handles: PluginListenerHandle[] = [];
    let onToken: (token: string) => void = () => {};
    let onFailure: (error: Error) => void = () => {};
    const answer = new Promise<string>((resolve, reject) => {
        onToken = resolve;
        onFailure = reject;
    });
    // Started before anything is asked of the plugin, so the deadline covers
    // the listener setup too and no step can leave the toggle spinning.
    const timer = setTimeout(
        () => onFailure(new Error('Timed out waiting for a device token.')),
        REGISTRATION_TIMEOUT_MS,
    );
    const register = async () => {
        handles.push(
            await PushNotifications.addListener('registration', (token) => onToken(token.value)),
        );
        handles.push(
            await PushNotifications.addListener('registrationError', (e) =>
                onFailure(new Error(e.error)),
            ),
        );
        await PushNotifications.register();
    };
    try {
        // Awaited together so that whichever fails first — the plugin call,
        // the error event or the deadline — is the one that is reported, and
        // none of them is left as an unhandled rejection.
        const [token] = await Promise.all([answer, register()]);
        // The plugin formats the token as uppercase hex. APNs device tokens
        // are conventionally lowercase, and one canonical spelling means the
        // server never stores the same device twice.
        return token.toLowerCase();
    } finally {
        clearTimeout(timer);
        for (const handle of handles) void handle.remove();
    }
}

/** Tell iOS to stop delivering remote notifications to this install. */
export async function nativePushUnregister(): Promise<void> {
    await PushNotifications.unregister();
}

/**
 * The query string a tapped notification is asking for, or null when it only
 * wants the app brought forward — which iOS has already done by the time the
 * tap reaches JavaScript.
 *
 * Only the query is taken, never the host or path. The app has no routes; a
 * trip is addressed entirely by `?from=…&to=…` (see tripLink.ts), and inside
 * the shell the page lives at capacitor://localhost, not at the origin the
 * server would write a link against. Taking the query alone also means a
 * malformed or hostile payload can change which trip is shown and nothing
 * else: it can never navigate the webview somewhere that is not the app.
 */
export function searchFromNotificationUrl(url: unknown, currentSearch: string): string | null {
    if (typeof url !== 'string' || !url) return null;
    let search: string;
    try {
        // The base is only there so a bare "/?from=a&to=b" parses.
        search = new URL(url, PUBLIC_WEB_ORIGIN).search;
    } catch {
        return null;
    }
    if (!search || search === currentSearch) return null;
    return search;
}

let listeningForTaps = false;

/**
 * Open the app at the place a tapped notification points to.
 *
 * The server sends `url` as a top-level key beside `aps`, and the plugin
 * hands the whole payload over as the notification's `data`.
 *
 * Navigating means assigning location.search, which reloads the bundled page
 * with the new query. That is deliberate: the trip planner reads its link
 * from window.location.search once, while mounting, exactly as it does when
 * someone opens a shared link in a browser. Reloading puts the app through
 * that same, already-tested path instead of teaching every component to
 * notice a URL changing underneath it, and it is what the service worker does
 * on the web (it navigates the open tab). The page is served from the app
 * bundle, so the reload costs no network. A url of "/" carries no query and
 * so never reloads.
 *
 * Call once at app start. iOS holds on to a tap that launched the app from
 * cold until the first listener is attached, so the listener is installed for
 * the lifetime of the page and never removed — removing and re-adding it
 * (React StrictMode would) could drop that one retained event.
 */
export function listenForNotificationTaps(): void {
    if (listeningForTaps) return;
    listeningForTaps = true;
    PushNotifications.addListener('pushNotificationActionPerformed', (action) => {
        // 'tap' is the notification itself; anything else is a dismissal or
        // a custom action button, neither of which the server sends.
        if (action.actionId !== 'tap') return;
        const data = action.notification.data as { url?: unknown } | null | undefined;
        const search = searchFromNotificationUrl(data?.url, window.location.search);
        if (search !== null) window.location.search = search;
    }).catch((e: unknown) => {
        console.warn('Could not listen for notification taps', e);
    });
}
