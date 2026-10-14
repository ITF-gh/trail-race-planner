// main.js: the browser app. Reads two GPX files locally (nothing is uploaded),
// calls the same core modules as the CLI, and draws the result in three sections:
//   01 Your engine     what your own run says about you (effort GPX only)
//   02 Race briefing   what the course says, before knowing who runs it (race GPX only)
//   03 D-day plan      both files plus your settings: clock times, tactics, gels
//   04 Race day        the plan played back in time on the map and profile, to rehearse it
// Each section renders as soon as the files it needs are loaded. A sticky bar on top jumps
// between sections and shows which one you are reading.

import { parseGpx, resample } from "../core/track.js";
import { analyseCourse } from "../core/terrain.js";
import { analyseEffort } from "../core/effort.js";
import { buildPlan, briefCourse, coarseIndices, parseAidStations, PLAN_DEFAULTS, LEVELS, DESCENT_LABELS } from "../core/plan.js";
import { TERRAIN, SCENARIOS } from "../core/model.js";
import { planToMarkdown } from "../core/markdown.js";
import { mmss, hm, clock, parseDuration } from "../core/format.js";
import { keyZones, toblerClock } from "../core/keyzones.js";
import { secAtKm } from "../core/script.js";
import { courseMap } from "./map.js";
import { mountReplay, stopReplay } from "./replay.js";
import { makeDemoRaceGpx, makeDemoEffortGpx, DEMO_ULTRA_PROFILE, DEMO_ULTRA_AID, DEMO_LONG_RUN_PROFILE } from "../demo.js";

const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k) || "null"); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage can be blocked */ } },
};

const state = {
  race: null, // {name, parsed, course, profile}
  effort: null, // {runs: [{name, parsed}], info}
  settings: { ...PLAN_DEFAULTS, ...(store.get("trp.settings") || {}) },
  scenario: store.get("trp.scenario") || "central",
  tab: "c", // D-day list: climbs or descents
  btab: "c", // briefing list: climbs or descents
  plan: null,
};

/* ---------- skeleton ---------- */
const PEAK = `<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M2 27 12 9l5 8 4-5 9 15z" fill="currentColor"/><path d="m12 9 2.6 4.6L12 12l-2 2.2z" fill="#fff" opacity=".85"/></svg>`;
// Photos come from Pexels (free licence: use and edit allowed, credit appreciated). The files sit
// in src/ui/photos and are copied next to index.html at build; style.css points the slots at them.
const PHOTOS = {
  hero: { by: "Artem Meletov", url: "https://www.pexels.com/photo/person-standing-on-mountain-peak-above-clouds-8910505/" },
  s1: { by: "Hobi Photography", url: "https://www.pexels.com/photo/hiker-with-flashlight-looking-at-starry-night-sky-27790902/" },
  s2: { by: "Elina Volkova", url: "https://www.pexels.com/photo/misty-forest-path-in-dense-woodland-29579873/" },
  s3: { by: "Jack Davis", url: "https://www.pexels.com/photo/back-view-of-a-woman-running-up-the-mountain-trail-8949023/" },
};
const credit = (key) => `<a class="photo-credit" href="${PHOTOS[key].url}" target="_blank" rel="noopener">Photo: ${PHOTOS[key].by} / Pexels</a>`;
const head = (num, kicker, title) => `<header class="sec-head"><div class="sec-num">${num}</div><div class="sec-kicker">${kicker}</div><h2>${title}</h2>${PHOTOS["s" + Number(num)] ? credit("s" + Number(num)) : ""}</header>`;
const NAV = [["s1", "01", "Engine"], ["s2", "02", "Briefing"], ["s3", "03", "D-day"], ["s4", "04", "Race day"]];

$("#app").innerHTML = `
<header class="hero" id="top">
  ${credit("hero")}
  <div class="hero-in">
    <div class="hero-row">
      <div>
        <div class="brand">${PEAK}Trail Race Planner</div>
        <h1 style="margin-top:14px">Know the course.<br><em>Own the day.</em></h1>
        <p class="lead">Drop one or more of your own runs and the race GPX. The planner learns how you move on every gradient, reads every climb of the course, and builds your race-day plan: pace, hikes, gels, checkpoints. Your files never leave this page.</p>
      </div>
      <button class="btn primary" id="demo" type="button">Try the demo</button>
    </div>
    <div class="drops">
      <div class="drop" id="dropEffort">
        <h3><span class="tag">01</span>Your runs</h3>
        <p>One or more recorded runs of 1.5 h or more at a steady effort, with some climbs. Recent runs count more. Heart rate and cadence are a bonus.</p>
        <div class="actions"><label class="btn ghost" for="fileEffort">Add GPX</label><input type="file" id="fileEffort" multiple accept=".gpx,application/gpx+xml,text/xml"><button class="btn ghost" id="clearRuns" type="button" hidden>Clear</button></div>
        <div class="status" id="stEffort" aria-live="polite"></div>
      </div>
      <div class="drop" id="dropRace">
        <h3><span class="tag">02</span>The race</h3>
        <p>The official course GPX, with elevation. Drop it here or choose it.</p>
        <div><label class="btn ghost" for="fileRace">Choose GPX</label><input type="file" id="fileRace" accept=".gpx,application/gpx+xml,text/xml"></div>
        <div class="status" id="stRace" aria-live="polite"></div>
      </div>
    </div>
  </div>
</header>

<nav class="topnav" id="topnav" aria-label="Sections">
  <div class="topnav-in">
    <a class="tn-brand" href="#top" aria-label="Back to top">${PEAK}</a>
    <div class="tn-links">${NAV.map(([id, n, t]) => `<a href="#${id}" data-sec="${id}"><b>${n}</b>${t}</a>`).join("")}</div>
    <div class="tn-sum" id="tnSum"></div>
  </div>
  <div class="tn-prog" aria-hidden="true"><i id="tnProg"></i></div>
</nav>

<section id="s1">
  ${head("01", "From your run", "Your engine")}
  <p class="sec-intro">What the planner reads from your own GPX: how fast you move on each gradient, fresh and tired, and how you fade.</p>
  <div id="s1body"></div>
</section>

<section id="s2">
  ${head("02", "From the race GPX", "Race briefing")}
  <p class="sec-intro">The course on its own: where the climbs and descents are, how hard each one is, and where the long climbs change character.</p>
  <div id="s2body"></div>
</section>

<section id="s3">
  ${head("03", "Your plan", "D-day")}
  <p class="sec-intro">Your engine on this course, with your race-day settings: finish time, clock time at every checkpoint, how to run each climb and descent, when to eat.</p>
  <div class="panel">
    <div class="fields">
      <label class="f">Start time<input type="time" id="startTime"></label>
      <label class="f">Terrain on race day
        <select id="terrain">${Object.entries(TERRAIN).map(([k, v]) => `<option value="${k}">${esc(v.label)}</option>`).join("")}</select>
      </label>
      <label class="f">Max heart rate (optional)<input type="number" id="maxHr" min="120" max="230" placeholder="for example 190"></label>
      <label class="f">Gel every (minutes)<input type="number" id="gelEveryMin" min="20" max="90"></label>
      <label class="f" style="grid-column:1 / -1">Aid stations<textarea id="aidStations" rows="3" placeholder="One per line: km, name, minutes stopped&#10;8.5 Refuge du Lac 2&#10;16 Ferme des Crêtes 3"></textarea><span class="hint">Stops are added to every clock time after the station. A gel due within ${PLAN_DEFAULTS.gelToAidMin} minutes of a station is taken there.</span></label>
    </div>
    <details class="adv">
      <summary>Advanced</summary>
      <div class="fields" style="margin-top:12px">
        <label class="f">Checkpoint every (km)<input type="number" id="checkpointKm" min="2" max="25"></label>
        <label class="f">Hiking threshold (% gradient)<input type="number" id="hikeGrade" min="6" max="30" placeholder="learned from your run"><span class="hint">Leave blank to learn it from your cadence.</span></label>
        <label class="f">Endurance exponent<input type="number" id="enduranceExp" step="0.01" min="0.03" max="0.15"><span class="hint">How fast you fade when the race is longer than your run. 0.07 is typical.</span></label>
        <label class="f">Run half-life (days)<input type="number" id="halfLifeDays" min="3" max="365"><span class="hint">With several runs: a run this many days older counts half as much.</span></label>
        <label class="f">Faster on gentle descents (%)<input type="number" id="descentBoost" step="1" min="0" max="10"><span class="hint">Only if your quads can take it. 0 is safe.</span></label>
      </div>
    </details>
    <div id="planErr"></div>
  </div>
  <div id="s3body" style="margin-top:22px"></div>
</section>

<section id="s4">
  ${head("04", "Rehearse it", "Race day")}
  <p class="sec-intro">Live the race before you run it. Press play and follow yourself along the course: the clock runs at your predicted pace, and every climb, gel and aid station shows what to do there. Replay it until the plan feels familiar.</p>
  <div id="s4body"></div>
</section>

<p class="foot">How it works: your run gives a pace for every gradient band, fresh and tired. Each 10 m of the course takes the pace of its band, sliding from fresh to tired along the race, scaled for terrain and for how much longer the race is than your run. Climbs and descents come from the course elevation, smoothed to ignore GPS noise. A model like this is usually within 5 to 10%: treat the three scenarios as a range, not a promise.</p>
<p class="foot">Photos by ${Object.values(PHOTOS).map((p) => `<a href="${p.url}" target="_blank" rel="noopener">${p.by}</a>`).join(", ")}, free to use under the <a href="https://www.pexels.com/license/" target="_blank" rel="noopener">Pexels licence</a>.</p>
`;

/* ---------- settings form ---------- */
const FIELDS = ["startTime", "terrain", "maxHr", "gelEveryMin", "aidStations", "checkpointKm", "hikeGrade", "enduranceExp", "halfLifeDays", "descentBoost"];
function writeSettings() {
  const s = state.settings;
  $("#startTime").value = s.startTime;
  $("#terrain").value = s.terrain;
  $("#maxHr").value = s.maxHr ?? "";
  $("#gelEveryMin").value = s.gelEveryMin;
  $("#checkpointKm").value = s.checkpointKm;
  $("#hikeGrade").value = s.hikeGrade ?? "";
  $("#enduranceExp").value = s.enduranceExp;
  $("#descentBoost").value = Math.round((s.descentBoost || 0) * 100);
  $("#aidStations").value = Array.isArray(s.aidStations) ? s.aidStations.map((a) => `${a.km} ${a.name} ${a.stopMin}`).join("\n") : s.aidStations || "";
  $("#halfLifeDays").value = s.halfLifeDays;
}
function readSettings() {
  const n = (id) => { const v = parseFloat($("#" + id).value); return Number.isFinite(v) ? v : null; };
  state.settings = {
    ...state.settings,
    startTime: $("#startTime").value || "09:00",
    terrain: $("#terrain").value,
    maxHr: n("maxHr"),
    gelEveryMin: n("gelEveryMin") || 45,
    checkpointKm: n("checkpointKm") || 10,
    hikeGrade: n("hikeGrade"),
    enduranceExp: n("enduranceExp") ?? 0.07,
    descentBoost: (n("descentBoost") || 0) / 100,
    aidStations: $("#aidStations").value,
    halfLifeDays: n("halfLifeDays") || 28,
  };
  store.set("trp.settings", state.settings);
}
writeSettings();
FIELDS.forEach((id) => $("#" + id).addEventListener("change", () => {
  readSettings();
  if (id === "halfLifeDays" && state.effort) setRuns(state.effort.runs); else compute();
}));

/* ---------- files ---------- */
function setStatus(which, html, ok) {
  $(which === "race" ? "#stRace" : "#stEffort").innerHTML = html;
  $(which === "race" ? "#dropRace" : "#dropEffort").classList.toggle("done", Boolean(ok));
}

function loadRace(xml, label) {
  try {
    const parsed = parseGpx(xml);
    const rs = resample(parsed, 10);
    const course = analyseCourse(rs);
    const idx = coarseIndices(course.n);
    const profile = idx.map((i) => [(i * course.step) / 1000, course.ele[i]]);
    const route = idx.map((i) => [rs.lat[i], rs.lon[i]]);
    state.race = { name: label || parsed.name || "Race", parsed, course, profile, route };
    setStatus("race", `<span class="ok">✓ ${esc(state.race.name)}</span> · ${course.totalKm.toFixed(1)} km · ${Math.round(course.gain)} m D+`, true);
  } catch (e) {
    state.race = null;
    setStatus("race", `<div class="err">${esc(e.message)}</div>`);
  }
  compute();
}

/** Add runs to the reference set. Each new file joins the ones already loaded. */
function loadEfforts(files) {
  const runs = state.effort ? [...state.effort.runs] : [];
  const bad = [];
  for (const { xml, label } of files) {
    try { const parsed = parseGpx(xml); runs.push({ name: label || parsed.name || `Run ${runs.length + 1}`, parsed }); } catch (e) { bad.push(`${label}: ${e.message}`); }
  }
  setRuns(runs, bad);
}
function setRuns(runs, bad = []) {
  state.effort = null;
  $("#clearRuns").hidden = !runs.length;
  if (runs.length) {
    try {
      const info = analyseEffort(runs.map((r) => r.parsed), { halfLifeDays: state.settings.halfLifeDays });
      state.effort = { runs, info };
    } catch (e) { bad.push(e.message); }
  }
  const list = state.effort ? state.effort.info.runs.map((r, i) => `<span class="ok">✓ ${esc(runs[i].name)}</span> · ${r.date} · ${r.distKm.toFixed(1)} km${runs.length > 1 ? ` · weight ${Math.round(r.weight * 100)}%` : ""}`).join("<br>") : "";
  setStatus("effort", list + bad.map((b) => `<div class="err">${esc(b)}</div>`).join(""), Boolean(state.effort));
  compute();
}

function wireDrop(boxId, inputId, loader) {
  const box = $(boxId);
  const input = $(inputId);
  const handle = async (fileList) => {
    const files = [...(fileList || [])];
    if (!files.length) return;
    const read = await Promise.all(files.map(async (f) => ({ xml: await f.text().catch(() => ""), label: f.name.replace(/\.gpx$/i, "") })));
    loader(read);
    input.value = ""; // so choosing the same file again still triggers a change
  };
  input.addEventListener("change", () => handle(input.files));
  box.addEventListener("dragover", (e) => { e.preventDefault(); box.classList.add("over"); });
  box.addEventListener("dragleave", () => box.classList.remove("over"));
  box.addEventListener("drop", (e) => { e.preventDefault(); box.classList.remove("over"); handle(e.dataTransfer.files); });
}
wireDrop("#dropRace", "#fileRace", (files) => loadRace(files[0].xml, files[0].label));
wireDrop("#dropEffort", "#fileEffort", loadEfforts);
$("#clearRuns").addEventListener("click", () => setRuns([]));

$("#demo").addEventListener("click", () => {
  // A made-up mountain ultra (78 km, 3,800 m up, seven aid stations) and two made-up 30 km
  // mountain long runs six weeks apart, so the weighting shows. Aid stations and start time
  // are filled in unless you typed your own.
  state.effort = null;
  loadEfforts([
    { xml: makeDemoEffortGpx({ profile: DEMO_LONG_RUN_PROFILE, startIso: "2026-10-11T07:00:00Z" }), label: "Demo mountain long run (made up)" },
    { xml: makeDemoEffortGpx({ profile: DEMO_LONG_RUN_PROFILE, fatigue: 0.3, startIso: "2026-08-30T07:00:00Z" }), label: "Demo older long run (made up)" },
  ]);
  const aid = $("#aidStations").value.trim();
  if (!aid || aid === "8.5 Refuge du Lac 2\n16 Ferme des Crêtes 3") {
    $("#aidStations").value = DEMO_ULTRA_AID;
    if ($("#startTime").value === PLAN_DEFAULTS.startTime) $("#startTime").value = "06:00";
    readSettings();
  }
  // The course is drawn as a loop over the Vercors so the map has something to show; the
  // profile does not match the real ground there.
  loadRace(makeDemoRaceGpx(DEMO_ULTRA_PROFILE, { name: "Ultra des Crêtes 78K", startEle: 650, loop: true, center: [45.05, 5.7] }), "Ultra des Crêtes 78K (made up)");
  $("#s1").scrollIntoView({ behavior: "smooth", block: "start" });
});

/* ---------- compute ---------- */
function compute() {
  state.plan = null;
  $("#planErr").innerHTML = "";
  if (state.race && state.effort) {
    try {
      state.plan = buildPlan(state.race.parsed, state.effort.runs.map((r) => r.parsed), state.settings);
    } catch (e) {
      $("#planErr").innerHTML = `<div class="err">${esc(e.message)}</div>`;
    }
  }
  renderEngine();
  renderBriefing();
  renderDday();
  renderReplay();
  renderNav();
}

/* ---------- shared pieces ---------- */
const tile = (k, v, s = "", cls = "") => `<div class="tile ${cls}"><div class="k">${k}</div><div class="v">${v}</div>${s ? `<div class="s">${s}</div>` : ""}</div>`;
const cell = (k, v, cls = "") => `<div class="c ${cls}"><span class="k">${k}</span><b>${v}</b></div>`;
const len = (m) => (m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`);
const kmRange = (x) => `${x.startKm.toFixed(1)} → ${x.endKm.toFixed(1)}`;
const empty = (html) => `<div class="empty">${html}</div>`;

function elevAt(profile, km) {
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
function profGeom(P, TOT, race) {
  const eles = P.map((p) => p[1]);
  const EMIN = Math.min(...eles), EMAX = Math.max(...eles);
  const W = 1000, l = 52, r = 14, top = race ? 34 : 18, base = race ? 205 : 190;
  const plotH = base - top - 24;
  const H = race ? 285 : 222;
  const x = (km) => l + (km / TOT) * (W - l - r);
  const y = (e) => base - 24 - ((e - EMIN) / Math.max(1, EMAX - EMIN)) * plotH;
  const km = (vx) => Math.max(0, Math.min(TOT, ((vx - l) / (W - l - r)) * TOT));
  return { EMIN, EMAX, W, l, r, top, base, plotH, H, x, y, km };
}

/**
 * Elevation profile. `brief` gives the climbs and descents; `race` (optional) adds
 * checkpoints and gels for one scenario; `zones` (optional) shades the key zones. Returns {html, x, y, km};
 * the html has a hidden `.pcur` cursor (a line and a dot) to move with translate().
 */
function profileView(P, brief, race, zones = []) {
  const TOT = brief.totalKm;
  const g = profGeom(P, TOT, race);
  const { EMIN, EMAX, W, l, r, top, base, H, x, y } = g;
  let s = "";
  zones.forEach((z) => {
    s += `<rect class="zone" x="${x(z.fromKm).toFixed(1)}" y="${top}" width="${(x(z.toKm) - x(z.fromKm)).toFixed(1)}" height="${base - top}"><title>Key zone ${z.n}: ${esc(z.title)}</title></rect>`;
    s += `<text class="zk" x="${(x(z.fromKm) + 4).toFixed(1)}" y="${top + 12}">★${z.n}</text>`;
  });
  let d = `M${x(0)},${base}`;
  P.forEach((p) => { d += ` L${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`; });
  d += ` L${x(TOT)},${base} Z`;
  s += `<path class="area" d="${d}"/>`;
  s += `<path class="ln" d="${P.map((p, i) => `${i ? "L" : "M"}${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join(" ")}"/>`;
  s += `<line class="axis" x1="${l}" x2="${W - r}" y1="${base}" y2="${base}"/>`;
  const tickEvery = TOT > 60 ? 10 : 5;
  for (let k = 0; k <= TOT; k += tickEvery) s += `<line class="axis" x1="${x(k)}" x2="${x(k)}" y1="${base}" y2="${base + 5}"/><text x="${x(k)}" y="${base + 18}" text-anchor="middle">${k}</text>`;
  s += `<text x="${W - r}" y="${base + 18}" text-anchor="end">km</text>`;
  [Math.ceil(EMIN / 10) * 10, Math.floor(EMAX / 10) * 10].forEach((e) => { s += `<text x="${l - 6}" y="${(y(e) + 3).toFixed(1)}" text-anchor="end">${e} m</text>`; });
  const seg = (a, b) => {
    const pts = [];
    const n = Math.max(2, Math.round((b - a) / 0.025));
    for (let i = 0; i <= n; i++) { const k = a + ((b - a) * i) / n; pts.push(`${i ? "L" : "M"}${x(k).toFixed(1)},${y(elevAt(P, k)).toFixed(1)}`); }
    return pts.join("");
  };
  const label = (c) => { const mid = (c.startKm + c.endKm) / 2; return `<text class="num" x="${x(mid).toFixed(1)}" y="${(y(elevAt(P, mid)) - 10).toFixed(1)}" text-anchor="middle">${c.n}</text>`; };
  brief.descents.forEach((dd) => { if (dd.level === 4) s += `<path class="dl" d="${seg(dd.startKm, dd.endKm)}"><title>Descent ${dd.n}, km ${dd.startKm.toFixed(2)}: ${Math.round(dd.loss)} m at ${Math.abs(dd.avg).toFixed(1)}%</title></path>`; });
  brief.climbs.forEach((c) => {
    // A split climb is drawn section by section, each in its own difficulty colour.
    const parts = c.sections.length ? c.sections : [c];
    parts.forEach((p) => {
      s += `<path class="cl cl${p.level}" d="${seg(p.startKm, p.endKm)}"><title>${c.sections.length ? "Section" : "Climb"} ${p.n}, km ${p.startKm.toFixed(2)}: ${Math.round(p.gain)} m at ${p.avg.toFixed(1)}%, ${LEVELS[p.level]}</title></path>`;
      if (p.level >= 3) s += label(p);
    });
    c.sections.slice(1).forEach((x2) => { const yy = y(elevAt(P, x2.startKm)); s += `<line class="cut" x1="${x(x2.startKm).toFixed(1)}" x2="${x(x2.startKm).toFixed(1)}" y1="${(yy - 7).toFixed(1)}" y2="${(yy + 7).toFixed(1)}"/>`; });
  });
  if (race) {
    race.checkpoints.filter((c) => c.label !== "Finish").forEach((c) => {
      s += `<line class="ck" x1="${x(c.km)}" x2="${x(c.km)}" y1="${top - 6}" y2="${base}"/><text class="tk" x="${x(c.km)}" y="${top - 12}" text-anchor="middle">${esc(c.label)} · ${clock(race.startSec, c.sec)}</text>`;
    });
    (race.aid || []).forEach((a) => {
      const yy = y(elevAt(P, a.km));
      s += `<path class="aid" d="M${x(a.km).toFixed(1)},${(yy - 6).toFixed(1)} l-7,-12 h14 z"><title>${esc(a.name)}, km ${a.km.toFixed(1)}: ${clock(race.startSec, a.sec)}</title></path>`;
    });
    race.gels.forEach((g) => {
      s += `<circle class="gel" cx="${x(g.km)}" cy="${base + 48}" r="9"/><text class="gelt" x="${x(g.km)}" y="${base + 51}" text-anchor="middle">G</text><text x="${x(g.km)}" y="${base + 70}" text-anchor="middle">${clock(race.startSec, g.sec)}</text>`;
    });
  }
  s += `<g class="pcur" style="display:none"><line x1="0" x2="0" y1="${top - 4}" y2="${base}"/><circle cx="0" cy="${base}" r="6"/></g>`;
  return { ...g, html: `<div class="prof-scroll"><svg viewBox="0 0 1000 ${H}" role="img" aria-label="Elevation profile with climbs coloured by difficulty">${s}</svg></div>` };
}

const LEGEND = `<div class="legend" style="margin-top:10px"><span class="chip l1">Easy</span><span class="chip l2">Moderate</span><span class="chip l3">Hard</span><span class="chip l4">Crux</span><span class="note" style="margin:0 0 0 4px">Dashed red: descent to brake on. Short ticks: where a long climb changes section.</span></div>`;

/* ---------- 01 your engine ---------- */
function renderEngine() {
  const box = $("#s1body");
  if (!state.effort) { box.innerHTML = empty(`<b>Drop one of your runs above</b> (or press Try the demo) to see your pace on every gradient.`); return; }
  const e = state.effort.info;
  const bands = e.bands;
  const steep = bands.filter((b) => b.vam && b.vam > 50 && b.source !== "estimated").sort((a, b) => b.vam - a.vam)[0];
  const hike = state.settings.hikeGrade ?? e.hikeGrade;
  const tiles = [
    e.runs.length > 1
      ? tile("Runs", `${e.runs.length}`, `weighted, half-life ${state.settings.halfLifeDays} days`)
      : tile("Distance · time", `${e.distKm.toFixed(1)}<small>km</small>`, hm(e.durationSec)),
    tile("Flat pace", `${mmss(e.flatPace)}<small>/km</small>`, e.flatHr ? `at HR ${Math.round(e.flatHr)}` : "no heart rate"),
    tile("Cadence", e.flatCad ? `${Math.round(e.flatCad)}<small>spm</small>` : "–", e.cadenceWasPerFoot ? "doubled from per-foot" : "on the flat"),
    tile("Best climb rate", steep ? `${Math.round(steep.vam)}<small>m/h</small>` : "–", steep ? steep.label : "not enough climbing"),
    tile("Hiking from", hike ? `${hike}<small>%</small>` : "15<small>%</small>", state.settings.hikeGrade ? "set by you" : e.hikeGrade ? "learned from your cadence" : "default, no hiking in your runs"),
    tile("Flat drift", e.drift ? `${e.drift.decouplingPct.toFixed(1)}<small>%</small>` : "–", e.drift ? `${mmss(e.drift.firstPace)} → ${mmss(e.drift.secondPace)} /km` : "needs heart rate"),
  ].join("");
  const maxPace = Math.max(...bands.map((b) => b.tired));
  const rows = bands.map((b) => {
    const fade = (b.tired / b.fresh - 1) * 100;
    return `<div class="pace ${b.source === "estimated" ? "est" : ""}">
      <div class="lab">${esc(b.label)}<small>${b.source}${b.hr ? ` · HR ${Math.round(b.hr)}` : ""}</small></div>
      <div class="bars"><i class="fr" style="width:${((b.fresh / maxPace) * 100).toFixed(1)}%"></i><i class="ti" style="width:${((b.tired / maxPace) * 100).toFixed(1)}%"></i></div>
      <div class="num"><b>${mmss(b.fresh)}</b> → ${mmss(b.tired)} <span style="color:var(--muted)">+${fade.toFixed(0)}%</span></div>
    </div>`;
  }).join("");
  box.innerHTML = `
    <div class="tiles">${tiles}</div>
    ${e.runs.length > 1 ? `<div class="sub-h">Your runs</div><div class="panel"><div class="paces">${e.runs.map((r, i) => `<div class="pace"><div class="lab">${esc(state.effort.runs[i].name)}<small>${r.date} · ${r.distKm.toFixed(1)} km · ${hm(r.durationSec)}</small></div><div class="bars"><i class="fr" style="width:${(r.weight * 100).toFixed(1)}%"></i></div><div class="num"><b>${Math.round(r.weight * 100)}%</b> weight</div></div>`).join("")}</div><p class="note">Each run counts with a weight that halves every ${state.settings.halfLifeDays} days of age, measured from your most recent run (an exponential decay, like a half-life). The paces below are the weighted average.</p></div>` : ""}
    <div class="sub-h">Pace by gradient</div>
    <div class="panel">
      <div class="keyline"><span><i style="background:var(--accent)"></i>Fresh (first half of your run)</span><span><i style="background:color-mix(in srgb,var(--fg) 35%,transparent)"></i>Tired (second half)</span><span>Longer bar = slower. Pace in min/km.</span></div>
      <div class="paces">${rows}</div>
      <p class="note">"Estimated" bands had under a minute of data in your run, so they use typical ratios to your flat pace. Flat drift above 5% means aerobic durability or fuelling is your limit, and a longer race will magnify it.</p>
    </div>`;
}

/* ---------- map styling shared by the briefing and the replay ---------- */
/** Coloured stretches (climbs by difficulty, braking descents) and markers for courseMap. */
function mapStyle(brief, aid, zones = []) {
  // key zones first, as a wide glow under the coloured climbs
  const paint = zones.map((z) => ({ fromKm: z.fromKm, toKm: z.toKm, cls: "rt-key", title: `★ Key zone ${z.n} · ${esc(z.title)}` }));
  brief.climbs.forEach((c) => (c.sections.length ? c.sections : [c]).forEach((p) => paint.push({ fromKm: p.startKm, toKm: p.endKm, cls: `rt-cl rt-cl${p.level}`, title: `Climb ${p.n} · km ${p.startKm.toFixed(1)} · ${Math.round(p.gain)} m at ${p.avg.toFixed(1)}% · ${LEVELS[p.level]}` })));
  brief.descents.filter((d) => d.level === 4).forEach((d) => paint.push({ fromKm: d.startKm, toKm: d.endKm, cls: "rt-dl", title: `Descent ${d.n} · km ${d.startKm.toFixed(1)} · ${Math.round(d.loss)} m at ${Math.abs(d.avg).toFixed(1)}% · brake` }));
  const marks = [{ km: 0, kind: "start", label: "Start" }];
  const every = brief.totalKm > 60 ? 10 : 5;
  for (let k = every; k < brief.totalKm - 1; k += every) marks.push({ km: k, kind: "km", label: String(k) });
  aid.forEach((a) => marks.push({ km: a.km, kind: "aid", label: esc(a.name), title: `${esc(a.name)} · km ${a.km.toFixed(1)}${a.time ? ` · ${a.time}` : ""}` }));
  return { paint, marks };
}
/** The key zones as a list; with `when` (km -> clock text) each one shows when you get there. */
function zoneList(zones, when) {
  if (!zones.length) return empty("No stretch stands out: an even course, run it evenly.");
  return `<div class="zones">${zones.map((z) => `<div class="zone-card m-${z.mode}">
    <div class="zn">★${z.n}</div>
    <div class="zb"><div class="zt"><span class="mode m-${z.mode}">${z.modeLabel}</span><b>${esc(z.title)}</b><span>km ${z.fromKm.toFixed(1)} → ${z.toKm.toFixed(1)}${when ? ` · ${when(z.fromKm)}` : ""}</span></div>
    <p>${esc(z.why)}</p><p class="zh">${esc(z.how)}</p></div>
    <div class="zs"><b>${z.stakeMin}</b><small>min in play</small></div>
  </div>`).join("")}</div>`;
}
const ZONE_NOTE = `Key zones are short stretches where how you run changes your race. <b>Attack</b>: push, time is won here. <b>Prepare</b>: set up what comes next (eat, drink, let your heart rate drop). <b>Manage</b>: protect your effort for later. Minutes in play = the typical gap, on that stretch and what follows, between runners of your level who run it well and those who do not: time on it × how much runners differ at that point (3% at the start to 18% at the finish, as fatigue spreads the field) × the kind of zone. One zone per 13 km of race.`;
const jumps = (items) => `<nav class="jumps" aria-label="In this section">${items.map(([href, t, cls]) => `<a href="#${href}" class="${cls || ""}">${t}</a>`).join("")}</nav>`;
let briefMap = null;

/* ---------- 02 race briefing ---------- */
function diffCell(c, maxScore) {
  return `<div class="diff"><span class="chip l${c.level}">${LEVELS[c.level]}</span><span class="bar"><i style="width:${Math.round(Math.min(1, c.score / maxScore) * 100)}%"></i></span><span class="sc">${Math.round(c.score)}</span></div>`;
}
function renderBriefing() {
  const box = $("#s2body");
  if (briefMap) { briefMap.destroy(); briefMap = null; }
  if (!state.race) { box.innerHTML = empty(`<b>Drop the race GPX above</b> to get the course briefing.`); return; }
  const brief = briefCourse(state.race.course, state.settings);
  const P = state.race.profile;
  const all = brief.climbs.flatMap((c) => [c, ...c.sections]);
  const maxScore = Math.max(...all.map((c) => c.score), 1);
  const crux = all.reduce((a, c) => (c.score > (a ? a.score : -1) ? c : a), null);
  const top = Math.max(...P.map((p) => p[1]));
  const tiles = [
    tile("Distance", `${brief.totalKm.toFixed(1)}<small>km</small>`),
    tile("Elevation gain", `${Math.round(brief.gain)}<small>m D+</small>`, `${Math.round(brief.loss)} m D−`),
    tile("Climbs", `${brief.climbs.length}`, `${brief.descents.length} descents`),
    tile("High point", `${Math.round(top)}<small>m</small>`),
    crux ? tile("Crux", `#${crux.n}`, `km ${crux.startKm.toFixed(1)} · ${Math.round(crux.gain)} m at ${crux.avg.toFixed(1)}%`) : "",
  ].join("");
  const climbRow = (c, sec) => `<div class="row v${c.level} ${sec ? "sec" : ""}">
      <div class="n">${c.n}</div>${cell("Km", kmRange(c))}${cell("Length", len(c.lenM))}${cell("Gain", `${Math.round(c.gain)} m`)}${cell("Average", `${c.avg.toFixed(1)}%`)}${cell("Steepest 100 m", `${Math.round(c.steep)}%`)}${diffCell(c, maxScore)}
    </div>`;
  const climbs = brief.climbs.map((c) => climbRow(c) + c.sections.map((x) => climbRow(x, true)).join("")).join("");
  const descents = brief.descents.map((d) => `<div class="row v${d.level}">
      <div class="n">${d.n}</div>${cell("Km", kmRange(d))}${cell("Length", len(d.lenM))}${cell("Loss", `${Math.round(d.loss)} m`)}${cell("Average", `${Math.abs(d.avg).toFixed(1)}%`)}${cell("Steepest 100 m", `${Math.abs(Math.round(d.steep))}%`)}<div class="diff"><span class="chip l${d.level}">${DESCENT_LABELS[d.level]}</span></div>
    </div>`).join("");
  const aid = parseAidStations(state.settings.aidStations).filter((a) => a.km <= brief.totalKm);
  // With a plan, the zones use your predicted times; before that, a typical runner's (Tobler's hiking function).
  const zones = state.plan ? state.plan.keyZones : keyZones(brief, P, aid, toblerClock(P));
  const view = profileView(P, brief, null, zones);
  box.innerHTML = `
    ${jumps([["b-map", "Map"], ["b-prof", "Profile"], ["b-key", "★ Key zones"], ["b-list", `Climbs and descents`]])}
    <div class="tiles">${tiles}</div>
    <div class="sub-h" id="b-map">Map</div>
    <div class="b-map" id="briefMap"></div>
    <p class="note">Coloured like the profile: climbs by difficulty, dashed red for descents to brake on, a yellow glow on the key zones. Triangles are aid stations, numbers are km. Hover the profile to see where you are on the map.</p>
    <div class="sub-h" id="b-prof">Profile</div>
    <div class="prof-wrap" id="briefProf">${view.html}${LEGEND}</div>
    <div class="sub-h" id="b-key">★ Key zones · where the race is played</div>
    <p class="note" style="margin:-4px 0 12px">${state.plan ? "From your predicted times." : "For a typical runner, until both files are loaded: then from your own predicted times."} ${ZONE_NOTE}</p>
    ${zoneList(zones)}
    <div class="sub-h" id="b-list">Climbs and descents</div>
    <div class="tabs" role="tablist" aria-label="Segments">
      <button type="button" role="tab" data-t="c" aria-selected="${state.btab === "c"}">Climbs · ${brief.climbs.length}</button>
      <button type="button" role="tab" data-t="d" aria-selected="${state.btab === "d"}">Descents · ${brief.descents.length}</button>
    </div>
    <div ${state.btab === "c" ? "" : "hidden"}>
    <p class="note" style="margin:-4px 0 12px">Difficulty = gain × steepness (average ÷ 8%, between 0.5 and 2) × fatigue (1.00 early, 1.15 mid-race, 1.35 late). Climbs of ${(state.settings.splitClimbM / 1000).toFixed(0)} km or more with ${state.settings.splitClimbMinGain} m of gain are split into sections of at least ${(state.settings.sectionMinM / 1000).toFixed(1)} km, each rated on its own.</p>
    <div class="rows">${climbs || empty("No climbs over 10 m.")}</div>
    </div>
    <div ${state.btab === "d" ? "" : "hidden"}>
    <p class="note" style="margin:-4px 0 12px">Brake: a 100 m stretch of 20% or more, or 12% on average. Control: 6% on average, or a 15% stretch. Let it run: everything else.</p>
    <div class="rows">${descents || empty("No descents over 10 m.")}</div>
    </div>`;
  box.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => {
    state.btab = b.dataset.t;
    box.querySelectorAll(".tabs button").forEach((x) => x.setAttribute("aria-selected", String(x === b)));
    const [c, d] = box.querySelectorAll(".tabs ~ div");
    c.hidden = state.btab !== "c";
    d.hidden = state.btab !== "d";
  }));

  briefMap = courseMap($("#briefMap"), { route: state.race.route, totalKm: brief.totalKm, ...mapStyle(brief, aid, zones) });
  // Hover (or touch) the profile: a cursor there, and a dot at the same km on the map.
  const svg = $("#briefProf svg");
  const cur = svg.querySelector(".pcur");
  const show = (ev) => {
    const b = svg.getBoundingClientRect();
    const km = view.km(((ev.clientX - b.left) / b.width) * 1000);
    cur.style.display = "";
    cur.setAttribute("transform", `translate(${view.x(km).toFixed(1)},0)`);
    cur.querySelector("circle").setAttribute("cy", view.y(elevAt(P, km)).toFixed(1));
    briefMap.setRunner(km);
  };
  svg.addEventListener("pointermove", show);
  svg.addEventListener("pointerdown", show);
}

/* ---------- 03 D-day ---------- */
function renderDday() {
  const out = $("#s3body");
  const plan = state.plan;
  if (!plan) {
    out.innerHTML = empty(state.race || state.effort ? `<b>Add the ${state.race ? "run" : "race"} GPX</b> to build your race-day plan.` : `<b>Load both files</b> (or press Try the demo) to build your race-day plan.`);
    return;
  }
  if (!plan.scenarios[state.scenario]) state.scenario = "central";
  const sid = state.scenario;
  const sc = plan.scenarios[sid];
  const st = plan.startSec;
  const brief = { totalKm: plan.course.totalKm, climbs: plan.climbs, descents: plan.descents };
  const aidMarks = plan.aidStations.map((a) => ({ km: a.km, name: a.name, sec: a.arrive[sid] }));

  const seg = SCENARIOS.map((s) => `<button type="button" data-s="${s.id}" aria-pressed="${s.id === sid}">${s.label}<small>${hm(plan.scenarios[s.id].finishSec)}</small></button>`).join("");
  const ckList = sc.checkpoints.map((c) => `<li><span>${esc(c.label)}</span><b>${clock(st, c.sec)} · ${hm(c.sec)}</b></li>`).join("");
  const GEL_WHERE = { top: "top of climb", bottom: "foot of descent", section: "end of a climb section", "before descent": "before the descent", "on the climb": "on the climb, walking" };
  const gelList = sc.gels.map((g) => `<li><span>km ${g.km.toFixed(1)}${g.at ? ` · ${esc(g.at)}` : g.where ? ` · ${GEL_WHERE[g.where]}` : ""}</span><b>${clock(st, g.sec)}</b></li>`).join("") || `<li><span>No gel needed for this length</span><b></b></li>`;
  const hrList = plan.hrGuide ? plan.hrGuide.map((h) => `<li><span>km ${h.fromKm.toFixed(0)} to ${h.toKm.toFixed(0)}</span><b>${esc(h.text)}</b></li>`).join("") : `<li><span>No heart rate in your run</span><b></b></li>`;
  const hikes = plan.climbs.flatMap((c) => [c, ...c.sections]).filter((c) => /^Hike/.test(c.tactic));
  const hikeList = hikes.map((c) => `<li><span>#${c.n} · km ${c.startKm.toFixed(1)}</span><b>${/steep part/.test(c.tactic) ? `${Math.round(c.steep)}% pitch` : `${c.avg.toFixed(0)}%`} · ${clock(st, c.start[sid])}</b></li>`).join("") || `<li><span>None at this threshold</span><b></b></li>`;

  const raceRow = (x, sec, chip) => `<div class="row v${x.level} ${sec ? "sec" : ""}">
      <div class="n">${x.n}</div>${cell("Km", kmRange(x))}${cell("Arrive", clock(st, x.start[sid]))}${cell("Time on it", `${Math.max(1, Math.round(x.dur[sid] / 60))} min`)}${cell("Pace", `${mmss(x.dur[sid] / (x.lenM / 1000))}/km`)}${cell("Tactic", esc(x.tactic), "w")}<div class="diff">${chip}</div>
    </div>`;
  const climbRows = plan.climbs.map((c) => raceRow(c, false, `<span class="chip l${c.level}">${LEVELS[c.level]}</span>`) + c.sections.map((x) => raceRow(x, true, `<span class="chip l${x.level}">${LEVELS[x.level]}</span>`)).join("")).join("");
  const descRows = plan.descents.map((d) => raceRow(d, false, `<span class="chip l${d.level}">${DESCENT_LABELS[d.level]}</span>`)).join("");

  const logKey = `trp.log.${(state.race && state.race.name) || "race"}.${plan.course.totalKm.toFixed(1)}`;
  const logMode = store.get("trp.logMode") || "race";

  out.innerHTML = `
  ${jumps([["d-key", "★ Key zones"], ["d-card", "Race card"], ["d-climbs", "Climb by climb"], ["d-log", "Plan versus actual"], ["d-export", "Export"], ["s4", "▶ Rehearse race day", "go"]])}
  <div class="dday-top">
    ${tile(`Finish · ${sc.label.toLowerCase()}`, clock(st, sc.finishSec), `${hm(sc.finishSec)} on course · start ${clock(st, 0)}`, "big")}
    <div class="panel" style="display:flex;flex-direction:column;gap:12px;justify-content:center">
      <div class="seg" role="group" aria-label="Scenario" id="scen">${seg}</div>
      <p class="note" style="margin:0">Race pace is ${((sc.factor - 1) * 100).toFixed(0)}% slower than your run on the same gradients: terrain factor plus the fade for a longer effort. Every clock time on this page follows the scenario you pick.</p>
    </div>
  </div>
  <div class="prof-wrap">${profileView(plan.course.profile, brief, { ...sc, startSec: st, aid: aidMarks }, plan.keyZones).html}
    <div class="legend" style="margin-top:10px"><span class="note" style="margin:0">Red dots: gels. Triangles: aid stations. Dotted lines: checkpoints. Shaded bands ★: key zones, where the race is played.</span></div>
  </div>

  <div class="sub-h" id="d-key">★ Key zones · where you can make a difference</div>
  ${zoneList(plan.keyZones, (km) => `you get there at ${clock(st, secAtKm(plan, sid, km))}`)}
  <p class="note">${ZONE_NOTE}</p>

  <div class="sub-h" id="d-card">Race card</div>
  <div class="grid">
    <div class="panel card"><h3>Checkpoints</h3><ul class="kv">${ckList}</ul></div>
    ${plan.aidStations.length ? `<div class="panel card"><h3>Aid stations</h3><ul class="kv">${plan.aidStations.map((a) => `<li><span>km ${a.km.toFixed(1)} · ${esc(a.name)}</span><b>${clock(st, a.arrive[sid])}${a.stopMin ? ` → ${clock(st, a.arrive[sid] + a.stopMin * 60)}` : ""}</b></li>`).join("")}</ul><p class="note">Arrival → departure. ${plan.aidStations.reduce((t, a) => t + a.stopMin, 0)} min of stops in total, included in the finish time.</p></div>` : ""}
    <div class="panel card"><h3>Gels</h3><ul class="kv">${gelList}</ul><p class="note">Every ${plan.params.gelEveryMin} min after the last one, taken at an aid station when one is close, else moved off climbs and technical descents. When the top is more than ${plan.params.gelMaxDelayMin} min away, it is taken at a change of slope or while walking.</p></div>
    <div class="panel card"><h3>Heart rate</h3><ul class="kv">${hrList}</ul><p class="note">Before each key zone: on pace with heart rate in the guide, commit to it. Above it, hold and eat, and save it for the next one.</p></div>
    <div class="panel card"><h3>Hike these</h3><ul class="kv">${hikeList}</ul><p class="note">Hiking from ${plan.params.hikeGrade}% (${state.settings.hikeGrade ? "set by you" : plan.effort.hikeGrade ? "learned from your cadence" : "default"}). A climb is hiked when its average is within 2 points of that, or just its steep part when a 100 m stretch reaches it.</p></div>
  </div>

  <div class="sub-h" id="d-climbs">Climb by climb</div>
  <div class="tabs" role="tablist" aria-label="Segments">
    <button type="button" role="tab" data-t="c" aria-selected="${state.tab === "c"}">Climbs</button>
    <button type="button" role="tab" data-t="d" aria-selected="${state.tab === "d"}">Descents</button>
  </div>
  <div class="rows" ${state.tab === "c" ? "" : "hidden"}>${climbRows}</div>
  <div class="rows" ${state.tab === "d" ? "" : "hidden"}>${descRows}</div>

  <div class="sub-h" id="d-log">Plan versus actual</div>
  <div class="panel">
    <div class="actions" style="margin-bottom:8px">
      <label class="f" style="flex-direction:row;align-items:center;gap:8px">Log for
        <select id="logsel" style="width:auto;min-width:200px"><option value="sim" ${logMode === "sim" ? "selected" : ""}>Training simulation</option><option value="race" ${logMode === "race" ? "selected" : ""}>Race day</option></select>
      </label>
      <span class="note" style="margin:0">Saved in this browser only.</span>
    </div>
    <div class="logrow loghead"><span>Checkpoint</span><span>Plan</span><span>Your time</span><span>Gap</span></div>
    <div id="logrows"></div>
    <p class="note">Type the first checkpoint as minutes and seconds if it is under an hour (56:30), the others as hours and minutes (1:55).</p>
  </div>

  <div class="sub-h" id="d-export">Take it with you</div>
  <div class="actions">
    <button class="btn primary" id="copyMd" type="button">Copy plan as Markdown</button>
    <button class="btn" id="copyJson" type="button">Copy as JSON</button>
    <span class="status" id="exportStat" aria-live="polite"></span>
  </div>`;

  /* wiring */
  out.querySelectorAll("#scen button").forEach((b) => b.addEventListener("click", () => { state.scenario = b.dataset.s; store.set("trp.scenario", state.scenario); renderDday(); renderReplay(); renderNav(); }));
  out.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => { state.tab = b.dataset.t; renderDday(); }));
  $("#logsel").addEventListener("change", (ev) => { store.set("trp.logMode", ev.target.value); drawLog(plan, logKey); });
  drawLog(plan, logKey);
  $("#copyMd").addEventListener("click", () => copyText(planToMarkdown(plan, sid)));
  $("#copyJson").addEventListener("click", () => copyText(JSON.stringify(slimPlan(plan, sid), null, 2)));
}

/* ---------- 04 race day replay ---------- */
function renderReplay() {
  const box = $("#s4body");
  const plan = state.plan;
  if (!plan) {
    stopReplay();
    box.innerHTML = empty(`<b>Build your plan first</b> (both files, or press Try the demo), then come back to play your race day.`);
    return;
  }
  const sid = plan.scenarios[state.scenario] ? state.scenario : "central";
  const sc = plan.scenarios[sid];
  const brief = { totalKm: plan.course.totalKm, climbs: plan.climbs, descents: plan.descents };
  const aidMarks = plan.aidStations.map((a) => ({ km: a.km, name: a.name, sec: a.arrive[sid], time: clock(plan.startSec, a.arrive[sid]) }));
  const prof = profileView(plan.course.profile, brief, { ...sc, startSec: plan.startSec, aid: aidMarks }, plan.keyZones);
  mountReplay(box, {
    plan, sid, prof, ...(() => { const m = mapStyle(brief, aidMarks, plan.keyZones); return { mapPaint: m.paint, mapMarks: m.marks }; })(),
    key: `${state.race && state.race.name}|${plan.course.totalKm.toFixed(2)}`,
  });
}

/* ---------- sticky navigation ---------- */
// Which section is on screen: an IntersectionObserver reports when each section crosses a thin
// band across the middle of the viewport, without listening to every scroll event.
function renderNav() {
  const plan = state.plan;
  const ready = { s1: Boolean(state.effort), s2: Boolean(state.race), s3: Boolean(plan), s4: Boolean(plan) };
  document.querySelectorAll(".tn-links a").forEach((a) => a.classList.toggle("ready", ready[a.dataset.sec]));
  const sum = $("#tnSum");
  if (plan) {
    const sc = plan.scenarios[state.scenario] || plan.scenarios.central;
    sum.innerHTML = `<span class="tn-fin"><small>Finish · ${esc(sc.label.toLowerCase())}</small><b>${clock(plan.startSec, sc.finishSec)}</b></span><a class="btn primary sm" href="#s4">▶ Race day</a>`;
  } else sum.innerHTML = `<button class="btn ghost sm" type="button" id="tnDemo">Try the demo</button>`;
  const d = $("#tnDemo");
  if (d) d.addEventListener("click", () => $("#demo").click());
}
(function wireNav() {
  const links = [...document.querySelectorAll(".tn-links a")];
  const setActive = (id) => links.forEach((a) => {
    const on = a.dataset.sec === id;
    a.classList.toggle("on", on);
    // On a narrow screen the links scroll sideways: keep the active one in view.
    const box = a.parentElement;
    if (on && (a.offsetLeft < box.scrollLeft || a.offsetLeft + a.offsetWidth > box.scrollLeft + box.clientWidth)) box.scrollTo({ left: a.offsetLeft - 8 });
  });
  if ("IntersectionObserver" in window) {
    const io = new IntersectionObserver((entries) => {
      entries.forEach((e) => { if (e.isIntersecting) setActive(e.target.id); });
    }, { rootMargin: "-45% 0px -50% 0px" });
    NAV.forEach(([id]) => io.observe($("#" + id)));
  }
  // Reading progress along the page: a thin bar under the navigation.
  const bar = $("#tnProg");
  let queued = false;
  const onScroll = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      const h = document.documentElement.scrollHeight - window.innerHeight;
      bar.style.width = `${h > 0 ? Math.min(100, (window.scrollY / h) * 100) : 0}%`;
      $("#topnav").classList.toggle("stuck", $("#topnav").getBoundingClientRect().top <= 0);
    });
  };
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();
})();

/* ---------- plan vs actual ---------- */
function drawLog(plan, logKey) {
  const mode = $("#logsel").value;
  const key = `${logKey}.${mode}`;
  const saved = store.get(key) || {};
  const sid = state.scenario;
  const cps = plan.scenarios[sid].checkpoints;
  $("#logrows").innerHTML = cps.map((c, i) => {
    const first = i === 0;
    return `<div class="logrow"><span class="lbl">${esc(c.label)}</span><span>${first && c.sec < 3600 ? mmss(c.sec) : hm(c.sec)}</span><input type="text" inputmode="numeric" autocomplete="off" data-i="${i}" placeholder="${first && c.sec < 3600 ? "mm:ss" : "h:mm"}" value="${esc(saved[i] || "")}" aria-label="${esc(c.label)} actual time"><span class="delta" id="gap${i}"></span></div>`;
  }).join("");
  const update = () => {
    $("#logrows").querySelectorAll("input").forEach((inp) => {
      const i = Number(inp.dataset.i);
      const out = $("#gap" + i);
      const short = i === 0 && cps[0].sec < 3600;
      const t = parseDuration(inp.value, short);
      if (t === null) { out.textContent = inp.value ? "Check format" : ""; return; }
      const dlt = t - cps[i].sec;
      const a = Math.abs(Math.round(dlt));
      out.textContent = Math.abs(dlt) < 5 ? "On plan" : `${Math.floor(a / 60)}:${String(a % 60).padStart(2, "0")} ${dlt < 0 ? "ahead" : "behind"}`;
    });
  };
  $("#logrows").querySelectorAll("input").forEach((inp) => {
    inp.addEventListener("input", update);
    inp.addEventListener("change", () => {
      const o = {};
      $("#logrows").querySelectorAll("input").forEach((x) => { o[x.dataset.i] = x.value.trim(); });
      store.set(key, o);
    });
  });
  update();
}

/* ---------- export ---------- */
function slimPlan(plan, sid) {
  return JSON.parse(JSON.stringify({ ...plan, scenarioShown: sid, course: { ...plan.course, profile: undefined, route: undefined } }, (k, v) => (k === "timeline" ? undefined : v)));
}
function setExportStatus(t) { const el = $("#exportStat"); if (el) el.textContent = t; }
function copyText(text) {
  const done = () => setExportStatus("Copied.");
  const fallback = () => {
    const ta = document.createElement("textarea");
    ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy") ? done() : setExportStatus("Could not copy here."); } catch (e) { setExportStatus("Could not copy."); }
    ta.remove();
  };
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, fallback);
  else fallback();
}
compute();
