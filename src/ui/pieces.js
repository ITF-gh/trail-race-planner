// pieces.js: the building blocks the Prep my race sections share: tiles, table rows, mini profiles
// (spark), the elevation profile (profileView), map styling, key-zone lists and the climbs and
// descents tables. Split out of main.js (2026-11-02).

import { STARS } from "../core/plan.js";
import { starChip, descChip } from "./chips.js";
import { clock } from "../core/format.js";
import { esc } from "./appstate.js";

// Small HTML builders used by several sections. Each returns HTML text.
//   tile(k, v, s, cls)  a key figure box: label k, value v, optional small line s
//   cell(k, v, cls)     one labelled cell in a climb or descent row
//   len(m)              a length in metres as "1.25 km" or "850 m"
//   kmRange(x)          "12.3": the start km of an object with startKm
//   empty(html)         the grey hint shown when a section has nothing to show yet
/* ---------- shared pieces ---------- */
export const tile = (k, v, s = "", cls = "") => `<div class="tile ${cls}"><div class="k">${k}</div><div class="v">${v}</div>${s ? `<div class="s">${s}</div>` : ""}</div>`;
export const cell = (k, v, cls = "") => `<div class="c ${cls}"><span class="k">${k}</span><b>${v}</b></div>`;
const len = (m) => (m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`);
export const kmRange = (x) => x.startKm.toFixed(1); // the start km only: the length column gives the rest
export const empty = (html) => `<div class="empty">${html}</div>`;
/**
 * The climbs and descents tables: one header row on top (the labels are not repeated in every
 * row), then the rows. cols: the column titles after the number and the mini profile; cls: the
 * table's kind ("t-route" or "t-plan"), which sets its column widths in src/ui/css.
 */
// Column order (Boss, design review 2): #, Km, the mini profile with the average gradient, then cols.
export const rowsTable = (cls, cols, body) => `<div class="rows tbl ${cls}" role="table"><div class="row rh" role="row"><div class="n">#</div><div class="c">Km</div><div class="c sph">Profile · avg</div>${cols.map((c) => `<div class="c${c.w ? " w" : ""}">${c.t || c}</div>`).join("")}<div class="diff"></div></div>${body}</div>`;
/**
 * spark(P, a, b): a small elevation line of the course from km a to km b, as an SVG (80 x 22),
 * scaled to that stretch's own lowest and highest point (at least 30 m of range, so a gentle
 * stretch looks gentle). 28 points along the stretch, read with elevAt from the profile.
 * The average gradient sits in bold on the middle of the line (it replaces an Average column).
 */
export function spark(P, a, b, avg = null) {
  const n = 28, pts = [];
  for (let i = 0; i <= n; i++) pts.push(elevAt(P, a + ((b - a) * i) / n));
  const lo = Math.min(...pts), hi = Math.max(...pts), mid = (lo + hi) / 2, half = Math.max(15, (hi - lo) / 2);
  const d = pts.map((e, i) => `${i ? "L" : "M"}${((i / n) * 78 + 1).toFixed(1)},${(11 - ((e - mid) / half) * 9).toFixed(1)}`).join("");
  // avg (optional): the average gradient, written in bold over the middle of the line.
  const lab = avg === null ? "" : `<b>${avg > 0 ? "+" : ""}${avg.toFixed(1)}%</b>`;
  return `<div class="sp" aria-hidden="true"><svg viewBox="0 0 80 22"><path d="${d}"/></svg>${lab}</div>`;
}

/**
 * Altitude (m) at a given km along the course, by linear interpolation in the profile.
 * profile: [[km, altitude m], ...] sorted by km. Before the start it returns the first
 * altitude, past the end the last one. In between it finds the first point at or after km and
 * takes the straight line between it and the one before: a + (fraction of the way) * (b - a).
 * Math.max(1e-9, ...) avoids dividing by zero if two points share the same km.
 * This is a simple scan from the start, so it costs more on long profiles.
 */
export function elevAt(profile, km) {
  if (km <= profile[0][0]) return profile[0][1];
  for (let i = 1; i < profile.length; i++) {
    if (profile[i][0] >= km) {
      const a = profile[i - 1], b = profile[i];
      return a[1] + ((km - a[0]) / Math.max(1e-9, b[0] - a[0])) * (b[1] - a[1]);
    }
  }
  return profile[profile.length - 1][1];
}

/**
 * Where things sit on the profile drawing (SVG units, viewBox 1000 wide): x(km), y(altitude),
 * and km(x) back from a click. Shared by the drawing and by the cursors that move on it.
 */
// Inputs: P the profile [[km, altitude m], ...], TOT the course length in km, race (truthy
// when gels and aid stations are drawn, which need more room underneath), flat (the compact
// cockpit version) and win (zoom window). Returns the sizes plus three converters:
//   x(km) -> SVG x, y(altitude m) -> SVG y (higher altitude = smaller y, SVG's y axis points down),
//   km(svg x) -> km, clamped to the visible window (used to turn a mouse position into a km).
// l and r are the left and right margins (room for the altitude labels), base the y of the axis.
function profGeom(P, TOT, race, flat = false, win = null) {
  // `win` [fromKm, toKm]: a zoomed window (drag-select on the briefing profile); altitudes scale to it.
  const K0 = win ? win[0] : 0, K1 = win ? win[1] : TOT;
  const inWin = win ? P.filter((p) => p[0] >= K0 && p[0] <= K1) : P;
  // Altitude range of what is on screen (the whole profile if the window holds under 2 points).
  // Math.min(...eles) uses spread to pass every array item as a separate argument.
  const eles = (inWin.length > 1 ? inWin : P).map((p) => p[1]);
  const EMIN = Math.min(...eles), EMAX = Math.max(...eles);
  // `flat`: the race day cockpit, where the profile runs the full width under the section bar,
  // so it is drawn about half as high (gels as small marks under the axis, no clock under them).
  // (Design review 2: the cockpit profile is 50% taller than it was, base 143 instead of 84.)
  const W = 1000, l = 52, r = 14, top = flat ? 22 : 18, base = flat ? 143 : race ? 205 : 190;
  const plotH = base - top - 24;
  const H = flat ? base + 34 : race ? 260 : 222;
  const x = (km) => l + ((km - K0) / (K1 - K0)) * (W - l - r);
  const y = (e) => base - 24 - ((e - EMIN) / Math.max(1, EMAX - EMIN)) * plotH;
  const km = (vx) => Math.max(K0, Math.min(K1, K0 + ((vx - l) / (W - l - r)) * (K1 - K0)));
  return { EMIN, EMAX, W, l, r, top, base, plotH, H, x, y, km, K0, K1 };
}

/**
 * Elevation profile. `brief` gives the climbs and descents; `race` (optional) adds
 * checkpoints and gels for one scenario; `zones` (optional) shades the key zones. Returns {html, x, y, km};
 * the html has a hidden `.pcur` cursor (a line and a dot) to move with translate().
 */
// Arguments: P profile [[km, m], ...]; brief {totalKm, climbs, descents} from core/plan.js;
// race {gels, aid, startSec, ...} or null; zones the key zones [{fromKm, toKm, n, title}].
// The last argument uses destructuring with defaults: options not given take the value after "=".
// Steps: 1. shaded key zones; 2. the filled area and the outline of the course;
// 3. the km and altitude axes; 4. climbs (by difficulty colour) and braking descents drawn over
// the outline; 5. aid stations and gels; 6. the clip for a zoom window and the hidden cursor.
// Every piece is SVG text added to `s`; toFixed(1) keeps one decimal to keep the text short.
export function profileView(P, brief, race, zones = [], { flat = false, win = null, inner = true, labels = false } = {}) {
  const TOT = brief.totalKm;
  const g = profGeom(P, TOT, race, flat, win);
  const { EMIN, EMAX, W, l, r, top, base, H, x, y, K0, K1 } = g;
  let s = "";
  // 1. Key zones: a shaded rectangle across the plot and a "★n" label. <title> gives a tooltip.
  zones.forEach((z) => {
    s += `<rect class="zone" data-z="${z.n}" x="${x(z.fromKm).toFixed(1)}" y="${top}" width="${(x(z.toKm) - x(z.fromKm)).toFixed(1)}" height="${base - top}"><title>Key zone ${z.n}: ${esc(z.title)}</title></rect>`;
    s += `<text class="zk" x="${(x(z.fromKm) + 4).toFixed(1)}" y="${top + 12}">★${z.n}</text>`;
  });
  // 2. The area under the profile: start at the axis (M), follow every point (L), come back
  // down to the axis at the end and close the shape (Z). Then the outline alone, on top.
  let d = `M${x(0)},${base}`;
  P.forEach((p) => { d += ` L${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`; });
  d += ` L${x(TOT)},${base} Z`;
  s += `<path class="area" d="${d}"/>`;
  s += `<path class="ln" d="${P.map((p, i) => `${i ? "L" : "M"}${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join(" ")}"/>`;
  // 3. Axes. A km tick every 10, 2, 1 or 0.5 km depending on how many km are on screen.
  // The 1e-9 margins avoid losing a tick to rounding (for example 9.999999 instead of 10).
  // `+k.toFixed(1)`: the unary + turns "10.0" back into the number 10, so labels show "10".
  let ax = `<line class="axis" x1="${l}" x2="${W - r}" y1="${base}" y2="${base}"/>`;
  const span = K1 - K0;
  const tickEvery = span >= 20 ? 10 : span >= 8 ? 2 : span >= 3 ? 1 : 0.5;
  for (let k = Math.ceil(K0 / tickEvery - 1e-9) * tickEvery; k <= K1 + 1e-9; k += tickEvery) ax += `<line class="axis" x1="${x(k)}" x2="${x(k)}" y1="${base}" y2="${base + 5}"/><text class="axt" x="${x(k)}" y="${base + 18}" text-anchor="middle">${+k.toFixed(1)}</text>`;
  ax += `<text class="axt" x="${W - r}" y="${base + 18}" text-anchor="end">km</text>`;
  // Two altitude labels: the bottom and the top of the range, rounded to 10 m inside it.
  [Math.ceil(EMIN / 10) * 10, Math.floor(EMAX / 10) * 10].forEach((e) => { ax += `<text class="axt" x="${l - 6}" y="${(y(e) + 3).toFixed(1)}" text-anchor="end">${e} m</text>`; });
  // seg(a, b): an SVG path that follows the profile from km a to km b, one point every 25 m
  // (0.025 km), so a climb can be drawn in colour exactly over the outline.
  const seg = (a, b) => {
    const pts = [];
    const n = Math.max(2, Math.round((b - a) / 0.025));
    for (let i = 0; i <= n; i++) { const k = a + ((b - a) * i) / n; pts.push(`${i ? "L" : "M"}${x(k).toFixed(1)},${y(elevAt(P, k)).toFixed(1)}`); }
    return pts.join("");
  };
  // label(c): the climb's (or section's) average gradient, written 10 units above its middle
  // (design review 2: the gradient says more on the profile than the number).
  const label = (c) => { const mid = (c.startKm + c.endKm) / 2; return `<text class="num" x="${x(mid).toFixed(1)}" y="${(y(elevAt(P, mid)) - 10).toFixed(1)}" text-anchor="middle">${c.avg.toFixed(0)}%</text>`; };
  // 4. Descents of level 4 (Brake) get a dashed red line; climbs are coloured by level 1..4.
  brief.descents.forEach((dd) => { if (dd.level === 4) s += `<path class="dl" d="${seg(dd.startKm, dd.endKm)}"><title>Descent ${dd.n}, km ${dd.startKm.toFixed(2)}: ${Math.round(dd.loss)} m at ${Math.abs(dd.avg).toFixed(1)}%</title></path>`; });
  brief.climbs.forEach((c) => {
    // A split climb is drawn section by section, each in its own difficulty colour, except on
    // the route profile (`labels`), where every climb shows whole, with its overall gradient.
    // Bumps are not drawn there either: the route shows climbs only.
    if (labels && c.bump) return;
    const parts = c.sections.length && !labels ? c.sections : [c];
    parts.forEach((p) => {
      const name = p !== c ? `Section ${p.n}` : c.label || `Climb ${c.n}`;
      // With `labels` (the route profile) the facts go in data-tip for the small pop-up window
      // (see renderBriefing) instead of the browser's slow <title> tooltip.
      const tip = `${name}|km ${p.startKm.toFixed(1)}|${len(p.lenM)}|+${Math.round(p.gain)} m|${p.avg.toFixed(1)}%|${p.level}`;
      s += labels
        ? `<path class="cl cl${p.level}" data-tip="${tip}" d="${seg(p.startKm, p.endKm)}"/>`
        : `<path class="cl cl${p.level}" d="${seg(p.startKm, p.endKm)}"><title>${name}, km ${p.startKm.toFixed(2)}: ${Math.round(p.gain)} m at ${p.avg.toFixed(1)}%, ${STARS[p.level]}</title></path>`;
      // Route profile: every climb (not the bumps) gets its overall average gradient, written
      // above its middle, in a small round badge that also opens the pop-up (name and figures).
      if (labels && !c.bump) {
        const mid = (p.startKm + p.endKm) / 2;
        if (mid >= K0 && mid <= K1) s += `<g class="clab" data-tip="${tip}" transform="translate(${x(mid).toFixed(1)},${(y(elevAt(P, mid)) - 14).toFixed(1)})"><rect x="-17" y="-9" width="34" height="16" rx="8"/><text y="3" text-anchor="middle">${p.avg.toFixed(0)}%</text></g>`;
      }
      if (inner && p.level >= 3) s += label(p);
    });
    // `inner: false` (the briefing): only the colours of the sections, no numbers or cut marks.
    if (inner) c.sections.slice(1).forEach((x2) => { const yy = y(elevAt(P, x2.startKm)); s += `<line class="cut" x1="${x(x2.startKm).toFixed(1)}" x2="${x(x2.startKm).toFixed(1)}" y1="${(yy - 7).toFixed(1)}" y2="${(yy + 7).toFixed(1)}"/>`; });
  });
  // 5. With a race: aid stations as small triangles above the line ("l-7,-12 h14 z" draws with
  // relative moves: down-left 7 and up 12, across 14, close), gels as "G" circles under the axis.
  if (race) {
    (race.aid || []).forEach((a) => {
      const yy = y(elevAt(P, a.km));
      s += `<path class="aid" d="M${x(a.km).toFixed(1)},${(yy - 6).toFixed(1)} l-7,-12 h14 z"><title>${esc(a.name)}, km ${a.km.toFixed(1)}: ${clock(race.startSec, a.sec)}</title></path>`;
    });
    race.gels.forEach((g) => {
      if (flat) { s += `<circle class="gel" cx="${x(g.km)}" cy="${base + 26}" r="6"/><text class="gelt" x="${x(g.km)}" y="${base + 29}" text-anchor="middle">G</text>`; return; }
      s += `<circle class="gel" cx="${x(g.km)}" cy="${base + 40}" r="9"/><text class="gelt" x="${x(g.km)}" y="${base + 43}" text-anchor="middle">G</text>`;
    });
  }
  // A zoomed window clips the drawing to the plot, so nothing spills over the axis labels.
  s = win ? `<defs><clipPath id="pclipW"><rect x="${l}" y="0" width="${W - l - r}" height="${H}"/></clipPath></defs><g clip-path="url(#pclipW)">${s}</g>${ax}` : s + ax;
  // 6. The cursor: hidden for now; the briefing and the replay show it and slide it with
  // transform="translate(x,0)". `{ ...g, html }` returns the geometry plus the finished SVG.
  s += `<g class="pcur" style="display:none"><line x1="0" x2="0" y1="${top - 4}" y2="${base}"/><circle cx="0" cy="${base}" r="6"/></g>`;
  return { ...g, html: `<div class="prof-scroll"><svg viewBox="0 0 1000 ${H}" role="img" aria-label="Elevation profile with climbs coloured by difficulty">${s}</svg></div>` };
}

/* ---------- map styling shared by the briefing and the replay ---------- */
/** Coloured stretches (climbs by difficulty, braking descents) and markers for courseMap. */
// Inputs: brief {totalKm, climbs, descents}; aid [{km, name, time?}]; zones the key zones.
// Returns {paint, marks} for map.js courseMap:
//   paint: stretches [{fromKm, toKm, cls, title}] coloured on the route by CSS class
//   marks: points [{km, kind, label, title?}]: the start, a km marker every 5 km (10 km on
//          races over 60 km, stopping a km before the finish) and the aid stations.
// A split climb is painted section by section (each in its own colour) instead of as one stretch.
export function mapStyle(brief, aid, zones = [], whole = false) {
  // key zones first, as a wide glow under the coloured climbs
  const paint = zones.map((z) => ({ fromKm: z.fromKm, toKm: z.toKm, cls: "rt-key", title: `★ Key zone ${z.n} · ${esc(z.title)}` }));
  // `whole` (Your route): each climb painted in one piece, in its own colour, like its profile;
  // bumps are left plain.
  brief.climbs.filter((c) => !whole || !c.bump).forEach((c) => (c.sections.length && !whole ? c.sections : [c]).forEach((p) => paint.push({ fromKm: p.startKm, toKm: p.endKm, cls: `rt-cl rt-cl${p.level}`, title: `${p !== c ? `Climb section ${p.n}` : c.label || `Climb ${c.n}`} · km ${p.startKm.toFixed(1)} · ${Math.round(p.gain)} m at ${p.avg.toFixed(1)}% · ${STARS[p.level]}` })));
  brief.descents.filter((d) => d.level === 4).forEach((d) => paint.push({ fromKm: d.startKm, toKm: d.endKm, cls: "rt-dl", title: `Descent ${d.n} · km ${d.startKm.toFixed(1)} · ${Math.round(d.loss)} m at ${Math.abs(d.avg).toFixed(1)}% · brake` }));
  const marks = [{ km: 0, kind: "start", label: "Start" }];
  const every = brief.totalKm > 60 ? 10 : 5;
  for (let k = every; k < brief.totalKm - 1; k += every) marks.push({ km: k, kind: "km", label: String(k) });
  aid.forEach((a) => marks.push({ km: a.km, kind: "aid", label: esc(a.name), title: `${esc(a.name)} · km ${a.km.toFixed(1)}${a.time ? ` · ${a.time}` : ""}` }));
  return { paint, marks };
}
/** The key zones as a list; with `when` (km -> clock text) each one shows when you get there. */
// zones: [{n, mode, modeLabel, title, fromKm, toKm, why, how, stakeMin}] from core/keyzones.js.
// when (optional): a function km -> text such as "you get there at 10:42". Returns HTML text.
export function zoneList(zones, when) {
  if (!zones.length) return empty("No stretch stands out: an even course, run it evenly.");
  return `<div class="zones">${zones.map((z) => `<div class="zone-card m-${z.mode}">
    <div class="zn">★${z.n}</div>
    <div class="zb"><div class="zt"><span class="mode m-${z.mode}">${z.modeLabel}</span><b>${esc(z.title)}</b><span>km ${z.fromKm.toFixed(1)} → ${z.toKm.toFixed(1)}${when ? ` · ${when(z.fromKm)}` : ""}</span></div>
    <p>${esc(z.why)}</p><p class="zh">${esc(z.how)}</p></div>
    <div class="zs"><small>up to</small><b>${z.stakeMin}</b><small>min to gain</small></div>
  </div>`).join("")}</div>`;
}
// ZONE_NOTE: the explanation of key zones shown under the lists in sections 02 and 03.
export const ZONE_NOTE = `Key zones are short stretches where how you run changes your race. <b>Attack</b>: push, time is won here. <b>Prepare</b>: set up what comes next (eat, drink, let your heart rate drop). <b>Manage</b>: protect your effort for later. "Up to X min to gain" = the typical gap, on that stretch and what follows, between runners of your level who run it well and those who do not: time on it × how much runners differ at that point (3% at the start to 18% at the finish, as fatigue spreads the field) × the kind of zone. One zone per 13 km of race.`;
// jumps(items): the row of in-section links at the top of a section; items [[target id, text, class?]].
export const jumps = (items) => `<nav class="jumps" aria-label="In this section">${items.map(([href, t, cls]) => `<a href="#${href}" class="${cls || ""}">${t}</a>`).join("")}</nav>`;

/* ---------- 02 race briefing ---------- */
/** One difficulty chip (1 to 4 stars) for a climb row; c.level is 1 to 4. */
function diffCell(c) {
  return `<div class="diff">${starChip(c.level)}</div>`;
}
/**
 * The climbs and descents lists of Your route, shared with Prep my run: two tabs (Climbs, Descents),
 * each a table with the mini profile, length, gain or loss, steepest 100 m and the stars or shoes.
 * brief: {climbs, descents, minClimb} (plan.js briefCourse); P: the profile; tab: "c" or "d"
 * (the open tab); splitM: the length from which a climb is split; noun: "race" or "run".
 * Wire the tabs with wireSegTabs.
 */
export function segListHtml(brief, P, tab, splitM, noun = "race") {
  // One table row for a climb (or, with sec = true, one of its sections, styled as indented).
  // Columns in reading order: where, how long, how steep, how much, the steepest bit.
  const climbRow = (c, sec) => `<div class="row v${c.level} ${sec ? "sec" : ""}">
      <div class="n">${c.n}</div>${cell("Km", kmRange(c))}${spark(P, c.startKm, c.endKm, c.avg)}${cell("Length", len(c.lenM))}${cell("Gain", `${Math.round(c.gain)} m`)}${cell("Steepest 100 m", `${Math.round(c.steep)}%`)}${diffCell(c)}
    </div>`;
  // Bumps (rises under brief.minClimb) are not climbs: they stay out of this table.
  const bumps = brief.climbs.filter((c) => c.bump).length;
  const climbs = brief.climbs.filter((c) => !c.bump).map((c) => climbRow(c) + c.sections.map((x) => climbRow(x, true)).join("")).join("");
  const descents = brief.descents.map((d) => `<div class="row v${d.level}">
      <div class="n">${d.n}</div>${cell("Km", kmRange(d))}${spark(P, d.startKm, d.endKm, d.avg)}${cell("Length", len(d.lenM))}${cell("Loss", `${Math.round(d.loss)} m`)}${cell("Steepest 100 m", `${Math.abs(Math.round(d.steep))}%`)}<div class="diff">${descChip(d.level)}</div>
    </div>`).join("");
  return `
    <div class="tabs seg-tabs" role="tablist" aria-label="Segments">
      <button type="button" role="tab" data-t="c" aria-selected="${tab === "c"}">Climbs · ${brief.climbs.length - bumps}</button>
      <button type="button" role="tab" data-t="d" aria-selected="${tab === "d"}">Descents · ${brief.descents.length}</button>
    </div>
    <div ${tab === "c" ? "" : "hidden"}>
    <p class="note" style="margin:-4px 0 12px">Difficulty = gain × steepness (average ÷ 8%, between 0.5 and 2) × fatigue (1.00 early, 1.15 mid-race, 1.35 late). A climb gains at least ${Math.round(brief.minClimb)} m (10% of the ${noun}'s D+, or 100 m on any ${noun}); ${bumps ? `the ${bumps} smaller rise${bumps === 1 ? " is a bump" : "s are bumps"}, not counted here${noun === "race" ? " but kept in your plan and race script" : ""}. ` : ""}Climbs of ${(splitM / 1000).toFixed(0)} km or more are split where the gradient clearly changes, each section at least 15% of the climb, and rated on its own.</p>
    ${climbs ? rowsTable("t-route", ["Length", "Gain", "Steepest 100 m"], climbs) : empty(`No climb of ${Math.round(brief.minClimb)} m or more.`)}
    </div>
    <div ${tab === "d" ? "" : "hidden"}>
    <p class="note" style="margin:-4px 0 12px">${descChip(4)} Brake: a 100 m stretch of 20% or more, or 12% on average. ${descChip(2)} Control: 6% on average, or a 15% stretch. ${descChip(1)} Let it run: everything else.</p>
    ${descents ? rowsTable("t-route", ["Length", "Loss", "Steepest 100 m"], descents) : empty("No descents over 10 m.")}
    </div>`;
}
/** The tabs of segListHtml inside `box`: a click shows its list; onTab("c" or "d") remembers it. */
export function wireSegTabs(box, onTab) {
  // ".seg-tabs ~ div" selects the divs that come after the tab bar at the same level: the two lists.
  box.querySelectorAll(".seg-tabs button").forEach((b) => b.addEventListener("click", () => {
    onTab(b.dataset.t);
    box.querySelectorAll(".seg-tabs button").forEach((x) => x.setAttribute("aria-selected", String(x === b)));
    const [c, d] = box.querySelectorAll(".seg-tabs ~ div");
    c.hidden = b.dataset.t !== "c";
    d.hidden = b.dataset.t !== "d";
  }));
}
