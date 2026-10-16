// print.js (ui): "Export A4". One printable document per mode, built from the same numbers as the
// page and laid out for A4 paper:
//   Prep my race   race card (key figures, profile, course sketch, checkpoints to fill in by hand),
//                  key zones, aid stations, gels, hikes, heart rate, the race section by section,
//                  every climb and descent, and your engine (pace by gradient)
//   Prep my run    key figures, profile, course sketch, key zones, the run section by section,
//                  every climb and descent with its tactic
//   Rewind my run  key figures, profile coloured by how you ran, key moments, your target,
//                  every section, your numbers, km splits, the deep-dive KPIs and climbs
// Pimp my GPX (watch messages, .fit/.gpx) is never printed: it belongs on the watch, not on paper.
//
// How it works: the document is a <div id="printDoc"> added to <body> and hidden on screen. When
// the page is printed, CSS (@media print in style.css) hides everything else and shows only it;
// @page sets the A4 size and margins. Black on white for ink, colours only where they carry
// meaning (difficulty, good/bad). The live map needs internet tiles and does not print well, so
// the course is drawn as a line sketch instead. The sheet is rebuilt on "beforeprint", so the
// browser's own Print menu (Ctrl+P) gives the same pages as the button. "Save as PDF" in the
// print dialog makes the PDF, named after the page title set here.
//
// Who calls it: main.js calls initPrint({collect}) once and gets back the function behind the "Export
// A4" buttons. collect(mode) gathers the data of the mode on screen (for Rewind my run: currentRun() of
// ui/review.js plus the athlete settings). printSheet(mode, data) builds the HTML. Each sheet is made
// of small helpers that return HTML strings (p4Kpi, p4Table, p4H...) and two drawings (p4Profile,
// p4Route). The numbers are read again from the core modules (core/script.js, core/review.js,
// core/insights.js), so paper and screen show the same figures.
// Every name here starts with p4 or P4 ("print A4"): the bundler (scripts/build.js) joins all files
// into one scope and refuses two top-level names that clash.

import { mmss, hm, clock, parseDuration } from "../core/format.js";
import { LEVELS, DESCENT_LABELS, judgeTarget } from "../core/plan.js";
import { SCENARIOS } from "../core/model.js";
import { raceLegs, raceTotals, secAtKm } from "../core/script.js";
import { runStats, runTarget, runSecAtKm } from "../core/review.js";
import { runKpis, climbTable } from "../core/insights.js";

// Escape text for HTML (& < > " become entities). `s ?? ""` uses "" when s is null or undefined (?? is
// the "nullish coalescing" operator: unlike ||, it keeps 0 and "").
const p4Esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
// Ink-friendly colours, readable on white: difficulty levels 1..4 and good / bad / neutral.
// P4_LEVEL is indexed by difficulty level 1 to 4 (index 0, grey, is the colour for "no level"). P4_TONE
// colours a run section by how it went, P4_ZONE a key zone by its mode.
const P4_LEVEL = ["#8a96ab", "#2e9e55", "#d9a400", "#ee7a1a", "#d81f3a"];
const P4_TONE = { good: "#2e9e55", bad: "#d81f3a", info: "#8a96ab", ok: "#8a96ab" };
const P4_ZONE = { attack: "#d81f3a", prepare: "#2f7fd0", manage: "#2e9e55" };
// The small red mountain logo of the header, as inline SVG ("M2 27 12 9l5 8..." draws a polygon through
// those points, z closes it).
const P4_PEAK = `<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M2 27 12 9l5 8 4-5 9 15z" fill="#d81f3a"/></svg>`;
// Short formatters: a duration ("42 min" or "2h05"), a km range ("4.2 → 7.9"), a length ("850 m" or
// "1.25 km").
const p4Dur = (sec) => (sec < 3600 ? `${Math.max(0, Math.round(sec / 60))} min` : hm(sec));
const p4Km = (a, b) => `${a.toFixed(1)} → ${b.toFixed(1)}`;
const p4Len = (m) => (m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`);

/* ---------- building blocks ---------- */
// Building blocks that return HTML strings: a key-figure tile, a coloured label, a heading with an
// optional subtitle, a note.
const p4Kpi = (k, v, s = "") => `<div class="p4-kpi"><span>${k}</span><b>${v}</b>${s ? `<small>${s}</small>` : ""}</div>`;
const p4Chip = (text, color) => `<span class="p4-chip" style="background:${color}">${p4Esc(text)}</span>`;
const p4H = (title, sub = "", cls = "") => `<h2 class="p4-h ${cls}">${title}${sub ? `<small>${sub}</small>` : ""}</h2>`;
const p4Note = (html) => `<p class="p4-note">${html}</p>`;
/**
 * A table from a list of header labels and a list of row HTML strings. A header that starts with
 * "#" is a number column: the # is removed and the header cell gets class "r" (right-aligned; the
 * rows set their own class). The regex /^#/ matches a # at the very start of the text only.
 */
function p4Table(head, rows, cls = "") {
  return `<table class="p4-t ${cls}"><thead><tr>${head.map((h) => `<th${h.startsWith("#") ? ' class="r"' : ""}>${h.replace(/^#/, "")}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table>`;
}

/**
 * The top of a sheet: the logo and mode name, the print date (in the browser's language:
 * toLocaleDateString with `undefined` as locale), the title, a subtitle and the row of key figures.
 * `kpis` is a list of p4Kpi HTML strings (empty ones add nothing).
 */
function p4Top(modeLabel, title, sub, kpis) {
  const now = new Date();
  const date = now.toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });
  return `<header class="p4-top">
    <div class="p4-brand">${P4_PEAK}Prep my race${modeLabel && modeLabel !== "Prep my race" ? ` · ${modeLabel}` : ""}</div><div class="p4-date">Printed ${p4Esc(date)}</div>
  </header>
  <h1>${p4Esc(title)}</h1>${sub ? `<p class="p4-sub">${sub}</p>` : ""}
  <div class="p4-kpis">${kpis.join("")}</div>`;
}

/**
 * Elevation at km on a profile [[km, ele], ...] (straight line between points).
 * Before the start it gives the first elevation, after the end the last. Otherwise it finds the
 * first point at or past km and interpolates from the point before it:
 * ele = a + (km - a.km) / (b.km - a.km) × (b - a).
 */
function p4EleAt(P, km) {
  if (km <= P[0][0]) return P[0][1];
  for (let i = 1; i < P.length; i++) if (P[i][0] >= km) { const a = P[i - 1], b = P[i]; return a[1] + ((km - a[0]) / Math.max(1e-9, b[0] - a[0])) * (b[1] - a[1]); }
  return P[P.length - 1][1];
}

/**
 * The elevation profile as plain SVG with its colours written in, so it prints the same whatever
 * the theme: `segs` [{fromKm, toKm, color, dash}] drawn thick over the line, `zones` (key zones,
 * shaded with ★n), `aids` (triangles), `gels` (G dots under the axis), `stops` (bars on the axis).
 *
 * `P` is the profile [[km, ele in m], ...]. Layers are drawn back to front, because in SVG what
 * comes later in the text is painted on top: key-zone shading, the grey area, the profile line,
 * the coloured stretches, the axes and labels, stops, aid stations, gels. The row of gels adds 16
 * units of height (222 instead of 206), only when there are gels. Returns the SVG as a string.
 */
function p4Profile(P, { segs = [], zones = [], aids = [], gels = [], stops = [] } = {}) {
  const TOT = P[P.length - 1][0];
  const eles = P.map((p) => p[1]);
  const EMIN = Math.min(...eles), EMAX = Math.max(...eles);
  const W = 1000, l = 50, r = 10, top = 18, base = 178, H = gels.length ? 222 : 206;
  // Scales: km to x, and elevation to y (SVG y grows downwards, so higher ground gets a smaller y).
  const x = (km) => l + (km / TOT) * (W - l - r);
  const y = (e) => base - 6 - ((e - EMIN) / Math.max(1, EMAX - EMIN)) * (base - top - 14);
  // The SVG path of the profile from km a to km b: the interpolated end points and every point in
  // between; "M" moves the pen to the first point, "L" draws a line to each next one.
  const path = (a, b) => {
    const pts = [[a, p4EleAt(P, a)], ...P.filter((p) => p[0] > a && p[0] < b), [b, p4EleAt(P, b)]];
    return pts.map((p, i) => `${i ? "L" : "M"}${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join("");
  };
  let s = "";
  // Key zones: a pale yellow band over the stretch, and its ★ number.
  zones.forEach((z) => {
    s += `<rect x="${x(z.fromKm).toFixed(1)}" y="${top - 6}" width="${Math.max(2, x(z.toKm) - x(z.fromKm)).toFixed(1)}" height="${base - top + 6}" fill="#ffe9a3" opacity=".75"/>`;
    s += `<text x="${(x(z.fromKm) + 2).toFixed(1)}" y="${top + 4}" font-size="12" font-weight="700" fill="#9a6b00">★${z.n}</text>`;
  });
  // The grey area under the profile: the line path with its first "M" turned into "L" (the regex /^M/
  // matches the M at the start), closed down to the base with Z.
  s += `<path d="M${x(0)},${base} ${path(0, TOT).replace(/^M/, "L")} L${x(TOT)},${base} Z" fill="#e9edf3"/>`;
  s += `<path d="${path(0, TOT)}" fill="none" stroke="#5b6577" stroke-width="1.3"/>`;
  // Coloured stretches (climbs by difficulty, or run sections by form); a dashed one is a descent to
  // brake on (stroke-dasharray "7 5": 7 units drawn, 5 blank).
  segs.forEach((g) => { s += `<path d="${path(g.fromKm, g.toKm)}" fill="none" stroke="${g.color}" stroke-width="${g.dash ? 3 : 4.2}" stroke-linecap="round"${g.dash ? ' stroke-dasharray="7 5"' : ""}/>`; });
  // Axes: a km tick every 1, 2, 5 or 10 km and the lowest and highest altitudes.
  s += `<line x1="${l}" x2="${W - r}" y1="${base}" y2="${base}" stroke="#14181f" stroke-width="1"/>`;
  // "k <= TOT - every * 0.3": no tick too close to the end, where it would hit the "km" label.
  const every = TOT > 60 ? 10 : TOT > 25 ? 5 : TOT > 10 ? 2 : 1;
  for (let k = 0; k <= TOT - every * 0.3; k += every) s += `<line x1="${x(k)}" x2="${x(k)}" y1="${base}" y2="${base + 4}" stroke="#14181f"/><text x="${x(k)}" y="${base + 15}" font-size="11" text-anchor="middle" fill="#3b4352">${k}</text>`;
  s += `<text x="${W - r}" y="${base + 15}" font-size="11" text-anchor="end" fill="#3b4352">km</text>`;
  [EMIN, EMAX].forEach((e) => { s += `<text x="${l - 5}" y="${(y(e) + 4).toFixed(1)}" font-size="11" text-anchor="end" fill="#3b4352">${Math.round(e)} m</text>`; });
  // Stops: a short black bar on the axis. Aid stations: a blue triangle above the profile (relative
  // path: l-6,-10 then h12, then z closes it). Gels: a red "G" dot under the axis.
  stops.forEach((st) => { s += `<rect x="${(x(st.km) - 2).toFixed(1)}" y="${base - 9}" width="4" height="9" fill="#14181f"/>`; });
  aids.forEach((a) => { const yy = y(p4EleAt(P, a.km)); s += `<path d="M${x(a.km).toFixed(1)},${(yy - 5).toFixed(1)} l-6,-10 h12 z" fill="#2f7fd0"/>`; });
  gels.forEach((g) => { s += `<circle cx="${x(g.km).toFixed(1)}" cy="${base + 30}" r="7" fill="#d81f3a"/><text x="${x(g.km).toFixed(1)}" y="${base + 33.5}" font-size="9" font-weight="700" text-anchor="middle" fill="#fff">G</text>`; });
  return `<svg class="p4-prof" viewBox="0 0 ${W} ${H}" role="img" aria-label="Elevation profile">${s}</svg>`;
}

/**
 * The course as a line sketch from its GPS points (no map tiles). `route` [[lat, lon], ...] has one
 * point per profile point, so point i is at km P[i][0]. Equirectangular projection: x = longitude ×
 * cos(latitude), y = latitude, which keeps the shape true over a few tens of km.
 *
 * `segs` colours stretches as in p4Profile, `aids` [{km}] adds triangles. Steps: project every
 * point (latitude is negated, because SVG y grows downwards and north must stay up), find the
 * bounding box, scale it to 400 units wide (height between 160 and 360), centre it, then draw the
 * grey line, the coloured stretches, a numbered circle every 1 to 10 km, the aid stations, the
 * start (red) and the finish (black). Returns "" when the points do not match the profile.
 */
function p4Route(route, P, { segs = [], aids = [] } = {}) {
  if (!route || route.length < 2 || route.length !== P.length) return "";
  // lat0: the mean latitude, in radians (× π / 180). cos(lat0) shrinks the longitudes: a degree of
  // longitude gets shorter the further you are from the equator.
  const lat0 = (route.reduce((s, p) => s + p[0], 0) / route.length) * (Math.PI / 180);
  const pts = route.map(([la, lo]) => [lo * Math.cos(lat0), -la]);
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  // Bounding box: x0 and y0 the smallest values, w and h the width and height ("|| 1e-6" avoids a size
  // of 0 on a course that runs straight north-south or east-west).
  const x0 = Math.min(...xs), y0 = Math.min(...ys);
  const w = Math.max(...xs) - x0 || 1e-6, h = Math.max(...ys) - y0 || 1e-6;
  // k is the scale (SVG units per projected degree), the same on both axes so the shape is not
  // stretched; the height gets 10% more room. ox and oy centre the drawing.
  const W = 400, pad = 18, k = (W - 2 * pad) / Math.max(w, h * 1.1);
  const H = Math.round(Math.min(360, Math.max(160, h * k + 2 * pad)));
  const ox = pad + ((W - 2 * pad) - w * k) / 2, oy = (H - h * k) / 2;
  // Point i on the sketch, as [x, y].
  const at = (i) => [ox + (pts[i][0] - x0) * k, oy + (pts[i][1] - y0) * k];
  const kms = P.map((p) => p[0]);
  // idx(km): the index of the first point at or past km (a linear scan). line(a, b): the path through
  // points a to b.
  const idx = (km) => { let i = 0; while (i < kms.length - 1 && kms[i] < km) i++; return i; };
  const line = (a, b) => { let d = ""; for (let i = a; i <= b; i++) { const [px, py] = at(i); d += `${i === a ? "M" : "L"}${px.toFixed(1)},${py.toFixed(1)}`; } return d; };
  let s = `<path d="${line(0, pts.length - 1)}" fill="none" stroke="#9aa3b2" stroke-width="2.4" stroke-linejoin="round"/>`;
  segs.forEach((g) => { const a = idx(g.fromKm), b = Math.max(a + 1, idx(g.toKm)); s += `<path d="${line(a, Math.min(b, pts.length - 1))}" fill="none" stroke="${g.color}" stroke-width="${g.dash ? 2.6 : 3.6}" stroke-linecap="round"${g.dash ? ' stroke-dasharray="5 4"' : ""}/>`; });
  const TOT = kms[kms.length - 1];
  const every = TOT > 60 ? 10 : TOT > 25 ? 5 : TOT > 10 ? 2 : 1;
  // A numbered circle every 1, 2, 5 or 10 km; none in the last third of a step before the finish.
  for (let km = every; km < TOT - every / 3; km += every) { const [px, py] = at(idx(km)); s += `<circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="7.5" fill="#fff" stroke="#14181f" stroke-width="1"/><text x="${px.toFixed(1)}" y="${(py + 3.3).toFixed(1)}" font-size="8.5" font-weight="700" text-anchor="middle" fill="#14181f">${km}</text>`; }
  aids.forEach((a) => { const [px, py] = at(idx(a.km)); s += `<path d="M${px.toFixed(1)},${(py - 4).toFixed(1)} l-6,-10 h12 z" fill="#2f7fd0" stroke="#fff" stroke-width=".8"/>`; });
  // Start and finish. The finish is drawn first, so on a loop the start dot sits on top of it.
  const [sx, sy] = at(0), [fx, fy] = at(pts.length - 1);
  s += `<circle cx="${fx.toFixed(1)}" cy="${fy.toFixed(1)}" r="5" fill="#14181f"/><circle cx="${sx.toFixed(1)}" cy="${sy.toFixed(1)}" r="6" fill="#d81f3a" stroke="#fff" stroke-width="1.5"/>`;
  return `<svg class="p4-route" viewBox="0 0 ${W} ${H}" role="img" aria-label="Course sketch">${s}</svg>`;
}

/**
 * Climbs coloured by difficulty (sections one by one) and the descents to brake on, dashed red.
 * Returns [{fromKm, toKm, color, dash?}] for p4Profile and p4Route. A climb split into sections
 * gives one stretch per section, each with its own level; level 4 descents are the "Brake" ones.
 */
function p4PlanSegs(plan) {
  const segs = [];
  plan.climbs.forEach((c) => (c.sections.length ? c.sections : [c]).forEach((p) => segs.push({ fromKm: p.startKm, toKm: p.endKm, color: P4_LEVEL[p.level] })));
  plan.descents.filter((d) => d.level === 4).forEach((d) => segs.push({ fromKm: d.startKm, toKm: d.endKm, color: P4_LEVEL[4], dash: true }));
  return segs;
}
// The legend under the profile: the four difficulty colours, the dashed descent and the key-zone
// shading.
const P4_LEGEND = `<div class="p4-legend">${[1, 2, 3, 4].map((l) => `<span><i style="background:${P4_LEVEL[l]}"></i>${LEVELS[l]}</span>`).join("")}<span><i class="dash"></i>Descent to brake on</span><span><i style="background:#ffe9a3"></i>★ Key zone</span></div>`;

/**
 * The key zones as cards: number, mode (Attack, Prepare or Manage) in its colour, title, km, why
 * it matters, how to run it, and the minutes in play. `when(km)` optionally adds the clock time
 * there. A zone with an unknown mode gets the amber colour.
 */
function p4Zones(zones, when) {
  if (!zones || !zones.length) return p4Note("No stretch stands out: an even course, run it evenly.");
  return `<div class="p4-zones">${zones.map((z) => `<div class="p4-zone" style="border-left-color:${P4_ZONE[z.mode] || "#d9a400"}">
    <div class="p4-zn">★${z.n}</div>
    <div><div class="p4-zt">${p4Chip(z.modeLabel, P4_ZONE[z.mode] || "#d9a400")}<b>${p4Esc(z.title)}</b><span>km ${p4Km(z.fromKm, z.toKm)}${when ? ` · ${when(z.fromKm)}` : ""}</span></div>
    <p>${p4Esc(z.why)}</p><p class="p4-how">${p4Esc(z.how)}</p></div>
    <div class="p4-zs"><b>${z.stakeMin}</b><small>min in play</small></div>
  </div>`).join("")}</div>`;
}

/**
 * The race (or the run to come) section by section, start to finish: the script to follow.
 * `plan` is the plan of core/plan.js, `sid` the scenario id ("best", "central" or "cautious"),
 * `st` the start clock in seconds since midnight. raceLegs (core/script.js) cuts the course into
 * sections; each row has a colour square, km, D+ / D−, arrival clock, time, pace, the tactic, and
 * marks for a key zone (★), aid stations (▲) and gels.
 */
function p4LegTable(plan, sid, st) {
  const legs = raceLegs(plan, sid);
  // The colour square: climbs by difficulty, descents grey (red for a Brake descent), runnable
  // stretches light grey.
  const color = (l) => (l.kind === "climb" ? P4_LEVEL[l.level] : l.kind === "descent" ? (l.level === 4 ? P4_LEVEL[4] : "#5b6577") : "#c5ccd8");
  const rows = legs.map((l) => {
    // The marks of a section; filter(Boolean) drops the empty ones before they are joined with " · ".
    const marks = [l.keyZone ? `<b class="p4-star">★${l.keyZone.n}</b>` : "", l.aids.map((a) => `▲ ${p4Esc(a.name)}`).join(" "), l.gels.length ? `${l.gels.length} gel${l.gels.length > 1 ? "s" : ""}` : ""].filter(Boolean).join(" · ");
    return `<tr><td class="p4-n"><i style="background:${color(l)}"></i>${l.i}</td><td><b>${p4Esc(l.title)}</b> <small>${p4Esc(l.label)}</small></td><td>${p4Km(l.startKm, l.endKm)}</td><td class="r">+${Math.round(l.up)} / −${Math.round(l.down)}</td><td class="r">${clock(st, l.startSec)}</td><td class="r">${p4Dur(l.durSec)}</td><td class="r">${l.pace ? mmss(l.pace) : "–"}</td><td>${p4Esc(l.tactic || "")}${marks ? `<div class="p4-marks">${marks}</div>` : ""}</td></tr>`;
  });
  return p4Table(["#", "Section", "Km", "#D+ / D− m", "#Arrive", "#Time", "#Pace /km", "How to run it"], rows, "p4-legs");
}

/**
 * Every climb (with its sections) and descent: the numbers, when you get there, the tactic.
 * `row(x, sec, isClimb)` writes one line: x is a climb, a climb section (sec = true, indented by
 * its CSS class) or a descent. x.start and x.dur hold one value per scenario, read with [sid].
 * flatMap puts each climb and then its sections in one flat list. The descents table reuses the
 * headers with "Gain" renamed "Loss".
 */
function p4ClimbTable(plan, sid, st) {
  const row = (x, sec, isClimb) => `<tr class="${sec ? "p4-sec" : ""}"><td class="p4-n"><i style="background:${isClimb ? P4_LEVEL[x.level] : x.level === 4 ? P4_LEVEL[4] : "#5b6577"}"></i>${x.n}</td><td>${p4Km(x.startKm, x.endKm)}</td><td class="r">${p4Len(x.lenM)}</td><td class="r">${isClimb ? `+${Math.round(x.gain)}` : `−${Math.round(x.loss)}`} m</td><td class="r">${Math.abs(x.avg).toFixed(1)}%</td><td class="r">${Math.abs(Math.round(x.steep))}%</td><td>${isClimb ? LEVELS[x.level] : DESCENT_LABELS[x.level]}</td><td class="r">${x.start ? clock(st, x.start[sid]) : "–"}</td><td class="r">${x.dur ? p4Dur(x.dur[sid]) : "–"}</td><td>${p4Esc(x.tactic || "")}</td></tr>`;
  const head = ["#", "Km", "#Length", "#Gain", "#Average", "#Steepest 100 m", "Difficulty", "#Arrive", "#Time on it", "Tactic"];
  const climbs = plan.climbs.flatMap((c) => [row(c, false, true), ...c.sections.map((x) => row(x, true, true))]);
  const descents = plan.descents.map((d) => row(d, false, false));
  return `${p4H("Climbs", `${plan.climbs.length} · split ones section by section`)}${climbs.length ? p4Table(head, climbs, "p4-cl") : p4Note("No climbs over 10 m.")}
    ${p4H("Descents", `${plan.descents.length}`)}${descents.length ? p4Table(head.map((h) => (h === "#Gain" ? "#Loss" : h)), descents, "p4-cl") : p4Note("No descents over 10 m.")}
    ${p4Note("Difficulty = gain × steepness × fatigue (later in the race counts more). Descents: Brake = a 100 m stretch of 20% or more, or 12% on average; Control = 6% on average, or a 15% stretch; Let it run = everything else.")}`;
}

/* ---------- Prep my race ---------- */
/**
 * The Prep my race document. Input (printData in main.js): plan (core/plan.js), sid (the scenario
 * picked), raceName, effort (the analysed reference runs, or null) and settings (target time,
 * hiking threshold, half-life...). Returns HTML in several <section class="p4-part">; the class
 * "p4-new" starts a new page (break-before: page in style.css). Parts:
 *   1. race card: key figures, scenarios, target verdict, profile, course sketch, checkpoints
 *   2. key zones, aid stations, gels, hikes, heart-rate guide
 *   3. the race section by section
 *   4. every climb and descent
 *   5. the engine: pace by gradient learned from your runs (only with reference runs)
 */
function p4PlanSheet({ plan, sid, raceName, effort, settings }) {
  // sc: the chosen scenario (finish time, checkpoints, gels); st: the start clock; T: the race totals
  // (raceTotals, core/script.js).
  const sc = plan.scenarios[sid];
  const st = plan.startSec;
  const T = raceTotals(plan, sid);
  const aids = plan.aidStations;
  // The key figures of the top row ("" when not relevant, for example with no aid stations).
  const kpis = [
    p4Kpi("Duration", hm(sc.finishSec), `${sc.label.toLowerCase()} scenario`),
    p4Kpi("Distance", `${T.km.toFixed(1)}<small> km</small>`),
    p4Kpi("Pace", `${mmss(T.paceSec)}<small> /km</small>`, `moving ${mmss(T.movingPaceSec)}`),
    p4Kpi("Elevation", `+${Math.round(T.gain)}<small> m</small>`, `−${Math.round(T.loss)} m`),
    p4Kpi("Finish", clock(st, sc.finishSec), `start ${clock(st, 0)}`),
    p4Kpi("Gels", String(T.gels), `every ${T.gelEveryMin} min`),
    aids.length ? p4Kpi("Aid stations", String(aids.length), `${Math.round(T.stopSec / 60)} min stopped`) : "",
    T.hrAvg ? p4Kpi("Heart rate", `${T.hrAvg}<small> bpm</small>`, `${T.hrMin} to ${T.hrMax} by phase`) : "",
  ];
  // The three scenarios side by side, the chosen one highlighted.
  const scen = SCENARIOS.map((s) => `<span class="${s.id === sid ? "on" : ""}">${s.label} <b>${hm(plan.scenarios[s.id].finishSec)}</b> <small>finish ${clock(st, plan.scenarios[s.id].finishSec)}</small></span>`).join("");
  // The targeted duration typed in 03 Plan, judged against the scenarios (judgeTarget, core/plan.js).
  const tgt = judgeTarget(plan, parseDuration(settings.targetTime));
  const VERDICT = { "out-of-reach": "Not backed by your runs", ambitious: "Ambitious", realistic: "Realistic", comfortable: "Comfortable" };
  const tgtHtml = tgt ? `<div class="p4-scen p4-tgt">Targeted duration <b>${hm(tgt.targetSec)}</b> · ${VERDICT[tgt.verdict]} · needs ${mmss(tgt.paceSec)}/km, stops included</div>` : "";
  // Data for the drawings and tables: aid stations as {km, name}, the coloured stretches, checkpoint
  // rows with two empty cells to fill in by hand on race day, where each gel is taken in words, and the
  // climbs and sections to hike (tactic starting with "Hike"; the regex /^Hike/ tests the start of the
  // text). `brief` is not used below.
  const aidMarks = aids.map((a) => ({ km: a.km, name: a.name }));
  const segs = p4PlanSegs(plan);
  const ckRows = sc.checkpoints.map((c) => `<tr><td>${p4Esc(c.label)}</td><td class="r">${clock(st, c.sec)}</td><td class="r">${hm(c.sec)}</td><td class="p4-write"></td><td class="p4-write"></td></tr>`);
  const GEL_WHERE = { top: "top of climb", bottom: "foot of descent", section: "end of a climb section", "before descent": "before the descent", "on the climb": "on the climb, walking" };
  const hikes = plan.climbs.flatMap((c) => [c, ...c.sections]).filter((c) => /^Hike/.test(c.tactic));
  const brief = { climbs: plan.climbs, descents: plan.descents };

  // Parts 1 to 4 as one HTML string (see the list above).
  let html = `<section class="p4-part">
    ${p4Top("Prep my race", raceName, `Race plan · ${p4Esc(sc.label.toLowerCase())} scenario · start ${clock(st, 0)}`, kpis)}
    <div class="p4-scen">${scen}</div>${tgtHtml}
    ${p4H("Profile")}
    ${p4Profile(plan.course.profile, { segs, zones: plan.keyZones, aids: aidMarks, gels: sc.gels })}
    ${P4_LEGEND}
    <div class="p4-grid2">
      <div class="p4-box">${p4H("Course", "start ● finish ●")}${p4Route(plan.course.route, plan.course.profile, { segs, aids: aidMarks }) || p4Note("No GPS points to draw the course.")}${p4Note("Triangles: aid stations. Circles: km.")}</div>
      <div>${p4H("Checkpoints", "fill in your times")}${p4Table(["Checkpoint", "#Clock", "#Elapsed", "Actual", "Gap"], ckRows, "p4-ck")}</div>
    </div>
  </section>
  <section class="p4-part">
    ${p4H("★ Key zones", "where you can make a difference")}
    ${p4Zones(plan.keyZones, (km) => `you get there at ${clock(st, secAtKm(plan, sid, km))}`)}
    <div class="p4-grid2 p4-mt">
      ${aids.length ? `<div>${p4H("Aid stations", `${aids.reduce((t, a) => t + a.stopMin, 0)} min of stops`)}${p4Table(["#Km", "Name", "#Arrive", "#Leave"], aids.map((a) => `<tr><td class="r">${a.km.toFixed(1)}</td><td>${p4Esc(a.name)}</td><td class="r">${clock(st, a.arrive[sid])}</td><td class="r">${a.stopMin ? clock(st, a.arrive[sid] + a.stopMin * 60) : "–"}</td></tr>`))}</div>` : ""}
      <div>${p4H("Gels", `every ${plan.params.gelEveryMin} min`)}${sc.gels.length ? p4Table(["#Km", "#Clock", "Where"], sc.gels.map((g) => `<tr><td class="r">${g.km.toFixed(1)}</td><td class="r">${clock(st, g.sec)}</td><td>${g.at ? `at ${p4Esc(g.at)}` : g.where ? GEL_WHERE[g.where] || "" : ""}</td></tr>`)) : p4Note("No gel needed for this length.")}</div>
      <div>${p4H("Hike these", `from ${plan.params.hikeGrade}%`)}${hikes.length ? p4Table(["#", "#Km", "Gradient", "#Clock"], hikes.map((c) => `<tr><td class="p4-n"><i style="background:${P4_LEVEL[c.level]}"></i>${c.n}</td><td class="r">${c.startKm.toFixed(1)}</td><td>${/steep part/.test(c.tactic) ? `${Math.round(c.steep)}% pitch` : `${c.avg.toFixed(0)}% average`}</td><td class="r">${clock(st, c.start[sid])}</td></tr>`)) : p4Note("None at this threshold.")}</div>
      <div>${p4H("Heart rate")}${plan.hrGuide ? p4Table(["Km", "Guide"], plan.hrGuide.map((h) => `<tr><td>${h.fromKm.toFixed(0)} → ${h.toKm.toFixed(0)}</td><td>${p4Esc(h.text)}</td></tr>`)) : p4Note("No heart rate in your runs.")}${p4Note("Before each key zone: on pace with heart rate in the guide, commit to it. Above it, hold and eat, and save it for the next one.")}</div>
    </div>
  </section>
  <section class="p4-part p4-new">
    ${p4H("The race section by section", `${raceName ? p4Esc(raceName) + " · " : ""}${sc.label.toLowerCase()} scenario`)}
    ${p4LegTable(plan, sid, st)}
    ${p4Note("Arrive = clock time at the start of the section. Time includes the aid-station stops in it; pace leaves them out. ★ key zone, ▲ aid station.")}
  </section>
  <section class="p4-part p4-new">
    ${p4ClimbTable(plan, sid, st)}
  </section>`;

  // Part 5, only with reference runs: the pace per gradient band, fresh (first half of your runs) and
  // tired (second half), the fade between them in %, and the weight of each run.
  if (effort) {
    const e = effort.info;
    const bandRows = e.bands.map((b) => `<tr><td>${p4Esc(b.label)}</td><td class="r"><b>${mmss(b.fresh)}</b></td><td class="r">${mmss(b.tired)}</td><td class="r">+${((b.tired / b.fresh - 1) * 100).toFixed(0)}%</td><td>${p4Esc(b.source)}${b.hr ? ` · HR ${Math.round(b.hr)}` : ""}</td></tr>`);
    const runRows = e.runs.map((r, i) => `<tr><td>${p4Esc(effort.runs[i].name)}</td><td>${p4Esc(r.date)}</td><td class="r">${r.distKm.toFixed(1)} km</td><td class="r">${hm(r.durationSec)}</td><td class="r">${Math.round(r.weight * 100)}%</td></tr>`);
    html += `<section class="p4-part">
      ${p4H("Engine", "what your runs say about you")}
      <div class="p4-kpis p4-kpis-s">${[
        p4Kpi("Flat pace", `${mmss(e.flatPace)}<small> /km</small>`, e.flatHr ? `at HR ${Math.round(e.flatHr)}` : ""),
        e.flatCad ? p4Kpi("Cadence", `${Math.round(e.flatCad)}<small> spm</small>`, "on the flat") : "",
        p4Kpi("Hiking from", `${plan.params.hikeGrade}<small>%</small>`, settings.hikeGrade ? "set by you" : plan.effort && plan.effort.hikeGrade ? "learned from your cadence" : "default"),
        p4Kpi("Race pace vs your runs", `+${((sc.factor - 1) * 100).toFixed(0)}<small>%</small>`, "terrain and fade for a longer effort"),
      ].join("")}</div>
      <div class="p4-grid2">
        <div>${p4H("Pace by gradient", "min/km, fresh → tired")}${p4Table(["Gradient", "#Fresh", "#Tired", "#Fade", "From"], bandRows)}</div>
        <div>${p4H("Reference runs")}${p4Table(["Run", "Date", "#Distance", "#Time", "#Weight"], runRows)}${p4Note(`Fresh = first half of your runs, tired = second half. "Estimated" bands had under a minute of data and use typical ratios to your flat pace. Each run's weight halves every ${settings.halfLifeDays} days of age.`)}</div>
      </div>
    </section>`;
  }
  return html;
}

/* ---------- Prep my run ---------- */
// Where the times of a Prep my run plan come from, in words for the subtitle.
const P4_SOURCE = { target: "your target time", runs: "your reference runs", estimate: "a generic estimate (Tobler's hiking function)" };
/**
 * The Prep my run document: key figures, profile, course sketch, key zones, the run section by
 * section, every climb and descent. Input: plan (same shape as a race plan, from core/preprun.js),
 * name, and source ("target", "runs" or "estimate"). It always uses the central scenario.
 */
function p4PrepSheet({ plan, name, source }) {
  const sid = "central";
  const sc = plan.scenarios[sid];
  const st = plan.startSec;
  const km = plan.course.totalKm;
  const segs = p4PlanSegs(plan);
  const kpis = [
    p4Kpi("Duration", hm(sc.finishSec), "estimated"),
    p4Kpi("Distance", `${km.toFixed(1)}<small> km</small>`),
    p4Kpi("Pace", `${mmss(sc.finishSec / km)}<small> /km</small>`),
    p4Kpi("Elevation", `+${Math.round(plan.course.gain)}<small> m</small>`, `−${Math.round(plan.course.loss)} m`),
    p4Kpi("Finish", clock(st, sc.finishSec), `start ${clock(st, 0)}`),
    p4Kpi("Climbs", String(plan.climbs.length), `${plan.descents.length} descents`),
    p4Kpi("Key zones", String((plan.keyZones || []).length)),
  ];
  return `<section class="p4-part">
    ${p4Top("Prep my run", name, `Run briefing · times from ${P4_SOURCE[source] || "an estimate"}`, kpis)}
    ${p4H("Profile")}
    ${p4Profile(plan.course.profile, { segs, zones: plan.keyZones })}
    ${P4_LEGEND}
    <div class="p4-grid2">
      <div class="p4-box">${p4H("Course", "start ● finish ●")}${p4Route(plan.course.route, plan.course.profile, { segs }) || p4Note("No GPS points to draw the course.")}${p4Note("Circles: km.")}</div>
      <div>${p4H("★ Key zones")}${p4Zones(plan.keyZones, (k) => `at ${clock(st, secAtKm(plan, sid, k))}`)}</div>
    </div>
  </section>
  <section class="p4-part p4-new">
    ${p4H("Your run section by section")}
    ${p4LegTable(plan, sid, st)}
    ${p4Note("Arrive = clock time at the start of the section. ★ key zone.")}
  </section>
  <section class="p4-part p4-new">${p4ClimbTable(plan, sid, st)}</section>`;
}

/* ---------- Rewind my run ---------- */
// The four verdicts against a target, as [tone for the colour, heading]: the same as RV_STATUS in
// ui/review.js.
const P4_STATUS = { reached: ["good", "Target reached"], reach: ["good", "Within reach"], stretch: ["info", "A stretch"], far: ["bad", "Far for now"] };
// The tone of a key moment, in words.
const P4_TONE_LABEL = { good: "Went well", bad: "Cost you", info: "Worth knowing" };
/**
 * A KPI value in its unit, as plain text (the screen version, inFmt in ui/insights.js, puts units
 * in <small>). "dur" seconds as h:mm, "%" a fraction as a percent, "pace" seconds per km as m:ss.
 */
function p4KpiFmt(k) {
  const v = k.value;
  switch (k.unit) {
    case "dur": return hm(v);
    case "n": case "num0": return String(Math.round(v));
    case "%": return `${(v * 100).toFixed(Math.abs(v) < 0.1 ? 1 : 0)}%`;
    case "pace": return `${mmss(v)} /km`;
    case "ratio": return v.toFixed(2);
    case "m/km": return `${Math.round(v)} m/km`;
    case "m/h": return `${Math.round(v)} m/h`;
    case "spm": return `${Math.round(v)} spm`;
    case "m": return `${v.toFixed(2)} m`;
    case "kcal": return `${Math.round(v)} kcal`;
    default: return v.toFixed(2);
  }
}
/**
 * The Rewind my run document. Input: run (the analysed run, core/review.js), name, target
 * ({kind, value} or null) and athlete (weight and heart rates saved by the deep-dive settings).
 * Parts: key figures, profile coloured by form, course sketch, records and key moments; the target
 * comparison (only with a target); every section; km splits; deep-dive KPIs and climbs.
 */
function p4RunSheet({ run, name, target, athlete = {} }) {
  const d = new Date(run.startMs);
  // st: the start as a time of day, in seconds since midnight, for clock times.
  const st = d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds();
  // The date in words, only when the file had a start time (Number.isFinite rejects NaN and undefined).
  const when = Number.isFinite(run.startMs) ? d.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric" }) : "";
  // The run's records and km splits (runStats, core/review.js).
  const S = runStats(run);
  const kpis = [
    p4Kpi("Duration", hm(run.elapsedSec), `${hm(run.movingSec)} moving`),
    p4Kpi("Distance", `${run.totalKm.toFixed(1)}<small> km</small>`),
    p4Kpi("Pace", `${mmss(run.avgPace)}<small> /km</small>`, `moving ${mmss(run.movingPace)}`),
    p4Kpi("Elevation", `+${Math.round(run.gain)}<small> m</small>`, `−${Math.round(run.loss)} m`),
    run.gapPace ? p4Kpi("Grade-adjusted", `${mmss(run.gapPace)}<small> /km</small>`, "flat-equivalent pace") : "",
    p4Kpi("Stopped", p4Dur(run.stopSec), `${run.stops.length} stop${run.stops.length === 1 ? "" : "s"}`),
    run.hasHr ? p4Kpi("Heart rate", `${Math.round(run.hrAvg)}<small> bpm</small>`, `peak ${Math.round(run.hrMax)}`) : "",
  ];
  // Coloured stretches (each section by how it went), the stops of a minute or more, and the second of
  // a key moment (worked out from its km when it has none).
  const segs = run.legs.map((l) => ({ fromKm: l.startKm, toKm: l.endKm, color: P4_TONE[l.tone] || P4_TONE.info }));
  const stops = run.stops.filter((s) => s.durSec >= 60).map((s) => ({ km: s.km }));
  const secOf = (m) => (Number.isFinite(m.sec) ? m.sec : runSecAtKm(run, m.km));
  // One table row per key moment: a coloured dot, km, clock, title, what happened and the tip.
  const moments = run.moments.map((m) => `<tr><td><span class="p4-dot" style="background:${P4_TONE[m.tone] || P4_TONE.info}"></span></td><td class="r">${m.km.toFixed(1)}</td><td class="r">${clock(st, secOf(m))}</td><td><b>${p4Esc(m.title)}</b> <small>${P4_TONE_LABEL[m.tone] || ""}</small><div>${p4Esc(m.text)}</div>${m.tip ? `<div class="p4-how">${p4Esc(m.tip)}</div>` : ""}</td></tr>`);

  // The target part, only when a target is set: verdict, four figures, and where to find or save time.
  let tgtHtml = "";
  const t = target ? runTarget(run, target) : null;
  if (t) {
    const [tone, head] = P4_STATUS[t.status];
    const tgtTxt = t.target.kind === "pace" ? `${mmss(t.target.value)}/km (${hm(t.targetSec)})` : `${hm(t.targetSec)} (${mmss(t.targetPace)}/km)`;
    // The pace (for a climb, the climbing speed) the target asked for on a section.
    const line = (l) => (l.kind === "climb" && l.tgtVam ? `${Math.round(l.tgtVam)} m/h climbing instead of ${Math.round(l.vam)}` : l.tgtPace ? `${mmss(l.tgtPace)}/km instead of ${mmss(l.pace)}` : "");
    tgtHtml = `<section class="p4-part">
      ${p4H("Against your target", tgtTxt)}
      <div class="p4-verdict" style="border-left-color:${P4_TONE[tone]}"><b>${head}</b> · ${t.gapSec > 0 ? `${p4Dur(t.gapSec)} over` : `${p4Dur(-t.gapSec)} inside`} your target${t.status !== "reached" || t.realisticSec < t.targetSec - 120 ? ` · aim for about <b>${hm(t.realisticSec)}</b> next time on this kind of course` : ""}</div>
      <div class="p4-kpis p4-kpis-s">${[
        p4Kpi(t.gapSec > 0 ? "Over target" : "Under target", p4Dur(Math.abs(t.gapSec)), `${hm(run.elapsedSec)} for ${hm(t.targetSec)}`),
        p4Kpi("Stops", t.stopGain >= 30 ? p4Dur(t.stopGain) : "OK", `${p4Dur(run.stopSec)} stopped, ${p4Dur(t.stopAllow)} allowed`),
        p4Kpi("Fade", t.fadeGain >= 30 ? p4Dur(t.fadeGain) : "None", "second half at first-half effort"),
        p4Kpi("Effort needed", `${t.effortPct >= 0 ? "+" : "−"}${Math.abs(t.effortPct).toFixed(1)}%`, t.targetGap ? `grade-adj. ${mmss(t.targetGap)}/km` : ""),
      ].join("")}</div>
      ${t.status === "reached" ? "" : `<div class="p4-grid2">
        <div>${p4H("Where to find the time")}<ul class="p4-list">${t.lose.map((l) => `<li><b>${l.i}. ${p4Esc(l.title)}</b> km ${p4Km(l.startKm, l.endKm)}: ${p4Dur(l.deltaSec)} slower than the target asked, ${line(l)}.</li>`).join("") || "<li>No section stands out: the gap is spread evenly.</li>"}</ul></div>
        ${t.ease.length ? `<div>${p4H("Where to ease off")}<ul class="p4-list">${t.ease.map((l) => `<li><b>${l.i}. ${p4Esc(l.title)}</b> km ${p4Km(l.startKm, l.endKm)}: ${p4Dur(-l.deltaSec)} faster than needed, before your fade.</li>`).join("")}</ul></div>` : ""}
      </div>`}
    </section>`;
  }

  // Every section, one row each; with a target, also its target time. The spread ...(cond ? [x] : [])
  // adds a column only when it is needed.
  const legRows = run.legs.map((l) => {
    const tl = t ? t.legs.find((x) => x.i === l.i) : null;
    return `<tr><td class="p4-n"><i style="background:${P4_TONE[l.tone] || P4_TONE.info}"></i>${l.i}</td><td><b>${p4Esc(l.title)}</b> <small>${p4Esc(l.label || "")}</small></td><td>${p4Km(l.startKm, l.endKm)}</td><td class="r">+${Math.round(l.up)} / −${Math.round(l.down)}</td><td class="r">${clock(st, l.startSec)}</td><td class="r">${p4Dur(l.movSec)}</td><td class="r">${l.pace ? mmss(l.pace) : "–"}</td><td class="r">${l.gap ? mmss(l.gap) : "–"}</td>${run.hasHr ? `<td class="r">${l.hr ? Math.round(l.hr) : "–"}</td>` : ""}<td>${p4Esc(l.verdict || "")}${l.vsPct ? ` ${l.vsPct > 0 ? "+" : ""}${l.vsPct}%` : ""}</td>${t ? `<td class="r">${tl ? p4Dur(tl.tgtSec) : "–"}</td>` : ""}</tr>`;
  });
  const legHead = ["#", "Section", "Km", "#D+ / D− m", "#Start", "#Moving", "#Pace", "#Grade-adj.", ...(run.hasHr ? ["#HR"] : []), "Against your average", ...(t ? ["#Target time"] : [])];

  // The records (best pace, fastest distances, steepest 100 m, highest point) as small key figures.
  const where = (o) => `km ${o.km.toFixed(1)} · ${clock(st, o.startSec)}`;
  const rec = [
    S.best1min ? p4Kpi("Best pace · 1 min", `${mmss(S.best1min.pace)}<small> /km</small>`, where(S.best1min)) : "",
    S.fastest1k ? p4Kpi("Fastest 1 km", mmss(S.fastest1k.sec), where(S.fastest1k)) : "",
    S.fastest5k ? p4Kpi("Fastest 5 km", S.fastest5k.sec < 3600 ? mmss(S.fastest5k.sec) : hm(S.fastest5k.sec), where(S.fastest5k)) : "",
    S.steepestUp && S.steepestUp.grade > 0 ? p4Kpi("Steepest 100 m up", `+${S.steepestUp.grade.toFixed(0)}<small>%</small>`, where(S.steepestUp)) : "",
    S.steepestDown && S.steepestDown.grade < 0 ? p4Kpi("Steepest 100 m down", `${S.steepestDown.grade.toFixed(0)}<small>%</small>`, where(S.steepestDown)) : "",
    p4Kpi("Highest point", `${Math.round(S.high.ele)}<small> m</small>`, `km ${S.high.km.toFixed(1)} · lowest ${Math.round(S.low.ele)} m`),
  ];
  // Km splits: the fastest km in green, the slowest in red (CSS classes p4-best and p4-worst).
  const splitRows = S.splits.map((x) => `<tr class="${x === S.fastestSplit ? "p4-best" : x === S.slowestSplit ? "p4-worst" : ""}"><td class="r">${x.part ? `+${(x.part * 1000).toFixed(0)} m` : x.km}</td><td class="r">${mmss(x.sec)}</td><td class="r">${x.pace ? mmss(x.pace) : "–"}</td><td class="r">${x.gap ? mmss(x.gap) : "–"}</td><td class="r">+${Math.round(x.up)} / −${Math.round(x.down)}</td>${run.hasHr ? `<td class="r">${x.hr ? Math.round(x.hr) : "–"}</td>` : ""}</tr>`);
  // Long runs: the splits in two side-by-side tables so they fit on one page.
  const half = splitRows.length > 26 ? Math.ceil(splitRows.length / 2) : splitRows.length;
  const splitHead = ["#Km", "#Time", "#Pace", "#Grade-adj.", "#D+ / D−", ...(run.hasHr ? ["#HR"] : [])];
  const splits = half < splitRows.length ? `<div class="p4-grid2">${p4Table(splitHead, splitRows.slice(0, half), "p4-split")}${p4Table(splitHead, splitRows.slice(half), "p4-split")}</div>` : p4Table(splitHead, splitRows, "p4-split");

  // Deep dive: the max heart rate is yours if you set one, else an estimate of at least 185 bpm (as in
  // ui/insights.js); then the KPIs in groups, and the climbs table.
  const hrMax = run.hasHr ? athlete.hrMax || Math.max(185, Math.round(run.hrMax || 0)) : null;
  const list = runKpis(run, { ...athlete, hrMax });
  const groups = [...new Set(list.map((k) => k.group))];
  const kpiHtml = groups.map((g) => `<div class="p4-kg"><h3>${g}</h3>${list.filter((k) => k.group === g).map((k) => `<div class="p4-kr"><span>${p4Esc(k.label)}</span><b>${p4KpiFmt(k)}</b><small>${p4Esc(k.hint)}</small></div>`).join("")}</div>`).join("");
  const ct = climbTable(run);
  const ctRows = ct.map((c) => `<tr><td class="p4-n"><i style="background:${P4_TONE[c.tone] || P4_TONE.info}"></i>${c.i}</td><td>${c.kind === "climb" ? "▲" : "▼"} ${p4Esc(c.title)}</td><td>${p4Km(c.startKm, c.endKm)}</td><td class="r">${c.kind === "climb" ? `+${Math.round(c.up)}` : `−${Math.round(c.down)}`} m</td><td class="r">${c.avg > 0 ? "+" : ""}${c.avg.toFixed(1)}%</td><td class="r">${hm(c.movSec)}</td><td class="r">${c.vam ? `${Math.round(c.vam)} m/h` : c.rate ? `${Math.round(c.rate)} m/h` : "–"}</td>${run.hasHr ? `<td class="r">${c.hr ? Math.round(c.hr) : "–"}</td>` : ""}${run.hasCad ? `<td class="r">${c.hikeShare !== null && c.hikeShare !== undefined ? `${Math.round(c.hikeShare * 100)}%` : "–"}</td>` : ""}<td>${p4Esc(c.verdict || "")}</td></tr>`);

  // The sheet, part by part.
  return `<section class="p4-part">
    ${p4Top("Rewind my run", name, `Run review${when ? ` · ${p4Esc(when)}` : ""} · start ${clock(st, 0)}`, kpis)}
    ${p4H("Profile", "coloured by how you ran each section against your own average on the same ground")}
    ${p4Profile(run.profile, { segs, stops })}
    <div class="p4-legend"><span><i style="background:${P4_TONE.good}"></i>Stronger than your average</span><span><i style="background:${P4_TONE.info}"></i>Your average</span><span><i style="background:${P4_TONE.bad}"></i>Weaker</span><span><i style="background:#14181f;width:3px"></i>Stop of a minute or more</span></div>
    <div class="p4-grid2">
      <div class="p4-box">${p4H("Course", "start ● finish ●")}${p4Route(run.route, run.profile, { segs }) || p4Note("No GPS points to draw the course.")}</div>
      <div>${p4H("Recap")}<div class="p4-kpis p4-kpis-s p4-kpis-2">${rec.join("")}</div></div>
    </div>
    ${p4H("Key moments", "good, bad and worth knowing, in the order they happened")}
    ${p4Table(["", "#Km", "#Clock", "What happened"], moments, "p4-mom")}
  </section>
  ${tgtHtml}
  <section class="p4-part p4-new">
    ${p4H("Every section", "moving time; pace and grade-adjusted pace in min/km")}
    ${p4Table(legHead, legRows, "p4-legs")}
    ${p4Note("Grade-adjusted pace = the flat pace that would have cost the same energy (Minetti). Against your average = this section compared with your own average on the same kind of ground.")}
  </section>
  <section class="p4-part">
    ${p4H("Km splits", "green: fastest, red: slowest")}
    ${splits}
  </section>
  <section class="p4-part p4-new">
    ${p4H("Deep dive", hrMax ? `heart rate max ${hrMax} bpm${athlete.hrMax ? "" : " (estimated)"}` : "")}
    <div class="p4-kgroups">${kpiHtml}</div>
    ${ct.length ? `${p4H("Climbs and descents")}${p4Table(["#", "Section", "Km", "#Vertical", "#Gradient", "#Time", "#Speed", ...(run.hasHr ? ["#HR"] : []), ...(run.hasCad ? ["#Hiked"] : []), "Verdict"], ctRows, "p4-cl")}${p4Note("Speed: vertical metres per hour (VAM) on climbs, vertical metres per hour down on descents.")}` : ""}
  </section>`;
}

/* ---------- the document ---------- */
// What the sheet says when nothing is loaded yet, for each mode.
const P4_EMPTY = {
  plan: "Load your runs and the race GPX (or press Try the demo) to build your plan, then export it.",
  prep: "Drop the GPX of your next run (or try the sample run), then export it.",
  run: "Drop the GPX of a run you did (or try the sample run), then export it.",
};
/**
 * The whole printable document for a mode ("plan", "prep" or "run") from its data (null when
 * nothing is loaded yet). With no data it returns a short sheet that says what to load first;
 * otherwise it picks the sheet builder of the mode and adds the footer.
 */
export function printSheet(mode, data) {
  if (!data) return `<div class="p4"><section class="p4-part">${p4Top({ plan: "Prep my race", prep: "Prep my run", run: "Rewind my run" }[mode] || "", "Nothing to export yet", P4_EMPTY[mode] || "", [])}</section></div>`;
  const body = mode === "run" ? p4RunSheet(data) : mode === "prep" ? p4PrepSheet(data) : p4PlanSheet(data);
  return `<div class="p4 p4-${mode}">${body}<footer class="p4-foot">Prep my race · itf-gh.github.io/trail-race-planner · a model is usually within 5 to 10%: treat times as a guide, not a promise.</footer></div>`;
}
/**
 * The file name the browser offers when saving as PDF (it takes the page title), e.g.
 * "Lakes 50 · race plan". Characters that are not allowed in file names (\ / : * ? " < > |) become
 * spaces: the regex matches one or more of them in a row. Returns null when there is no data.
 */
export function printTitle(mode, data) {
  if (!data) return null;
  const name = mode === "run" ? data.name : mode === "prep" ? data.name : data.raceName;
  return `${String(name || "Prep my race").replace(/[\\/:*?"<>|]+/g, " ").trim()} · ${{ plan: "race plan", prep: "run briefing", run: "run review" }[mode]}`;
}

/**
 * Wire the export. `collect(mode)` returns the data of the mode on screen, or null when nothing is
 * loaded. Returns print(): build the sheet and open the browser's print dialog.
 *
 * Side effects: adds the hidden <div id="printDoc"> to <body> and listens to the window's
 * "beforeprint" and "afterprint" events. build() fills the sheet for the mode on screen and sets
 * the page title (the PDF's file name), keeping the old title in savedTitle; done() puts the title
 * back and empties the sheet once printing is over. Errors while collecting or building are
 * caught, so the print dialog still opens, with an error message on the page.
 */
export function initPrint({ collect }) {
  const doc = document.createElement("div");
  doc.id = "printDoc";
  doc.setAttribute("aria-hidden", "true");
  document.body.appendChild(doc);
  let savedTitle = null;
  const build = () => {
    const mode = document.documentElement.dataset.mode || "plan";
    let data = null;
    try { data = collect(mode); } catch (e) { data = null; }
    try { doc.innerHTML = printSheet(mode, data); } catch (e) { doc.innerHTML = `<div class="p4"><p>Could not build the A4 export: ${p4Esc(e.message)}</p></div>`; }
    const t = printTitle(mode, data);
    if (t && savedTitle === null) { savedTitle = document.title; document.title = t; }
  };
  const done = () => {
    if (savedTitle !== null) { document.title = savedTitle; savedTitle = null; }
    doc.innerHTML = "";
  };
  window.addEventListener("beforeprint", build);
  window.addEventListener("afterprint", done);
  // The function handed back: build now and open the print dialog. "beforeprint" then fires and builds
  // once more; the savedTitle check keeps the original title safe.
  return () => { build(); window.print(); };
}
