// sw.js — minimal service worker, required (alongside the manifest) for
// Chrome/Edge/Android to offer "Install app". Deliberately conservative:
// this is a live financial dashboard, so /api/* is NEVER cached — every
// data request always goes to the network, full stop. Only the static
// shell (the page itself, manifest, icons) gets a network-first cache, so a
// flaky connection doesn't leave the app fully blank, but a fresh deploy is
// still what loads whenever the network is actually up.

const CACHE_NAME = 'madina-bi-shell-v4';
const SHELL_URLS = ['/', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    // Cache each file on its own and ignore failures: addAll() rejects if ANY
    // file fails (e.g. '/' before the password is entered), which would fail
    // the whole worker install and make the site non-installable.
    caches.open(CACHE_NAME)
      .then((cache) => Promise.all(SHELL_URLS.map((u) => cache.add(u).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Never intercept API calls (or anything non-GET) — always straight to
  // the network, so filters/pivots/reports can never show stale data.
  if (req.method !== 'GET' || url.pathname.startsWith('/api/')) return;

  // Static shell: try the network first (so an update is picked up as soon
  // as it's reachable), fall back to the cache only if the network fails.
  event.respondWith(
    fetch(req, { cache: 'no-cache' })
      .then((res) => {
        if (!res.ok) return res; // never cache a 401 / error page
        const copy = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
        return res;
      })
      .catch(() => caches.match(req))
  );
});
