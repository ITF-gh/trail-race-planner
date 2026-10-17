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
//
// Where it sits: replay.js (the race-day and Prep my run cockpit) calls courseMap() with the
// course route (one [lat, lon] point per 100 m, made in the core), the coloured stretches and
// the markers, then drives the returned controller on every animation frame (setRunner) and
// on every section change (highlight). Nothing here computes the plan; it only draws it.
//
// Main exports:
//   loadLeaflet()            load the Leaflet library once, on demand
//   courseMap(el, opts)      draw the course and return a small controller object
//   pointAt(route, km, ...)  [lat, lon] at a given km, by linear interpolation
//
// Key idea: one controller, two drawing engines. courseMap() returns the controller at once,
// remembers what it was asked to do while Leaflet loads (runner position, highlight, follow),
// then picks the engine (leafletMap or svgMap, same methods) and replays those wishes on it.
// The caller never needs to know which engine is in use, or wait for it.

import { trackEvent } from "./analytics.js";

// Paths of the Leaflet files copied next to the page by the build (relative to index.html).
const LEAFLET_JS = "vendor/leaflet/leaflet.js";
const LEAFLET_CSS = "vendor/leaflet/leaflet.css";

// The one shared loading Promise: every caller gets the same one, so the script is added once.
let leafletPromise = null;
/**
 * Load Leaflet once, on first use. Resolves with window.L, or null if it cannot load.
 *
 * How: it adds a <link> (the stylesheet) and a <script> tag to the page head, then waits for the
 * script's onload (success) or onerror (failure). A Promise wraps those two callbacks so callers
 * can simply write loadLeaflet().then(...). The Promise never rejects: failure resolves with null,
 * which callers read as "use the SVG fallback".
 * Side effects: adds two elements to document.head, the first time only.
 */
export function loadLeaflet() {
  // Already loaded (window.L is the global Leaflet puts on the page): nothing to do.
  if (window.L && window.L.map) return Promise.resolve(window.L);
  // Loading already started by an earlier call: share its Promise instead of loading twice.
  if (leafletPromise) return leafletPromise;
  leafletPromise = new Promise((done) => {
    const css = document.createElement("link");
    css.rel = "stylesheet";
    css.href = LEAFLET_CSS;
    document.head.appendChild(css);
    const js = document.createElement("script");
    js.src = LEAFLET_JS;
    js.async = true;
    // Give up after 8 s (a stalled network): resolve with null so the SVG map is drawn instead.
    const timer = setTimeout(() => done(null), 8000);
    js.onload = () => { clearTimeout(timer); done(window.L && window.L.map ? window.L : null); };
    js.onerror = () => { clearTimeout(timer); done(null); };
    document.head.appendChild(js);
  });
  return leafletPromise;
}

/**
 * The three background maps offered in the layer switcher (top right of the map).
 * For each one:
 *   label        name shown in the switcher (also the key Leaflet reports on a switch)
 *   url          tile URL template: Leaflet replaces {z} zoom, {x}/{y} tile column/row,
 *                {s} one of the subdomains (spreads the downloads over several servers),
 *                {r} "@2x" on high-density screens (sharper tiles), "" otherwise
 *   maxZoom      the deepest zoom that server provides
 *   subdomains   letters that replace {s} (Leaflet's default is "abc")
 *   attribution  credit line the tile licences require, shown bottom right
 */
const TILES = {
  map: {
    label: "Map",
    url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
  },
  light: {
    label: "Light",
    url: "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png",
    maxZoom: 20,
    subdomains: "abcd",
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions" target="_blank" rel="noopener">CARTO</a>',
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
 * Returns a controller: setRunner(km) moves the runner dot, highlight(cur) makes the section you
 * are on ({fromKm, toKm}, or null) glow, show(fromKm, toKm) zooms on a stretch, focus(fromKm, toKm)
 * zooms on it and dims the rest of the route (focus(null) undoes it), follow(on), fit(), destroy().
 * Leaflet loads in the background, so the controller works before the map is ready.
 *
 * Side effects: empties `el`, adds the "map" class, shows "Loading map…" until an engine is ready.
 */
export function courseMap(el, opts) {
  // What the caller asked for so far, kept so it can be applied once the engine exists:
  //   km         last runner position (km), or null if never set
  //   hl         last highlight request, kept as an argument list for the spread call below
  //   following  whether the map should follow the runner
  //   impl       the engine (Leaflet or SVG controller) once ready, null before
  //   dead       destroy() was called: do not build anything when Leaflet arrives
  const ctl = { km: null, hl: null, fc: null, following: false, impl: null, dead: false };
  el.classList.add("map");
  el.innerHTML = `<div class="map-loading">Loading map…</div>`;
  // Each method stores the wish in `ctl`, and passes it on right away if the engine is ready.
  const api = {
    setRunner(km) { ctl.km = km; if (ctl.impl) ctl.impl.setRunner(km); },
    highlight(cur) { ctl.hl = [cur]; if (ctl.impl) ctl.impl.highlight(cur); },
    show(fromKm, toKm) { if (ctl.impl) ctl.impl.show(fromKm, toKm); },
    focus(fromKm, toKm) { ctl.fc = fromKm === null || fromKm === undefined ? null : [fromKm, toKm]; if (ctl.impl) ctl.impl.focus(ctl.fc); },
    follow(on) { ctl.following = on; if (ctl.impl) ctl.impl.follow(on); },
    fit() { if (ctl.impl) ctl.impl.fit(); },
    destroy() { ctl.dead = true; if (ctl.impl) ctl.impl.destroy(); },
  };
  loadLeaflet().then((L) => {
    // The page may have moved on while Leaflet loaded (el.isConnected is false once the element
    // is removed from the page): then build nothing.
    if (ctl.dead || !el.isConnected) return;
    // Leaflet if it loaded, the flat SVG trace otherwise. Both return the same set of methods.
    ctl.impl = L ? leafletMap(L, el, opts) : svgMap(el, opts);
    // Replay the stored wishes on the new engine. `...ctl.hl` spreads the saved argument list.
    if (ctl.hl) ctl.impl.highlight(...ctl.hl);
    if (ctl.fc) ctl.impl.focus(ctl.fc);
    if (ctl.km !== null) ctl.impl.setRunner(ctl.km);
    if (ctl.following) ctl.impl.follow(true);
  });
  return api;
}

/**
 * Position on the route at `km`, interpolated between the 100 m points.
 *
 * The route points are evenly spaced, so the point index is simply proportional to the distance:
 * f = (km / totalKm) x (number of gaps). The integer part i is the point just before, the decimal
 * part t (0 to 1) says how far along the gap to the next point we are. The result is
 * a + t x (b - a) for latitude and for longitude (linear interpolation; fine over 100 m).
 * Inputs: route [[lat, lon], ...], totalKm and km in kilometres. Returns [lat, lon].
 */
export function pointAt(route, totalKm, km) {
  // Clamp km / totalKm to 0..1 so a km before the start or past the finish stays on the course.
  const f = Math.max(0, Math.min(1, km / totalKm)) * (route.length - 1);
  // At the very finish f equals the last index: keep i one below so route[i + 1] exists.
  const i = Math.min(route.length - 2, Math.floor(f));
  const t = f - i;
  return [route[i][0] + t * (route[i + 1][0] - route[i][0]), route[i][1] + t * (route[i + 1][1] - route[i][1])];
}
/**
 * The route points between km `a` and km `b` (nearest 100 m points, ends included), as a new
 * array. Used to draw a coloured stretch or the glow of the current section.
 */
const slice = (route, totalKm, a, b) => {
  const n = route.length - 1;
  const i = Math.max(0, Math.round((a / totalKm) * n));
  const j = Math.min(n, Math.round((b / totalKm) * n));
  // Array.slice stops BEFORE its second index, hence j + 1 to include point j.
  return route.slice(i, j + 1);
};

/**
 * HTML of one marker for Leaflet: an aid-station marker (its name as a
 * tooltip), a labelled badge for the start, a numbered round badge for a km marker.
 * The look comes from the .mk classes in style.css.
 */
function markHtml(m) {
  if (m.kind === "aid") return `<div class="mk mk-aid" title="${m.label}"></div>`;
  if (m.kind === "start") return `<div class="mk mk-start">${m.label}</div>`;
  return `<div class="mk mk-km">${m.label}</div>`;
}

/**
 * The Leaflet engine: a real map with tiles, layers, scale, markers and a moving runner.
 * Inputs: L the Leaflet library, el the box to draw in, and the same opts as courseMap
 * (destructured here: `paint = []` means "an empty list if the caller gave none").
 * Returns the controller methods (setRunner, show, highlight, follow, fit, destroy).
 * Side effects: fills `el` with the Leaflet map, starts tile downloads, sends analytics events
 * when the reader switches layer or presses Recenter.
 *
 * Drawing order matters: what is added last sits on top. The order here is, bottom to top:
 * tiles, casing (a wide pale line under the course), the glow of the current section, the course
 * line, the coloured stretches, the markers, the runner.
 */
function leafletMap(L, el, { route, totalKm, paint = [], marks = [] }) {
  el.innerHTML = "";
  // 1. The map itself. scrollWheelZoom off (turned on after a click, see below); zoomSnap 0.25
  // lets fitBounds pick quarter zoom levels so the course fills the box more closely.
  const map = L.map(el, { scrollWheelZoom: false, zoomSnap: 0.25, attributionControl: true });
  // Plain <img> tiles (no crossOrigin): nothing reads their pixels, and a CORS-mode request
  // fails outright whenever a tile server answers without CORS headers.
  // 2. One Leaflet tile layer per entry of TILES, keyed by its label: { Map: layer, Light: layer,
  // Topo: layer }. Object.entries turns the object into [key, value] pairs, .map builds new
  // pairs, and Object.fromEntries turns them back into an object.
  const layers = Object.fromEntries(Object.entries(TILES).map(([k, t]) => [t.label, L.tileLayer(t.url, { maxZoom: t.maxZoom, attribution: t.attribution, subdomains: t.subdomains || "abc" })]));
  // Sky mode starts on the light CARTO tiles; the night look keeps the OpenStreetMap ones.
  // (The theme is stored as data-theme on the <html> element.)
  const sky = document.documentElement.dataset.theme === "sky";
  (sky ? layers.Light : layers.Map).addTo(map);
  // If the OpenStreetMap tiles do not come (blocked, rate-limited, offline server), switch once to
  // the Light map from another server rather than leave a blank grey box.
  // The rule: at least 4 tile errors and not one tile loaded yet, and Map still the layer shown.
  let tileOk = 0, tileErr = 0, swapped = false;
  layers.Map.on("tileload", () => { tileOk++; });
  layers.Map.on("tileerror", () => {
    tileErr++;
    if (swapped || tileOk > 0 || tileErr < 4 || !map.hasLayer(layers.Map)) return;
    swapped = true;
    map.removeLayer(layers.Map);
    layers.Light.addTo(map);
    trackEvent("map-fallback");
  });
  // 3. Controls: the layer switcher (first argument = base layers, of which one shows at a
  // time; null = no overlay layers) and a metric scale bar.
  L.control.layers(layers, null, { position: "topright" }).addTo(map);
  // Leaflet also fires baselayerchange when the first layer is (re)attached: count real switches only.
  let base = sky ? "Light" : "Map";
  map.on("baselayerchange", (e) => { if (e.name !== base) { base = e.name; trackEvent("map-layer", e.name); } });
  L.control.scale({ imperial: false }).addTo(map);
  // Wheel zoom only after a click on the map, so scrolling the page never gets stuck in it.
  map.on("click", () => map.scrollWheelZoom.enable());
  map.on("mouseout", () => map.scrollWheelZoom.disable());

  // 4. The course lines. L.polyline draws a line through [lat, lon] points; className hands the
  // styling (colour, width) to style.css. interactive: false means mouse events pass through.
  const casing = L.polyline(route, { className: "rt-casing", interactive: false }).addTo(map);
  // The section you are on: a soft glow drawn UNDER the coloured course (added right after the
  // casing, so everything drawn later sits on top), so the section keeps its own colour and only
  // shines. Made once; it only gets new points when you change section.
  const curGlow = L.polyline([], { className: "rt-cur-glow", interactive: false }).addTo(map);
  const line = L.polyline(route, { className: "rt-line", interactive: false }).addTo(map);
  // Coloured stretches (climbs by level, braking descents), each with a tooltip that follows
  // the mouse along the line (sticky).
  paint.forEach((p) => L.polyline(slice(route, totalKm, p.fromKm, p.toKm), { className: p.cls }).bindTooltip(p.title, { sticky: true }).addTo(map));
  // The focused stretch (a profile zoom, a race-script moment): the route outside it is dimmed by
  // the "map-dim" class on the box (see style.css), and this group redraws the stretch on top at
  // full strength: the plain line, then each coloured stretch cut to the window. Empty otherwise.
  const focusGroup = L.layerGroup().addTo(map);
  const drawFocus = (a, b) => {
    focusGroup.clearLayers();
    el.classList.toggle("map-dim", a !== null);
    if (a === null) return;
    focusGroup.addLayer(L.polyline(slice(route, totalKm, a, b), { className: "rt-line rt-f", interactive: false }));
    paint.forEach((p) => {
      const f = Math.max(a, p.fromKm), t = Math.min(b, p.toKm);
      if (t > f) focusGroup.addLayer(L.polyline(slice(route, totalKm, f, t), { className: `${p.cls} rt-f`, interactive: false }));
    });
  };
  // 5. Markers. L.divIcon makes a marker from our own HTML instead of Leaflet's blue pin;
  // iconSize: null lets CSS decide the size. zIndexOffset raises aid stations above km badges.
  marks.forEach((m) => {
    const icon = L.divIcon({ className: "mk-wrap", html: markHtml(m), iconSize: null });
    const mk = L.marker(pointAt(route, totalKm, m.km), { icon, keyboard: false, zIndexOffset: m.kind === "aid" ? 500 : 0 }).addTo(map);
    if (m.kind !== "km") mk.bindTooltip(m.title || m.label, { direction: "top", offset: [0, -8] });
  });
  // 6. The runner: a marker on top of everything (zIndexOffset 1000). Created here but only
  // added to the map on the first setRunner(), so it does not sit at the start before playing.
  const runner = L.marker(route[0], { icon: L.divIcon({ className: "mk-wrap", html: `<div class="runner"><i></i></div>`, iconSize: null }), interactive: false, zIndexOffset: 1000 });
  // Follow state, three flags:
  //   following  the replay asked the map to keep the runner in view
  //   zoomed     the first close-up on the runner was already done (keep the reader's zoom after)
  //   free       the reader dragged the map: stop following until Recenter (or follow() again)
  let following = false; // the replay wants the map to follow the runner
  let zoomed = false;
  let free = false; // ...but you moved the map yourself: it stays where you put it
  // Zoom and pan so the whole course fits, with an 18 px margin.
  const fit = () => map.fitBounds(line.getBounds(), { padding: [18, 18] });
  fit();
  // The box can change size after the map is drawn (the panel next to it grows with its text):
  // tell Leaflet, or it keeps placing things for the old size.
  // ResizeObserver calls its function each time the observed element changes size. The
  // typeof test skips it on old browsers that do not have it.
  const resize = typeof ResizeObserver === "function" ? new ResizeObserver(() => map.invalidateSize({ pan: false })) : null;
  if (resize) resize.observe(el);
  // Recenter button: brings the runner back into view and resumes following.
  // L.Control.extend makes a new kind of map control; onAdd() returns its DOM element.
  const Recenter = L.Control.extend({
    onAdd() {
      const b = L.DomUtil.create("button", "map-recenter");
      b.type = "button";
      b.innerHTML = "◎ Recenter";
      b.title = "Back to the runner";
      // Without this, a click on the button would also reach the map underneath (and turn on
      // wheel zoom, see above).
      L.DomEvent.disableClickPropagation(b);
      L.DomEvent.on(b, "click", () => {
        trackEvent("map-recenter");
        free = false;
        b.classList.remove("on");
        // Runner on the map: centre on it, at zoom 14 or closer. No runner yet: show the course.
        if (map.hasLayer(runner)) map.setView(runner.getLatLng(), Math.max(map.getZoom(), 14));
        else fit();
      });
      return b;
    },
  });
  // Created now, added to the map only when following starts (see follow()).
  const recenter = new Recenter({ position: "bottomright" });
  // Dragging the map is your move: stop following until you press Recenter. Zooming keeps
  // following (the map re-centres only if the runner leaves the view).
  // The "on" class makes the Recenter button stand out, to say the map is no longer following.
  map.on("dragstart", () => {
    if (!following) return;
    free = true;
    recenter.getContainer() && recenter.getContainer().classList.add("on");
  });
  return {
    /** Move the runner to `km` (and keep it in view when following). Called on every frame. */
    setRunner(km) {
      const p = pointAt(route, totalKm, km);
      runner.setLatLng(p);
      if (!map.hasLayer(runner)) runner.addTo(map);
      // Following: re-centre only when the runner leaves the middle of the view, so the map
      // holds still most of the time instead of sliding on every frame.
      // pad(-0.25) shrinks the visible box by 25% on each side: that inner box is "the middle".
      if (following && !free && !map.getBounds().pad(-0.25).contains(p)) map.panTo(p, { animate: false });
    },
    // Zoom the map onto a stretch of the course (a section picked on the bar of sections).
    show(fromKm, toKm) {
      const pts = slice(route, totalKm, fromKm, toKm);
      if (pts.length < 2) return;
      // Like a drag: the map stays on that stretch until you press Recenter or Play.
      if (following) { free = true; recenter.getContainer() && recenter.getContainer().classList.add("on"); }
      // Make sure Leaflet knows the box's current size before computing the zoom.
      map.invalidateSize({ pan: false });
      // 40 px margin, and never closer than zoom 14 (a short stretch would fill the screen).
      map.fitBounds(L.latLngBounds(pts), { padding: [40, 40], maxZoom: 14 });
    },
    /** Zoom on [fromKm, toKm] and dim the rest of the route; null brings the whole route back. */
    focus(fc) {
      drawFocus(fc ? fc[0] : null, fc ? fc[1] : null);
      if (fc) this.show(fc[0], fc[1]);
    },
    /** Make the section `cur` ({fromKm, toKm}) glow; null clears the glow. */
    highlight(cur) {
      const pts = (x) => (x ? slice(route, totalKm, x.fromKm, x.toKm) : []);
      curGlow.setLatLngs(pts(cur));
    },
    /** Start (on = true) or stop following the runner. Stopping zooms back out to the course. */
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
    // Stop watching the box size and let Leaflet remove its elements and listeners.
    destroy() { if (resize) resize.disconnect(); map.remove(); },
  };
}

/**
 * Offline fallback: the course projected onto a flat SVG (equirectangular, fine at race scale).
 *
 * Projection: x = longitude x cos(mean latitude), y = -latitude. One degree of longitude gets
 * shorter towards the poles (by the cosine of the latitude), so this keeps the course's shape
 * right over a few tens of km. y is negated because SVG's y axis points down, while latitude
 * grows northwards.
 * Inputs: el the box, and the same opts as courseMap. Returns the same controller methods as
 * leafletMap; follow, show and fit do nothing here (the whole course is always in view).
 * Side effects: replaces the contents of `el` with an <svg> and a short "offline" note.
 */
function svgMap(el, { route, totalKm, paint = [], marks = [] }) {
  // 1. Mean latitude of the course (reduce adds up all latitudes), and its cosine.
  const lat0 = route.reduce((s, p) => s + p[0], 0) / route.length;
  const kx = Math.cos((lat0 * Math.PI) / 180);
  const xs = route.map((p) => p[1] * kx), ys = route.map((p) => -p[0]);
  // 2. The bounding box of the projected course. Math.min(...xs) spreads the array into
  // separate arguments, so Math.min sees every value.
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  // 3. Scale to a drawing 1000 units wide with a 30-unit margin. The height follows the course's
  // shape but stays between 300 and 900; s2 is the final scale that fits both ways, and ox/oy
  // centre the course in the drawing. 1e-9 avoids a division by zero on a dead-straight course.
  const W = 1000, pad = 30;
  const sc = (W - 2 * pad) / Math.max(x1 - x0, 1e-9);
  const H = Math.max(300, Math.min(900, (y1 - y0) * sc + 2 * pad));
  const s2 = Math.min(sc, (H - 2 * pad) / Math.max(y1 - y0, 1e-9));
  const ox = (W - (x1 - x0) * s2) / 2, oy = (H - (y1 - y0) * s2) / 2;
  // [lat, lon] -> [x, y] in drawing units. ([la, lo]) destructures the pair into two names.
  const pt = ([la, lo]) => [ox + (lo * kx - x0) * s2, oy + (-la - y0) * s2];
  // SVG path data for a list of points: "M x,y" moves the pen to the first point, then
  // "L x,y" draws a straight line to each next one. toFixed(1) keeps one decimal, enough here.
  const path = (pts) => pts.map((p, i) => { const [x, y] = pt(p); return `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`; }).join("");
  // 4. Build the SVG as text, bottom to top: casing, empty glow (filled by highlight), course
  // line, coloured stretches (each with a <title> = native tooltip), markers, hidden runner.
  let s = `<path class="rt-casing" d="${path(route)}"/><path class="rt-cur-glow" d=""/><path class="rt-line" d="${path(route)}"/>`;
  paint.forEach((p) => { s += `<path class="${p.cls}" d="${path(slice(route, totalKm, p.fromKm, p.toKm))}"><title>${p.title}</title></path>`; });
  marks.forEach((m) => {
    const [x, y] = pt(pointAt(route, totalKm, m.km));
    // Aid station: a small triangle pointing down at the spot ("l" and "h" are relative moves:
    // 7 left and 12 up, then 14 across; "z" closes the shape). Others: a numbered circle.
    if (m.kind === "aid") s += `<path class="aid" d="M${x.toFixed(1)},${(y - 4).toFixed(1)} l-7,-12 h14 z"><title>${m.title || m.label}</title></path>`;
    else s += `<g class="kmk"><circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="11"/><text x="${x.toFixed(1)}" y="${(y + 4).toFixed(1)}" text-anchor="middle">${m.label}</text></g>`;
  });
  s += `<g class="runner-svg" style="display:none"><circle r="13" class="halo"/><circle r="7"/></g>`;
  // viewBox sets the drawing's own coordinate system (0..W by 0..H); the browser scales it to
  // whatever size CSS gives the <svg>.
  el.innerHTML = `<svg class="map-svg" viewBox="0 0 ${W} ${H.toFixed(0)}" role="img" aria-label="Course map">${s}</svg><div class="map-off">Map tiles unavailable offline: course shape only.</div>`;
  const dot = el.querySelector(".runner-svg");
  const glow = el.querySelector(".rt-cur-glow");
  return {
    highlight(cur) { glow.setAttribute("d", cur ? path(slice(route, totalKm, cur.fromKm, cur.toKm)) : ""); },
    // Show the runner group and move it with a transform (cheaper than rebuilding the SVG).
    setRunner(km) { const [x, y] = pt(pointAt(route, totalKm, km)); dot.style.display = ""; dot.setAttribute("transform", `translate(${x.toFixed(1)},${y.toFixed(1)})`); },
    follow() {},
    show() {},
    focus(fc) { this.highlight(fc ? { fromKm: fc[0], toKm: fc[1] } : null); },
    fit() {},
    destroy() {},
  };
}
