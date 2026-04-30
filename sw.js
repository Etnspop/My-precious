// Service worker scope is determined by the path this file is served from,
// so paths here are resolved relative to it (works whether the site is at
// /  or  /<repo-name>/  on GitHub Pages).
// Bump CACHE on each deploy and bump the ?v= query string in index.html on
// any change to app.js or style.css. The query string makes the new asset
// URL distinct, so the old cache entry can't satisfy the new request.
const CACHE = "myprecious-v10";
const SHELL = [
  "./",
  "./index.html",
  "./style.css?v=6",
  "./app.js?v=6",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",
  "./apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => Promise.all(SHELL.map((u) => c.add(u).catch(() => {}))))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // Never intercept third-party API calls (Binance, Yahoo, Stooq, CoinGecko).
  if (url.origin !== self.location.origin) return;

  // Network-first for the HTML shell so updates come through quickly.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
          return res;
        })
        .catch(() => caches.match(req).then((c) => c || caches.match("./")))
    );
    return;
  }

  // Cache-first for our own static assets.
  event.respondWith(
    caches.match(req).then((cached) =>
      cached ||
      fetch(req).then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
    )
  );
});
