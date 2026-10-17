// replay.js: section 04, the race-day replay. Plays the plan back in time: a runner moves
// along the map and the elevation profile, the clock runs at the predicted pace, and every
// key moment (climbs, gels, aid stations, key zones) shows a short cue to rehearse.
//
// Animation: requestAnimationFrame calls `frame` before each screen refresh (about 60 times
// a second). Each frame moves race time forward by (real seconds since the last frame x
// speed), then redraws only what changed: a few text fields, the runner on the map and the
// cursor on the profile. Nothing is re-rendered from scratch while it plays.
//
// Sections: the course is cut into numbered sections (raceLegs: each climb or climb section,
// each descent, the runnable stretches between). The section you are on is lit up in three
// places at once (the bar of sections above the map, the map, the profile) and its targets fill
// the panel next to the map. Those only change when you enter a new section, so draw() compares
// the section number with the last one and touches the DOM only then.
//
// Where it sits: main.js (Plan a race) and preprun.js (Prep my run, through main.js's cockpit)
// call mountReplay() with a finished plan (from src/core/plan.js) and a drawn profile. All the
// race facts come from src/core/script.js: raceScript (the list of moments), raceStateAt (where
// the runner is at a given second), raceLegs (the sections). This file only shows them and
// handles the buttons, the keyboard, the seek bar and clicks on the profile.
//
// Time unit: everything runs on "race seconds", seconds since the start gun (rp.sec). The
// clock of day is that plus plan.startSec (the start time, seconds after midnight).
//
// Main exports: mountReplay (build and wire the whole cockpit), stopReplay (stop and clean up),
// fitPanel and alignBar (two layout helpers also used by other screens).

import { raceScript, raceStateAt, secAtKm, raceLegs, raceTotals, legAtKm, gainLoss, racePaceLine } from "../core/script.js";
import { courseMap } from "./map.js";
import { mmss, hm, hms, clock } from "../core/format.js";
import { trackEvent, trackOnce } from "./analytics.js";

/**
 * The panel never scrolls: the "coming next" list keeps only the rows that fit in it.
 * Rows are shown again first, so a taller window gets them back.
 *
 * Input: `list`, the <ul> element inside the .rp-hud panel. Side effect: sets `hidden` on the
 * rows whose bottom edge falls below the panel's inner bottom edge.
 * getBoundingClientRect() gives an element's position and size on screen, in pixels.
 */
export function fitPanel(list) {
  // closest() walks up the page from `list` to the first parent matching the selector.
  const hud = list && list.closest(".rp-hud");
  if (!hud) return;
  // [...list.children] copies the live list of child elements into a plain array.
  const rows = [...list.children];
  rows.forEach((li) => { li.hidden = false; });
  // The panel's bottom edge minus its bottom padding: the last pixel a row may reach.
  const bottom = hud.getBoundingClientRect().bottom - parseFloat(getComputedStyle(hud).paddingBottom || 0);
  // 1 px of tolerance for rounding.
  rows.forEach((li) => { if (li.getBoundingClientRect().bottom > bottom + 1) li.hidden = true; });
}

// Escape text before putting it in HTML: the regex [&<>"] matches each of those four characters,
// and each is replaced by its HTML entity, so a name like "A<B" shows as text, not as a tag.
const escR = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
// Replay speeds: v = race seconds per real second. 360 means one race hour (3600 s) plays in
// 10 real seconds.
const SPEEDS = [
  { v: 120, label: "1 h in 30 s" },
  { v: 360, label: "1 h in 10 s" },
  { v: 900, label: "1 h in 4 s" },
];
/**
 * Altitude at `km` on the profile, linear between points.
 * P is the profile: [[km, elevation in metres], ...] sorted by km. A simple forward scan finds
 * the first point at or past `km`; the result is interpolated between it and the point before.
 * The clamp (0 to 1) keeps a km outside the profile on its end values; `|| 1` avoids dividing
 * by zero when two points share the same km.
 */
function eleOn(P, km) {
  let i = 1;
  while (i < P.length - 1 && P[i][0] < km) i++;
  const a = P[i - 1], b = P[i];
  return a[1] + Math.max(0, Math.min(1, (km - a[0]) / (b[0] - a[0] || 1))) * (b[1] - a[1]);
}
// Length and climb of a section, written out under its title.
const legData = (l) => `${(l.endKm - l.startKm).toFixed(1)} km · +${Math.round(l.up)} / −${Math.round(l.down)} m`;
// The symbol shown for each kind of moment or section (the "kind" field from core/script.js).
const ICON = { start: "▶", climb: "▲", top: "⛰", descent: "▼", gel: "G", aid: "⛺", phase: "◐", key: "★", ai: "✦", finish: "🏁" };

// Survives re-renders (a scenario switch, a settings change), so the replay keeps its place.
// It lives at module level (outside any function), so there is one for the whole page.
//   key      identifies the course being replayed; a new key means a new course: start at 0
//   sec      current race time, in seconds since the start
//   playing  true while the animation runs
//   speed    race seconds per real second (one of SPEEDS)
//   pauseAt  "Stop at each moment" ticked: pause on every moment of the script
//   follow   "Follow the runner" ticked: the map keeps the runner in view
//   raf      id of the pending requestAnimationFrame, to cancel it
//   map      the map controller from map.js, or null
// Set later: last (timestamp of the previous frame, ms) and onKey (the keyboard listener).
const rp = { key: "", sec: 0, playing: false, speed: 360, pauseAt: false, follow: false, raf: 0, map: null };

/**
 * Mount the replay in `box`. `prof` draws the profile: {html, x(km), y(ele)} in SVG units of a
 * viewBox 1000 wide, with a `.pcur` group to move. `mapPaint` / `mapMarks` style the route.
 * `noun` names what plays ("Race", or "Run" in Prep my run).
 * (This block describes mountReplay, further down.)
 */
/**
 * Line the section bar up with the profile: pad `bar` so its km 0 and its finish sit right above
 * the profile's own km 0 and finish. `x0`/`x1` are those two points in the SVG's viewBox units;
 * getScreenCTM() turns them into screen pixels, whatever size the SVG is drawn at. Runs again
 * whenever the profile is resized (window, phone rotation, a fold opening).
 *
 * getScreenCTM() returns a matrix {a, b, c, d, e, f}: a screen x = a x (SVG x) + e when the
 * SVG is not rotated, so `m.a * x0 + m.e` is the screen x of km 0.
 * Side effect: sets the bar's left and right padding (in px), or clears them.
 */
export function alignBar(bar, svg, x0, x1) {
  if (!bar || !svg || typeof svg.getScreenCTM !== "function") return;
  const fit = () => {
    const m = svg.getScreenCTM();
    const r = bar.getBoundingClientRect();
    if (!m || !r.width) return;
    // Pixels between the bar's left edge and km 0, and between the finish and the bar's right edge.
    const left = m.a * x0 + m.e - r.left, right = r.right - (m.a * x1 + m.e);
    // A profile scrolled sideways (wider than its box) cannot be matched: keep the full-width bar.
    const ok = left >= 0 && right >= 0 && left + right < r.width / 2;
    bar.style.paddingLeft = ok ? `${left.toFixed(1)}px` : "";
    bar.style.paddingRight = ok ? `${right.toFixed(1)}px` : "";
  };
  fit();
  if (typeof ResizeObserver === "function") new ResizeObserver(fit).observe(svg);
}

// Each pace line gets its own clip ids (rpPc1Past...), so two profiles on the page never share one.
let rpPaceN = 0;

/**
 * The pace line on a replay's profile, the same one Rewind my run draws: speed (higher = faster)
 * along the course, scaled between the slow 5% and the fast 5% so one steep wall does not squash
 * the rest, drawn thin and faint, with only the WHOLE current section lit, a dot at the runner and
 * the live pace written next to it. Used by every replay built on mountReplay: Your race (with
 * the calculated plan or the AI one) and Prep my run.
 *
 * How it works: the same SVG path is drawn three times, each copy inside a clipPath (a stencil:
 * only what lies inside its rectangle shows). One rectangle covers the course before the current
 * section, one the section itself (the lit copy), one the rest. Moving the runner only moves and
 * resizes those three rectangles, which is far cheaper than redrawing the line every frame.
 *
 * Inputs: svg, the profile <svg>; cur, its cursor group (the line goes just under it); prof, the
 * geometry from profileView (x, top, base, l, r, W, H); pl, the speeds [{km, v}] (racePaceLine).
 * Returns { draw(km, leg, sec, stopText) } to call on each frame, or null with too little data.
 */
function mountPaceLine(svg, cur, prof, pl) {
  const vs = pl.map((p) => p.v).filter((v) => v > 0).sort((a, b) => a - b);
  if (vs.length < 5) return null;
  const { x, l, r, W, H, top, base } = prof;
  // Percentiles with a little margin, then speed to y: clamped, fast at the top.
  const vlo = vs[Math.floor(vs.length * 0.05)] * 0.95, vhi = vs[Math.floor(vs.length * 0.95)] * 1.03;
  const yHi = top + 4, yLo = base - 10;
  const paceY = (v) => yLo - ((Math.max(vlo, Math.min(vhi, v)) - vlo) / Math.max(1e-6, vhi - vlo)) * (yLo - yHi);
  const d = pl.filter((p) => p.v > 0).map((p, i) => `${i ? "L" : "M"}${x(p.km).toFixed(1)},${paceY(p.v).toFixed(1)}`).join("");
  const id = `rpPc${++rpPaceN}`;
  const clip = (k) => `<clipPath id="${id}${k}"><rect x="${l}" y="0" width="0" height="${H}"/></clipPath>`;
  // insertAdjacentHTML on an SVG element parses the text as SVG (its parent sets the namespace),
  // so these become real SVG elements. "beforebegin" puts them just before the cursor: on top of
  // the profile, under the cursor.
  cur.insertAdjacentHTML("beforebegin", `<defs>${clip("Past")}${clip("Trail")}${clip("Ahead")}</defs><g class="rv-pace rp-pace">`
    + `<path class="rv-pl ahead" clip-path="url(#${id}Ahead)" d="${d}"/><path class="rv-pl past" clip-path="url(#${id}Past)" d="${d}"/><path class="rv-pl trail" clip-path="url(#${id}Trail)" d="${d}"/>`
    + `<text class="rv-pl-t" x="${W - r - 2}" y="${(yHi + 3).toFixed(1)}" text-anchor="end">${mmss(1000 / vhi)}/km</text><text class="rv-pl-t" x="${W - r - 2}" y="${(yLo + 3).toFixed(1)}" text-anchor="end">${mmss(1000 / vlo)}/km</text>`
    + `<circle class="rv-pl-dot" r="4.5" cx="${x(0)}" cy="${paceY(pl[0].v || vlo).toFixed(1)}"/><text class="rv-pl-v" x="${x(0)}" y="0"></text></g>`);
  // The group just added: the parent of the path clipped by this line's own clip.
  const g = svg.querySelector(`[clip-path="url(#${id}Ahead)"]`).parentNode;
  const rect = (k) => svg.querySelector(`#${id}${k} rect`);
  const R = { past: rect("Past"), trail: rect("Trail"), ahead: rect("Ahead") };
  const dot = g.querySelector(".rv-pl-dot");
  const txt = g.querySelector(".rv-pl-v");
  // Speed at km k, interpolated between the 100 m points (a short walk from the start: 1000
  // points at most, cheap enough once per frame).
  const vAt = (k) => { let i = 1; while (i < pl.length - 1 && pl[i].km < k) i++; const a = pl[i - 1], b = pl[i]; const f = Math.max(0, Math.min(1, (k - a.km) / (b.km - a.km || 1))); return a.v + f * (b.v - a.v); };
  return {
    draw(km, leg, sec, stopText) {
      const ax = x(leg.startKm), bx = x(leg.endKm), cx = x(km);
      R.past.setAttribute("width", Math.max(0, ax - l).toFixed(1));
      R.trail.setAttribute("x", ax.toFixed(1));
      R.trail.setAttribute("width", Math.max(0, bx - ax).toFixed(1));
      R.ahead.setAttribute("x", bx.toFixed(1));
      R.ahead.setAttribute("width", Math.max(0, W - r - bx).toFixed(1));
      const v = vAt(km);
      const cy = paceY(v);
      dot.setAttribute("cx", cx.toFixed(1));
      dot.setAttribute("cy", cy.toFixed(1));
      g.classList.toggle("on", sec > 0);
      txt.textContent = sec > 0 ? stopText || (v > 0 ? `${mmss(1000 / v)}/km` : "") : "";
      // Near the right edge the text goes on the left of the dot, so it stays inside the plot.
      const right = cx > W - 120;
      txt.setAttribute("x", (cx + (right ? -9 : 9)).toFixed(1));
      txt.setAttribute("y", (cy - 6).toFixed(1));
      txt.setAttribute("text-anchor", right ? "end" : "start");
    },
  };
}

/**
 * Build the replay cockpit inside `box` and wire every control (see the block two comments up
 * for `prof`, `mapPaint`, `mapMarks` and `noun`). Other inputs:
 *   plan  the plan from core/plan.js (course, scenarios, aid stations, startSec...)
 *   sid   the scenario shown: "best", "central" or "cautious"
 *   key   an id of the course; the same key as last time keeps the replay where it was
 * Returns nothing. Side effects: replaces box's HTML, creates a map, adds listeners on the
 * document (keyboard, clicks outside the section pop-up), sends analytics events.
 *
 * Structure: (1) compute the data, (2) write the HTML once, (3) keep references to the elements
 * that change, (4) draw() puts the state at rp.sec on screen, (5) frame() advances time while
 * playing, (6) event listeners for buttons, seek bar, sections, script list, profile, keyboard.
 * All the small functions below are closures: they are created inside mountReplay and keep
 * access to its local variables (plan, legs, els...) for as long as the page uses them.
 */
export function mountReplay(box, { plan, sid, prof, mapPaint, mapMarks, key, noun = "Race" }) {
  // 1. Data. Stop any replay already running, and restart from 0 on a different course.
  stopReplay();
  if (rp.key !== key) { rp.key = key; rp.sec = 0; }
  const st = plan.startSec;
  const sc = plan.scenarios[sid];
  // The moments to rehearse, in time order: [{kind, title, cue, km, sec, level}, ...].
  const script = raceScript(plan, sid);
  // A scenario switch can make the race shorter: keep the position inside it.
  rp.sec = Math.min(rp.sec, sc.finishSec);
  const hasMap = Boolean(plan.course.route);
  // The numbered sections: [{i, kind, level, title, label, tactic, startKm, endKm, startSec,
  // endSec, km, up, down, avg, pace, durSec, keyZone}, ...].
  const legs = raceLegs(plan, sid);
  // Totals for the four tiles at the top (duration, stops, gain, paces, finish).
  const tot = raceTotals(plan, sid);
  const TOT_KM = plan.course.totalKm;
  // A km as a percentage of the course: used to place sections and aid stations on the bar.
  const pct = (km) => `${((km / TOT_KM) * 100).toFixed(3)}%`;
  // CSS classes of a section: its kind, plus its difficulty level (l1..l4) unless it is flat.
  const legCls = (l) => `k-${l.kind}${l.kind === "flat" ? "" : ` l${l.level}`}`;
  // One of the four target tiles: a key, a big value and an optional small line under it.
  const totTile = (k, v, sub, cls = "") => `<div class="rp-tot ${cls}"><span class="k">${k}</span><b>${v}</b>${sub ? `<small>${sub}</small>` : ""}</div>`;

  // 2. HTML, written once.
  // Everything you need while it plays sits in one screen-high "cockpit": race targets, the
  // section bar, the map, the panel (clock, target vs now, cue), the profile and the controls.
  // CSS grid places them; the map takes whatever height is left, so it shrinks on small screens.
  // Below the cockpit: the full race script as a list (one button per moment).
  // Each section button carries data-i (its index in `legs`) so a click knows which one it is.
  box.innerHTML = `
  <div class="rp-cockpit${hasMap ? "" : " nomap"}" id="rpCockpit">
  <div class="rp-totals" aria-label="${noun} targets">
    ${totTile("Duration", hm(tot.durationSec), `${Math.round(tot.stopSec / 60)} min of stops`)}
    ${totTile("Distance", `${TOT_KM.toFixed(1)}<small>km</small>`, `${Math.round(tot.gain)} m D+ · ${legs.length} sections`)}
    ${totTile("Average pace", `${mmss(tot.paceSec)}<small>/km</small>`, `moving ${mmss(tot.movingPaceSec)}/km`)}
    ${totTile(`Finish · ${escR(sc.label.toLowerCase())}`, clock(st, tot.finishSec), `start ${clock(st, 0)}`)}
  </div>
  <div class="rp-legbar">
    <div class="rp-legs" id="rpLegs" role="group" aria-label="${noun} sections">${legs.map((l) => `<button type="button" class="lg ${legCls(l)}${l.keyZone ? " kz" : ""}" data-i="${l.i - 1}" style="left:${pct(l.startKm)};width:${pct(l.endKm - l.startKm)}" title="${l.i}. ${escR(l.title)} · ${escR(l.label)} · km ${l.startKm.toFixed(1)} → ${l.endKm.toFixed(1)}" aria-label="Section ${l.i}: ${escR(l.title)}"></button>`).join("")}
      ${plan.aidStations.map((a) => `<i class="lg-aid" style="left:${pct(a.km)}" title="${escR(a.name)}"></i>`).join("")}
      <i class="lg-pos" id="rpLegPos"></i>
    </div>
    <div class="rp-legfoot">
      <div class="rp-legnow" id="rpLegNow" aria-live="polite"></div>
      <div class="rp-legend" aria-label="Legend">${[1, 2, 3, 4].map((l) => `<span class="chip st l${l}" title="${["", "Easy", "Moderate", "Hard", "Crux"][l]}">${"★".repeat(l)}<i>${"★".repeat(4 - l)}</i></span>`).join("")}<span><i class="sw fl"></i>Runnable</span><span><i class="sw ds"></i>Descent</span><span><i class="sw ds4"></i>Brake</span><span><i class="sw kz"></i>Key zone</span><span><i class="sw ad"></i>Aid</span><span><i class="sw rv-pl-sw"></i>Pace</span></div>
    </div>
  </div>
    ${hasMap ? `<div class="rp-map" id="rpMap"></div>` : ""}
    <div class="panel rp-hud">
      <div class="rp-top">
        <div class="rp-clock"><span class="k">Duration</span><b id="rpClock"></b></div>
        <div class="rp-run"><span id="rpUp"></span><span id="rpKm"></span><span id="rpElapsed"></span></div>
      </div>
      <div class="rp-prog" aria-hidden="true"><i id="rpBar"></i></div>
      <div class="rp-leg" id="rpLeg"></div>
      <div class="rp-now" id="rpNow" hidden></div>
      <p class="rp-cue-line" id="rpCue" aria-live="polite"></p>
      ${plan.ai ? `<div class="rp-ai-box" id="rpAi" aria-live="polite"></div>` : ""}
      <ul class="kv rp-next" id="rpNext"></ul>
    </div>
  <div class="prof-wrap rp-prof" id="rpProf">${prof.html}</div>
  <div class="rp-controls">
    <button class="btn icon" type="button" id="rpPrev" aria-label="Previous moment" title="Previous moment (←)">⏮</button>
    <button class="btn primary rp-play" type="button" id="rpPlay"></button>
    <button class="btn icon" type="button" id="rpNextBtn" aria-label="Next moment" title="Next moment (→)">⏭</button>
    <input type="range" id="rpSeek" min="0" max="${Math.round(sc.finishSec)}" step="10" aria-label="${noun} time">
    <label class="f inline">Speed<select id="rpSpeed" aria-label="Replay speed">${SPEEDS.map((s) => `<option value="${s.v}" ${s.v === rp.speed ? "selected" : ""}>${s.label}</option>`).join("")}</select></label>
    <label class="chk"><input type="checkbox" id="rpPause" ${rp.pauseAt ? "checked" : ""}> Stop at each moment</label>
    ${hasMap ? `<label class="chk"><input type="checkbox" id="rpFollow" ${rp.follow ? "checked" : ""}> Follow the runner</label>` : ""}
  </div>
  </div>
  <div class="sub-h" id="rp-script">${noun} script · ${script.length} moments</div>
  <ol class="rp-script" id="rpScript">${script.map((e, i) => `<li data-i="${i}" class="k-${e.kind} lv${e.level}"><button type="button"><span class="ic">${ICON[e.kind] || "•"}</span><span class="t"><b>${escR(e.title)}</b><small>km ${e.km.toFixed(1)} · ${clock(st, e.sec)}</small></span><span class="cue">${escR(e.cue)}</span></button></li>`).join("")}</ol>`;

  // 3. Find the elements once and keep them in `els`, so each frame does not search the page.
  // $r(selector) is a short name for "the first element in this box matching the CSS selector".
  const $r = (s) => box.querySelector(s);
  const els = { leg: $r("#rpLeg"), legNow: $r("#rpLegNow"), legPos: $r("#rpLegPos"), legBtns: [...box.querySelectorAll("#rpLegs .lg")], clock: $r("#rpClock"), el: $r("#rpElapsed"), bar: $r("#rpBar"), km: $r("#rpKm"), up: $r("#rpUp"), now: $r("#rpNow"), next: $r("#rpNext"), cue: $r("#rpCue"), ai: box.querySelector("#rpAi"), play: $r("#rpPlay"), seek: $r("#rpSeek"), cur: $r("#rpProf .pcur"), list: $r("#rpScript") };
  // A window resize changes the room in the panel: fit the "coming next" list again.
  if (typeof ResizeObserver === "function") new ResizeObserver(() => fitPanel(els.next)).observe($r(".rp-hud"));
  alignBar($r(".rp-legbar"), $r("#rpProf svg"), prof.x(0), prof.x(plan.course.totalKm));
  if (hasMap) {
    rp.map = courseMap($r("#rpMap"), { route: plan.course.route, totalKm: plan.course.totalKm, paint: mapPaint, marks: mapMarks });
    // Follow only once the replay has started (at 0 the whole course is more useful).
    rp.map.follow(rp.follow && rp.sec > 0);
  }

  // Profile: a soft band over the section you are on, and a glow drawn UNDER the coloured line
  // (inserted right after the area fill), so the section keeps its own colours and only shines.
  const svgEl = $r("#rpProf svg");
  const P = plan.course.profile;
  // SVG path data ("M x,y L x,y ...": move to the first point, then straight lines) following
  // the profile from km a to km b, with exact interpolated ends.
  const linePts = (a, b) => {
    const pts = [[a, eleOn(P, a)], ...P.filter((p) => p[0] > a && p[0] < b), [b, eleOn(P, b)]];
    return pts.map((p, i) => `${i ? "L" : "M"}${prof.x(p[0]).toFixed(1)},${prof.y(p[1]).toFixed(1)}`).join("");
  };
  // Two SVG groups (<g>) made once and refilled on each section change: legG (the band and the
  // section number) and glowG (the glow under the line).
  let legG = null;
  let glowG = null;
  if (svgEl && els.cur) {
    // SVG elements must be created with their namespace, or the browser treats them as unknown
    // HTML tags and draws nothing.
    const NS = "http://www.w3.org/2000/svg";
    legG = document.createElementNS(NS, "g");
    legG.setAttribute("class", "pleg");
    // insertBefore(new, ref) puts the band just under the cursor, so the cursor stays on top.
    svgEl.insertBefore(legG, els.cur);
    glowG = document.createElementNS(NS, "g");
    glowG.setAttribute("class", "pglow");
    const area = svgEl.querySelector(".area");
    svgEl.insertBefore(glowG, area ? area.nextSibling : svgEl.firstChild);
    // The hover pop-up says it all: no native tooltips on top of it.
    svgEl.querySelectorAll("title").forEach((t) => t.remove());
  }
  const pace = svgEl && els.cur ? mountPaceLine(svgEl, els.cur, prof, racePaceLine(plan, sid)) : null;
  /**
   * Light up section number `li` (index in `legs`) everywhere: band and glow on the profile,
   * scroll of the profile on a phone, glow on the map, and on/past/next classes on the bar.
   * Called only when the runner enters a new section.
   */
  const drawLeg = (li) => {
    const l = legs[li];
    const n = legs[li + 1] || null;
    // A rectangle from the section's start to its end, over the full height of the profile
    // (at least 2 units wide so a very short section still shows).
    const band = (x, cls) => `<rect class="${cls}" x="${prof.x(x.startKm).toFixed(1)}" y="${prof.top - 4}" width="${Math.max(2, prof.x(x.endKm) - prof.x(x.startKm)).toFixed(1)}" height="${prof.base - prof.top + 4}"/>`;
    if (legG) {
      // lx: middle of the section, where its number is written.
      const lx = (prof.x(l.startKm) + prof.x(l.endKm)) / 2;
      legG.innerHTML = band(l, "pl-cur") + `<text class="pl-t" x="${lx.toFixed(1)}" y="${prof.base - 6}" text-anchor="middle">${l.i}</text>`;
      glowG.innerHTML = `<path class="pl-glow" d="${linePts(l.startKm, l.endKm)}"/>`;
    }
    // On a phone the profile is wider than the screen: bring the section into view.
    // k converts viewBox units (1000 wide) to scroll pixels; centre on the middle of this
    // section and the next one, so you also see what comes.
    if (profScroll && profScroll.scrollWidth > profScroll.clientWidth + 4) {
      const k = profScroll.scrollWidth / 1000;
      const mid = ((prof.x(l.startKm) + prof.x((n || l).endKm)) / 2) * k;
      profScroll.scrollLeft = Math.max(0, mid - profScroll.clientWidth / 2);
    }
    if (rp.map) rp.map.highlight({ fromKm: l.startKm, toKm: l.endKm });
    // classList.toggle(name, condition) adds the class when the condition is true, removes it otherwise.
    els.legBtns.forEach((b, k) => { b.classList.toggle("on", k === li); b.classList.toggle("past", k < li); b.classList.toggle("nx", k === li + 1); });
  };
  // Average gradient with its sign, e.g. "+7.4%" or "-3.0%".
  const gradeTxt = (l) => `${l.avg > 0 ? "+" : ""}${l.avg.toFixed(1)}%`;
  // A runnable stretch says so in its title already: no chip repeating it.
  // Climbs show their difficulty as 1 to 4 stars (the word stays in the tooltip); descents keep their word.
  const legChip = (l) => (l.kind === "flat" ? "" : l.kind === "climb" ? `<span class="chip st l${l.level}" title="${escR(l.label)}">${"★".repeat(l.level)}<i>${"★".repeat(4 - l.level)}</i></span>` : `<span class="chip l${l.level}">${escR(l.label)}</span>`);
  // The scrolling box around the profile (used by drawLeg above: it runs only later, after this
  // line has set the value).
  const profScroll = $r("#rpProf .prof-scroll");

  // 4. draw(): put the state at rp.sec on screen. Runs on every frame while playing, so it
  // compares with what it drew last time (the last* variables) and skips work that would not
  // change anything. Writing innerHTML is the slow part; textContent and style are cheap.
  let lastLeg = -1;
  let lastCue = -1;
  let lastNowHtml = "";
  let lastNextHtml = "";
  const draw = () => {
    // s: where the runner is at this second (km, ele, grade, pace, frac of the race done,
    // aid station if stopped at one, key zone, next gel / aid / climb / key zone...).
    const s = raceStateAt(plan, sid, rp.sec);
    // Time since the start is the number that matters on course; the time of day is secondary.
    els.clock.textContent = hms(s.sec);
    // Under the clock, what matters most first: the climbing done, then the distance, then the
    // time of day. gainLoss adds up every rise of the profile from the start to the runner.
    els.up.innerHTML = `<b>+${Math.round(gainLoss(P, 0, s.km).up)}</b> / ${Math.round(tot.gain)} m D+`;
    // Share of the race done first, then km done / total, on one line (design review 2).
    els.km.innerHTML = `<b class="pct">${Math.round(s.frac * 100)}%</b> · <b>${s.km.toFixed(1)}</b> / ${plan.course.totalKm.toFixed(1)} km`;
    els.el.textContent = `clock ${clock(st, s.sec)}`;
    els.bar.style.width = `${(s.frac * 100).toFixed(2)}%`;
    els.seek.value = Math.round(s.sec);
    // The section you are on: lit up everywhere when it changes, its countdown on every frame.
    const li = legAtKm(legs, s.km);
    const l = legs[li];
    if (li !== lastLeg) {
      lastLeg = li;
      drawLeg(li);
      const n = legs[li + 1];
      els.leg.className = `rp-leg k-${l.kind} lv${l.level}`;
      // Target (the plan for this section) next to Now (where the replay is): the Now column is
      // filled on every frame, the rest only when the section changes.
      // row(): one table row; `id` names the Now cell so it can be found and updated later.
      const row = (k, target, id) => `<tr><th>${k}</th><td>${target}</td><td class="now" ${id ? `id="${id}"` : ""}>${id ? "" : "–"}</td></tr>`;
      // The section card: number, title, chips, tactic, what comes next, and the target table.
      els.leg.innerHTML = `
        <div class="rp-leg-h"><span class="rp-leg-n"><small>Section</small><b>${l.i}</b><small>/ ${legs.length}</small></span>
          <span class="rp-leg-pct" aria-live="off"><b id="rpLegPct"></b><small>done</small></span>
          <span class="rp-leg-t"><b>${escR(l.title)}</b>${legChip(l)}<span class="rp-leg-len">${(l.endKm - l.startKm).toFixed(1)} km</span>${l.keyZone ? ` <span class="chip keyc">★ Key zone ${l.keyZone.n}</span>` : ""}
          </span></div>
        <div class="rp-leg-info">
          <p class="k-${l.kind}"><span class="ic">${ICON[l.kind] || "➜"}</span><b title="${escR(l.tactic)}">${escR(l.tactic)}</b><span class="d">${legData(l)}</span></p>
          ${l.ai && l.ai.effort ? `<p class="rp-ai-note"><span class="ic">${ICON.ai}</span><b>Effort ${l.ai.effort}/5</b><span>${escR(l.ai.mode || "")}</span></p>` : ""}
          <p class="nx ${n ? `k-${n.kind}` : ""}"><span class="lab">Next</span>${n ? `<span class="ic">${ICON[n.kind] || "➜"}</span><b>${n.i}. ${escR(n.title)}</b><span class="d">${legData(n)}</span>` : `<span class="ic">${ICON.finish}</span><b>Finish</b>`}</p>
        </div>
        <table class="rp-tg">
          <thead><tr><th></th><th>Target</th><th class="now">Now</th></tr></thead>
          <tbody>
            ${row("Pace", l.pace ? `${mmss(l.pace)}/km` : "–", "tnPace")}
            ${row("Gradient", `${gradeTxt(l)} <small>avg</small>`, "tnGrade")}
            ${row("Elevation done", `+${Math.round(l.up)} / −${Math.round(l.down)} m`, "tnEle")}
            ${row("Section done", `${l.km.toFixed(2)} km`, "tnPct")}
            ${row("Section time", hm(l.durSec), "tnTime")}
          </tbody>
        </table>`;
      // The latest moment (a key zone, a climb, an aid station...) is written first under the title.
      // prepend() moves the existing cue element (it is not copied) to the top of the card.
      els.leg.querySelector(".rp-leg-info").prepend(els.cue);
      // The five Now cells, found once per section: { Pace: td, Grade: td, Ele: td, Pct: td, Time: td }.
      els.tn = Object.fromEntries(["Pace", "Grade", "Ele", "Pct", "Time"].map((k) => [k, els.leg.querySelector(`#tn${k}`)]));
      // Where you are, always on top of the box: % of this section done and % of the whole course.
      els.legPct = els.leg.querySelector("#rpLegPct");
      lastNextHtml = ""; // the card changed height: fit the list below it again
    }
    // Every frame: what is left in this section, in km and seconds (never below 0).
    const leftKm = Math.max(0, l.endKm - s.km);
    const leftSec = Math.max(0, l.endSec - s.sec);
    els.legNow.innerHTML = `<b>Section ${l.i}/${legs.length}</b> · ${escR(l.title)} ${legChip(l)} <span class="left">${leftKm.toFixed(1)} km · ${leftSec >= 3600 ? hm(leftSec) : `${Math.round(leftSec / 60)} min`} to go in it</span>`;
    // The small position mark on the section bar.
    els.legPos.style.left = `${(s.frac * 100).toFixed(2)}%`;
    // Minutes spent in this section so far.
    const inMin = Math.max(0, Math.round((s.sec - l.startSec) / 60));
    // The Now column. A pace of 0 means the runner is stopped (at an aid station).
    els.tn.Pace.textContent = s.pace ? `${mmss(s.pace)}/km` : "stopped";
    els.tn.Grade.textContent = s.aid ? "–" : `${s.grade > 0 ? "+" : ""}${s.grade.toFixed(0)}%`;
    // Climbed and dropped since the section started, against what the whole section holds.
    const done = gainLoss(P, l.startKm, Math.max(l.startKm, Math.min(l.endKm, s.km)));
    els.tn.Ele.textContent = `+${Math.round(done.up)} / −${Math.round(done.down)} m`;
    // Share of the section's distance done, in %. (This `pct` hides the pct() helper above,
    // inside draw() only.)
    const pct = l.km > 0 ? Math.round((Math.min(l.km, Math.max(0, s.km - l.startKm)) / l.km) * 100) : 100;
    els.tn.Pct.innerHTML = `${pct}% <small>${leftKm.toFixed(1)} km left</small>`;
    els.legPct.textContent = `${pct}%`;
    els.tn.Time.innerHTML = `${inMin} min <small>${leftSec >= 3600 ? hm(leftSec) : `${Math.round(leftSec / 60)} min`} left</small>`;
    // The play button's label: Pause while playing, Replay at the finish, Resume part way, Play at 0.
    // (a ? b : c ? d : e is a chain of "if a then b, else if c then d, else e".)
    els.play.innerHTML = rp.playing ? "❚❚ Pause" : rp.sec >= sc.finishSec ? "↺ Replay" : rp.sec > 0 ? "▶ Resume" : `▶ Play ${noun === "Race" ? "race day" : "your run"}`;

    // The section card says what you are on; this line only flags a stop or the finish.
    // aid.arrive[sid] is the arrival second in this scenario; adding the stop gives the time out.
    let now = "";
    if (s.aid) now = `<span class="chip aidc">Aid station</span> <b>${escR(s.aid.name)}</b> · out at ${clock(st, s.aid.arrive[sid] + s.aid.stopMin * 60)}`;
    else if (s.sec >= sc.finishSec) now = `<span class="chip l1">Done</span> <b>Finished</b> · ${hm(sc.finishSec)}`;
    if (now !== lastNowHtml) { els.now.innerHTML = now; els.now.hidden = !now; lastNowHtml = now; }

    // "Coming next" list: the key zone you are in (or the next one), the next gel, aid station
    // and climb. Each line is "" when there is none; join("") glues them, and `||` supplies the
    // finish line when all four are empty (an empty string counts as false).
    // until(sec): time from now to that race second, as "12 min" or "1h05".
    const until = (sec) => { const m = Math.max(0, Math.round((sec - s.sec) / 60)); return m >= 60 ? hm(m * 60) : `${m} min`; };
    const next = [
      s.keyZone ? `<li class="key"><span>★ Key zone ${s.keyZone.n}</span><b>until km ${s.keyZone.toKm.toFixed(1)}</b></li>` : s.nextKey ? `<li><span>Next key zone · ${s.nextKey.n}</span><b>km ${s.nextKey.fromKm.toFixed(1)} · ${clock(st, secAtKm(plan, sid, s.nextKey.fromKm))}</b></li>` : "",
      s.nextGel ? `<li><span>Next gel</span><b>in ${until(s.nextGel.sec)} · km ${s.nextGel.km.toFixed(1)}</b></li>` : "",
      s.nextAid ? `<li><span>Next aid · ${escR(s.nextAid.name)}</span><b>${(s.nextAid.km - s.km).toFixed(1)} km · ${clock(st, s.nextAid.arrive[sid])}</b></li>` : "",
      s.nextClimb ? `<li><span>Next climb · #${s.nextClimb.n}</span><b>${Math.round(s.nextClimb.gain)} m · in ${until(s.nextClimb.start[sid])}</b></li>` : "",
    ].join("") || `<li><span>Nothing left but the finish</span><b></b></li>`;
    if (next !== lastNextHtml) { els.next.innerHTML = next; lastNextHtml = next; fitPanel(els.next); }

    // The cue on screen is the latest moment reached.
    // The script is sorted by time: scan forward while the moment is not in the future
    // (0.5 s of tolerance, as moments are reached by seeking to their second + 1).
    let ci = -1;
    for (let i = 0; i < script.length && script[i].sec <= s.sec + 0.5; i++) ci = i;
    // AI plan only: the AI message box. An AI key moment reached in this section speaks first,
    // else the AI's note and reason for the section. Redrawn when the section or the moment changes.
    if (els.ai && (ci !== lastCue || els.ai.dataset.leg !== String(li))) {
      els.ai.dataset.leg = String(li);
      const e = ci >= 0 ? script[ci] : null;
      const m = e && e.kind === "ai" && e.km >= l.startKm - 1e-6 ? e : null;
      const a = l.ai || {};
      const lines = m ? [`<b>${escR(m.title)}</b> ${escR(m.cue)}`] : [a.note ? escR(a.note) : "", a.why ? `<small>Why: ${escR(a.why)}</small>` : ""].filter(Boolean);
      els.ai.innerHTML = lines.length ? `<span class="ic">${ICON.ai}</span><div>${lines.map((x) => `<p>${x}</p>`).join("")}</div>` : `<span class="ic">${ICON.ai}</span><div><p class="muted">No AI message on this section.</p></div>`;
    }
    if (ci !== lastCue) {
      lastCue = ci;
      // Before the first moment, show the first one anyway (Math.max avoids index -1).
      const e = script[Math.max(0, ci)];
      els.cue.className = `rp-cue-line k-${e.kind} lv${e.level}`;
      els.cue.title = e.cue;
      els.cue.innerHTML = `<span class="ic">${ICON[e.kind] || "•"}</span><b>${escR(e.title)}</b><span class="d">km ${e.km.toFixed(1)} · ${hm(e.sec)}</span>`;
      // In the script list below: mark the current moment and grey the past ones.
      els.list.querySelectorAll("li").forEach((li) => { li.classList.toggle("on", Number(li.dataset.i) === ci); li.classList.toggle("past", Number(li.dataset.i) < ci); });
    }
    // The pace line: the whole current section lit, the dot and the live pace at the runner.
    if (pace) pace.draw(s.km, l, s.sec, s.aid ? "stopped" : "");
    // Profile cursor: slide the group sideways to the km, then put its dot at the elevation.
    if (els.cur) {
      els.cur.style.display = "";
      els.cur.setAttribute("transform", `translate(${prof.x(s.km).toFixed(1)},0)`);
      els.cur.querySelector("circle").setAttribute("cy", prof.y(s.ele).toFixed(1));
    }
    if (rp.map) rp.map.setRunner(s.km);
  };

  /**
   * 5. One animation step. `now` is the timestamp the browser passes to every
   * requestAnimationFrame callback (milliseconds since the page loaded).
   * dt = real seconds since the last frame, capped at 0.25 s so a tab left in the background
   * (where the browser stops sending frames) does not jump ahead when it comes back.
   * On the first frame rp.last is 0, so `rp.last || now` makes dt 0.
   */
  const frame = (now) => {
    if (!rp.playing) return;
    const dt = Math.min(0.25, (now - (rp.last || now)) / 1000);
    rp.last = now;
    const prev = rp.sec;
    let next = Math.min(sc.finishSec, prev + dt * rp.speed);
    // "Stop at each moment": if a moment falls between the previous and the new time, stop just
    // after it (its second + 1, so the same moment is not hit again on Resume) and pulse the cue.
    if (rp.pauseAt) {
      const hit = script.find((e) => e.sec > prev + 0.5 && e.sec <= next);
      if (hit) { next = hit.sec + 1; rp.playing = false; els.cue.classList.add("pulse"); }
    }
    rp.sec = next;
    if (rp.sec >= sc.finishSec) rp.playing = false;
    draw();
    // Ask for the next frame: this is what makes the loop (each frame schedules the next one).
    if (rp.playing) rp.raf = requestAnimationFrame(frame);
  };
  /** Start playing (from 0 again if at the finish). */
  const play = () => {
    if (rp.sec >= sc.finishSec) rp.sec = 0;
    rp.playing = true;
    rp.last = 0;
    els.cue.classList.remove("pulse");
    if (rp.map) rp.map.focus(null); // the whole route again
    if (rp.map && rp.follow) rp.map.follow(true);
    rp.raf = requestAnimationFrame(frame);
    draw();
  };
  /** Stop playing and cancel the frame already scheduled. */
  const pause = () => { rp.playing = false; cancelAnimationFrame(rp.raf); draw(); };
  /** Jump to race second `sec` (clamped to the race). */
  const seek = (sec) => { rp.sec = Math.max(0, Math.min(sc.finishSec, sec)); els.cue.classList.remove("pulse"); draw(); };
  /**
   * Go to the next moment (dir > 0) or the previous one (dir < 0). Moments are reached at their
   * second + 1, so "previous" skips the one just reached (it must be more than 1.5 s back).
   */
  const jump = (dir) => {
    const list = dir > 0 ? script.filter((e) => e.sec > rp.sec + 0.5) : script.filter((e) => e.sec < rp.sec - 1.5).reverse();
    if (list[0]) { pause(); seek(list[0].sec + 1); }
  };

  // 6. Event listeners. addEventListener(type, fn) runs fn each time that event happens on the
  // element. "input" fires continuously while the seek bar is dragged, "change" once at the end.
  els.play.addEventListener("click", () => { trackEvent(rp.playing ? "replay-pause" : "replay-play"); rp.playing ? pause() : play(); });
  $r("#rpPrev").addEventListener("click", () => { trackEvent("replay-step", "prev"); jump(-1); });
  $r("#rpNextBtn").addEventListener("click", () => { trackEvent("replay-step", "next"); jump(1); });
  els.seek.addEventListener("input", () => seek(Number(els.seek.value)));
  els.seek.addEventListener("change", () => trackEvent("replay-seek"));
  $r("#rpSpeed").addEventListener("change", (e) => { rp.speed = Number(e.target.value); trackEvent("replay-speed", e.target.value); });
  $r("#rpPause").addEventListener("change", (e) => { rp.pauseAt = e.target.checked; trackEvent("replay-pause-at", e.target.checked ? "on" : "off"); });
  // The "Follow the runner" box exists only when there is a map.
  const fol = $r("#rpFollow");
  if (fol) fol.addEventListener("change", (e) => { rp.follow = e.target.checked; trackEvent("replay-follow", rp.follow ? "on" : "off"); if (rp.map) rp.map.follow(rp.follow); });
  // A click on a section of the bar jumps there and opens a pop-up with its length and real
  // metres up and down; a second click on the same section (or a click elsewhere) closes it.
  const legsBox = $r("#rpLegs");
  const tip = document.createElement("div");
  tip.className = "rp-ptip";
  tip.hidden = true;
  legsBox.appendChild(tip);
  // Index of the section whose pop-up is open, -1 when closed.
  let tipLeg = -1;
  const closeTip = () => { tip.hidden = true; tipLeg = -1; };
  // "pointerdown" covers mouse, touch and pen. contains() tells whether the click was inside the bar.
  document.addEventListener("pointerdown", (ev) => { if (!tip.hidden && !legsBox.contains(ev.target)) closeTip(); });
  els.legBtns.forEach((b) => b.addEventListener("click", () => {
    // dataset.i reads the data-i attribute written in the HTML (a string, hence Number()).
    const i = Number(b.dataset.i);
    if (i === tipLeg) { closeTip(); return; }
    trackEvent("replay-section", legs[i].kind);
    const l = legs[i];
    tipLeg = i;
    tip.innerHTML = `<b>${l.i}. ${escR(l.title)}</b><span><i>Length</i>${l.km.toFixed(2)} km</span><span><i>D+</i>${Math.round(l.up)} m</span><span><i>D−</i>${Math.round(l.down)} m</span>`;
    tip.hidden = false;
    // Centre the pop-up under the clicked section, but keep it inside the bar's width.
    const lb = legsBox.getBoundingClientRect(), bb = b.getBoundingClientRect();
    tip.style.left = `${Math.max(0, Math.min(lb.width - tip.offsetWidth, bb.left - lb.left + bb.width / 2 - tip.offsetWidth / 2))}px`;
    tip.style.top = `${lb.height + 8}px`;
    pause();
    seek(l.startSec + 1);
    // Show that section and the next one on the map; following stops until Play or Recenter.
    // legs[l.i] is the NEXT section: l.i counts from 1 while the array index counts from 0.
    // The rest of the route is dimmed until Play.
    if (rp.map) { const n = legs[l.i] || l; rp.map.focus(l.startKm, n.endKm); }
  }));
  // A click on a moment in the script list: go there and scroll the cockpit back into view.
  els.list.querySelectorAll("li button").forEach((b) => b.addEventListener("click", () => {
    // Which kind of moment was opened: a key zone, a climb, an aid station, a gel...
    trackEvent("replay-moment", script[Number(b.parentElement.dataset.i)].kind);
    pause();
    const m = script[Number(b.parentElement.dataset.i)];
    seek(m.sec + 1);
    // The map zooms on the section of that moment, the rest of the route dimmed (until Play).
    const l = legs.find((x) => m.km >= x.startKm && m.km < x.endKm) || legs[legs.length - 1];
    if (rp.map && l) rp.map.focus(l.startKm, l.endKm);
    $r(".rp-cockpit").scrollIntoView({ behavior: "smooth", block: "start" });
  }));
  // Click or drag on the profile to move the runner there.
  const svg = $r("#rpProf svg");
  if (svg) {
    // Screen x of the pointer -> x in the profile's 1000-wide viewBox -> km (prof.km does the
    // last step, as the inverse of prof.x).
    const toKm = (ev) => {
      const b = svg.getBoundingClientRect();
      const vx = ((ev.clientX - b.left) / b.width) * 1000;
      return prof.km(vx);
    };
    // A drag is left to the browser, so the profile scrolls freely.
    // Only a tap counts: the pointer must be released less than 8 px from where it went down
    // (Math.hypot gives the straight-line distance).
    let down = null;
    svg.addEventListener("pointerdown", (ev) => { down = { x: ev.clientX, y: ev.clientY }; });
    svg.addEventListener("pointercancel", () => { down = null; });
    svg.addEventListener("pointerup", (ev) => {
      if (down && Math.hypot(ev.clientX - down.x, ev.clientY - down.y) < 8) { trackEvent("replay-profile-tap"); pause(); seek(secAtKm(plan, sid, toKm(ev))); }
      down = null;
    });
  }
  // Keyboard: space plays or pauses, arrows step between moments (only while the replay is on screen).
  // Kept in rp.onKey so stopReplay() can remove this exact function later.
  rp.onKey = (ev) => {
    if (!box.isConnected) return;
    const tag = (ev.target.tagName || "").toLowerCase();
    // Typing in a text box or a menu: leave the keys alone (the seek bar and tick boxes are fine).
    if (["input", "select", "textarea"].includes(tag) && ev.target.type !== "range" && ev.target.type !== "checkbox") return;
    // Replay scrolled out of view (entirely above or below the window): do nothing.
    const r = box.getBoundingClientRect();
    if (r.bottom < 0 || r.top > window.innerHeight) return;
    if ([" ", "ArrowLeft", "ArrowRight"].includes(ev.key)) trackOnce("replay-keyboard");
    // preventDefault() stops the browser's own action (space scrolls the page, arrows move the
    // seek bar) so the key does only our action. Space on a button is left to the button.
    if (ev.key === " " && tag !== "button") { ev.preventDefault(); rp.playing ? pause() : play(); }
    else if (ev.key === "ArrowRight" && tag !== "input") { ev.preventDefault(); jump(1); }
    else if (ev.key === "ArrowLeft" && tag !== "input") { ev.preventDefault(); jump(-1); }
  };
  document.addEventListener("keydown", rp.onKey);
  // First draw, so the cockpit shows the current position before anything is pressed.
  draw();
}

/**
 * Stop the animation and free the map (before a re-render, or when the plan goes away).
 * Also removes the keyboard listener, so an old replay no longer reacts to keys.
 */
export function stopReplay() {
  rp.playing = false;
  cancelAnimationFrame(rp.raf);
  if (rp.onKey) document.removeEventListener("keydown", rp.onKey);
  rp.onKey = null;
  if (rp.map) rp.map.destroy();
  rp.map = null;
}
