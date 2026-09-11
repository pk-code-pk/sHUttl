/*
 * Service worker for class reminders.
 *
 * Deliberately does nothing but push. No fetch handler, no cache: the app is a
 * live map and a stale cached shell would show buses where they were an hour
 * ago. Adding offline support later is a separate decision with its own
 * invalidation story, not a line here.
 */

self.addEventListener('install', () => {
    // Take over immediately; there is no cache to warm.
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
    let payload = {};
    try {
        payload = event.data ? event.data.json() : {};
    } catch {
        // A plain-text push still deserves to be shown.
        payload = { body: event.data ? event.data.text() : '' };
    }
    const title = payload.title || 'Time to leave';
    const options = {
        body: payload.body || '',
        data: payload.data || { url: '/' },
        icon: '/favicon_package/android-chrome-192x192.png',
        badge: '/favicon_package/favicon-64x64.png',
        // One reminder per class: a re-send for the same event replaces the
        // earlier card rather than stacking beside it.
        tag: payload.tag || (payload.data && payload.data.id) || undefined,
    };
    event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const url = (event.notification.data && event.notification.data.url) || '/';
    event.waitUntil(
        self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
            // Prefer the tab that is already open: the rider is mid-task there.
            const target = new URL(url, self.location.origin).href;
            for (const w of wins) {
                if ('focus' in w) {
                    if (w.url !== target && 'navigate' in w) {
                        return w.navigate(target).then((nw) => (nw || w).focus());
                    }
                    return w.focus();
                }
            }
            return self.clients.openWindow(target);
        }),
    );
});
