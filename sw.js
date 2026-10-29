// Offline support. build.mjs replaces VERSION and ASSETS. Network first, so a new deployment is used as soon as it is reachable.
const VERSION = "dev";
const ASSETS = [];
const CACHE = `jg-${VERSION}`;

self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", event => {
  event.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(key => key.startsWith("jg-") && key !== CACHE).map(key => caches.delete(key))))
    .then(() => self.clients.claim()));
});
self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== location.origin) return;
  event.respondWith(fetch(event.request).then(response => {
    // The Graphviz WASM bundle is cached the first time a graph is drawn, not on install.
    if (response.ok) { const copy = response.clone(); caches.open(CACHE).then(cache => cache.put(event.request, copy)); }
    return response;
  }).catch(async () => (await caches.match(event.request, { ignoreSearch: true })) ?? (event.request.mode === "navigate" ? caches.match("./") : Response.error())));
});
