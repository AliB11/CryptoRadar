/* رادارِ بازار — service worker */
const CACHE = 'radar-shell-v1';
const SHELL = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.pathname.startsWith('/api/')) return;
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).then(r => {
        const copy = r.clone();
        caches.open(CACHE).then(c => c.put('/index.html', copy)).catch(() => {});
        return r;
      }).catch(() => caches.match('/index.html'))
    );
    return;
  }
  if (url.origin !== location.origin) return;
  event.respondWith(
    caches.match(req).then(hit => {
      const go = fetch(req).then(r => {
        if (r && r.ok) {
          const copy = r.clone();
          caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
        }
        return r;
      }).catch(() => hit);
      return hit || go;
    })
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const data = event.notification.data || {};
  const target = data.url || '/';
  event.waitUntil((async () => {
    const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of list) {
      if ('focus' in client) {
        await client.focus();
        client.postMessage({ type: 'radar-open', url: target, id: data.id || null });
        return;
      }
    }
    if (self.clients.openWindow) await self.clients.openWindow(target);
  })());
});
