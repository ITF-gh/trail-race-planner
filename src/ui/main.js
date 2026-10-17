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
// This file is the conductor: it owns the shared `state` object, wires the buttons and
// inputs, and calls compute() whenever something changes.
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
import { buildPlan, judgeTarget, briefCourse, coarseIndices, parseAidStations, PLAN_DEFAULTS, LEVELS, STARS, DESCENT_LABELS } from "../core/plan.js";
import { TERRAIN, SCENARIOS } from "../core/model.js";
import { planToMarkdown } from "../core/markdown.js";
import { watchPanelHtml, mountWatch, watchPoints, downloadCourse, pimpBadge } from "./watch.js";
import { prepHeroHtml, initPrepRun } from "./preprun.js";
import { mmss, hm, clock, parseDuration } from "../core/format.js";
import { keyZones, toblerClock } from "../core/keyzones.js";
import { secAtKm, raceLegs } from "../core/script.js";
import { courseMap } from "./map.js";
import { mountReplay, stopReplay } from "./replay.js";
import { initRunMode, pauseRun, currentRun } from "./review.js";
import { initPrint, P4_EXPORTS } from "./print.js";
import { initHelp } from "./help.js";
import { siteFooter } from "../site/site.js";
import { initAccount, acctSaveRun, acctSaveGpx, acctOpenAsk, acctAiBadge } from "./account.js";
import { arUse, arState, arBarHtml } from "./airace.js";
import { startAnalytics, trackEvent, trackOnce, analyticsOn, analyticsName } from "./analytics.js";
import { makeDemoRaceGpx, makeDemoEffortGpx, DEMO_ULTRA_PROFILE, DEMO_ULTRA_AID, DEMO_LONG_RUN_PROFILE } from "../demo.js";

/**
 * $(selector, root): a short name for root.querySelector(selector), which returns the first
 * element matching a CSS selector ("#id", ".class", "div > a"...) or null if none matches.
 * `r = document` is a default parameter: search the whole page unless a root is given.
 */
const $ = (s, r = document) => r.querySelector(s);
/**
 * esc(text): makes text safe to put inside HTML. It replaces the four characters that HTML
 * treats as markup (& < > ") by their entity codes (&amp; &lt; &gt; &quot;).
 * The regex /[&<>"]/g matches any one of those four characters; the `g` flag means every
 * occurrence, not just the first. Used on anything that came from a file or the user (race
 * names, aid station names), so a name like "<b>" shows as text instead of becoming markup.
 */
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/**
 * store: a thin wrapper around localStorage (text-only storage kept by the browser for this
 * site). Values are turned into text with JSON.stringify on the way in and back with JSON.parse
 * on the way out, so objects and numbers survive. Both calls are wrapped in try/catch because
 * storage can be blocked (private browsing, strict settings): then get() returns null and set()
 * silently does nothing, and the app still works, it just forgets on reload.
 */
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k) || "null"); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage can be blocked */ } },
};

/**
 * state: everything the page currently knows, in one object. The render* functions read it;
 * the event handlers change it and then call compute() or a render function.
 *   race      the loaded race GPX: name, parsed points, course analysis, a light profile
 *             [[km, altitude m], ...] and route [[lat, lon], ...] for drawing.
 *   effort    your reference runs and what analyseEffort learned from them (`info`).
 *   settings  the settings form. `{ ...A, ...B }` (spread) copies A's fields, then B's on top:
 *             the defaults from plan.js, overridden by what was saved in this browser.
 *   scenario  which of the three scenarios is shown: "best", "central" or "cautious".
 *   plan      the result of buildPlan, or null until both files are loaded.
 * (state.foldClimbs is also set later, by renderDday, to remember if "Climb by climb" is open.)
 */
const state = {
  race: null, // {name, parsed, course, profile}
  effort: null, // {runs: [{name, parsed}], info}
  settings: { ...PLAN_DEFAULTS, ...(store.get("trp.settings") || {}) },
  scenario: store.get("trp.scenario") || "central",
  tab: "c", // D-day list: climbs or descents
  kz: null, // Your plan: the open key zone chip (index in plan.keyZones), or null
  btab: "c", // briefing list: climbs or descents
  bwin: null, // briefing profile zoom window [fromKm, toKm], null = whole course
  plan: null,
  aiOn: store.get("trp.ai.on") === true, // Your race shows the AI plan (when there is one)
};

// PEAK: the small mountain logo, as inline SVG text, reused in the hero, the top bar and prep mode.
/* ---------- skeleton ---------- */
const PEAK = `<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M2 27 12 9l5 8 4-5 9 15z" fill="currentColor"/><path d="m12 9 2.6 4.6L12 12l-2 2.2z" fill="#fff" opacity=".85"/></svg>`;
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
function a4Box(key) {
  const ex = P4_EXPORTS[key];
  return `<details class="a4x" data-a4="${key}"><summary><span aria-hidden="true">⎙</span> Export A4</summary>
    <div class="a4x-body"><span class="a4x-h">${ex.label} on A4 paper or as a PDF. Print:</span>
    ${ex.parts.map(([id, label, on]) => `<label class="chk"><input type="checkbox" value="${id}" ${on ? "checked" : ""}> ${label}</label>`).join("")}
    <button class="btn sm primary" type="button" data-a4go="${key}">⎙ Print or save as PDF</button><span class="a4x-msg" role="status"></span></div></details>`;
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
// s1..s5 (section banners).
const PHOTOS = {
  hero: { by: "Artem Meletov", url: "https://www.pexels.com/photo/person-standing-on-mountain-peak-above-clouds-8910505/" },
  heroRun: { by: "Cara Denison", url: "https://www.pexels.com/photo/silhouette-of-jogger-at-sunset-in-park-34730429/" },
  heroRewind: { by: "Boys in Bristol Photography", url: "https://www.pexels.com/photo/silhouette-of-a-man-running-in-a-meadow-against-the-sky-20498424/" },
  s1: { by: "Hobi Photography", url: "https://www.pexels.com/photo/hiker-with-flashlight-looking-at-starry-night-sky-27790902/" },
  s2: { by: "Elina Volkova", url: "https://www.pexels.com/photo/misty-forest-path-in-dense-woodland-29579873/" },
  s3: { by: "Jack Davis", url: "https://www.pexels.com/photo/back-view-of-a-woman-running-up-the-mountain-trail-8949023/" },
  s4: { by: "Lorenzo Castellino", url: "https://www.pexels.com/photo/man-walking-at-a-river-in-mountains-14989443/" },
  s5: { by: "Alin Serban", url: "https://www.pexels.com/photo/trail-runner-in-green-mountain-landscape-30932860/" },
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
    ${prepHeroHtml(PEAK)}
    <div class="hero-row review-only">
      <div>
        <div class="brand">${PEAK}Prep my race <span class="brand-desc">Prep &amp; go</span></div>
        <h1 style="margin-top:14px">Relive the run.<br><em>Learn from it.</em></h1>
        <p class="lead">Drop the run you just did and watch it again at your real pace. See where you flew, where it cost you and what to change next time. Your file never leaves this page.</p>
      </div>
      <button class="btn primary" type="button" data-run-sample>Try a sample run</button>
    </div>
    <div class="drops review-only">
      <div class="drop" id="dropRun">
        <h3><span class="tag">▶</span>Your run</h3>
        <p>The GPX your watch recorded (export it from Garmin Connect, Strava, Suunto, Coros...). Cadence is a bonus; heart rate in the file is ignored.</p>
        <div class="actions"><label class="btn ghost" for="fileRun">Choose GPX</label><input type="file" id="fileRun" accept=".gpx,application/gpx+xml,text/xml"></div>
        <div class="status" id="stRun" aria-live="polite"></div>
      </div>
    </div>
    <div class="hero-row plan-only">
      <div>
        <div class="brand">${PEAK}Prep my race <span class="brand-desc">Prep &amp; go</span></div>
        <h1 style="margin-top:14px">Know the course.<br><em>Own the day.</em></h1>
        <p class="lead">Drop a few of your runs and the race GPX: you get a race-day plan built on how you really move, with pace, hikes, gels and aid stations. Rehearse it, put it on your watch, and start the day already knowing it. Your files never leave this page.</p>
      </div>
      <button class="btn primary" id="demo" type="button">Try the demo</button>
    </div>
    <div class="drops plan-only">
      <div class="drop" id="dropEffort">
        <h3><span class="tag">01</span>Your runs</h3>
        <p>One or more recorded runs of 1.5 h or more at a steady effort, with some climbs. Recent runs count more. Cadence is a bonus; heart rate in the file is ignored.</p>
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
      <label class="f">Targeted duration (optional)<input type="text" id="targetTime" inputmode="numeric" placeholder="h:mm, for example 10:15" autocomplete="off"><span class="hint">The planner says if your runs back it up.</span></label>
      <label class="f">Terrain on race day
        <select id="terrain">${Object.entries(TERRAIN).map(([k, v]) => `<option value="${k}">${esc(v.label)}</option>`).join("")}</select>
      </label>
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
  </div>
  <div id="s2body" style="margin-top:22px"></div>
</section>

<section id="s3" class="plan-only">
  ${head("03", "Clock times, pace, gels, where to walk", "Your plan")}
  <p class="sec-intro">What the planner computes from your engine and the route settings: finish time, clock time at every checkpoint, the pace strategy for each climb and descent, when to eat.</p>
  ${a4Box("plan")}
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
  <div id="sPrepBody"><div class="empty">Drop the GPX of your next run above, or try the sample run.</div></div>
</section>

<section id="s5" class="review-only">
  ${head("▶", "After the run", "Rewind my run", "s5")}
  <p class="sec-intro">Your run played back at its real pace. The bar, the map and the profile are coloured by how you ran each stretch compared with your own average on the same kind of ground; each key moment stops the replay and says what it means. Add the time or pace you were aiming for, and the review shows how far you were, where the time went and where to change your effort to reach it.</p>
  ${a4Box("run")}
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
const FIELDS = ["startTime", "targetTime", "terrain", "gelEveryMin", "aidStations", "checkpointKm", "hikeGrade", "enduranceExp", "halfLifeDays", "descentBoost"];
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
  $("#targetTime").value = s.targetTime || "";
  $("#terrain").value = s.terrain;
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
 * `?? 0.07` only when it is null, so the endurance exponent can be set to any valid number.
 * The aid stations stay as raw text here; core/plan.js parseAidStations reads them.
 */
function readSettings() {
  const n = (id) => { const v = parseFloat($("#" + id).value); return Number.isFinite(v) ? v : null; };
  state.settings = {
    ...state.settings,
    startTime: $("#startTime").value || "09:00",
    targetTime: $("#targetTime").value.trim(),
    terrain: $("#terrain").value,
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
    } catch (e) { bad.push(e.message); }
  }
  // One status line per run: name, date, distance, and its weight in % when there are several.
  const list = state.effort ? state.effort.info.runs.map((r, i) => `<span class="ok">✓ ${esc(runs[i].name)}</span> · ${r.date} · ${r.distKm.toFixed(1)} km${runs.length > 1 ? ` · weight ${Math.round(r.weight * 100)}%` : ""}`).join("<br>") : "";
  setStatus("effort", list + bad.map((b) => `<div class="err">${esc(b)}</div>`).join(""), Boolean(state.effort));
  compute();
}

/**
 * Make a drop box accept files, both by drag and drop and by its "Choose GPX" button.
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
wireDrop("#dropEffort", "#fileEffort", (files) => { loadEfforts(files); files.forEach((f) => acctSaveGpx(f.xml, f.label)); });
$("#clearRuns").addEventListener("click", () => { trackEvent("runs-clear"); setRuns([]); });

// "Try the demo": load made-up runs and a made-up race from src/demo.js, as if they were dropped.
$("#demo").addEventListener("click", () => {
  trackEvent("demo");
  // A made-up mountain ultra (78 km, 3,800 m up, seven aid stations) and two made-up 30 km
  // mountain long runs six weeks apart, so the weighting shows. Aid stations and start time
  // are filled in unless you typed your own.
  state.effort = null;
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
      state.plan = buildPlan(state.race.parsed, state.effort.runs.map((r) => r.parsed), { ...state.settings, ...profileHeart() });
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

// Small HTML builders used by several sections. Each returns HTML text.
//   tile(k, v, s, cls)  a key figure box: label k, value v, optional small line s
//   cell(k, v, cls)     one labelled cell in a climb or descent row
//   len(m)              a length in metres as "1.25 km" or "850 m"
//   kmRange(x)          "12.3": the start km of an object with startKm
//   empty(html)         the grey hint shown when a section has nothing to show yet
/* ---------- shared pieces ---------- */
const tile = (k, v, s = "", cls = "") => `<div class="tile ${cls}"><div class="k">${k}</div><div class="v">${v}</div>${s ? `<div class="s">${s}</div>` : ""}</div>`;
const cell = (k, v, cls = "") => `<div class="c ${cls}"><span class="k">${k}</span><b>${v}</b></div>`;
const len = (m) => (m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`);
const kmRange = (x) => x.startKm.toFixed(1); // the start km only: the length column gives the rest
// descChip(level): a descent's risk as ▼ icons (▼ Let it run, ▼▼ Control, ▼▼▼ Brake), the word in the tooltip.
const descChip = (l) => { const k = l >= 4 ? 3 : l >= 2 ? 2 : 1; return `<span class="chip st dsc d${k}" title="${DESCENT_LABELS[l]}" aria-label="${DESCENT_LABELS[l]}">${"▼".repeat(k)}</span>`; };
// starChip(l): a climb's difficulty as 1 to 4 stars in its level colour (the unlit ones dimmed),
// with the word (Easy...Crux) kept for screen readers and the hover tooltip.
const starChip = (l) => `<span class="chip st l${l}" title="${LEVELS[l]}" aria-label="${l} of 4 stars, ${LEVELS[l]}">${STARS[l]}<i>${"★".repeat(4 - l)}</i></span>`;
const empty = (html) => `<div class="empty">${html}</div>`;
/**
 * The climbs and descents tables: one header row on top (the labels are not repeated in every
 * row), then the rows. cols: the column titles after the number and the mini profile; cls: the
 * table's kind ("t-route" or "t-plan"), which sets its column widths in style.css.
 */
// Column order (Boss, design review 2): #, Km, the mini profile with the average gradient, then cols.
const rowsTable = (cls, cols, body) => `<div class="rows tbl ${cls}" role="table"><div class="row rh" role="row"><div class="n">#</div><div class="c">Km</div><div class="c sph">Profile · avg</div>${cols.map((c) => `<div class="c${c.w ? " w" : ""}">${c.t || c}</div>`).join("")}<div class="diff"></div></div>${body}</div>`;
/**
 * spark(P, a, b): a small elevation line of the course from km a to km b, as an SVG (80 x 22),
 * scaled to that stretch's own lowest and highest point (at least 30 m of range, so a gentle
 * stretch looks gentle). 28 points along the stretch, read with elevAt from the profile.
 * The average gradient sits in bold on the middle of the line (it replaces an Average column).
 */
function spark(P, a, b, avg = null) {
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
function profileView(P, brief, race, zones = [], { flat = false, win = null, inner = true, labels = false } = {}) {
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

// LEGEND: the colour key under the profile (difficulty levels 1 to 4 and braking descents).
const LEGEND = `<div class="legend" style="margin-top:10px">${[1, 2, 3, 4].map((l) => starChip(l)).join("")}<span class="note" style="margin:0 0 0 4px">Each stretch is coloured by its average gradient. Dashed red: descent to brake on.</span></div>`;

/* ---------- 01 your engine ---------- */
/**
 * Section 01 Engine: what your own runs say about you. Reads state.effort.info from
 * core/effort.js and writes into #s1body: key figure tiles (how you move: flat pace, cadence,
 * climbing paces, climb rate) and a bar chart of your pace on each gradient band, fresh and tired.
 */
function renderEngine() {
  const box = $("#s1body");
  if (!state.effort) { box.innerHTML = empty(`<b>Drop one of your runs above</b> (or press Try the demo) to see your pace on every gradient.`); return; }
  const e = state.effort.info;
  const bands = e.bands;
  // The band with the best climb rate (VAM, vertical metres per hour), counting only bands with
  // a real climb rate (over 50 m/h) that were measured rather than estimated. sort() puts the
  // highest first, [0] takes it (undefined if none qualify).
  const steep = bands.filter((b) => b.vam && b.vam > 50 && b.source !== "estimated").sort((a, b) => b.vam - a.vam)[0];
  // The key figures are about how you move, not about the run itself (its length and duration
  // say nothing without context): flat pace, cadence, a gentle and a steep climb, best climb rate.
  // band(id): one gradient band of BANDS (core/terrain.js); fadeTxt: how much slower tired is.
  const band = (id) => bands.find((b) => b.id === id);
  const fadeTxt = (b) => `tired ${mmss(b.tired)} · +${((b.tired / b.fresh - 1) * 100).toFixed(0)}%`;
  const gentle = band("u1"), steepB = band("u4");
  const tiles = [
    tile("Flat pace", `${mmss(e.flatPace)}<small>/km</small>`, e.runs.length > 1 ? `${e.runs.length} runs, weighted` : "on the flat"),
    tile("Cadence", e.flatCad ? `${Math.round(e.flatCad)}<small>spm</small>` : "–", e.cadenceWasPerFoot ? "doubled from per-foot" : "on the flat"),
    tile("Pace +2 to +6%", `${mmss(gentle.fresh)}<small>/km</small>`, fadeTxt(gentle)),
    tile("Pace +15 to +22%", `${mmss(steepB.fresh)}<small>/km</small>`, fadeTxt(steepB)),
    tile("Best climb rate", steep ? `${Math.round(steep.vam)}<small>m/h</small>` : "–", steep ? steep.label : "not enough climbing"),
  ].join("");
  // Bars are drawn as a share of the slowest pace on the page, so the longest bar fills the row.
  // Pace is in seconds per km: a longer bar is slower. `fade` is how much slower tired is, in %.
  const maxPace = Math.max(...bands.map((b) => b.tired));
  const rows = bands.map((b) => {
    const fade = (b.tired / b.fresh - 1) * 100;
    return `<div class="pace ${b.source === "estimated" ? "est" : ""}">
      <div class="lab">${esc(b.label)}<small>${b.source}${b.hr ? ` · HR ${Math.round(b.hr)}` : ""}</small></div>
      <div class="bars"><i class="fr" style="width:${((b.fresh / maxPace) * 100).toFixed(1)}%"></i><i class="ti" style="width:${((b.tired / maxPace) * 100).toFixed(1)}%"></i></div>
      <div class="num"><b class="pf">${mmss(b.fresh)}</b><span class="pt">${mmss(b.tired)}</span><span class="pfade${fade >= 15 ? " hi" : ""}">+${fade.toFixed(0)}%</span></div>
    </div>`;
  }).join("");
  // Your runs and their weights show under the drop box at the top (setRuns), not here.
  box.innerHTML = `
    <div class="tiles">${tiles}</div>
    <div class="sub-h">Pace by gradient</div>
    <div class="panel compact">
      <div class="keyline"><span><i style="background:var(--accent)"></i>Fresh (first half of your run)</span><span><i style="background:color-mix(in srgb,var(--fg) 35%,transparent)"></i>Tired (second half)</span><span>Longer bar = slower. On the right: fresh pace, tired pace, how much you fade. Pace in min/km.</span></div>
      <div class="paces">${rows}</div>
      <p class="note">"Estimated" bands had under a minute of data in your run, so they use typical ratios to your flat pace.</p>
    </div>`;
}

/* ---------- map styling shared by the briefing and the replay ---------- */
/** Coloured stretches (climbs by difficulty, braking descents) and markers for courseMap. */
// Inputs: brief {totalKm, climbs, descents}; aid [{km, name, time?}]; zones the key zones.
// Returns {paint, marks} for map.js courseMap:
//   paint: stretches [{fromKm, toKm, cls, title}] coloured on the route by CSS class
//   marks: points [{km, kind, label, title?}]: the start, a km marker every 5 km (10 km on
//          races over 60 km, stopping a km before the finish) and the aid stations.
// A split climb is painted section by section (each in its own colour) instead of as one stretch.
function mapStyle(brief, aid, zones = [], whole = false) {
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
function zoneList(zones, when) {
  if (!zones.length) return empty("No stretch stands out: an even course, run it evenly.");
  return `<div class="zones">${zones.map((z) => `<div class="zone-card m-${z.mode}">
    <div class="zn">★${z.n}</div>
    <div class="zb"><div class="zt"><span class="mode m-${z.mode}">${z.modeLabel}</span><b>${esc(z.title)}</b><span>km ${z.fromKm.toFixed(1)} → ${z.toKm.toFixed(1)}${when ? ` · ${when(z.fromKm)}` : ""}</span></div>
    <p>${esc(z.why)}</p><p class="zh">${esc(z.how)}</p></div>
    <div class="zs"><small>up to</small><b>${z.stakeMin}</b><small>min to gain</small></div>
  </div>`).join("")}</div>`;
}
// ZONE_NOTE: the explanation of key zones shown under the lists in sections 02 and 03.
const ZONE_NOTE = `Key zones are short stretches where how you run changes your race. <b>Attack</b>: push, time is won here. <b>Prepare</b>: set up what comes next (eat, drink, let your heart rate drop). <b>Manage</b>: protect your effort for later. "Up to X min to gain" = the typical gap, on that stretch and what follows, between runners of your level who run it well and those who do not: time on it × how much runners differ at that point (3% at the start to 18% at the finish, as fatigue spreads the field) × the kind of zone. One zone per 13 km of race.`;
// jumps(items): the row of in-section links at the top of a section; items [[target id, text, class?]].
const jumps = (items) => `<nav class="jumps" aria-label="In this section">${items.map(([href, t, cls]) => `<a href="#${href}" class="${cls || ""}">${t}</a>`).join("")}</nav>`;
// The two Leaflet maps currently shown. They are kept so the next render can destroy() them
// first: a map left behind would keep its event listeners and memory.
let briefMap = null;
let ddayMap = null;

/* ---------- 02 race briefing ---------- */
/** One difficulty chip (1 to 4 stars) for a climb row; c.level is 1 to 4. */
function diffCell(c) {
  return `<div class="diff">${starChip(c.level)}</div>`;
}
/**
 * Section 02 Course: the race on its own, before knowing who runs it. Writes into #s2body:
 * key figures, a map, a zoomable elevation profile, the key zones, and the climbs and descents
 * tables. Needs only state.race. Side effects: replaces briefMap, reads and sets state.bwin
 * (zoom window) and state.btab (which tab is open), adds listeners to the new elements.
 */
function renderBriefing() {
  const box = $("#s2body");
  if (briefMap) { briefMap.destroy(); briefMap = null; }
  if (!state.race) { box.innerHTML = empty(`<b>Drop the race GPX above</b> to get the course briefing.`); return; }
  // briefCourse (core/plan.js) lists the climbs and descents with their difficulty level.
  const brief = briefCourse(state.race.course, state.settings);
  const P = state.race.profile;
  const top = Math.max(...P.map((p) => p[1]));
  const tiles = [
    tile("Distance", `${brief.totalKm.toFixed(1)}<small>km</small>`),
    tile("Elevation gain", `${Math.round(brief.gain)}<small>m D+</small>`, `${Math.round(brief.loss)} m D−`),
    tile("Climbs", `${brief.climbs.filter((c) => !c.bump).length}`, `${brief.descents.length} descents`),
    tile("High point", `${Math.round(top)}<small>m</small>`),
    tile("Start time", esc(state.settings.startTime || PLAN_DEFAULTS.startTime), "set it below"),
  ].join("");
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
  const aid = parseAidStations(state.settings.aidStations).filter((a) => a.km <= brief.totalKm);
  // With a plan, the zones use your predicted times; before that, a typical runner's (Tobler's hiking function).
  const zones = state.plan ? state.plan.keyZones : keyZones(brief, P, aid, toblerClock(P));
  // A zoom window saved from a longer course no longer fits: forget it.
  if (state.bwin && state.bwin[1] > brief.totalKm) state.bwin = null;
  // Write the section. `hidden` on a tab's div hides it; the tab buttons below switch them.
  box.innerHTML = `
    ${jumps([["b-map", "Map and profile"], ["b-list", `Climbs and descents`]])}
    <div class="tiles">${tiles}</div>
    <div class="sub-h" id="b-map">Map and profile</div>
    <div class="b-map" id="briefMap"></div>
    <div class="prof-wrap b-prof" id="briefProf"><div class="prof-tools"><span class="note" style="margin:0">Drag across the profile to zoom: the map follows. Each climb shows whole, its badge gives its average gradient; hover or tap it for the figures.</span><button type="button" class="btn sm" id="profReset" hidden>Reset zoom</button></div><div id="briefProfSvg"></div><div class="prof-pop" id="profPop" hidden></div>${LEGEND}</div>
    <p class="note">Map and profile share their colours: climbs by difficulty, dashed red for descents to brake on, a yellow glow on the key zones (the details are in Your plan). Triangles are aid stations, numbers are km. Hover the profile to see where you are on the map.</p>
    <div class="sub-h" id="b-list">Climbs and descents</div>
    <div class="tabs" role="tablist" aria-label="Segments">
      <button type="button" role="tab" data-t="c" aria-selected="${state.btab === "c"}">Climbs · ${brief.climbs.length - bumps}</button>
      <button type="button" role="tab" data-t="d" aria-selected="${state.btab === "d"}">Descents · ${brief.descents.length}</button>
    </div>
    <div ${state.btab === "c" ? "" : "hidden"}>
    <p class="note" style="margin:-4px 0 12px">Difficulty = gain × steepness (average ÷ 8%, between 0.5 and 2) × fatigue (1.00 early, 1.15 mid-race, 1.35 late). A climb gains at least ${Math.round(brief.minClimb)} m (10% of the race's D+, or 100 m on any race); ${bumps ? `the ${bumps} smaller rise${bumps === 1 ? " is a bump" : "s are bumps"}, not counted here but kept in your plan and race script. ` : ""}Climbs of ${(state.settings.splitClimbM / 1000).toFixed(0)} km or more are split where the gradient clearly changes, each section at least 15% of the climb, and rated on its own.</p>
    ${climbs ? rowsTable("t-route", ["Length", "Gain", "Steepest 100 m"], climbs) : empty(`No climb of ${Math.round(brief.minClimb)} m or more.`)}
    </div>
    <div ${state.btab === "d" ? "" : "hidden"}>
    <p class="note" style="margin:-4px 0 12px">▼▼▼ Brake: a 100 m stretch of 20% or more, or 12% on average. ▼▼ Control: 6% on average, or a 15% stretch. ▼ Let it run: everything else.</p>
    ${descents ? rowsTable("t-route", ["Length", "Loss", "Steepest 100 m"], descents) : empty("No descents over 10 m.")}
    </div>`;
  // Tabs: a click selects one tab and shows its list without redrawing the whole section.
  // ".tabs ~ div" selects the divs that come after the tab bar at the same level: the two lists.
  // `const [c, d] = ...` (destructuring) names the first two results c and d.
  box.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => {
    state.btab = b.dataset.t;
    trackEvent("briefing-tab", state.btab === "c" ? "climbs" : "descents");
    box.querySelectorAll(".tabs button").forEach((x) => x.setAttribute("aria-selected", String(x === b)));
    const [c, d] = box.querySelectorAll(".tabs ~ div");
    c.hidden = state.btab !== "c";
    d.hidden = state.btab !== "d";
  }));

  // The map: the route coloured like the profile. `...mapStyle(...)` spreads paint and marks into
  // the options object.
  briefMap = courseMap($("#briefMap"), { route: state.race.route, totalKm: brief.totalKm, ...mapStyle(brief, aid, zones, true) });
  // The profile, drawn for the whole course or for the zoom window. Hover (or touch) it for a cursor
  // there and a dot at the same km on the map; drag across it (like Strava) to zoom on that stretch.
  // drawProf is an arrow function kept in a variable so it can call itself again after a zoom.
  const drawProf = () => {
    const view = profileView(P, brief, null, zones, { win: state.bwin, inner: false, labels: true });
    const host = $("#briefProfSvg");
    host.innerHTML = view.html;
    $("#profReset").hidden = !state.bwin;
    const svg = host.querySelector("svg");
    const cur = svg.querySelector(".pcur");
    // kmAt(ev): the km under the pointer. getBoundingClientRect gives the SVG's size on screen in
    // pixels; the pointer's share of that width, times 1000 (the viewBox width), is the SVG x.
    const kmAt = (ev) => { const b = svg.getBoundingClientRect(); return view.km(((ev.clientX - b.left) / b.width) * 1000); };
    // The selection rectangle shown while dragging. SVG elements must be created with their
    // namespace (createElementNS), not createElement, or the browser does not draw them.
    const sel = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    sel.setAttribute("class", "psel"); sel.setAttribute("y", String(view.top)); sel.setAttribute("height", String(view.base - view.top)); sel.style.display = "none";
    svg.appendChild(sel);
    // from: the km where the drag started, or null when no drag is going on.
    let from = null;
    // show(ev): move the cursor line and dot to the pointer, move the runner dot on the map to
    // the same km, and during a drag stretch the selection from `from` to here.
    // The small pop-up window over a climb: name, then km, length, D+ and average gradient
    // (data-tip, written by profileView as "name|km|length|D+|avg|level").
    const pop = $("#profPop");
    const wrap = $("#briefProf");
    const tipAt = (ev) => {
      const t = ev.target.closest && ev.target.closest("[data-tip]");
      if (!t) { pop.hidden = true; return; }
      const [name, km, ln, up, avg, lv] = t.dataset.tip.split("|");
      pop.innerHTML = `<b>${name}</b> ${starChip(+lv)}<span>${km}</span><span>${ln}</span><span>${up}</span><span><b>${avg}</b> avg</span>`;
      pop.hidden = false;
      const w = wrap.getBoundingClientRect();
      pop.style.left = `${Math.min(w.width - pop.offsetWidth - 4, Math.max(4, ev.clientX - w.left - pop.offsetWidth / 2))}px`;
      pop.style.top = `${Math.max(4, ev.clientY - w.top - pop.offsetHeight - 14)}px`;
    };
    svg.addEventListener("pointerleave", () => { pop.hidden = true; });
    const show = (ev) => {
      if (from === null && ev.pointerType === "mouse") tipAt(ev);
      const km = kmAt(ev);
      cur.style.display = "";
      cur.setAttribute("transform", `translate(${view.x(km).toFixed(1)},0)`);
      cur.querySelector("circle").setAttribute("cy", view.y(elevAt(P, km)).toFixed(1));
      briefMap.setRunner(km);
      if (from !== null) {
        const a = Math.min(from, km), b = Math.max(from, km);
        sel.style.display = ""; sel.setAttribute("x", view.x(a).toFixed(1)); sel.setAttribute("width", Math.max(0, view.x(b) - view.x(a)).toFixed(1));
      }
    };
    // Pointer events cover mouse, pen and touch in one API. setPointerCapture keeps sending the
    // events to the SVG even if the finger or mouse leaves it during the drag.
    svg.addEventListener("pointermove", show);
    svg.addEventListener("pointerdown", (ev) => { from = kmAt(ev); svg.setPointerCapture(ev.pointerId); show(ev); });
    svg.addEventListener("pointercancel", () => { from = null; sel.style.display = "none"; });
    svg.addEventListener("pointerup", (ev) => {
      if (from === null) return;
      const to = kmAt(ev), a = Math.min(from, to), b = Math.max(from, to);
      from = null; sel.style.display = "none";
      // A tap on a climb (touch screens have no hover) opens its pop-up.
      if (ev.pointerType !== "mouse") tipAt(ev);
      // A real drag (not a tap): at least 2% of what is on screen, and never under 300 m.
      if (b - a >= Math.max(0.3, (view.K1 - view.K0) * 0.02)) {
        state.bwin = [a, b];
        trackEvent("briefing-zoom");
        drawProf();
        briefMap.focus(a, b);
      }
    });
  };
  // Reset zoom: back to the whole course, and the map back to the whole route.
  $("#profReset").addEventListener("click", () => { state.bwin = null; drawProf(); briefMap.focus(null); briefMap.fit(); });
  drawProf();
  if (state.bwin) briefMap.focus(state.bwin[0], state.bwin[1]);
}

/* ---------- 03 D-day ---------- */
/**
 * Section 03 Plan: the race-day plan from state.plan (core/plan.js buildPlan). Writes into
 * #s3body: the scenario switch and finish time, the targeted-duration verdict, the profile with
 * gels and aid stations, a map, the key zones, the race card (checkpoints, aid stations, gels,
 * heart rate, hikes), the climb-by-climb table, the plan-versus-actual log and export buttons.
 * Times in the plan are seconds from the start; clock(startSec, sec) turns them into a time of
 * day and hm(sec) into a duration. Many values are stored per scenario: x.start[sid], x.dur[sid].
 * Side effects: replaces ddayMap, adds listeners, reads and writes localStorage.
 */
function renderDday() {
  const out = $("#s3body");
  const plan = state.plan;
  if (ddayMap) { ddayMap.destroy(); ddayMap = null; }
  if (!plan) {
    out.innerHTML = empty(state.race || state.effort ? `<b>Add the ${state.race ? "run" : "race"} GPX</b> to build your race-day plan.` : `<b>Load both files</b> (or press Try the demo) to build your race-day plan.`);
    return;
  }
  // A scenario saved in this browser that the plan does not have falls back to central.
  if (!plan.scenarios[state.scenario]) state.scenario = "central";
  const sid = state.scenario;
  const sc = plan.scenarios[sid];
  const st = plan.startSec;
  const brief = { totalKm: plan.course.totalKm, climbs: plan.climbs, descents: plan.descents };
  const aidMarks = plan.aidStations.map((a) => ({ km: a.km, name: a.name, sec: a.arrive[sid] }));

  // The HTML pieces of the race card, one list item per line. `||` gives a fallback line
  // when a list comes out empty ("" is falsy).
  const seg = SCENARIOS.map((s) => `<button type="button" data-s="${s.id}" aria-pressed="${s.id === sid}">${s.label}<small>${hm(plan.scenarios[s.id].finishSec)}</small></button>`).join("");
  const ckList = sc.checkpoints.map((c) => `<li><span>${esc(c.label)}</span><b>${clock(st, c.sec)} · ${hm(c.sec)}</b></li>`).join("");
  // GEL_WHERE: how to describe where a gel was moved to, by the `where` code plan.js gives it.
  const GEL_WHERE = { top: "top of climb", bottom: "foot of descent", section: "end of a climb section", "before descent": "before the descent", "on the climb": "on the climb, walking" };
  const gelList = sc.gels.map((g) => `<li><span>km ${g.km.toFixed(1)}${g.at ? ` · ${esc(g.at)}` : g.where ? ` · ${GEL_WHERE[g.where]}` : ""}</span><b>${clock(st, g.sec)}</b></li>`).join("") || `<li><span>No gel needed for this length</span><b></b></li>`;
  const hrList = plan.hrGuide ? plan.hrGuide.map((h) => `<li><span>km ${h.fromKm.toFixed(0)} to ${h.toKm.toFixed(0)}</span><b>${esc(h.text)}</b></li>`).join("") : `<li><span>Add your max heart rate in your profile (account icon) for a heart-rate guide</span><b></b></li>`;
  // The climbs (and climb sections) to hike: those whose tactic starts with "Hike".
  // The regex /^Hike/ matches "Hike" at the start of the text; /steep part/ anywhere in it.
  const hikes = plan.climbs.flatMap((c) => [c, ...c.sections]).filter((c) => /^Hike/.test(c.tactic));
  const hikeList = hikes.map((c) => `<li><span>#${c.n} · km ${c.startKm.toFixed(1)}</span><b>${/steep part/.test(c.tactic) ? `${Math.round(c.steep)}% pitch` : `${c.avg.toFixed(0)}%`} · ${clock(st, c.start[sid])}</b></li>`).join("") || `<li><span>None at this threshold</span><b></b></li>`;

  // One table row for a climb, section or descent: arrival clock time, time on it (at least
  // 1 min), average pace in min/km (duration in s / length in km) and the tactic.
  const raceRow = (x, sec, chip) => `<div class="row v${x.level} ${sec ? "sec" : ""}">
      <div class="n">${x.n}</div>${cell("Km", kmRange(x))}${spark(plan.course.profile, x.startKm, x.endKm, x.avg)}${cell("Arrive", clock(st, x.start[sid]))}${cell("Time on it", `${Math.max(1, Math.round(x.dur[sid] / 60))} min`)}${cell("Pace", `${mmss(x.dur[sid] / (x.lenM / 1000))}/km`)}${cell("Tactic", esc(x.tactic), "w")}<div class="diff">${chip}</div>
    </div>`;
  const climbRows = plan.climbs.map((c) => raceRow(c, false, starChip(c.level)) + c.sections.map((x) => raceRow(x, true, starChip(x.level))).join("")).join("");
  const descRows = plan.descents.map((d) => raceRow(d, false, descChip(d.level))).join("");
  const PLAN_COLS = ["Arrive", "Time on it", "Pace", { t: "Tactic", w: true }];

  // The plan-versus-actual times are saved per race name and distance, so two races do not mix.
  const logKey = `trp.log.${(state.race && state.race.name) || "race"}.${plan.course.totalKm.toFixed(1)}`;
  const logMode = store.get("trp.logMode") || "race";

  // The targeted duration: parseDuration reads "h:mm" into seconds (null if it cannot), and
  // judgeTarget compares it with the three scenarios. TARGET maps each verdict to
  // [title, tone (colour class), explanation].
  const target = judgeTarget(plan, parseDuration(state.settings.targetTime));
  const TARGET = {
    "out-of-reach": ["Not backed by your runs", "bad", "More than 5% faster than your best-case scenario: nothing in your reference runs shows that speed on this course. Aim for a time inside the scenario range, or add a faster recent run."],
    ambitious: ["Ambitious", "warn", "Faster than your best-case scenario but within the model's margin: it needs a great day, a fast course and no mistakes."],
    realistic: ["Realistic", "good", "Inside the range of your three scenarios: your runs say you can do it."],
    comfortable: ["Comfortable", "good", "Slower than your cautious scenario: you have margin. Keep it as a safe goal, or aim a little higher."],
  };
  // (() => { ... })() is an arrow function called at once (an IIFE): a way to run a few
  // statements where an expression is expected. A typed target that could not be read gets a
  // format hint; no target, nothing.
  const targetHtml = target ? (() => {
    const [title, tone, why] = TARGET[target.verdict];
    const pct = target.vsCentralPct;
    return `<div class="panel target-card t-${tone}" id="d-target">
      <div class="tg-h"><span class="k">Targeted duration</span><b>${hm(target.targetSec)}</b><span class="chip tg-chip">${title}</span></div>
      <p>${why}</p>
      <ul class="kv"><li><span>Versus your balanced scenario (${hm(plan.scenarios.central.finishSec)})</span><b>${Math.abs(pct) < 0.5 ? "the same" : `${Math.abs(pct).toFixed(1)}% ${pct > 0 ? "faster" : "slower"}`}</b></li>
      <li><span>Average pace it needs, stops included</span><b>${mmss(target.paceSec)}/km <small>balanced ${mmss(target.centralPaceSec)}/km</small></b></li>
      <li><span>Scenario range</span><b>${hm(plan.scenarios.best.finishSec)} to ${hm(plan.scenarios.cautious.finishSec)}</b></li></ul>
    </div>`;
  })() : state.settings.targetTime ? `<div class="panel target-card t-warn" id="d-target"><p>Write the targeted duration as hours:minutes, for example 10:15.</p></div>` : "";

  // Write the whole section in one go.
  out.innerHTML = `
  ${jumps([["d-map", "Map"], ["d-key", "★ Key zones"], ["d-card", "Race card"], ["d-climbs", "Climb by climb"], ["d-log", "Plan versus actual"], ["d-export", "Export"], ["s-pimp", "05 Coach"], ["rpCockpit", "▶ Your race", "go"]])}
  <div class="dday-top has-pimp">
    ${tile(`Estimated duration · ${sc.label.toLowerCase()}`, hm(sc.finishSec), `finish at ${clock(st, sc.finishSec)} · start ${clock(st, 0)}`, "big")}
    <div class="panel" style="display:flex;flex-direction:column;gap:12px;justify-content:center">
      <div class="scen-row"><div class="seg" role="group" aria-label="Scenario" id="scen">${seg}</div>${acctAiBadge("race")}</div>
      <p class="note" style="margin:0">Race pace is ${((sc.factor - 1) * 100).toFixed(0)}% slower than your run on the same gradients: terrain factor plus the fade for a longer effort. Every clock time on this page follows the scenario you pick.</p>
    </div>
    <div class="side-stack">${pimpBadge("#s-pimp")}</div>
  </div>
  ${targetHtml}
  <div class="prof-wrap">${profileView(plan.course.profile, brief, { ...sc, startSec: st, aid: aidMarks }, plan.keyZones).html}
    <div class="legend" style="margin-top:10px"><span class="note" style="margin:0">Red dots: gels. Triangles: aid stations. Shaded bands ★: key zones, where the race is played.</span></div>
  </div>
  ${plan.keyZones.length ? `<div class="kz-bar" id="d-key" role="group" aria-label="Key zones"><span class="kz-h">Key zones</span>${plan.keyZones.map((z, i) => `<button type="button" class="kz-chip m-${z.mode}" data-z="${i}" aria-pressed="${state.kz === i}" title="${esc(z.title)}">★${z.n}<small>${z.modeLabel}</small></button>`).join("")}<span class="kz-hint">Pick a star: its message opens, the profile and the map show where it is.</span></div>
  <div id="kzMsg"></div>` : `<div id="d-key">${zoneList([])}</div>`}
  <div class="sub-h" id="d-map">Map</div>
  <div class="b-map" id="ddayMap"></div>

  <details class="fold" id="d-card"><summary class="sub-h">Race card</summary>
  <div class="grid">
    <div class="panel card"><h3>Checkpoints</h3><ul class="kv">${ckList}</ul></div>
    ${plan.aidStations.length ? `<div class="panel card"><h3>Aid stations</h3><ul class="kv">${plan.aidStations.map((a) => `<li><span>km ${a.km.toFixed(1)} · ${esc(a.name)}</span><b>${clock(st, a.arrive[sid])}${a.stopMin ? ` → ${clock(st, a.arrive[sid] + a.stopMin * 60)}` : ""}</b></li>`).join("")}</ul><p class="note">Arrival → departure. ${plan.aidStations.reduce((t, a) => t + a.stopMin, 0)} min of stops in total, included in the finish time.</p></div>` : ""}
    <div class="panel card"><h3>Gels</h3><ul class="kv">${gelList}</ul><p class="note">Every ${plan.params.gelEveryMin} min after the last one, taken at an aid station when one is close, else moved off climbs and technical descents. When the top is more than ${plan.params.gelMaxDelayMin} min away, it is taken at a change of slope or while walking.</p></div>
    <div class="panel card"><h3>Heart rate</h3><ul class="kv">${hrList}</ul><p class="note">Before each key zone: on pace with heart rate in the guide, commit to it. Above it, hold and eat, and save it for the next one.</p></div>
    <div class="panel card"><h3>Hike these</h3><ul class="kv">${hikeList}</ul><p class="note">Hiking from ${plan.params.hikeGrade}% (${state.settings.hikeGrade ? "set by you" : plan.effort.hikeGrade ? "learned from your cadence" : "default"}). A climb is hiked when its average is within 2 points of that, or just its steep part when a 100 m stretch reaches it.</p></div>
  </div>
  </details>

  <details class="fold" id="d-climbs" ${state.foldClimbs === false ? "" : "open"}><summary class="sub-h">Climb by climb</summary>
  <div class="tabs" role="tablist" aria-label="Segments">
    <button type="button" role="tab" data-t="c" aria-selected="${state.tab === "c"}">Climbs</button>
    <button type="button" role="tab" data-t="d" aria-selected="${state.tab === "d"}">Descents</button>
  </div>
  <div ${state.tab === "c" ? "" : "hidden"}>${rowsTable("t-plan", PLAN_COLS, climbRows)}</div>
  <div ${state.tab === "d" ? "" : "hidden"}>${rowsTable("t-plan", PLAN_COLS, descRows)}</div>
  </details>

  <details class="fold" id="d-log"><summary class="sub-h">Plan versus actual <small>extra</small></summary>
  <div class="panel">
    <div class="actions" style="margin-bottom:8px">
      <label class="f" style="flex-direction:row;align-items:center;gap:8px">Log for
        <select id="logsel" style="width:auto;min-width:200px"><option value="sim" ${logMode === "sim" ? "selected" : ""}>Training simulation</option><option value="race" ${logMode === "race" ? "selected" : ""}>Race result</option></select>
      </label>
      <span class="note" style="margin:0">Saved in this browser only.</span>
    </div>
    <div class="logrow loghead"><span>Checkpoint</span><span>Plan</span><span>Your time</span><span>Gap</span></div>
    <div id="logrows"></div>
    <p class="note">Type the first checkpoint as minutes and seconds if it is under an hour (56:30), the others as hours and minutes (1:55).</p>
  </div>
  </details>

  <div class="sub-h" id="d-export">Take it with you</div>
  <div class="actions">
    <button class="btn primary" id="copyMd" type="button">Copy plan as Markdown</button>
    <button class="btn" id="copyJson" type="button">Copy as JSON</button>
    <button class="btn" id="printDday" type="button">⎙ Export A4 (print or PDF)</button>
    <span class="status" id="exportStat" aria-live="polite"></span>
  </div>`;

  // Wiring: the elements above are new, so their listeners are added after every redraw.
  // A scenario click redraws all the sections whose times depend on it, and saves the choice.
  /* wiring */
  out.querySelectorAll("#scen button").forEach((b) => b.addEventListener("click", () => { state.scenario = b.dataset.s; trackEvent("scenario", state.scenario); store.set("trp.scenario", state.scenario); renderDday(); renderReplay(); renderPimp(); renderNav(); }));
  // Switching the Climbs / Descents tab redraws the section and keeps "Climb by climb" open.
  out.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => { state.tab = b.dataset.t; state.foldClimbs = true; trackEvent("dday-tab", state.tab); renderDday(); }));
  // The "toggle" event fires when a <details> block opens or closes.
  out.querySelectorAll("details.fold").forEach((d) => d.addEventListener("toggle", () => { if (d.open) trackEvent("fold-open", d.id); if (d.id === "d-climbs") state.foldClimbs = d.open; }));
  $("#logsel").addEventListener("change", (ev) => { trackEvent("log-mode", ev.target.value); store.set("trp.logMode", ev.target.value); drawLog(plan, logKey); });
  drawLog(plan, logKey);
  $("#copyMd").addEventListener("click", () => { trackEvent("export", "markdown"); copyText(planToMarkdown(plan, sid)); });
  $("#copyJson").addEventListener("click", () => { trackEvent("export", "json"); copyText(JSON.stringify(slimPlan(plan, sid), null, 2)); });
  $("#printDday").addEventListener("click", () => { const box = $("#s3 .a4x"); box.open = true; box.scrollIntoView({ behavior: "smooth", block: "center" }); });
  // `...mapStyle(...)` spreads paint and marks into the options. Without a route there is no map.
  // The race on a map, coloured like the profile, with your aid stations and key zones.
  if (state.race && state.race.route) ddayMap = courseMap($("#ddayMap"), { route: state.race.route, totalKm: plan.course.totalKm, ...mapStyle(brief, parseAidStations(state.settings.aidStations).filter((a) => a.km <= plan.course.totalKm), plan.keyZones) });
  else $("#ddayMap").remove();
  // Key zone chips: one open at a time (state.kz, the index, or null). Opening one writes its card
  // under the chips, shades its band on the profile (class "on") and zooms the map on it with the
  // rest of the route dimmed; a second click on the same chip closes it.
  const openZone = (i) => {
    if (i !== null && !plan.keyZones[i]) i = null;
    state.kz = i;
    out.querySelectorAll(".kz-chip").forEach((b) => b.setAttribute("aria-pressed", String(+b.dataset.z === i)));
    const z = i === null ? null : plan.keyZones[i];
    out.querySelectorAll(".prof-wrap rect.zone").forEach((rc) => rc.classList.toggle("on", !!z && +rc.dataset.z === z.n));
    const msg = $("#kzMsg");
    if (msg) msg.innerHTML = z ? `${zoneList([z])}<p class="note kz-note">${ZONE_NOTE}</p>` : "";
    if (ddayMap) { if (z) ddayMap.focus(z.fromKm, z.toKm); else { ddayMap.focus(null); ddayMap.fit(); } }
  };
  out.querySelectorAll(".kz-chip").forEach((b) => b.addEventListener("click", () => {
    const i = +b.dataset.z;
    if (state.kz !== i) trackEvent("key-zone", String(plan.keyZones[i].n));
    openZone(state.kz === i ? null : i);
  }));
  if (state.kz !== null && state.kz !== undefined) openZone(state.kz);
  // The "Pimp my GPX" sticker drawn by pimpBadge() above links to section 05.
  $("#s3body .pimp-link").addEventListener("click", () => trackEvent("nav", "pimp-badge"));
}

/* ---------- 05 pimp my GPX: the watch messages and the course for the watch ---------- */
/**
 * Section 05 Your coach: the watch messages for this plan (built and edited by ui/watch.js) and the
 * buttons to download the course as a Garmin .fit or as a GPX with waypoints. Writes into
 * #sPimpBody. say(text) shows a short status next to the buttons.
 */
function renderPimp() {
  const box = $("#sPimpBody");
  const plan = state.plan;
  if (!plan) { box.innerHTML = empty(`<b>Build your plan first</b> (both files, or press Try the demo), then get the race GPX back with your plan on it.`); return; }
  const sid = plan.scenarios[state.scenario] ? state.scenario : "central";
  box.innerHTML = `
  <p class="note" style="margin-top:0">Timed on your <b>${esc(plan.scenarios[sid].label.toLowerCase())}</b> scenario (change it in 03 Your plan).</p>
  <div class="sub-h" id="d-watch">Watch messages</div>
  <div id="dWatch">${watchPanelHtml(plan)}</div>

  <div class="sub-h" id="d-pimp">Your pimped GPX</div>
  <div class="actions">
    <button class="btn primary" id="dlFit" type="button">Garmin course (.fit)</button>
    <button class="btn" id="dlGpx" type="button">GPX with messages</button>
    <span class="status" id="pimpStat" aria-live="polite"></span>
  </div>
  <p class="note">The course files carry this scenario's plan and your watch messages above: for example "HIKE 5.5k +726" (hike the next 5.5 km, 726 m up) or "!POWER HIKE 2.3k" at a key zone. Messages are at least 200 m and 1 minute apart. Import the .fit in Garmin Connect (Courses, Import) or copy it to the watch's GARMIN/NewFiles folder, then follow the course. The GPX works with other brands too.</p>`;
  const say = (t) => { $("#pimpStat").textContent = t; };
  mountWatch($("#dWatch"), { plan, sid, key: watchKey(plan, sid), say });
  $("#dlFit").addEventListener("click", () => exportCourse("fit", plan, sid, say));
  $("#dlGpx").addEventListener("click", () => exportCourse("gpx", plan, sid, say));
}

/* ---------- 04 race day replay ---------- */
/**
 * Section 04 Your race: the plan played back in time (ui/replay.js), in #s4body. Only drawn in
 * Prep my race mode. The key (race name | km) lets replay.js remember things per race.
 */
function renderReplay() {
  // Only on screen in Prep my race: drawing it in another mode would take the one map and
  // animation away from the cockpit that is showing (Prep my run). setMode draws it on the way back.
  const mode = document.documentElement.dataset.mode;
  if (mode && mode !== "plan") return;
  const box = $("#s4body");
  const calc = state.plan;
  if (!calc) {
    stopReplay();
    $("#s4ai").innerHTML = "";
    box.innerHTML = empty(`<b>Build your plan first</b> (both files, or press Try the demo), then come back to play your race day.`);
    return;
  }
  const sid = calc.scenarios[state.scenario] ? state.scenario : "central";
  // The Calculated / AI switch (airace.js): with AI on and an AI plan that fits this plan, the
  // cockpit plays the AI plan, rebuilt by code from the AI's answer; otherwise the calculated one.
  const key = raceKey();
  const ai = arState(calc, key);
  const on = state.aiOn && ai.state === "ok";
  const plan = on ? ai.result.plan : calc;
  $("#s4ai").innerHTML = arBarHtml(ai, on, calc.scenarios[sid].finishSec, on ? plan.scenarios[sid].finishSec : null);
  document.documentElement.classList.toggle("ai-on", on);
  mountCockpit(box, plan, sid, key);
}
/** The race key ("name|km"): what replay.js and the AI answer are remembered by. */
const raceKey = () => `${state.race && state.race.name}|${state.plan.course.totalKm.toFixed(2)}`;
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
/** The race-day cockpit (sections, map, profile, script) for any plan: a race, or a run to come. */
// box: the element to draw into; plan: a plan from buildPlan; sid: scenario id; key: a text that
// identifies the race; noun: "Race" or "Run", used in the cockpit's wording.
// It prepares the compact profile (flat: true) and the map colours, then hands everything to
// replay.js mountReplay, which runs the animation. Also used by Prep my run (see initPrepRun).
function mountCockpit(box, plan, sid, key, noun = "Race") {
  const sc = plan.scenarios[sid];
  const brief = { totalKm: plan.course.totalKm, climbs: plan.climbs, descents: plan.descents };
  const aidMarks = plan.aidStations.map((a) => ({ km: a.km, name: a.name, sec: a.arrive[sid], time: clock(plan.startSec, a.arrive[sid]) }));
  const prof = profileView(plan.course.profile, brief, { ...sc, startSec: plan.startSec, aid: aidMarks }, plan.keyZones, { flat: true });
  const m = mapStyle(brief, aidMarks, plan.keyZones);
  mountReplay(box, { plan, sid, prof, mapPaint: m.paint, mapMarks: m.marks, key, noun });
}

/* ---------- sticky navigation ---------- */
// Which section is on screen: an IntersectionObserver reports when each section crosses a thin
// band across the middle of the viewport, without listening to every scroll event.
/**
 * Update the top bar: mark as "ready" the links of sections that have something to show, and
 * show either a Your race button (once there is a plan) or a Try the demo button.
 * Sections s5, s6 and s-prep belong to other modules: they count as ready when an element those
 * modules draw (#rvCockpit, #inKpi, .prep-ready) exists. Also refreshes the A4 export button.
 */
function renderNav() {
  const plan = state.plan;
  const ready = { s1: Boolean(state.effort), s2: Boolean(state.race), s3: Boolean(plan), s4: Boolean(plan), "s-pimp": Boolean(plan), s5: Boolean($("#rvCockpit")), s6: Boolean($("#inKpi")), "s-prep": Boolean($("#sPrepBody .prep-ready")) };
  document.querySelectorAll(".tn-links a").forEach((a) => a.classList.toggle("ready", ready[a.dataset.sec]));
  const sum = $("#tnSum");
  if (plan) {
    sum.innerHTML = `<a class="btn primary sm" href="#rpCockpit">▶ Your race</a>`;
  } else sum.innerHTML = `<button class="btn ghost sm" type="button" id="tnDemo">Try the demo</button>`;
  const d = $("#tnDemo");
  if (d) d.addEventListener("click", () => $("#demo").click());
  const go = sum.querySelector('a[href="#rpCockpit"]');
  if (go) go.addEventListener("click", () => trackEvent("nav", "race-day-button"));
}
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

/* ---------- plan vs actual ---------- */
/**
 * The plan-versus-actual log in section 03: one row per checkpoint with the planned time, a box
 * for your real time and the gap (ahead or behind). plan: the plan; logKey: the storage key
 * prefix for this race. Two logs are kept, picked by the select: a training simulation and the
 * race result. Side effects: draws #logrows and saves what you type in localStorage.
 */
function drawLog(plan, logKey) {
  const mode = $("#logsel").value;
  const key = `${logKey}.${mode}`;
  const saved = store.get(key) || {};
  const sid = state.scenario;
  const cps = plan.scenarios[sid].checkpoints;
  // A first checkpoint under an hour (3600 s) is written as mm:ss, all others as h:mm.
  $("#logrows").innerHTML = cps.map((c, i) => {
    const first = i === 0;
    return `<div class="logrow"><span class="lbl">${esc(c.label)}</span><span>${first && c.sec < 3600 ? mmss(c.sec) : hm(c.sec)}</span><input type="text" inputmode="numeric" autocomplete="off" data-i="${i}" placeholder="${first && c.sec < 3600 ? "mm:ss" : "h:mm"}" value="${esc(saved[i] || "")}" aria-label="${esc(c.label)} actual time"><span class="delta" id="gap${i}"></span></div>`;
  }).join("");
  // update(): recompute every gap from what is typed. parseDuration(text, short) reads mm:ss when
  // short is true, else h:mm, and returns seconds or null. Within 5 s counts as on plan.
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
  // Typing updates the gaps at once ("input"); leaving the box ("change") saves all the times.
  $("#logrows").querySelectorAll("input").forEach((inp) => {
    inp.addEventListener("input", update);
    inp.addEventListener("change", () => {
      const o = {};
      $("#logrows").querySelectorAll("input").forEach((x) => { o[x.dataset.i] = x.value.trim(); });
      store.set(key, o);
      trackOnce("log-time-entered");
    });
  });
  update();
}

/* ---------- export ---------- */
/**
 * The plan as plain data for "Copy as JSON", without the heavy parts: the drawing profile, the
 * route and every scenario's timeline. JSON.stringify's second argument (a "replacer") is called
 * for each key: returning undefined drops that key. The text is parsed back to get a clean copy.
 */
function slimPlan(plan, sid) {
  return JSON.parse(JSON.stringify({ ...plan, scenarioShown: sid, course: { ...plan.course, profile: undefined, route: undefined } }, (k, v) => (k === "timeline" ? undefined : v)));
}
/** Show a short message next to the export buttons (if section 03 is drawn). */
function setExportStatus(t) { const el = $("#exportStat"); if (el) el.textContent = t; }
/* ---------- watch messages (ui/watch.js): saved per race, distance and scenario ---------- */
// The storage key for the watch messages you edited: one set per race name, distance and scenario.
const watchKey = (plan, sid) => `trp.watch.${(state.race && state.race.name) || "race"}.${plan.course.totalKm.toFixed(1)}.${sid}`;

/** Save the plan as a watch course: FIT (Garmin) or GPX with waypoints (any brand). */
// kind: "fit" or "gpx"; plan, sid: the plan and scenario; say(text): shows the result.
// The original GPX points (track) are passed along so the course follows the real route.
// downloadCourse (ui/watch.js) builds the file, starts the download and returns the file name.
function exportCourse(kind, plan, sid, say) {
  const name = (state.race && state.race.name) || "Race";
  const track = state.race && state.race.parsed ? state.race.parsed.points : null;
  try {
    const file = downloadCourse(kind, { plan, sid, track, name, points: watchPoints(plan, sid, watchKey(plan, sid)) });
    say(`Saved ${file}.`);
  } catch (e) { say(`Could not make the course: ${e.message}`); }
}

/**
 * Copy text to the clipboard. The modern way is navigator.clipboard.writeText (needs a secure
 * page, https or localhost, and returns a promise). When it is missing or refused, the fallback
 * puts the text in an invisible <textarea>, selects it and runs the older "copy" command.
 */
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
// sample), and put a button with its distance and duration in the top bar.
initRunMode({ onLoaded: (run, { sample, name } = {}) => {
  if (!sample) acctSaveRun(run, name);
  $("#tnRun").innerHTML = `<a class="btn primary sm" href="#rvCockpit">▶ ${run.totalKm.toFixed(1)} km · ${hm(run.elapsedSec)}</a>`;
  renderNav();
} });

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
// The profile's heart rates changed (account window): redraw the plan, its heart-rate guide uses them.
document.addEventListener("trp-profile", () => { if (state.race) compute(); });

// Start-up, in order: draw the empty sections, start Prep my run (it can reuse your reference
// runs and settings, and draws its own cockpit through mountCockpit), apply the mode from the
// address (?mode=...), then start anonymous analytics and the account menu.
compute();
prepCtl = initPrepRun({ getRuns: () => (state.effort ? state.effort.runs.map((r) => r.parsed) : []), getSettings: () => state.settings, onLoaded: () => renderNav(), cockpit: (box, plan, key) => mountCockpit(box, plan, "central", key, "Run") });
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
