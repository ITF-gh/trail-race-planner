// map.js: the course on a map. OpenStreetMap tiles drawn by Leaflet when it can load,
// a plain SVG trace of the course when it cannot (offline, or a host that blocks it).
//
// How a web map works: the world is cut into square 256 px images ("tiles") for each zoom
// level (zoom z has 2^z x 2^z tiles). The browser downloads only the tiles in view, from
// URLs like tile.openstreetmap.org/{z}/{x}/{y}.png, and Leaflet lays them out and moves them
// as you pan and zoom. The course is drawn on top as SVG lines, from its latitude/longitude
// points projected the same way as the tiles (Web Mercator).
//
// Leaflet itself is shipped next to the page (dist/vendor/leaflet), so the map code works
// without the internet; only the tile images need the network. With no tiles you still get
// the course line, the markers and the runner on a plain background.

import { trackEvent } from "./analytics.js";

const LEAFLET_JS = "vendor/leaflet/leaflet.js";
const LEAFLET_CSS = "vendor/leaflet/leaflet.css";

let leafletPromise = null;
/** Load Leaflet once, on first use. Resolves with window.L, or null if it cannot load. */
export function loadLeaflet() {
  if (window.L && window.L.map) return Promise.resolve(window.L);
  if (leafletPromise) return leafletPromise;
  leafletPromise = new Promise((done) => {
    const css = document.createElement("link");
    css.rel = "stylesheet";
    css.href = LEAFLET_CSS;
    document.head.appendChild(css);
    const js = document.createElement("script");
    js.src = LEAFLET_JS;
    js.async = true;
    const timer = setTimeout(() => done(null), 8000);
    js.onload = () => { clearTimeout(timer); done(window.L && window.L.map ? window.L : null); };
    js.onerror = () => { clearTimeout(timer); done(null); };
    document.head.appendChild(js);
  });
  return leafletPromise;
}

const TILES = {
  map: {
    label: "Map",
    url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
  },
  topo: {
    label: "Topo",
    url: "https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png",
    maxZoom: 17,
    attribution: 'Map data &copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors, SRTM · style &copy; <a href="https://opentopomap.org" target="_blank" rel="noopener">OpenTopoMap</a> (CC-BY-SA)',
  },
};

/**
 * Draw the course in `el`. `opts`:
 *   route   [[lat, lon], ...] one point per 100 m (same points as the profile)
 *   totalKm course length
 *   paint   [{fromKm, toKm, cls, title}] coloured stretches (climbs by level, braking descents)
 *   marks   [{km, kind: "aid"|"km"|"gel", label}] markers along the course
 * Returns a controller: setRunner(km) moves the runner dot, follow(on), fit(), destroy().
 * Leaflet loads in the background, so the controller works before the map is ready.
 */
export function courseMap(el, opts) {
  const ctl = { km: null, following: false, impl: null, dead: false };
  el.classList.add("map");
  el.innerHTML = `<div class="map-loading">Loading map…</div>`;
  const api = {
    setRunner(km) { ctl.km = km; if (ctl.impl) ctl.impl.setRunner(km); },
    follow(on) { ctl.following = on; if (ctl.impl) ctl.impl.follow(on); },
    fit() { if (ctl.impl) ctl.impl.fit(); },
    destroy() { ctl.dead = true; if (ctl.impl) ctl.impl.destroy(); },
  };
  loadLeaflet().then((L) => {
    if (ctl.dead || !el.isConnected) return;
    ctl.impl = L ? leafletMap(L, el, opts) : svgMap(el, opts);
    if (ctl.km !== null) ctl.impl.setRunner(ctl.km);
    if (ctl.following) ctl.impl.follow(true);
  });
  return api;
}

/** Position on the route at `km`, interpolated between the 100 m points. */
export function pointAt(route, totalKm, km) {
  const f = Math.max(0, Math.min(1, km / totalKm)) * (route.length - 1);
  const i = Math.min(route.length - 2, Math.floor(f));
  const t = f - i;
  return [route[i][0] + t * (route[i + 1][0] - route[i][0]), route[i][1] + t * (route[i + 1][1] - route[i][1])];
}
const slice = (route, totalKm, a, b) => {
  const n = route.length - 1;
  const i = Math.max(0, Math.round((a / totalKm) * n));
  const j = Math.min(n, Math.round((b / totalKm) * n));
  return route.slice(i, j + 1);
};

function markHtml(m) {
  if (m.kind === "aid") return `<div class="mk mk-aid" title="${m.label}"></div>`;
  if (m.kind === "start") return `<div class="mk mk-start">${m.label}</div>`;
  return `<div class="mk mk-km">${m.label}</div>`;
}

function leafletMap(L, el, { route, totalKm, paint = [], marks = [] }) {
  el.innerHTML = "";
  const map = L.map(el, { scrollWheelZoom: false, zoomSnap: 0.25, attributionControl: true });
  const layers = Object.fromEntries(Object.entries(TILES).map(([k, t]) => [t.label, L.tileLayer(t.url, { maxZoom: t.maxZoom, attribution: t.attribution, subdomains: "abc", crossOrigin: true })]));
  layers.Map.addTo(map);
  L.control.layers(layers, null, { position: "topright" }).addTo(map);
  // Leaflet also fires baselayerchange when the first layer is (re)attached: count real switches only.
  let base = "Map";
  map.on("baselayerchange", (e) => { if (e.name !== base) { base = e.name; trackEvent("map-layer", e.name); } });
  L.control.scale({ imperial: false }).addTo(map);
  // Wheel zoom only after a click on the map, so scrolling the page never gets stuck in it.
  map.on("click", () => map.scrollWheelZoom.enable());
  map.on("mouseout", () => map.scrollWheelZoom.disable());

  L.polyline(route, { className: "rt-casing", interactive: false }).addTo(map);
  const line = L.polyline(route, { className: "rt-line", interactive: false }).addTo(map);
  paint.forEach((p) => L.polyline(slice(route, totalKm, p.fromKm, p.toKm), { className: p.cls }).bindTooltip(p.title, { sticky: true }).addTo(map));
  marks.forEach((m) => {
    const icon = L.divIcon({ className: "mk-wrap", html: markHtml(m), iconSize: null });
    const mk = L.marker(pointAt(route, totalKm, m.km), { icon, keyboard: false, zIndexOffset: m.kind === "aid" ? 500 : 0 }).addTo(map);
    if (m.kind !== "km") mk.bindTooltip(m.title || m.label, { direction: "top", offset: [0, -8] });
  });
  const runner = L.marker(route[0], { icon: L.divIcon({ className: "mk-wrap", html: `<div class="runner"><i></i></div>`, iconSize: null }), interactive: false, zIndexOffset: 1000 });
  let following = false; // the replay wants the map to follow the runner
  let zoomed = false;
  let free = false; // ...but you moved the map yourself: it stays where you put it
  const fit = () => map.fitBounds(line.getBounds(), { padding: [18, 18] });
  fit();
  // Recenter button: brings the runner back into view and resumes following.
  const Recenter = L.Control.extend({
    onAdd() {
      const b = L.DomUtil.create("button", "map-recenter");
      b.type = "button";
      b.innerHTML = "◎ Recenter";
      b.title = "Back to the runner";
      L.DomEvent.disableClickPropagation(b);
      L.DomEvent.on(b, "click", () => {
        trackEvent("map-recenter");
        free = false;
        b.classList.remove("on");
        if (map.hasLayer(runner)) map.setView(runner.getLatLng(), Math.max(map.getZoom(), 14));
        else fit();
      });
      return b;
    },
  });
  const recenter = new Recenter({ position: "bottomright" });
  // Dragging the map is your move: stop following until you press Recenter. Zooming keeps
  // following (the map re-centres only if the runner leaves the view).
  map.on("dragstart", () => {
    if (!following) return;
    free = true;
    recenter.getContainer() && recenter.getContainer().classList.add("on");
  });
  return {
    setRunner(km) {
      const p = pointAt(route, totalKm, km);
      runner.setLatLng(p);
      if (!map.hasLayer(runner)) runner.addTo(map);
      // Following: re-centre only when the runner leaves the middle of the view, so the map
      // holds still most of the time instead of sliding on every frame.
      if (following && !free && !map.getBounds().pad(-0.25).contains(p)) map.panTo(p, { animate: false });
    },
    follow(on) {
      following = on;
      free = false;
      if (on && !recenter.getContainer()) recenter.addTo(map);
      if (recenter.getContainer()) recenter.getContainer().classList.remove("on");
      // Zoom in on the runner the first time only; after that your zoom level is kept.
      if (on && map.hasLayer(runner)) { map.setView(runner.getLatLng(), zoomed ? map.getZoom() : Math.max(map.getZoom(), 14), { animate: false }); zoomed = true; }
      else if (!on) fit();
    },
    fit,
    destroy() { map.remove(); },
  };
}

/** Offline fallback: the course projected onto a flat SVG (equirectangular, fine at race scale). */
function svgMap(el, { route, totalKm, paint = [], marks = [] }) {
  const lat0 = route.reduce((s, p) => s + p[0], 0) / route.length;
  const kx = Math.cos((lat0 * Math.PI) / 180);
  const xs = route.map((p) => p[1] * kx), ys = route.map((p) => -p[0]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const W = 1000, pad = 30;
  const sc = (W - 2 * pad) / Math.max(x1 - x0, 1e-9);
  const H = Math.max(300, Math.min(900, (y1 - y0) * sc + 2 * pad));
  const s2 = Math.min(sc, (H - 2 * pad) / Math.max(y1 - y0, 1e-9));
  const ox = (W - (x1 - x0) * s2) / 2, oy = (H - (y1 - y0) * s2) / 2;
  const pt = ([la, lo]) => [ox + (lo * kx - x0) * s2, oy + (-la - y0) * s2];
  const path = (pts) => pts.map((p, i) => { const [x, y] = pt(p); return `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`; }).join("");
  let s = `<path class="rt-casing" d="${path(route)}"/><path class="rt-line" d="${path(route)}"/>`;
  paint.forEach((p) => { s += `<path class="${p.cls}" d="${path(slice(route, totalKm, p.fromKm, p.toKm))}"><title>${p.title}</title></path>`; });
  marks.forEach((m) => {
    const [x, y] = pt(pointAt(route, totalKm, m.km));
    if (m.kind === "aid") s += `<path class="aid" d="M${x.toFixed(1)},${(y - 4).toFixed(1)} l-7,-12 h14 z"><title>${m.title || m.label}</title></path>`;
    else s += `<g class="kmk"><circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="11"/><text x="${x.toFixed(1)}" y="${(y + 4).toFixed(1)}" text-anchor="middle">${m.label}</text></g>`;
  });
  s += `<g class="runner-svg" style="display:none"><circle r="13" class="halo"/><circle r="7"/></g>`;
  el.innerHTML = `<svg class="map-svg" viewBox="0 0 ${W} ${H.toFixed(0)}" role="img" aria-label="Course map">${s}</svg><div class="map-off">Map tiles unavailable offline: course shape only.</div>`;
  const dot = el.querySelector(".runner-svg");
  return {
    setRunner(km) { const [x, y] = pt(pointAt(route, totalKm, km)); dot.style.display = ""; dot.setAttribute("transform", `translate(${x.toFixed(1)},${y.toFixed(1)})`); },
    follow() {},
    fit() {},
    destroy() {},
  };
}
