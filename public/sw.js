// Service worker: caches the application shell so the field-reading screen opens without a connection.
// API responses are never cached here (field data is stored explicitly in IndexedDB by the app).
const CACHE = 'aquatrack-shell-v7';
const SHELL = ['/', '/index.html', '/styles.css', '/manifest.webmanifest', '/img/icon.svg', '/js/app.js', '/js/core.js', '/js/offline.js',
  '/js/views/dashboard.js', '/js/views/customers.js', '/js/views/field.js', '/js/views/readings.js', '/js/views/billing.js', '/js/views/ops.js',
  '/js/views/network.js', '/js/views/admin.js', '/js/views/portal.js',
  '/js/views/channels.js', '/js/views/waterpoints.js', '/js/views/waterloss.js', '/js/ocr.js',
  '/js/route.js', '/js/views/quality.js', '/js/views/collections.js', '/js/views/labs.js', '/js/views/growth.js', '/js/views/service.js', '/js/views/locale.js', '/js/views/operations.js', '/js/i18n.js', '/i18n/ui-fr.json', '/i18n/ui-pt.json', '/status.html', '/js/status.js'];
// The OCR engine under /vendor/ (~10 MB) is cached on first use (or via “Prepare photo reading offline”).
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  // Network first (so updates arrive), fall back to cache when offline.
  e.respondWith(fetch(e.request).then(r => { if (r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); } return r; })
    .catch(() => caches.match(e.request).then(r => r || caches.match('/index.html'))));
});
