// Service worker: caches the application shell so the field-reading screen opens without a connection.
// API responses are never cached here (field data is stored explicitly in IndexedDB by the app).
const CACHE = 'aquatrack-shell-v9';
const OCR_CACHE = 'aquatrack-ocr';
const SHELL = ['/', '/index.html', '/styles.css', '/manifest.webmanifest', '/img/icon.svg', '/js/app.js', '/js/core.js', '/js/offline.js',
  '/js/views/dashboard.js', '/js/views/customers.js', '/js/views/field.js', '/js/views/readings.js', '/js/views/billing.js', '/js/views/ops.js',
  '/js/views/network.js', '/js/views/admin.js', '/js/views/portal.js',
  '/js/views/channels.js', '/js/views/waterpoints.js', '/js/views/waterloss.js', '/js/ocr.js',
  '/js/route.js', '/js/views/quality.js', '/js/views/collections.js', '/js/views/labs.js', '/js/views/growth.js', '/js/views/service.js', '/js/views/locale.js', '/js/views/operations.js', '/js/views/wsp.js', '/js/i18n.js', '/i18n/ui-fr.json', '/i18n/ui-pt.json', '/status.html', '/js/status.js', '/transparency.html', '/js/transparency.js'];
// The OCR engine under /vendor/ (~10 MB) is cached on first use (or via “Prepare photo reading offline”).
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const oldShells = (await caches.keys()).filter(k => k.startsWith('aquatrack-shell-') && k !== CACHE);
    // Preserve OCR assets already downloaded by field staff before removing old shells.
    const ocr = await caches.open(OCR_CACHE);
    for (const key of oldShells) {
      const old = await caches.open(key);
      for (const request of await old.keys()) {
        if (new URL(request.url).pathname.startsWith('/vendor/')) {
          const response = await old.match(request);
          if (response && !(await ocr.match(request))) await ocr.put(request, response);
        }
      }
      await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

function offlinePage(path) {
  if (path === '/status' || path === '/status/') return '/status.html';
  if (path.startsWith('/t/')) return '/transparency.html';
  if (path === '/' || SHELL.includes(path)) return path;
  return null;
}

self.addEventListener('fetch', e => {
  const request = e.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== location.origin ||
      url.pathname === '/api' || url.pathname.startsWith('/api/')) return;

  const vendor = url.pathname.startsWith('/vendor/');
  const cacheName = vendor ? OCR_CACHE : CACHE;
  const key = vendor ? request : request.mode === 'navigate'
    ? offlinePage(url.pathname)
    : SHELL.includes(url.pathname) ? url.pathname : null;

  const network = fetch(request);
  if (key) {
    e.waitUntil(network.then(async response => {
      if (!response.ok) return;
      const copy = response.clone();
      const cache = await caches.open(cacheName);
      await cache.put(key, copy);
    }).catch(() => {}));
  }

  e.respondWith(network.catch(async () => {
    const cached = key && await caches.match(key, { cacheName });
    if (cached) return cached;
    return request.mode === 'navigate'
      ? new Response('This AquaTrack page is unavailable offline. Reconnect and try again.', {
        status: 503,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' }
      })
      : Response.error();
  }));
});
