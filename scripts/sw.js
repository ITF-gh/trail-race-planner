// Service worker: network first (always the live app), last copy from the cache when offline. Same-site GET only.
const CACHE = "pmr-__VER__";
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener("fetch", (e) => {
  const r = e.request;
  if (r.method !== "GET" || new URL(r.url).origin !== self.location.origin) return;
  e.respondWith(
    fetch(r)
      .then((res) => {
        if (res.ok) { const c = res.clone(); caches.open(CACHE).then((x) => x.put(r, c)); }
        return res;
      })
      .catch(() => caches.match(r, { ignoreSearch: r.mode === "navigate" }).then((m) => m || caches.match("./")))
  );
});
