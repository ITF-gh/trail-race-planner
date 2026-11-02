// main.js: the browser app. Reads two GPX files locally (nothing is uploaded),
// calls the same core modules as the CLI, and draws the result in sections:
//   01 Your engine     what your own runs say about you (effort GPX only)
//   02 Your route      what the course says, before knowing who runs it (race GPX only)
//   03 Your plan       both files plus your settings: clock times, tactics, gels
//   04 Your race       the plan played back in time on the map and profile, to rehearse it
//   05 Your coach      the plan as watch messages (Pimp my GPX)
// Three modes share the page, picked by the switch on top and kept in the address (?mode=):
//   Prep my race  (plan, default)  the sections above, plus a targeted duration to check
//   Prep my run   (?mode=prep)     a GPX of a run to come, given back with details (section s-prep, ui/preprun.js)
//   Rewind my run (?mode=run)      a run you just did, replayed with its key moments (ui/review.js)
// A data-mode attribute on <html> hides what belongs to the other modes (.plan-only,
// .prep-only, .review-only).
// Each section renders as soon as the files it needs are loaded. A sticky bar on top jumps
// between sections and shows which one you are reading.
//
// Where it sits in the data flow:
//   GPX file (dropped or chosen) -> core/track.js parseGpx + resample (one sample every 10 m)
//   -> core/terrain.js analyseCourse (race) and core/effort.js analyseEffort (your runs)
//   -> core/plan.js buildPlan (both together, with the settings form)
//   -> the render* functions below, which write HTML into the page.
// Other UI modules do the heavy drawing: map.js (Leaflet map), replay.js (the rehearsal
// cockpit), watch.js (watch messages and course files), preprun.js, review.js, print.js.
// This file is the conductor: it wires the buttons and inputs and calls compute() whenever
// something changes. The shared `state` lives in appstate.js; the sections are drawn by
// route.js (01, 02) and race.js (03, 04, 05), with the shared building blocks in pieces.js.
//
// Ideas used in this file, in plain words:
// - Template literals: most HTML is built as text with `...${value}...` and then put into the
//   page with element.innerHTML = text. esc() protects any text that came from a file.
// - localStorage: the browser's small key-value store, used to remember settings, the theme,
//   the chosen scenario and the plan-versus-actual times on this device only.
// - Event listeners and event delegation: addEventListener("click", ...) runs a function on a
//   click. A listener on `document` (at the bottom of the file) catches clicks anywhere and then
//   checks what was clicked, so elements drawn later need no listener of their own.
// - SVG: the elevation profile is an SVG drawing built from text. A path's "d" attribute is a
//   list of pen moves: M x,y moves the pen, L x,y draws a straight line, Z closes the shape.
// - IntersectionObserver and requestAnimationFrame: browser tools to react to scrolling cheaply.
// - CustomEvent: this file announces "trp-theme" and "trp-mode" on `document` so other modules
//   can follow a theme or mode change without importing this file.

import { parseGpx, resample } from "../core/track.js";
import { analyseCourse } from "../core/terrain.js";
import { analyseEffort } from "../core/effort.js";
import { PLAN_DEFAULTS, coarseIndices, buildPlan, parseAidStations } from "../core/plan.js";
import { TERRAIN } from "../core/model.js";
import { prepHeroHtml, initPrepRun } from "./preprun.js";
import { hm, parseDuration } from "../core/format.js";
import { raceLegs } from "../core/script.js";
import { stopReplay } from "./replay.js";
import { pauseRun, initRunMode, currentRun, restoreRun } from "./review.js";
import { planSummary } from "../core/saved.js";
import { packTrack, unpackTrack, trackToGpx } from "../core/snapshot.js";
import { runRecord } from "../core/runrecord.js";
import { P4_EXPORTS, initPrint } from "./print.js";
import { initHelp } from "./help.js";
import { SITE, siteFooter } from "../site/site.js";
import { refsCardHtml, initRefs } from "./refs.js";
import { acctSaveGpx, acctOpenAsk, acctSaveRun, acctSaveItem, acctOnReopen, acctOnUseFile, initAccount } from "./account.js";
import { arUse } from "./airace.js";
import { i18nInit } from "./i18n.js";
import { profileSetBands, profileTune } from "./profile.js";
import { analyticsOn, analyticsName, trackEvent, trackOnce, startAnalytics } from "./analytics.js";
import { makeDemoEffortGpx, DEMO_LONG_RUN_PROFILE, DEMO_ULTRA_AID, makeDemoRaceGpx, DEMO_ULTRA_PROFILE } from "../demo.js";
import { store, $, esc, state } from "./appstate.js";
import { segListHtml, wireSegTabs } from "./pieces.js";
import { renderEngine, renderBriefing } from "./route.js";
import { renderDday, renderReplay, renderPimp, renderNav, mountCockpit, raceKey } from "./race.js";

// PEAK: the small mountain logo, as inline SVG text, reused in the hero, the top bar and prep mode.
/* ---------- skeleton ---------- */
const PEAK = `<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M2 27 12 9l5 8 4-5 9 15z" fill="currentColor"/><path d="m12 9 2.6 4.6L12 12l-2 2.2z" fill="#fff" opacity=".85"/></svg>`;
// The logo, the name and the short line beside it, the same in every mode (the line is the site's tagline).
const BRAND = `${PEAK}Prep my race <span class="brand-desc">${SITE.tagline.replace("&", "&amp;")}</span>`;
// Photos come from Pexels (free licence: use and edit allowed, credit appreciated). The files sit
// in src/ui/photos and are copied next to index.html at build; style.css points the slots at them.
// Plan mode keeps the nature and adventure look; "Review a run" mode gets sport shots. No face is
// recognisable in any of them: people are seen from behind, far away or as silhouettes.
/* ---------- Sky mode: a bright theme, blue skies, white and sunrise tones ---------- */
// Night is the default; the choice of Sky is kept in this browser.
const THEME_KEY = "trp.theme";
/** The theme to start with: "sky" if this browser saved it, otherwise "night". */
/**
 * One "Export A4" box per printable section (design review 2): a small fold-out with a tick box per
 * part of the sheet (P4_EXPORTS in ui/print.js; unticked parts are not printed) and the button that
 * opens the print dialog (print, or Save as PDF). `key` is the entry of P4_EXPORTS.
 */
/**
 * "Save to my account" (Boss, 2026-10-18): keeps the computed summary of what is on screen in the
 * online account, only when the runner presses it. `kind` is plan, session or run (core/saved.js).
 */
const saveBox = (kind) => `<div class="savex"><button class="btn sm ghost" type="button" data-save="${kind}">☁ Save to my account</button><span class="savex-msg" role="status"></span></div>`;
function a4Box(key) {
  const ex = P4_EXPORTS[key];
  return `<details class="a4x" data-a4="${key}"><summary><span aria-hidden="true">⎙</span> Export A4</summary>
    <div class="a4x-body"><span class="a4x-h">${ex.label} on A4 paper or as a PDF. Print:</span>
    ${ex.parts.map(([id, label, on]) => `<label class="chk"><input type="checkbox" value="${id}" ${on ? "checked" : ""}> ${label}</label>`).join("")}
    <button class="btn sm primary" type="button" data-a4go="${key}">⎙ Print or save as PDF</button><button class="btn sm ghost" type="button" data-a4save="${key}">☁ Save A4 to my account</button><span class="a4x-msg" role="status"></span></div></details>`;
}
function initialTheme() {
  return store.get(THEME_KEY) === "sky" ? "sky" : "night";
}
/**
 * Apply a theme ("sky" or "night"). Side effects: sets data-theme on <html> (style.css switches
 * its colours on that attribute) and updates the theme button's text, tooltip and aria-pressed
 * (aria-pressed tells screen readers whether a toggle button is on). The button does not exist
 * yet on the first call (the page is built further down), hence the `if (b)`.
 */
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  const b = document.getElementById("themeBtn");
  if (b) { b.textContent = t === "sky" ? "☾ Night" : "☀ Sky mode"; b.setAttribute("aria-pressed", String(t === "sky")); b.title = t === "sky" ? "Back to the night look" : "Switch to the bright sky look"; }
}
// Apply the theme at once, before the page is built, so it does not flash in the wrong colours.
applyTheme(initialTheme());

// PHOTOS: who took each banner photo and its Pexels page, used for the credit links.
// Keys: hero / heroRun / heroRewind (top banner in Prep my race / Prep my run / Rewind my run),
// s1..s6 (section banners).
const PHOTOS = {
  hero: { by: "Artem Meletov", url: "https://www.pexels.com/photo/person-standing-on-mountain-peak-above-clouds-8910505/" },
  heroRun: { by: "Cara Denison", url: "https://www.pexels.com/photo/silhouette-of-jogger-at-sunset-in-park-34730429/" },
  heroRewind: { by: "Boys in Bristol Photography", url: "https://www.pexels.com/photo/silhouette-of-a-man-running-in-a-meadow-against-the-sky-20498424/" },
  s1: { by: "Hobi Photography", url: "https://www.pexels.com/photo/hiker-with-flashlight-looking-at-starry-night-sky-27790902/" },
  s2: { by: "Elina Volkova", url: "https://www.pexels.com/photo/misty-forest-path-in-dense-woodland-29579873/" },
  s3: { by: "Jack Davis", url: "https://www.pexels.com/photo/back-view-of-a-woman-running-up-the-mountain-trail-8949023/" },
  s4: { by: "Lorenzo Castellino", url: "https://www.pexels.com/photo/man-walking-at-a-river-in-mountains-14989443/" },
  s5: { by: "Alin Serban", url: "https://www.pexels.com/photo/trail-runner-in-green-mountain-landscape-30932860/" },
  s6: { by: "Kelly", url: "https://www.pexels.com/photo/black-digital-smartwatch-3999644/" },
};
/** credit(key, cls): the small "Photo: name / Pexels" link for one photo, as HTML text. */
const credit = (key, cls = "") => `<a class="photo-credit${cls ? " " + cls : ""}" href="${PHOTOS[key].url}" target="_blank" rel="noopener">Photo: ${PHOTOS[key].by} / Pexels</a>`;
/**
 * head(num, kicker, title, key): the banner at the top of each section, as HTML text: its number,
 * a one-line kicker, the title and the photo credit. `key` defaults to "s" + the number
 * (Number("01") is 1, so section "01" uses PHOTOS.s1); a key with no photo gives no credit.
 */
const head = (num, kicker, title, key = "s" + Number(num)) => `<header class="sec-head"><div class="sec-num">${num}</div><div class="sec-kicker">${kicker}</div><h2>${title}</h2>${PHOTOS[key] ? credit(key) : ""}</header>`;
// NAV: the links of the sticky top bar, each [section id, number shown, title].
const NAV = [["s1", "01", "Engine"], ["s2", "02", "Route"], ["s3", "03", "Plan"], ["s4", "04", "Race"], ["s-pimp", "05", "Coach"], ["s-prep", "◆", "Prep my run"], ["s5", "▶", "Recap"], ["s6", "▶▶", "Deep dive"]];
/** The modes, in switch order: data-mode value, label, and the class that only it shows. */
const MODES = [["plan", "Prep my race", "plan-only"], ["prep", "Prep my run", "prep-only"], ["run", "Rewind my run", "review-only"]];
/** Which mode class a nav link gets, so it only shows in its own mode (see MODES). */
const navClass = (id) => (id === "s5" || id === "s6" ? "review-only" : id === "s-prep" ? "prep-only" : "plan-only");
// MODE_SEG: the three-button mode switch on top. Each button carries data-mode, which the
// listener near setMode() reads. `.map(...).join("")` turns the list into one HTML string.
const MODE_SEG = `<div class="seg mode-seg" role="group" aria-label="Mode">${MODES.map(([m, label]) => `<button type="button" data-mode="${m}">${label}</button>`).join("")}</div>`;

/*
 * The whole page skeleton, written once into <div id="app"> in index.html. It holds the hero
 * (file drops for each mode), the sticky navigation and one <section> per part of the app,
 * each with an empty "...body" div that the render functions fill later. Classes plan-only,
 * prep-only and review-only make each part show in its own mode only.
 */
$("#app").innerHTML = `
<header class="hero" id="top">
  ${credit("hero", "plan-only")}${credit("heroRun", "prep-only")}${credit("heroRewind", "review-only")}
  <div class="hero-in">
    ${MODE_SEG}
    ${prepHeroHtml(BRAND)}
    <div class="hero-row review-only">
      <div>
        <div class="brand">${BRAND}</div>
        <h1 style="margin-top:14px">Relive the run.<br><em>Learn from it.</em></h1>
        <p class="lead">Drop the run you just did and watch it again at your real pace. See where you flew, where it cost you and what to change next time. Your file never leaves this page.</p>
      </div>
      <button class="btn primary" type="button" data-run-sample>Try a sample run</button>
    </div>
    <div class="drops review-only">
      <div class="drop" id="dropRun">
        <h3><span class="tag">▶</span>Your run</h3>
        <p>The GPX your watch recorded (export it from Garmin Connect, Strava, Suunto, Coros...). Cadence is a bonus; heart rate in the file is ignored.</p>
        <div class="status" id="stRun" aria-live="polite"></div>
        <div class="actions drop-act"><label class="btn ghost" for="fileRun">Add GPX</label><input type="file" id="fileRun" accept=".gpx,application/gpx+xml,text/xml"></div>
      </div>
      ${refsCardHtml("run")}
    </div>
    <div class="hero-row plan-only">
      <div>
        <div class="brand">${BRAND}</div>
        <h1 style="margin-top:14px">Know the course.<br><em>Own the day.</em></h1>
        <p class="lead">Drop a few of your runs and the race GPX: you get a race-day plan built on how you really move, with pace, hikes, gels and aid stations. Rehearse it, put it on your watch, and start the day already knowing it. Your files never leave this page.</p>
      </div>
      <button class="btn primary" id="demo" type="button">Try the demo</button>
    </div>
    <div class="drops plan-only">
      <div class="drop" id="dropEffort">
        <h3><span class="tag">01</span>Your runs</h3>
        <p>One or more recorded runs of 1.5 h or more at a steady effort, with some climbs. Recent runs count more. Cadence is a bonus; heart rate in the file is ignored.</p>
        <div class="status" id="stEffort" aria-live="polite"></div>
        <div class="actions drop-act"><label class="btn ghost" for="fileEffort">Add GPX</label><input type="file" id="fileEffort" multiple accept=".gpx,application/gpx+xml,text/xml"><button class="btn ghost" id="clearRuns" type="button" hidden>Clear</button></div>
      </div>
      <div class="drop" id="dropRace">
        <h3><span class="tag">02</span>The race</h3>
        <p>The official course GPX, with elevation. Drop it here or choose it.</p>
        <div class="status" id="stRace" aria-live="polite"></div>
        <div class="actions drop-act"><label class="btn ghost" for="fileRace">Add GPX</label><input type="file" id="fileRace" accept=".gpx,application/gpx+xml,text/xml"></div>
      </div>
    </div>
  </div>
</header>

<nav class="topnav" id="topnav" aria-label="Sections">
  <div class="topnav-in">
    <a class="tn-brand" href="#top" aria-label="Back to the top menu" title="Back to the top menu">${PEAK}</a>
    <div class="tn-links">${NAV.map(([id, n, t]) => `<a href="#${id}" data-sec="${id}" class="${navClass(id)}${id === "s4" ? " tn-star" : ""}"><b>${n}</b>${t}</a>`).join("")}</div>
    <button class="btn ghost sm tn-theme" type="button" id="themeBtn" aria-pressed="false"></button>
    <div class="tn-sum plan-only" id="tnSum"></div>
    <div class="tn-sum review-only"><span id="tnRun"></span></div>
  </div>
  <div class="tn-prog" aria-hidden="true"><i id="tnProg"></i></div>
</nav>

<section id="s1" class="plan-only">
  ${head("01", "What your runs say about you", "Your engine")}
  <p class="sec-intro">What the planner reads from your own GPX: how fast you move on each gradient, fresh and tired, and how you fade.</p>
  <div id="s1body"></div>
</section>

<section id="s2" class="plan-only">
  ${head("02", "What the route asks, section by section", "Your route")}
  <p class="sec-intro">The course and your race-day settings: start time, terrain, gels and aid stations, then where the climbs and descents are, how hard each one is, and where the long climbs change character.</p>
  <div class="panel">
    <div class="fields">
      <label class="f">Start time<input type="time" id="startTime"></label>
      <label class="f">Race date (optional)<input type="date" id="raceDate"><span class="hint">Sets dusk and dawn at the start line: stretches in the dark are planned ${Math.round(PLAN_DEFAULTS.nightSlow * 100)}% slower.</span></label>
      <label class="f">Targeted duration (optional)<input type="text" id="targetTime" inputmode="numeric" placeholder="h:mm, for example 10:15" autocomplete="off"><span class="hint">The planner says if your runs back it up.</span></label>
      <label class="f">Terrain on race day
        <select id="terrain">${Object.entries(TERRAIN).map(([k, v]) => `<option value="${k}">${esc(v.label)}</option>`).join("")}</select>
      </label>
      <label class="f">Form on race day
        <select id="form"><option value="0">Normal</option><option value="3">In shape (3% faster)</option><option value="5">Top shape (5% faster)</option></select>
        <span class="hint">Your runs set the plan. Tell it if you feel sharper than in training.</span>
      </label>
      <label class="f">Gel every (minutes)<input type="number" id="gelEveryMin" min="20" max="90"></label>
      <label class="f" style="grid-column:1 / -1">Aid stations<textarea id="aidStations" rows="3" placeholder="One per line: km, name, minutes stopped&#10;8.5 Refuge du Lac 2&#10;16 Ferme des Crêtes 3"></textarea><span class="hint">Stops are added to every clock time after the station. A gel due within ${PLAN_DEFAULTS.gelToAidMin} minutes of a station is taken there.</span></label>
    </div>
    <details class="adv">
      <summary>Advanced</summary>
      <div class="fields" style="margin-top:12px">
        <label class="f">Checkpoint every (km)<input type="number" id="checkpointKm" min="2" max="25"></label>
        <label class="f">Hiking threshold (% gradient)<input type="number" id="hikeGrade" min="6" max="30" placeholder="learned from your run"><span class="hint">Leave blank to learn it from your cadence.</span></label>
        <label class="f">Endurance exponent<input type="number" id="enduranceExp" step="0.01" min="0.03" max="0.15"><span class="hint">How fast you fade when the race is longer than your run. ${PLAN_DEFAULTS.enduranceExp} is the default.</span></label>
        <label class="f">Run half-life (days)<input type="number" id="halfLifeDays" min="3" max="365"><span class="hint">With several runs: a run this many days older counts half as much.</span></label>
        <label class="f">Faster on gentle descents (%)<input type="number" id="descentBoost" step="1" min="0" max="10"><span class="hint">Only if your quads can take it. 0 is safe.</span></label>
      </div>
    </details>
  </div>
  <div id="s2body" style="margin-top:22px"></div>
</section>

<section id="s3" class="plan-only">
  ${head("03", "Clock times, pace, gels, where to walk", "Your plan")}
  <p class="sec-intro">What the planner computes from your engine and the route settings: finish time, clock time at every checkpoint, the pace strategy for each climb and descent, when to eat.</p>
  ${a4Box("plan")}
  ${saveBox("plan")}
  <div id="planErr"></div>
  <div id="s3body" style="margin-top:22px"></div>
</section>

<section id="s4" class="plan-only">
  ${head("04", "Run it before you run it", "Your race")}
  <p class="sec-intro">Live the race before you run it. Press play and follow yourself along the course: the clock runs at your predicted pace, and every climb, gel and aid station shows what to do there. Replay it until the plan feels familiar.</p>
  ${a4Box("race")}
  <div id="s4ai"></div>
  <div id="s4body"></div>
</section>

<section id="s-pimp" class="plan-only">
  ${head("05", "Your plan on your wrist", "Your coach", "none")}
  <p class="sec-intro">The race GPX given back with your plan on it: the messages your watch shows along the course (hike here, brake there, the key zones). Check them, edit them, then download the course for your watch.</p>
  <div id="sPimpBody"></div>
</section>

<section id="s-prep" class="prep-only">
  ${head("◆", "Before the run", "Prep my run", "s4")}
  <p class="sec-intro">The run you are about to do, read like a race course: every climb and descent, with the GPX given back carrying those details for your watch.</p>
  ${a4Box("prep")}
  ${saveBox("session")}
  <div id="sPrepBody"><div class="empty">Drop the GPX of your next run above, or try the sample run.</div></div>
</section>

<section id="s5" class="review-only">
  ${head("▶", "After the run", "Rewind my run", "s5")}
  <p class="sec-intro">Your run played back at its real pace. The bar, the map and the profile are coloured by how you ran each stretch compared with your own average on the same kind of ground; each key moment stops the replay and says what it means. Add the time or pace you were aiming for, and the review shows how far you were, where the time went and where to change your effort to reach it.</p>
  ${a4Box("run")}
  ${saveBox("run")}
  <div id="s5body"></div>
</section>

<section id="s6" class="review-only">
  ${head("▶▶", "Go deeper", "Deep dive", "s6")}
  <p class="sec-intro">Everything your watch recorded, turned into numbers and charts you can play with: change a distance or a band width and they redraw; click a point or a row and the replay above jumps there.</p>
  ${a4Box("deep")}
  <div id="s6body"></div>
</section>

<p class="foot plan-only">How it works: your run gives a pace for every gradient band, fresh and tired. Each 10 m of the course takes the pace of its band, sliding from fresh to tired along the race, scaled for terrain and for how much longer the race is than your run. Climbs and descents come from the course elevation, smoothed to ignore GPS noise. A model like this is usually within 5 to 10%: treat the three scenarios as a range, not a promise.</p>
${siteFooter({ analytics: analyticsOn ? analyticsName : "" })}
`;

// FIELDS: the ids of the settings inputs. Each one, when changed, re-reads the form and
// recomputes the plan (see the forEach just after writeSettings()).
/* ---------- settings form ---------- */
const FIELDS = ["startTime", "raceDate", "targetTime", "terrain", "form", "gelEveryMin", "aidStations", "checkpointKm", "hikeGrade", "enduranceExp", "halfLifeDays", "descentBoost"];
/**
 * Fill the settings form from state.settings (used once at start-up, with saved values).
 * `??` (nullish coalescing) gives the right side only when the left is null or undefined, so a
 * missing hiking threshold shows an empty box while a real 0 would stay 0.
 * descentBoost is kept as a fraction (0.05) but shown as a percentage (5).
 * Aid stations can be saved as a list of objects or as the raw text; both are shown as text,
 * one "km name minutes" per line.
 */
function writeSettings() {
  const s = state.settings;
  $("#startTime").value = s.startTime;
  $("#raceDate").value = s.raceDate || "";
  $("#targetTime").value = s.targetTime || "";
  $("#terrain").value = s.terrain;
  $("#form").value = String(s.form || 0);
  $("#gelEveryMin").value = s.gelEveryMin;
  $("#checkpointKm").value = s.checkpointKm;
  $("#hikeGrade").value = s.hikeGrade ?? "";
  $("#enduranceExp").value = s.enduranceExp;
  $("#descentBoost").value = Math.round((s.descentBoost || 0) * 100);
  $("#aidStations").value = Array.isArray(s.aidStations) ? s.aidStations.map((a) => `${a.km} ${a.name} ${a.stopMin}`).join("\n") : s.aidStations || "";
  $("#halfLifeDays").value = s.halfLifeDays;
}
/**
 * Read the settings form back into state.settings and save it in this browser.
 * n(id) reads a number input: parseFloat turns the text into a number, and NaN (empty or not
 * a number) becomes null. `x || 45` falls back to a default when the box is empty (or 0);
 * `??` only when it is null, so the endurance exponent can be set to any valid number.
 * The aid stations stay as raw text here; core/plan.js parseAidStations reads them.
 */
function readSettings() {
  const n = (id) => { const v = parseFloat($("#" + id).value); return Number.isFinite(v) ? v : null; };
  state.settings = {
    ...state.settings,
    startTime: $("#startTime").value || "09:00",
    raceDate: $("#raceDate").value,
    targetTime: $("#targetTime").value.trim(),
    terrain: $("#terrain").value,
    form: Number($("#form").value) || 0,
    gelEveryMin: n("gelEveryMin") || 45,
    checkpointKm: n("checkpointKm") || 10,
    hikeGrade: n("hikeGrade"),
    enduranceExp: n("enduranceExp") ?? PLAN_DEFAULTS.enduranceExp,
    descentBoost: (n("descentBoost") || 0) / 100,
    aidStations: $("#aidStations").value,
    halfLifeDays: n("halfLifeDays") || 28,
  };
  store.set("trp.settings", state.settings);
}
// Put saved settings into the form, then listen to every field: a change re-reads the form,
// counts the event (anonymous analytics) and rebuilds everything. A new half-life changes the
// weight of each run, so the runs are analysed again (setRuns) before compute().
writeSettings();
FIELDS.forEach((id) => $("#" + id).addEventListener("change", () => {
  readSettings();
  trackEvent("setting", id);
  if (id === "halfLifeDays" && state.effort) setRuns(state.effort.runs); else compute();
}));
// Second call, now that the theme button exists, so it gets the right label.
applyTheme(document.documentElement.dataset.theme);
// The theme button flips night <-> sky, saves the choice and tells other modules.
$("#themeBtn").addEventListener("click", () => {
  const t = document.documentElement.dataset.theme === "sky" ? "night" : "sky";
  applyTheme(t); store.set(THEME_KEY, t); trackEvent("theme", t);
  // Maps pick their tiles when they are drawn: redraw so they follow the theme.
  compute();
  document.dispatchEvent(new CustomEvent("trp-theme", { detail: { theme: t } }));
});


/* ---------- files ---------- */
/**
 * Show a status message under a drop box. which: "race" or anything else for the runs box.
 * html: the message (HTML text). ok: true adds the "done" class (style.css marks the box as filled).
 */
function setStatus(which, html, ok) {
  $(which === "race" ? "#stRace" : "#stEffort").innerHTML = html;
  $(which === "race" ? "#dropRace" : "#dropEffort").classList.toggle("done", Boolean(ok));
}

/**
 * Load the race GPX from its text (xml) and a display label (the file name).
 * Steps: 1. parse the GPX points; 2. resample them to one point every 10 m; 3. analyse the
 * course (smoothed elevation, gradient, climbs, descents); 4. keep a lighter copy for drawing:
 * coarseIndices picks a subset of sample indices, giving the profile as [km, altitude m] and
 * the route as [lat, lon]. course.step is the sample spacing in metres, so i * step / 1000 is km.
 * Side effects: sets state.race (or null on error), writes the status line, calls compute().
 */
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
    trackEvent("gpx-error", "race");
    setStatus("race", `<div class="err">${esc(e.message)}</div>`);
  }
  compute();
}

/**
 * Add runs to the reference set. Each new file joins the ones already loaded.
 * files: [{xml, label}]. A file that cannot be parsed is listed as an error and skipped.
 * `[...state.effort.runs]` (spread) copies the array, so the old list is not changed in place.
 */
/** Add runs to the reference set. Each new file joins the ones already loaded. */
function loadEfforts(files) {
  const runs = state.effort ? [...state.effort.runs] : [];
  const bad = [];
  for (const { xml, label } of files) {
    try { const parsed = parseGpx(xml); runs.push({ name: label || parsed.name || `Run ${runs.length + 1}`, parsed }); } catch (e) { bad.push(`${label}: ${e.message}`); trackEvent("gpx-error", "run"); }
  }
  setRuns(runs, bad);
}
/**
 * Replace the whole set of reference runs and analyse them together.
 * runs: [{name, parsed}]; bad: error messages to show (files that failed to load).
 * analyseEffort weighs each run by its age (half-life in days, see docs/HOW_IT_WORKS.md section 3)
 * and returns per-run info (date, km, weight 0..1) plus the pace table by gradient band.
 * Side effects: sets state.effort, shows or hides the Clear button, writes the status, compute().
 */
function setRuns(runs, bad = []) {
  state.effort = null;
  $("#clearRuns").hidden = !runs.length;
  if (runs.length) {
    try {
      const info = analyseEffort(runs.map((r) => r.parsed), { halfLifeDays: state.settings.halfLifeDays });
      state.effort = { runs, info };
      profileSetBands(info.bands);
    } catch (e) { bad.push(e.message); }
  }
  // One status line per run: name, date, distance, and its weight in % when there are several.
  const list = state.effort ? state.effort.info.runs.map((r, i) => `<span class="ok">✓ ${esc(runs[i].name)}</span> · ${r.date} · ${r.distKm.toFixed(1)} km${runs.length > 1 ? ` · weight ${Math.round(r.weight * 100)}%` : ""}`).join("<br>") : "";
  // Your own runs are also kept in the profile (account.js): a line says so, with a link to it.
  const kept = state.effort && state.ownRuns ? `<div class="to-profile-line">Also kept in your <button class="to-profile" type="button" data-open-profile="bests">profile</button>: bests and achievements.</div>` : "";
  setStatus("effort", list + bad.map((b) => `<div class="err">${esc(b)}</div>`).join("") + kept, Boolean(state.effort));
  compute();
}

/**
 * Make a drop box accept files, both by drag and drop and by its "Add GPX" button.
 * boxId / inputId: CSS selectors of the box and of its <input type="file">.
 * loader: called with [{xml, label}] once every file has been read as text.
 * Files are read in the browser (File.text()), nothing is uploaded. Promise.all waits for all
 * the files at once; `await` pauses this async function until they are read. A file that cannot
 * be read gives "" (catch), which parseGpx then reports as an error.
 * The regex /\.gpx$/i matches ".gpx" at the end of the name, any case; it is removed for the label.
 */
function wireDrop(boxId, inputId, loader) {
  const box = $(boxId);
  const input = $(inputId);
  const handle = async (fileList) => {
    const files = [...(fileList || [])];
    if (!files.length) return;
    trackEvent("gpx-upload", boxId === "#dropRace" ? "race" : "run");
    const read = await Promise.all(files.map(async (f) => ({ xml: await f.text().catch(() => ""), label: f.name.replace(/\.gpx$/i, "") })));
    loader(read);
    // Each file also joins My files in the account menu (account.js listens to "trp-gpx").
    read.forEach((r) => document.dispatchEvent(new CustomEvent("trp-gpx", { detail: r })));
    input.value = ""; // so choosing the same file again still triggers a change
  };
  input.addEventListener("change", () => handle(input.files));
  // Drag and drop: preventDefault() on dragover tells the browser this box accepts a drop (the
  // default would be to open the file in the tab). The "over" class highlights the box meanwhile.
  box.addEventListener("dragover", (e) => { e.preventDefault(); box.classList.add("over"); });
  box.addEventListener("dragleave", () => box.classList.remove("over"));
  box.addEventListener("drop", (e) => { e.preventDefault(); box.classList.remove("over"); handle(e.dataTransfer.files); });
}
// The race box takes one file (the first one if several are dropped).
wireDrop("#dropRace", "#fileRace", (files) => loadRace(files[0].xml, files[0].label));
// Your own runs also go into the run log behind the account menu (on this device only).
wireDrop("#dropEffort", "#fileEffort", (files) => { state.ownRuns = true; loadEfforts(files); files.forEach((f) => acctSaveGpx(f.xml, f.label)); });
$("#clearRuns").addEventListener("click", () => { trackEvent("runs-clear"); state.ownRuns = false; setRuns([]); });

// "Try the demo": load made-up runs and a made-up race from src/demo.js, as if they were dropped.
$("#demo").addEventListener("click", () => {
  trackEvent("demo");
  // A made-up mountain ultra (78 km, 3,800 m up, seven aid stations) and two made-up 30 km
  // mountain long runs six weeks apart, so the weighting shows. Aid stations and start time
  // are filled in unless you typed your own.
  state.effort = null;
  state.ownRuns = false;
  loadEfforts([
    { xml: makeDemoEffortGpx({ profile: DEMO_LONG_RUN_PROFILE, startIso: "2026-10-11T07:00:00Z" }), label: "Demo mountain long run (made up)" },
    { xml: makeDemoEffortGpx({ profile: DEMO_LONG_RUN_PROFILE, fatigue: 0.3, startIso: "2026-08-30T07:00:00Z" }), label: "Demo older long run (made up)" },
  ]);
  // Only fill the demo aid stations when the box is empty or still holds this example text
  // (the same two stations as the placeholder), so stations you typed are never overwritten.
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

/**
 * compute(): the heart of the page. Build the plan if both files are there, then redraw every
 * plan-mode section. Called after any change (file loaded, setting changed, theme changed).
 * Each render function draws an "empty" hint when what it needs is missing.
 */
/* ---------- compute ---------- */
function compute() {
  state.plan = null;
  $("#planErr").innerHTML = "";
  if (state.race && state.effort) {
    try {
      // Your runs alone set the level (Boss, 2026-10-29: a road best can be old and says nothing
      // of the training around it); "Form on race day" (settings.form) is your own say.
      state.plan = buildPlan(state.race.parsed, state.effort.runs.map((r) => r.parsed), { ...state.settings, ...profileHeart(), tune: profileTune() });
      // The regex /\(made up\)$/ matches "(made up)" at the end of the name: the demo's label.
      // Once per visit: did this visitor get a plan, from the demo or from their own files?
      trackOnce("plan-built", /\(made up\)$/.test(state.race.name) ? "demo" : "own");
    } catch (e) {
      $("#planErr").innerHTML = `<div class="err">${esc(e.message)}</div>`;
    }
  }
  renderEngine();
  renderBriefing();
  renderDday();
  renderReplay();
  renderPimp();
  renderNav();
}
// The switch's buttons and links (event delegation on the bar, drawn again at every render).
$("#s4ai").addEventListener("click", (ev) => {
  const b = ev.target.closest("[data-ar]");
  if (!b) return;
  const what = b.dataset.ar;
  if (what === "ask") { acctOpenAsk(); return; }
  state.aiOn = what === "ai";
  store.set("trp.ai.on", state.aiOn);
  trackEvent("ai-switch", what);
  renderReplay();
});
// An AI doc to play (a new answer, or one picked in the account menu's AI docs): Your race
// plays it, with the AI switch on.
document.addEventListener("trp-ai-use", (ev) => {
  // Prep my run docs are played by preprun.js.
  if (ev.detail && ev.detail.mode === "prep_run") return;
  arUse(ev.detail);
  if (!state.plan) return;
  state.aiOn = true;
  store.set("trp.ai.on", true);
  renderReplay();
});
// wireNav runs once at start-up: (function () { ... })() is a function called at once, which
// keeps its variables (links, bar, queued) private instead of adding them to the whole file.
(function wireNav() {
  const links = [...document.querySelectorAll(".tn-links a")];
  links.forEach((a) => a.addEventListener("click", () => trackEvent("nav", a.dataset.sec)));
  // setActive(id): highlight the link of the section being read.
  const setActive = (id) => links.forEach((a) => {
    const on = a.dataset.sec === id;
    a.classList.toggle("on", on);
    // On a narrow screen the links scroll sideways: keep the active one in view.
    const box = a.parentElement;
    if (on && (a.offsetLeft < box.scrollLeft || a.offsetLeft + a.offsetWidth > box.scrollLeft + box.clientWidth)) box.scrollTo({ left: a.offsetLeft - 8 });
  });
  // IntersectionObserver: the browser calls back when an observed element enters or leaves an
  // area. rootMargin "-45% 0px -50% 0px" shrinks that area to a band from 45% to 50% down the
  // window, so a section becomes "active" when it crosses the middle of the screen.
  // The `in window` check skips it on very old browsers that lack it.
  if ("IntersectionObserver" in window) {
    const io = new IntersectionObserver((entries) => {
      // Which sections a visit actually reaches, counted once each per visit.
      entries.forEach((e) => { if (e.isIntersecting) { setActive(e.target.id); trackOnce("section-reached", e.target.id); } });
    }, { rootMargin: "-45% 0px -50% 0px" });
    NAV.forEach(([id]) => io.observe($("#" + id)));
  }
  // Reading progress along the page: a thin bar under the navigation.
  const bar = $("#tnProg");
  // Scroll events fire many times per frame. `queued` plus requestAnimationFrame (run once before
  // the next screen paint) makes sure the bar is updated at most once per frame (throttling).
  let queued = false;
  const onScroll = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      // Progress in % = how far down / how far it can go (page height minus window height).
      const h = document.documentElement.scrollHeight - window.innerHeight;
      bar.style.width = `${h > 0 ? Math.min(100, (window.scrollY / h) * 100) : 0}%`;
      // "stuck": the bar has reached the top of the window (it is position: sticky in style.css).
      $("#topnav").classList.toggle("stuck", $("#topnav").getBoundingClientRect().top <= 0);
    });
  };
  // passive: true promises the listener never calls preventDefault, so scrolling stays smooth.
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();
})();
/* ---------- mode: prep my race, prep my run, check my run ---------- */
// The mode lives in the address (?mode=prep or ?mode=run; none for Prep my race), so a link or a
// refresh opens the same one. Other modules can follow the switch through the "trp-mode" event.
// modeOf(m): m if it is one of the three mode ids, else "plan". some() is true if any item matches.
const modeOf = (m) => (MODES.some(([id]) => id === m) ? m : "plan");
/**
 * Switch the page to a mode ("plan", "prep" or "run"). track: count the switch in analytics
 * (false for the first call at start-up). Side effects: sets data-mode on <html> (CSS then
 * shows only that mode's parts), presses the right switch button, stops or starts the
 * animations, rewrites the address and fires a "trp-mode" event for other modules.
 */
function setMode(mode, track = true) {
  const m = modeOf(mode);
  document.documentElement.dataset.mode = m;
  document.querySelectorAll("button[data-mode]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.mode === m)));
  // One cockpit plays at a time (replay.js keeps a single animation and map), and its ids are
  // fixed: leaving Prep my race empties the race one, renderReplay builds it again on the way back.
  if (m !== "plan") { stopReplay(); $("#s4body").innerHTML = ""; }
  if (m !== "run") pauseRun();
  if (m === "plan") renderReplay();
  // history.replaceState changes the address bar without reloading or adding a Back step.
  try {
    const u = new URL(window.location.href);
    if (m === "plan") u.searchParams.delete("mode"); else u.searchParams.set("mode", m);
    window.history.replaceState(null, "", u);
  } catch (e) { /* file:// or a sandboxed frame */ }
  document.dispatchEvent(new CustomEvent("trp-mode", { detail: { mode: m } }));
  if (track) trackEvent("mode", m);
}
// Every button with data-mode (the switch on top and the shortcuts in the bar) switches mode.
document.querySelectorAll("button[data-mode]").forEach((b) => b.addEventListener("click", () => { setMode(b.dataset.mode); window.scrollTo({ top: 0 }); }));
// Rewind my run mode (ui/review.js). When a run is loaded: save it in the run log (not the
// sample) and say so at the top of the review, with a link to the profile and any all-time best
// it beats; then put a button with its distance and duration in the top bar.
initRunMode({ onLoaded: (run, { sample, name } = {}) => {
  if (!sample) {
    acctSaveRun(run, name).then((r) => {
      const body = $("#s5body");
      if (!r || !body) return;
      const what = r.count === 1 ? "your first run there" : r.bests.length ? `new best: ${r.bests.join(", ")}!` : `${r.count} runs`;
      body.querySelectorAll(".to-profile-line").forEach((el) => el.remove());
      body.insertAdjacentHTML("afterbegin", `<div class="to-profile-line${r.bests.length ? " best" : ""}">Saved to your profile · ${esc(what)} <button class="to-profile" type="button" data-open-profile="bests">See my profile</button></div>`);
    });
  }
  $("#tnRun").innerHTML = `<a class="btn primary sm" href="#rvCockpit">▶ ${run.totalKm.toFixed(1)} km · ${hm(run.elapsedSec)}</a>`;
  renderNav();
} });

/* ---------- Save to my account: the whole mode, to reopen it later and still work ---------- */
// One Save button per mode (Boss, 2026-10-18: "like saving the page"). A save keeps:
//   summary   the numbers shown in the Account window list (core/saved.js, or the run summary)
//   snap      what the mode needs to compute everything again: the points it read (packed by
//             core/snapshot.js, never the file itself and never heart rate) and its settings,
//             gzipped and written as base64 text
// Reopening feeds the points back through each mode's own loader, as if the files were dropped,
// so the target, the settings and the scenario can all be changed again.

// gzip a value (as JSON) into base64 text, and back. CompressionStream is the browser's built-in
// gzip; base64 turns the bytes into plain text the database can hold.
async function gzPack(value) {
  const stream = new Blob([JSON.stringify(value)]).stream().pipeThrough(new CompressionStream("gzip"));
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  let bin = "";
  // String.fromCharCode in chunks: one call per byte would be slow, one call for all can overflow.
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
async function gzUnpack(b64) {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return JSON.parse(await new Response(stream).text());
}
// Settings worth keeping with a race plan: everything of the form, never heart rates (those
// come from the profile and stay in the browser).
const keepSettings = (s) => { const { maxHr, restHr, ...rest } = s; return rest; };

// What each mode saves: { kind, title, summary, snap }, or null when nothing is loaded.
function saveItem(kind) {
  if (kind === "plan") {
    if (!state.plan || !state.race || !state.effort) return null;
    const name = state.race.name || "Race";
    return { kind, title: name, summary: planSummary(state.plan, { name, targetSec: parseDuration(state.settings.targetTime) }),
      snap: { mode: "plan", race: { label: name, track: packTrack(state.race.parsed) }, runs: state.effort.runs.map((r) => ({ label: r.name, track: packTrack(r.parsed) })), settings: keepSettings(state.settings), scenario: state.scenario } };
  }
  if (kind === "session") {
    const c = prepCtl && prepCtl.current();
    return c ? { kind, title: c.name || "Run", summary: planSummary(c.plan, { name: c.name, targetSec: c.targetSec || null }),
      snap: { mode: "prep", label: c.name, track: packTrack(c.parsed), targetSec: c.targetSec || 0 } } : null;
  }
  const r = currentRun();
  if (!r) return null;
  const rec = runRecord(r.run, r.name);
  return { kind, title: rec.name, summary: rec, snap: { mode: "run", label: r.name, track: packTrack(r.parsed), target: r.target || null } };
}
// Save the mode (`kind`) from button `b`, its message in `msg`. `a4` ({key, keep}, or none): an
// A4 export saved to the account (Boss, 2026-10-23): the same save plus the export and its ticked
// parts, so reopening it lays the sheet out again and opens the print dialog. The sheet is rebuilt
// from the points, never stored as a page, so heart rate and weight never go online.
async function saveFrom(b, msg, kind, a4 = null) {
  let item = null;
  try { item = saveItem(kind); } catch (e) { item = null; }
  if (!item) { msg.textContent = kind === "plan" ? "Nothing to save yet: load your runs and the race first." : "Nothing to save yet: load a GPX first."; return; }
  b.disabled = true;
  msg.textContent = "Saving…";
  const title = a4 ? `A4 · ${item.title}`.slice(0, 80) : item.title;
  let r;
  try { r = await acctSaveItem({ kind: item.kind, title, data: { v: 2, summary: item.summary, snap: await gzPack(item.snap), ...(a4 ? { a4 } : {}) } }); }
  catch (e) { r = { msg: `Could not save: ${e.message}` }; }
  b.disabled = false;
  msg.textContent = r.msg;
}
document.querySelectorAll("[data-save]").forEach((b) => b.addEventListener("click", () => saveFrom(b, b.parentElement.querySelector(".savex-msg"), b.dataset.save)));
// The save kind of each A4 export's mode.
const A4_KIND = { plan: "plan", prep: "session", run: "run" };
// Reopen a saved item (the Account window's list): switch to its mode and load it back.
acctOnReopen(async (it) => {
  const s = await gzUnpack(it.data.snap);
  if (s.mode === "plan") {
    setMode("plan");
    state.settings = { ...PLAN_DEFAULTS, ...s.settings };
    store.set("trp.settings", state.settings);
    writeSettings();
    if (s.scenario) { state.scenario = s.scenario; store.set("trp.scenario", s.scenario); }
    state.ownRuns = false;
    setRuns(s.runs.map((x) => ({ name: x.label, parsed: unpackTrack(x.track) })));
    loadRace(trackToGpx(unpackTrack(s.race.track)), s.race.label);
    $("#s3").scrollIntoView({ behavior: "smooth", block: "start" });
  } else if (s.mode === "prep") {
    setMode("prep");
    prepCtl.restore(trackToGpx(unpackTrack(s.track)), s.label, s.targetSec);
  } else {
    setMode("run");
    restoreRun(trackToGpx(unpackTrack(s.track)), s.label, s.target);
  }
  trackEvent("saved-reopen", s.mode);
  // A saved A4 export: once the mode has its data again (computed in the background, so ask every
  // 200 ms, for 10 s at most), print its sheet with the parts ticked when it was saved.
  const a4 = it.data.a4;
  if (a4 && P4_EXPORTS[a4.key]) {
    for (let i = 0; i < 50 && !printData(P4_EXPORTS[a4.key].mode); i++) await new Promise((ok) => setTimeout(ok, 200));
    if (printData(P4_EXPORTS[a4.key].mode)) printA4(a4.key, Array.isArray(a4.keep) ? a4.keep : null);
  }
});

// Use a file from My files (account menu) in a mode, as if it had been dropped there:
//   race    the race course of Prep my race
//   prep    the route of a Prep my run session
//   rewind  the run replayed in Rewind my run
acctOnUseFile((xml, label, use) => {
  if (use === "race") {
    setMode("plan");
    loadRace(xml, label);
    $("#dropRace").scrollIntoView({ behavior: "smooth", block: "center" });
  } else if (use === "prep") {
    setMode("prep");
    prepCtl.restore(xml, label);
  } else {
    setMode("run");
    restoreRun(xml, label);
  }
});

/* ---------- export A4 (ui/print.js): the mode on screen, laid out for paper ---------- */
// prepCtl: the controller returned by initPrepRun below; null until then.
let prepCtl = null;
/**
 * What the A4 export needs for a mode, or null when there is nothing to print yet.
 * run: the reviewed run plus the athlete details saved in this browser; prep: the run to come;
 * plan: the plan, the scenario shown, the race name, the runs and the settings.
 */
function printData(mode) {
  if (mode === "run") {
    const r = currentRun();
    return r ? { ...r, athlete: store.get("trp.athlete") || {} } : null;
  }
  if (mode === "prep") return prepCtl ? prepCtl.current() : null;
  if (!state.plan) return null;
  const sid = state.plan.scenarios[state.scenario] ? state.scenario : "central";
  return { plan: state.plan, sid, raceName: (state.race && state.race.name) || "Race", effort: state.effort, settings: state.settings };
}
// initPrint (ui/print.js) returns the function that lays out and prints the current mode.
const printA4 = initPrint({ collect: printData });
// The Export A4 boxes: print the ticked parts of that section's sheet, or say what to load first.
document.querySelectorAll("[data-a4go]").forEach((b) => b.addEventListener("click", () => {
  const key = b.dataset.a4go;
  const box = b.closest(".a4x");
  const msg = box.querySelector(".a4x-msg");
  if (!printData(P4_EXPORTS[key].mode)) { msg.textContent = "Nothing to export yet: load a GPX first."; return; }
  const keep = [...box.querySelectorAll("input:checked")].map((i) => i.value);
  msg.textContent = "";
  trackEvent("export", `a4-${key}`);
  printA4(key, keep);
}));
// Save A4 to my account: the mode, plus which export and which parts.
document.querySelectorAll("[data-a4save]").forEach((b) => b.addEventListener("click", () => {
  const key = b.dataset.a4save;
  const box = b.closest(".a4x");
  saveFrom(b, box.querySelector(".a4x-msg"), A4_KIND[P4_EXPORTS[key].mode], { key, keep: [...box.querySelectorAll("input:checked")].map((i) => i.value) });
}));
// The profile's heart rates changed (account window): redraw the plan, its heart-rate guide uses them.
document.addEventListener("trp-profile", () => { if (state.race) compute(); });
// Your references changed (My references card, ui/refs.js): plan again at the new level.
document.addEventListener("trp-refs", () => { if (state.race) compute(); });

// Start-up, in order: draw the empty sections, start Prep my run (it can reuse your reference
// runs and settings, and draws its own cockpit through mountCockpit), apply the mode from the
// address (?mode=...), then start anonymous analytics and the account menu.
initRefs();
compute();
prepCtl = initPrepRun({ getRuns: () => (state.effort ? state.effort.runs.map((r) => r.parsed) : []), getSettings: () => state.settings, onLoaded: () => renderNav(), cockpit: (box, plan, key, timeline) => mountCockpit(box, plan, "central", key, "Run", timeline),
  // Prep my run's climbs and descents: the same tables as Your route, with their own open tab.
  segments: (box, plan) => {
    box.innerHTML = segListHtml({ climbs: plan.climbs, descents: plan.descents, minClimb: plan.course.minClimb }, plan.course.profile, state.ptab, plan.params.splitClimbM, "run");
    wireSegTabs(box, (t) => { state.ptab = t; trackEvent("prep-segments-tab", t === "c" ? "climbs" : "descents"); });
  } });
setMode(new URLSearchParams(window.location.search).get("mode"), false);
// Not in a copy opened as a file (the AI test copy): no outside script on a page holding a key.
if (location.protocol !== "file:") startAnalytics();
// The Ask the AI window (account.js) reads the race being prepared through this function: the
// race GPX (name, km, climbing, sections once the plan exists, aid stations typed), how many GPX
// files are in Your runs, the target time typed and the calculated central finish time.
initAccount({
  getRace: () => ({
    race: state.race ? {
      name: state.race.name, km: state.race.course.totalKm, gain: state.race.course.gain,
      legs: state.plan ? raceLegs(state.plan, "central").length : state.race.course.climbs.length + state.race.course.descents.length,
      aid: parseAidStations(state.settings.aidStations).length,
    } : null,
    gpxRuns: state.effort ? state.effort.runs.length : 0,
    targetText: state.settings.targetTime || "",
    centralSec: state.plan ? state.plan.scenarios.central.finishSec : null,
    // The race key the AI docs are filed under (the same as Your race's).
    key: state.plan ? raceKey() : null,
    // The whole plan, for the local AI test (ailocal.js builds the AI input from it).
    plan: state.plan,
  }),
  // The Ask the AI coach window (Prep my run) reads the run to come through this one.
  getRun: () => {
    const c = prepCtl && prepCtl.current();
    return c ? { name: c.name, km: c.plan.course.totalKm, gain: c.plan.course.gain, climbs: c.plan.climbs.filter((x) => !x.bump).length, spots: c.spots, plan: c.plan, key: c.key } : null;
  },
});
initHelp();
// English or French (flags next to the account button; i18n.js swaps the texts).
i18nInit(document.querySelector(".acct"));

// This is event delegation: one listener on the whole document handles every jump link, even
// the ones drawn after start-up. closest() climbs from the clicked element to the nearest
// ancestor (or itself) matching the selector; "a[href^='#']" means a link whose href starts with #.
// A jump link to a folded section opens it first, so the link lands on something to read.
document.addEventListener("click", (ev) => {
  const a = ev.target.closest && ev.target.closest(".jumps a[href^='#']");
  if (!a) return;
  const t = document.getElementById(a.getAttribute("href").slice(1));
  const fold = t && (t.matches("details") ? t : t.closest("details"));
  if (fold) fold.open = true;
});

// Also delegated. Clicks on links, buttons and <summary> are left alone. The heading's following
// siblings get "fold-hid" (hidden by style.css): for a sub-title, up to the next sub-title, fold or
// Pimp my GPX sticker; for a section banner, everything after it in the section.
// Click a section banner or a sub-title (the red-bar headings) to fold what it heads, click again to unfold.
document.addEventListener("click", (ev) => {
  if (ev.target.closest("a, button, summary")) return;
  const h = ev.target.closest(".sec-head, .sub-h");
  if (!h || h.matches("summary")) return;
  const folded = h.classList.toggle("folded");
  h.setAttribute("aria-expanded", String(!folded));
  for (let n = h.nextElementSibling; n; n = n.nextElementSibling) {
    if (h.matches(".sub-h") && (n.matches(".sub-h") || n.matches("details.fold") || n.matches(".pimp-link"))) break;
    n.classList.toggle("fold-hid", folded);
  }
  trackEvent("fold-title", folded ? "close" : "open");
});
