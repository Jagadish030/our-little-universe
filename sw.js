const CACHE_NAME = 'our-little-universe-v4';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(['./', './index.html']))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res && (res.ok || res.type === 'opaque')) {
          const resClone = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, resClone));
        }
        return res;
      })
      .catch(() => caches.match(req))
  );
});

/* ─── Push notifications ───
   Fires a system notification when a push arrives — but only if
   nobody's actually looking at the app right now (unless the sender
   marked it alwaysShow, used for things other than plain chat). */
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { title: 'Our Little Universe', body: event.data ? event.data.text() : 'New message' };
  }

  const title = data.title || 'Our Little Universe';
  const options = {
    body: data.body || 'You have a new message',
    icon: data.icon || './icon-192.png',
    badge: data.badge || './icon-192.png',
    tag: data.tag || 'chat-message',
    renotify: true,
    // Carry the raw routing fields through, not just the built URL —
    // the page can act on scope/id/reply directly without re-parsing
    // a query string.
    data: {
      url: data.url || './',
      scope: data.scope || null,
      id: data.id || null,
      reply: !!data.reply
    }
  };

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      if (data.alwaysShow) return self.registration.showNotification(title, options);
      const isAppFocused = clientList.some((client) => client.focused);
      if (isAppFocused) return;
      return self.registration.showNotification(title, options);
    })
  );
});

/* ─── Notification click ───
   If a tab is already open, we DON'T do a hard navigate — navigating
   to the exact same URL the tab is already on is a no-op in most
   browsers, which is why tapping a notification used to leave the
   chat looking stale until a manual refresh. Instead we focus the
   existing tab and postMessage it the routing details directly, so
   the page's own JS decides what to open/refresh — no reload, no
   lost state. Only when NO tab is open do we fall back to opening a
   fresh window at the full deep-link URL. */
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const { url, scope, id, reply } = event.notification.data || {};
  const targetUrl = url || './';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) {
          client.focus();
          if ('postMessage' in client) {
            client.postMessage({ type: 'mw-deep-link', scope, id, reply });
          }
          return;
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
    })
  );
});
