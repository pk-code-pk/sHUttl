// Reference service worker for "leave now" shuttle reminders.
//
// The frontend agent copies this to frontend/public/sw.js and registers it
// with navigator.serviceWorker.register('/sw.js'). The backend sends the
// payload built in reminders.build_notification():
//   { title, body, data: { url, reminder_id } }
//
// The worker, not the page, receives the push — that is what lets the phone
// get the nudge with the site closed.

self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch (_) {
    // A non-JSON push (e.g. a test from DevTools) still deserves a banner.
    payload = { title: 'Shuttle', body: event.data ? event.data.text() : '' };
  }
  const title = payload.title || 'Shuttle reminder';
  const options = {
    body: payload.body || '',
    data: payload.data || { url: '/' },
    icon: '/favicon.ico',
    // Same reminder re-sent replaces the banner instead of stacking a second.
    tag: payload.data && payload.data.reminder_id ? `reminder-${payload.data.reminder_id}` : undefined,
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL((event.notification.data && event.notification.data.url) || '/', self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      // Prefer refocusing an existing tab: opening a second one on a phone
      // loses whatever the rider was already looking at.
      for (const client of clients) {
        if (client.url === target && 'focus' in client) {
          return client.focus();
        }
      }
      if (clients.length && 'navigate' in clients[0]) {
        return clients[0].navigate(target).then((c) => c && c.focus());
      }
      return self.clients.openWindow(target);
    })
  );
});
