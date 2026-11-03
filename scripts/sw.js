// Service worker: network first (always the live app), last copy from the cache when offline. Same-site GET only.
const CACHE = "pmr-__VER__";
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE && k !== "pmr-share").map((k) => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener("fetch", (e) => {
  const r = e.request;
  // A file shared to the installed app (manifest share_target): keep it, then open the app, which reads it (ui/trackfile.js).
  if (r.method === "POST" && new URL(r.url).searchParams.has("share-target")) {
    e.respondWith((async () => {
      const f = (await r.formData()).getAll("track").find((x) => x && x.size);
      if (f) await (await caches.open("pmr-share")).put("shared-track", new Response(f, { headers: { "x-name": encodeURIComponent(f.name || "shared") } }));
      return Response.redirect(new URL("./?shared=1", self.registration.scope).href, 303);
    })());
    return;
  }
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
