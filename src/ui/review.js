// review.js (ui): the "Check my run" mode. Drop the GPX of a run you just did and replay it: the runner
// moves along the map and the profile at your real pace, with your real stops, the clock shows
// the real time of day, and every key moment (strong climb, fade, stop, heart rate drift...) stops
// the replay with what it means. Same cockpit as the race-day replay (same CSS grid and classes),
// but everything in it comes from what you recorded, not from a plan.
//
// Colours: the section bar, the map and the profile are coloured by how you ran each stretch
// compared with your own average on the same kind of ground (green: better, red: worse), so a
// glance shows where the run went well and where it cost you.
//
// Name: the page now calls this mode "Rewind my run" (address ?mode=run); "Check my run" is the
// name it had before, still used in a few comments.
//
// Where it sits: main.js calls initRunMode() once at start-up. When a GPX is dropped, the file goes
// through core/track.js (parseGpx: GPX text to GPS points) and core/review.js (analyseRun: the whole
// analysis: 10 m samples, stops, sections or "legs", key moments, colours). This file only draws the
// result and animates it; all the maths lives in core/review.js. The "Deep dive" under the replay is
// drawn by ui/insights.js, and ui/print.js reads currentRun() for the A4 export.
//
// Main exports:
//   initRunMode()          wire the drop zone and the sample button (called once)
//   mountRun()             draw the whole cockpit for one analysed run and wire its controls
//   stopRun(), pauseRun()  stop the animation (when you leave the mode)
//   currentRun()           the run on screen, for the A4 export
//
// Key ideas used here:
//   - HTML is built as template strings (`...${value}...`) and written with innerHTML in one go.
//   - The replay loop uses requestAnimationFrame: the browser calls `frame` before each screen refresh
//     (about 60 times a second); each call moves run time on by the real time that passed times the
//     replay speed, then redraws.
//   - draw() remembers what it drew last (lastLeg, lastCue, lastNow, lastNext) and only rebuilds a
//     block when it changed, so 60 redraws a second stay cheap.
//   - SVG coordinates: the profile uses a viewBox 1000 units wide, so positions are computed once in
//     those units and the browser scales the drawing to the real screen width.
//   - The state of the replay (rv) lives in one module-level object, so a re-render keeps its place.
//   - localStorage keeps the target you typed between visits (this browser only).

import { parseGpx } from "../core/track.js";
import { analyseRun, runStateAt, runLegAt, runSecAtKm, runTarget, parseTarget, runStats, runPaceLine } from "../core/review.js";
import { courseMap } from "./map.js";
import { fitPanel, alignBar } from "./replay.js";
import { mmss, hm, hms, clock } from "../core/format.js";
import { trackEvent, trackOnce } from "./analytics.js";
import { makeDemoRunGpx } from "../demo.js";
import { mountInsights, emptyInsights } from "./insights.js";

/**
 * Escape text before it goes into HTML: & < > and " become &amp; &lt; &gt; &quot;, so a run name
 * like "Up & down <3" shows as typed instead of breaking the page (or injecting markup).
 * The regex /[&<>"]/g matches any one of those four characters, everywhere (g = global); the
 * small object maps each one to its HTML entity.
 */
const rvEsc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
// Replay speeds offered in the Speed menu. `v` is how many seconds of run time pass per real second: 60
// means one hour of running replays in one minute, 480 in 7.5 s.
const RV_SPEEDS = [
  { v: 60, label: "1 h in 1 min" },
  { v: 180, label: "1 h in 20 s" },
  { v: 480, label: "1 h in 7.5 s" },
];
// Length and climb of a section, written out under its title, e.g. "2.4 km · +180 / −20 m".
// `l` is one section ("leg") of the run: startKm and endKm in km, up and down in metres.
const rvLegData = (l) => `${(l.endKm - l.startKm).toFixed(1)} km · +${Math.round(l.up)} / −${Math.round(l.down)} m`;
// One symbol per kind of section or key moment (the `kind` field set by core/review.js).
const RV_ICON = { start: "▶", finish: "🏁", climb: "▲", descent: "▼", flat: "➜", stop: "❚❚", fade: "↘", even: "=", "finish-strong": "↗", "finish-weak": "↘", drift: "♥", hr: "♥", walk: "⋯" };
// The three tones of a key moment, as the words shown with it.
const RV_TONE = { good: "Went well", bad: "Cost you", info: "Worth knowing" };
// Words for the form level 1 to 5 of a stretch (index 0 is unused): how you ran it against your own
// average. Used as the tooltip of the coloured route on the map.
const RV_FORM = ["", "Much weaker", "Weaker", "Your average", "Stronger", "Much stronger"];

/**
 * The target typed last time (kept in this browser only), or null.
 * localStorage stores text only, so the object {kind, value} is saved as JSON and parsed back.
 * The try/catch covers a private window or blocked storage, where reading can throw.
 */
function rvLoadTarget() {
  try { return JSON.parse(localStorage.getItem("trp.runTarget") || "null"); } catch { return null; }
}
/**
 * Save the target `t` ({kind: "time" or "pace", value in seconds, or seconds per km for a pace})
 * in localStorage, or remove it when `t` is null. Errors (private mode, full storage) are ignored.
 */
function rvSaveTarget(t) {
  try { if (t) localStorage.setItem("trp.runTarget", JSON.stringify(t)); else localStorage.removeItem("trp.runTarget"); } catch { /* private mode: keep it for this visit only */ }
}
// A signed duration: "+12 min" or "−3 min". `dur` is declared further down; that is fine because this
// arrow function only runs later, once the whole module has loaded.
const rvSigned = (sec) => `${sec >= 0 ? "+" : "−"}${dur(Math.abs(sec))}`;
// The four verdicts of runTarget (core/review.js) against your target, as [CSS class, heading]: reached
// = done; reach = close, stops and pacing cover the gap; stretch = needs more fitness; far = aim lower
// for now.
const RV_STATUS = {
  reached: ["rv-good", "Target reached"],
  reach: ["rv-good", "Within reach"],
  stretch: ["rv-ok", "A stretch"],
  far: ["rv-bad", "Far for now"],
};

/**
 * The "Against your target" block: the form, the verdict, where the gap comes from, and the
 * sections where changing the effort would have changed the result.
 *
 * Inputs: `run` is the analysed run (core/review.js analyseRun); `t` is the comparison from
 * runTarget(run, target), or null when no target is set. Times are in seconds, paces in seconds
 * per km. Returns an HTML string; it does not touch the page (mountRun writes it and wires the
 * form's submit and Clear buttons).
 *
 * Fields of `t` used here: status (reached / reach / stretch / far), targetSec and targetPace,
 * gapSec (positive = slower than the target), realisticSec (a time to aim for next time),
 * vsFirstPct and effortPct (% more effort needed), stopGain and fadeGain (seconds you could win
 * on stops and on the fade), stopAllow (stop time allowed), lose and ease (sections to push and to
 * ease off), legs (every section with its target time tgtSec and deltaSec = actual minus target).
 */
function rvTargetHtml(run, t) {
  // 1. The form, filled with the saved target if there is one: a time as h:mm (hm() writes "2h45", so
  // the "h" becomes ":"), a pace as m:ss. The placeholder suggests 5% faster than today (× 0.95) as an
  // example. `${cond ? "selected" : ""}` adds the word only for the chosen option.
  const kind = rv.target ? rv.target.kind : "time";
  const val = rv.target ? (rv.target.kind === "pace" ? mmss(rv.target.value) : hm(rv.target.value).replace("h", ":")) : "";
  const form = `<form class="rv-tgt-form" id="rvTgtForm">
    <label class="f">Target<select id="rvTgtKind"><option value="time" ${kind === "time" ? "selected" : ""}>Finish time (h:mm)</option><option value="pace" ${kind === "pace" ? "selected" : ""}>Average pace (m:ss /km)</option></select></label>
    <label class="f">Value<input type="text" id="rvTgtVal" value="${val}" placeholder="${kind === "pace" ? mmss(run.avgPace * 0.95) : hm(run.elapsedSec * 0.95).replace("h", ":")}" autocomplete="off" inputmode="numeric" size="8"></label>
    <button class="btn primary" type="submit">Compare</button>
    ${rv.target ? `<button class="btn" type="button" id="rvTgtClear">Clear</button>` : ""}
    <span class="rv-tgt-err" id="rvTgtErr" role="alert"></span>
  </form>`;
  // 2. No target yet: just the form and a line on what it does.
  if (!t) return `<div class="panel rv-tgt">${form}<p class="note">Type the time (or the pace) you were aiming for. The review then shows how far you were from it, where the time went, and how to spread your effort to get there next time.</p></div>`;
  // 3. The verdict. Array destructuring: RV_STATUS[t.status] is [class, heading], so cls and head get
  // its two items.
  const [cls, head] = RV_STATUS[t.status];
  // The target in words: for a pace target also the finish time it means, and the other way round.
  const tgtTxt = t.target.kind === "pace" ? `${mmss(t.target.value)}/km (${hm(t.targetSec)} for ${run.totalKm.toFixed(1)} km)` : `${hm(t.targetSec)} (${mmss(t.targetPace)}/km)`;
  // A percentage with its sign and one decimal: "+4.2%" or "−1.0%".
  const more = (x) => `${x >= 0 ? "+" : "−"}${Math.abs(x).toFixed(1)}%`;
  // One explanation per verdict. The object is built and indexed at once ({...}[t.status]), a compact
  // way to write a switch. 120 s: a new aim is only suggested when it is more than 2 min faster than
  // the target.
  const why = {
    reached: `You finished in ${hm(run.elapsedSec)}, ${dur(-t.gapSec)} inside your target of ${tgtTxt}.${t.realisticSec < t.targetSec - 120 ? ` On this run you could aim for about <b>${hm(t.realisticSec)}</b> next time: your first-half effort held to the end, and stops kept to 1 min per hour.` : ""}`,
    reach: `You were ${dur(t.gapSec)} over ${tgtTxt}. The legs were there: shorter stops and holding your first-half effort to the end cover the gap.`,
    stretch: `You were ${dur(t.gapSec)} over ${tgtTxt}. It needs ${more(t.vsFirstPct)} on the effort you showed in the first half: realistic after a block of training.`,
    far: `You were ${dur(t.gapSec)} over ${tgtTxt}. It needs ${more(t.vsFirstPct)} on the effort you showed in the first half. Aim for about <b>${hm(t.realisticSec)}</b> next time on this kind of course, then build from there.`,
  }[t.status];
  // Small helpers that return HTML: a number tile, a section name with its km, and the pace (for a
  // climb, the climbing speed VAM in m/h) the target asked for on a section.
  const tile = (k, v, sub) => `<div class="rp-tot"><span class="k">${k}</span><b>${v}</b>${sub ? `<small>${sub}</small>` : ""}</div>`;
  const sec = (l) => `${l.i}. ${rvEsc(l.title)} <small>km ${l.startKm.toFixed(1)} → ${l.endKm.toFixed(1)}</small>`;
  const tgtLine = (l) => (l.kind === "climb" && l.tgtVam ? `${Math.round(l.tgtVam)} m/h climbing instead of ${Math.round(l.vam)}` : l.tgtPace ? `${mmss(l.tgtPace)}/km instead of ${mmss(l.pace)}` : "");
  // 4. Where the time went: the sections that cost the most against the target (lose), and the sections
  // run faster than needed before the fade (ease). Not shown when the target was reached. `|| ...`
  // gives a fallback line when the list is empty (join("") of an empty list is "", which counts as
  // false).
  const adapt = t.status === "reached" ? "" : `
    <div class="rv-tgt-adapt">
      <div><div class="sub-h">Where to find the time</div><ul class="rv-tgt-list">${t.lose.map((l) => `<li class="rv-bad"><b>${sec(l)}</b><span>${dur(l.deltaSec)} slower than the target asked: ${tgtLine(l)}.${l.startKm >= run.halves.km ? " Late in the run: this is fuel and pacing, not fitness." : ""}</span></li>`).join("") || `<li>No section stands out: the gap is spread evenly.</li>`}</ul></div>
      ${t.ease.length ? `<div><div class="sub-h">Where to ease off</div><ul class="rv-tgt-list">${t.ease.map((l) => `<li class="rv-good"><b>${sec(l)}</b><span>${dur(-l.deltaSec)} faster than the target needed, before your fade: easing off here keeps legs for the end.</span></li>`).join("")}</ul></div>` : ""}
    </div>`;
  // 5. All of it together: the verdict, four tiles (gap, stops, fade, effort needed), the two lists,
  // and a folded table (<details>) of every section, where a gap of more than 15 s is coloured (rv-b
  // red, rv-g green).
  return `<div class="panel rv-tgt">${form}
    <div class="rv-tgt-head ${cls}"><b>${head}</b><p>${why}</p></div>
    <div class="rp-totals rv-tgt-tiles">
      ${tile(t.gapSec > 0 ? "Over target" : "Under target", dur(Math.abs(t.gapSec)), `${hm(run.elapsedSec)} for ${hm(t.targetSec)}`)}
      ${tile("Stops", t.stopGain >= 30 ? dur(t.stopGain) : "OK", `${dur(run.stopSec)} stopped, ${dur(t.stopAllow)} allowed`)}
      ${tile("Fade", t.fadeGain >= 30 ? dur(t.fadeGain) : "None", "second half at your first-half effort")}
      ${tile("Effort needed", more(t.effortPct), t.targetGap ? `grade-adjusted ${mmss(t.targetGap)}/km instead of ${mmss(run.gapPace)}` : "on your average today")}
    </div>
    ${adapt}
    <details class="rv-tgt-all"><summary>Every section against the target</summary>
      <table class="rp-tg"><thead><tr><th>Section</th><th>Today</th><th>Target</th><th>Gap</th><th>Target pace</th></tr></thead><tbody>
      ${t.legs.map((l) => `<tr><th>${l.i}. ${rvEsc(l.title)}</th><td>${dur(l.movSec)}</td><td>${dur(l.tgtSec)}</td><td class="${l.deltaSec > 15 ? "rv-b" : l.deltaSec < -15 ? "rv-g" : ""}">${rvSigned(l.deltaSec)}</td><td>${l.tgtPace ? `${mmss(l.tgtPace)}/km` : "–"}${l.tgtVam && l.kind === "climb" ? ` <small>${Math.round(l.tgtVam)} m/h</small>` : ""}</td></tr>`).join("")}
      </tbody></table>
      <p class="note">The target spreads one even effort over the whole run: each section gets the time it takes at your own average for its kind of ground, scaled so the total hits the target (stops: 1 min per hour allowed). Moving time only; stops are in the Stops tile.</p>
    </details>
  </div>`;
}

/**
 * "Your numbers": the records of the run as tiles (a click replays that moment), then the pace of
 * every km as bars (taller = faster) with the full table folded underneath.
 *
 * Inputs: `run` (the analysed run) and `st`, the clock time of the start in seconds since
 * midnight (to show times of day). runStats(run) (core/review.js) gives the records: best paces,
 * fastest 200 m / 1 km / 5 km, steepest 100 m up and down, highest and lowest point, and the
 * per-km splits. Returns an HTML string. Each clickable tile or bar carries data-sec (the second
 * of the run to jump to); mountRun adds the click listeners.
 */
function rvStatsHtml(run, st) {
  const S = runStats(run);
  // "km 4.2 · 10:31": where and at what time of day a record happened.
  const where = (o) => `km ${o.km.toFixed(1)} · ${clock(st, o.startSec)}`;
  // One record tile. It is a <button>, so it can be clicked and reached with the keyboard; data-sec is
  // only added when there is a moment to replay.
  const tile = (k, key, v, sub, o) => `<button type="button" class="rv-st" data-k="${key}"${o ? ` data-sec="${Math.round(o.startSec)}"` : ""}><span class="k">${k}</span><b>${v}</b><small>${sub}</small></button>`;
  // A "fastest distance" tile: its time, pace and place, or nothing when the run is too short for it (o
  // is null).
  const fast = (o, label, key) => (o ? tile(label, key, `${mmss(o.sec)}`, `${mmss(o.pace)}/km · ${where(o)}`, o) : "");
  // The list of tiles. A record that does not exist gives "", which join("") simply skips.
  const tiles = [
    tile("Average pace", "avg", `${mmss(S.avgPace)}<small>/km</small>`, `moving ${mmss(S.movingPace)} · grade-adj. ${mmss(S.gapPace)}`),
    S.best1min ? tile("Best pace · 1 min", "best", `${mmss(S.best1min.pace)}<small>/km</small>`, where(S.best1min), S.best1min) : "",
    fast(S.fastest200, "Fastest 200 m", "f200"),
    fast(S.fastest1k, "Fastest 1 km", "f1k"),
    fast(S.fastest5k, "Fastest 5 km", "f5k"),
    S.steepestUp && S.steepestUp.grade > 0 ? tile("Steepest 100 m up", "up", `+${S.steepestUp.grade.toFixed(0)}<small>%</small>`, `${mmss(S.steepestUp.sec)} for 100 m · ${where(S.steepestUp)}`, S.steepestUp) : "",
    S.steepestDown && S.steepestDown.grade < 0 ? tile("Steepest 100 m down", "down", `${S.steepestDown.grade.toFixed(0)}<small>%</small>`, `${mmss(S.steepestDown.sec)} for 100 m · ${where(S.steepestDown)}`, S.steepestDown) : "",
    tile("Highest point", "high", `${Math.round(S.high.ele)}<small>m</small>`, `km ${S.high.km.toFixed(1)} · lowest ${Math.round(S.low.ele)} m`),
  ].join("");
  // Bars: one per km, height by speed so faster stands taller, from 85% of the slowest km.
  // Speed in m/s is 1000 / pace (pace in seconds per km). Splits with no pace are left out, and the
  // chart is only drawn when there are at least two km to compare.
  const sp = S.splits.filter((x) => x.pace);
  let bars = "";
  if (sp.length > 1) {
    // Math.max(...array) spreads the array into separate arguments: the fastest and slowest km speeds.
    // The floor is 85% of the slowest, so even the slowest bar has some height.
    const vmax = Math.max(...sp.map((x) => 1000 / x.pace)), vmin = Math.min(...sp.map((x) => 1000 / x.pace)) * 0.85;
    // The drawing box in SVG units (viewBox 1000 x 120): bars stand on y = 96 (base) and reach up to y
    // = 16 (top). SVG y grows downwards, so a taller bar has a smaller y. gap: the space between two
    // bars.
    const W = 1000, H = 120, top = 16, base = 96, gap = 2;
    // Width of one bar; 40 units are kept for the average label on the left.
    const bw = (W - 40) / sp.length;
    // Speed to y: a straight-line map from [vmin, vmax] to [base, top]. Math.max(1e-6, ...) avoids a
    // division by zero when every km has the same speed.
    const yv = (v) => base - ((v - vmin) / Math.max(1e-6, vmax - vmin)) * (base - top);
    // The moving average speed, drawn as a horizontal line across the bars.
    const avgV = 1000 / S.movingPace;
    let svg = "";
    // One <g> group per km: the bar (<rect>) and a <title>, which the browser shows as a tooltip.
    // `x.part` is set on the last, partial km (the fraction of a km it covers). data-sec is the run
    // second at the start of that km, so a click replays it. The fastest and slowest km get the class
    // "best" or "worst".
    sp.forEach((x, k) => {
      const v = 1000 / x.pace, yy = yv(v), xx = 34 + k * bw;
      const tag = x === S.fastestSplit ? " best" : x === S.slowestSplit ? " worst" : "";
      svg += `<g class="rv-km-bar${tag}" data-sec="${Math.round(runSecAtKm(run, x.km - (x.part || 1)))}"><rect x="${(xx + gap / 2).toFixed(1)}" y="${yy.toFixed(1)}" width="${Math.max(1, bw - gap).toFixed(1)}" height="${(base - yy).toFixed(1)}"/><title>${x.part ? `Last ${(x.part * 1000).toFixed(0)} m` : `Km ${x.km}`}: ${mmss(x.pace)}/km · +${Math.round(x.up)} / −${Math.round(x.down)} m</title></g>`;
      // The km number under the bar; on runs over 30 km only every other one, so they do not overlap.
      if (sp.length <= 30 || k % 2 === 0) svg += `<text x="${(xx + bw / 2).toFixed(1)}" y="${base + 14}" text-anchor="middle">${x.part ? "end" : x.km}</text>`;
      // The pace is written above the fastest and the slowest km only.
      if (tag) svg += `<text class="rv-km-lab" x="${(xx + bw / 2).toFixed(1)}" y="${(yy - 4).toFixed(1)}" text-anchor="middle">${mmss(x.pace)}</text>`;
    });
    // The average line, with its pace as a label on the left.
    svg += `<line class="rv-km-avg" x1="34" x2="${W - 6}" y1="${yv(avgV).toFixed(1)}" y2="${yv(avgV).toFixed(1)}"/><text class="rv-km-lab" x="30" y="${(yv(avgV) + 3).toFixed(1)}" text-anchor="end">${mmss(S.movingPace)}</text>`;
    bars = `<div class="rv-kms"><div class="rv-kms-h"><b>Pace per km</b><small>taller = faster · line = your moving average · click a bar to replay that km</small></div><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Pace of each km">${svg}</svg></div>`;
  }
  // The full table of splits, folded in a <details> element (a click on the summary opens it). The
  // heart-rate column only appears when the file has heart rate.
  const table = `<details class="rv-tgt-all"><summary>Every km: time, pace, grade-adjusted pace, climbing${run.hasHr ? ", heart rate" : ""}</summary>
    <table class="rp-tg rv-km-t"><thead><tr><th>Km</th><th>Time</th><th>Pace</th><th>Grade-adj.</th><th>D+ / D−</th>${run.hasHr ? "<th>HR</th>" : ""}</tr></thead><tbody>
    ${S.splits.map((x) => `<tr${x === S.fastestSplit ? ' class="best"' : x === S.slowestSplit ? ' class="worst"' : ""}><th>${x.part ? `+${(x.part * 1000).toFixed(0)} m` : x.km}</th><td>${mmss(x.sec)}${x.stopSec >= 30 ? ` <small>${dur(x.stopSec)} stopped</small>` : ""}</td><td>${x.pace ? `${mmss(x.pace)}/km` : "–"}</td><td>${x.gap ? `${mmss(x.gap)}/km` : "–"}</td><td>+${Math.round(x.up)} / −${Math.round(x.down)} m</td>${run.hasHr ? `<td>${x.hr ? Math.round(x.hr) : "–"}</td>` : ""}</tr>`).join("")}
    </tbody></table></details>`;
  return `<div class="panel rv-stats"><div class="rv-st-grid">${tiles}</div>${bars}${table}</div>`;
}

// The state of the review, in one module-level object. It survives a re-render (mountRun runs
// again when you set a target), so the replay keeps its place.
//   run      the analysed run on screen (from analyseRun), or null
//   name     the name shown for it (file name, or "Sample trail run")
//   target   the target you typed: {kind: "time" or "pace", value in seconds}, or null
//   sec      where the replay is, in seconds since the start of the run
//   playing  true while the animation runs
//   speed    run seconds per real second (see RV_SPEEDS)
//   pauseAt  the "Stop at each moment" checkbox
//   follow   the "Follow the runner" checkbox: the map keeps the runner in view
//   raf      the id returned by requestAnimationFrame, needed to cancel the next frame
//   map      the map object from ui/map.js (a wrapper around Leaflet), or null
//   onKey    the keyboard listener, kept so it can be removed later
// Two more fields are added later: last (time stamp of the previous frame, in ms) and seekTo
// (a function the deep dive calls to move the replay).
const rv = { run: null, name: "", target: rvLoadTarget(), sec: 0, playing: false, speed: 180, pauseAt: false, follow: false, raf: 0, map: null, onKey: null };

/**
 * Seconds since midnight, local time, when the run started (for clock times of day).
 * `ms` is a time stamp in milliseconds; 9:30:15 in the morning gives 34215.
 */
const startOfDay = (ms) => { const d = new Date(ms); return d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds(); };
// A duration in words: "42 min" under an hour, else hm() gives "2h05". A negative value shows as "0
// min".
const dur = (sec) => (sec < 3600 ? `${Math.max(0, Math.round(sec / 60))} min` : hm(sec));

/**
 * The profile of the run (SVG, viewBox 1000 wide): the line coloured by form, a pin over each key
 * moment (green good, red bad) and a triangle at each stop. Returns {html, x, y, km, top, base}.
 *
 * `run.profile` is a list of [km, elevation in m] pairs. Besides the HTML string, the function
 * returns the scales it used, so mountRun can draw on the same SVG later:
 *   x(km) gives the SVG x, y(ele) the SVG y, km(svgX) the km (the reverse of x, for clicks),
 *   line(fromKm, toKm) the SVG path text of the profile between two km,
 *   paceY(speed) and paceAt(km) for the pace line (paceY is null when there is too little data),
 *   l, r, W, top, base: the margins and size of the plot.
 * SVG path syntax used below: "M x,y" moves the pen, "L x,y" draws a straight line to a point,
 * "l dx,dy" and "h dx" draw relative to the last point, "Z" or "z" closes the shape.
 */
function rvProfile(run) {
  const P = run.profile;
  const TOT = run.totalKm;
  // All the elevations, to find the lowest (EMIN) and highest (EMAX) point.
  const eles = P.map((p) => p[1]);
  const EMIN = Math.min(...eles), EMAX = Math.max(...eles);
  // Flat: it runs the full width of the cockpit, right under the section bar.
  // Plot box in SVG units: l and r are the left and right margins (room for the altitude labels),
  // the profile lives between y = top and y = base, and H is the total height.
  const W = 1000, l = 52, r = 14, top = 26, base = 92, H = 114;
  const plotH = base - top - 12;
  // Scales: km to x, and elevation to y (higher ground = smaller y, since SVG y grows downwards). km()
  // is the reverse of x(), clamped to the run, to turn a click position into a km.
  const x = (km) => l + (km / TOT) * (W - l - r);
  const y = (e) => base - 8 - ((e - EMIN) / Math.max(1, EMAX - EMIN)) * plotH;
  const km = (vx) => Math.max(0, Math.min(TOT, ((vx - l) / (W - l - r)) * TOT));
  // Elevation at km k: find the first profile point past k (a linear scan), then interpolate in a
  // straight line between it and the point before. "|| 1" avoids dividing by 0 when two points share a
  // km.
  const eAt = (k) => { let i = 1; while (i < P.length - 1 && P[i][0] < k) i++; const a = P[i - 1], b = P[i]; return a[1] + Math.max(0, Math.min(1, (k - a[0]) / (b[0] - a[0] || 1))) * (b[1] - a[1]); };
  // The SVG path of the profile from km a to km b: the two interpolated end points plus every profile
  // point in between; "M" for the first point, "L" for the rest.
  const line = (a, b) => [[a, eAt(a)], ...P.filter((p) => p[0] > a && p[0] < b), [b, eAt(b)]].map((p, i) => `${i ? "L" : "M"}${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join("");
  // 1. The grey area under the profile: down to the base at km 0, along the profile, back down at the
  // finish, closed with Z.
  let s = `<path class="area" d="M${x(0)},${base} ${P.map((p) => `L${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join(" ")} L${x(TOT)},${base} Z"/>`;
  // 2. The coloured line: one path per "effort band" (a stretch where your form was the same), with
  // class rv-f1 to rv-f5, from much weaker to much stronger.
  run.effortBands.forEach((b) => { s += `<path class="rv-pf rv-f${b.cls}" d="${line(b.fromKm, b.toKm)}"/>`; });
  // 3. The km axis: a tick every 1, 2, 5 or 10 km depending on the run length. "+ 1e-9" keeps the last
  // tick despite the rounding errors of adding decimals.
  s += `<line class="axis" x1="${l}" x2="${W - r}" y1="${base}" y2="${base}"/>`;
  const tick = TOT > 60 ? 10 : TOT > 25 ? 5 : TOT > 8 ? 2 : 1;
  for (let k = 0; k <= TOT + 1e-9; k += tick) s += `<line class="axis" x1="${x(k)}" x2="${x(k)}" y1="${base}" y2="${base + 5}"/><text x="${x(k)}" y="${base + 18}" text-anchor="middle">${k}</text>`;
  s += `<text x="${W - r}" y="${base + 18}" text-anchor="end">km</text>`;
  // 4. Two altitude labels, rounded to 10 m: the lowest and the highest.
  [Math.ceil(EMIN / 10) * 10, Math.floor(EMAX / 10) * 10].forEach((e) => { s += `<text x="${l - 6}" y="${(y(e) + 3).toFixed(1)}" text-anchor="end">${e} m</text>`; });
  // 5. A small triangle over each stop of a minute or more, with a tooltip.
  run.stops.filter((st) => st.durSec >= 60).forEach((st) => { const yy = y(eAt(st.km)); s += `<path class="aid" d="M${x(st.km).toFixed(1)},${(yy - 5).toFixed(1)} l-6,-10 h12 z"><title>Stopped ${Math.round(st.durSec / 60)} min at km ${st.km.toFixed(1)}</title></path>`; });
  // 6. A pin above each good or bad key moment ("info" moments get none): a line down to the profile, a
  // circle with + or −, and the title as a tooltip.
  run.moments.filter((m) => m.tone !== "info").forEach((m) => {
    const xx = x(m.km);
    s += `<g class="rv-pin-p ${m.tone}"><line x1="${xx.toFixed(1)}" x2="${xx.toFixed(1)}" y1="${top - 8}" y2="${y(eAt(m.km)).toFixed(1)}"/><circle cx="${xx.toFixed(1)}" cy="${top - 14}" r="8"/><text x="${xx.toFixed(1)}" y="${top - 10.5}" text-anchor="middle">${m.tone === "good" ? "+" : "−"}</text><title>${rvEsc(m.title)}</title></g>`;
  });
  // Pace line: speed (higher = faster) over the same band, scaled between your slow 5% and fast
  // 5% so a stop or a sprint does not squash the rest. Three copies of one path, each clipped to
  // a part of the run: before the current section, the current section (lit), after it (both faint).
  const pl = runPaceLine(run);
  // The speeds (m/s) sorted from slow to fast, without the stops (v = 0), to pick the 5% and 95% points
  // (percentiles).
  const vs = pl.map((p) => p.v).filter((v) => v > 0).sort((a, b) => a - b);
  let paceY = null;
  if (vs.length > 4) {
    // vlo and vhi: the slow 5% and fast 5% speeds, with a little margin (× 0.95 and × 1.03). yHi and
    // yLo: the height band the line uses.
    const vlo = vs[Math.floor(vs.length * 0.05)] * 0.95, vhi = vs[Math.floor(vs.length * 0.95)] * 1.03;
    const yHi = top + 4, yLo = base - 10;
    // Speed to y: clamped between vlo and vhi, fast at the top.
    paceY = (v) => yLo - (Math.max(vlo, Math.min(vhi, v)) - vlo) / Math.max(1e-6, vhi - vlo) * (yLo - yHi);
    const d = pl.filter((p) => p.v > 0).map((p, i) => `${i ? "L" : "M"}${x(p.km).toFixed(1)},${paceY(p.v).toFixed(1)}`).join("");
    // A clipPath only shows what lies inside its rectangle. The three clips start empty (width 0);
    // draw() in mountRun moves and resizes their rectangles as the replay moves on.
    const clip = (id) => `<clipPath id="${id}"><rect x="${l}" y="0" width="0" height="${H}"/></clipPath>`;
    // The same path three times, one per clip, so each part has its own style (ahead, past, current
    // section); then the slow and fast pace labels on the right, the moving dot, and an empty text for
    // the live pace.
    s += `<defs>${clip("rvPcPast")}${clip("rvPcTrail")}${clip("rvPcAhead")}</defs><g class="rv-pace">`
      + `<path class="rv-pl ahead" clip-path="url(#rvPcAhead)" d="${d}"/><path class="rv-pl past" clip-path="url(#rvPcPast)" d="${d}"/><path class="rv-pl trail" clip-path="url(#rvPcTrail)" d="${d}"/>`
      + `<text class="rv-pl-t" x="${W - r - 2}" y="${(yHi + 3).toFixed(1)}" text-anchor="end">${mmss(1000 / vhi)}/km</text><text class="rv-pl-t" x="${W - r - 2}" y="${(yLo + 3).toFixed(1)}" text-anchor="end">${mmss(1000 / vlo)}/km</text>`
      + `<circle class="rv-pl-dot" r="4.5" cx="${x(0)}" cy="${paceY(pl[0].v || vlo).toFixed(1)}"/><text class="rv-pl-v" x="${x(0)}" y="0"></text></g>`;
  }
  // The cursor (a vertical line and a dot), hidden until the replay starts; draw() moves it with a
  // transform.
  s += `<g class="pcur" style="display:none"><line x1="0" x2="0" y1="${top - 4}" y2="${base}"/><circle cx="0" cy="${base}" r="6"/></g>`;
  // Where the pace line is at `k` km (interpolated between its 100 m points).
  const paceAt = (k) => { let i = 1; while (i < pl.length - 1 && pl[i].km < k) i++; const a = pl[i - 1], b = pl[i]; const f = Math.max(0, Math.min(1, (k - a.km) / (b.km - a.km || 1))); return a.v + f * (b.v - a.v); };
  // The returned object. The html wraps the SVG in a box that can scroll sideways on narrow screens.
  return { x, y, km, top, base, line, paceY, paceAt, l, W, r, html: `<div class="prof-scroll"><svg viewBox="0 0 1000 ${H}" role="img" aria-label="Elevation profile of your run, coloured by how you ran each stretch">${s}</svg></div>` };
}

/**
 * Map styling: the route coloured by form, a glow under each good or bad moment, stops as triangles.
 * Returns {paint, marks} for courseMap (ui/map.js):
 *   paint  [{fromKm, toKm, cls, title}]  stretches of the route drawn with a CSS class and tooltip
 *   marks  [{km, kind, label, title?}]   markers: the start, a km marker every 2, 5 or 10 km
 *                                        (none in the last 500 m), and stops of a minute or more
 * Moments shorter than 100 m (0.1 km) get no glow. The glows are listed first, the coloured route
 * after them.
 */
function rvMapStyle(run) {
  const paint = run.moments.filter((m) => m.tone !== "info" && m.toKm - m.km >= 0.1).map((m) => ({ fromKm: m.km, toKm: m.toKm, cls: `rv-mglow ${m.tone}`, title: `${m.tone === "good" ? "+" : "−"} ${rvEsc(m.title)}` }));
  run.effortBands.forEach((b) => paint.push({ fromKm: b.fromKm, toKm: b.toKm, cls: `rv-rt rv-f${b.cls}`, title: RV_FORM[b.cls] }));
  const marks = [{ km: 0, kind: "start", label: "Start" }];
  const every = run.totalKm > 60 ? 10 : run.totalKm > 25 ? 5 : 2;
  for (let k = every; k < run.totalKm - 0.5; k += every) marks.push({ km: k, kind: "km", label: String(k) });
  run.stops.filter((st) => st.durSec >= 60).forEach((st) => marks.push({ km: st.km, kind: "aid", label: "Stop", title: `Stopped ${Math.round(st.durSec / 60)} min · km ${st.km.toFixed(1)}` }));
  return { paint, marks };
}

/**
 * Mount the review cockpit for `run` in `box`.
 *
 * `box` is the element to fill (#s5body); `run` is the result of analyseRun (core/review.js).
 * Side effects: replaces box.innerHTML, creates the map, adds click, pointer and keyboard
 * listeners, and watches the size of the live panel. It does not start playing: the user presses
 * Play. Steps:
 *   1. Compute what the page needs (start clock, profile, target comparison).
 *   2. Write the whole HTML in one go: totals, section bar, map, live panel, profile, controls,
 *      recap, target, key moments and the "How to read it" note.
 *   3. Find the elements once (els) and create the map.
 *   4. Define draw(): put the state at second rv.sec on screen.
 *   5. Define the animation loop and the controls (play, pause, seek, jump to a moment).
 *   6. Wire the buttons, the profile, the keyboard and the target form, then draw once.
 */
export function mountRun(box, run) {
  // 1. Stop any earlier replay (its animation, map and key listener) before building a new one. A
  // different run starts at second 0; the same run (re-rendered after a target change) keeps its place.
  stopRun();
  if (rv.run !== run) { rv.run = run; rv.sec = 0; }
  const st = startOfDay(run.startMs);
  const legs = run.legs;
  const moments = run.moments;
  const TOT = run.totalKm;
  // A km as a CSS percentage of the run, to place blocks on the section bar (3 decimals, so blocks line
  // up on long runs).
  const pct = (k) => `${((k / TOT) * 100).toFixed(3)}%`;
  const prof = rvProfile(run);
  // The comparison with your target, when one is set (runTarget, core/review.js).
  const tgt = rv.target ? runTarget(run, rv.target) : null;
  const good = moments.filter((m) => m.tone === "good");
  const bad = moments.filter((m) => m.tone === "bad");
  // The start date in British style, e.g. "Sat 12 Oct 2026".
  const date = new Date(run.startMs).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric" });
  // Small HTML helpers: a total tile, the plural name of each kind of section, and the verdict chip of
  // a section ("Stronger +8%").
  const tile = (k, v, sub) => `<div class="rp-tot"><span class="k">${k}</span><b>${v}</b>${sub ? `<small>${sub}</small>` : ""}</div>`;
  const KIND = { climb: "climbs", descent: "descents", flat: "runnable stretches" };
  const legChip = (l) => `<span class="chip rv-${l.tone}">${l.verdict}${l.vsPct ? ` ${l.vsPct > 0 ? "+" : ""}${l.vsPct}%` : ""}</span>`;

  // 2. The whole cockpit as one HTML string. Each block of the section bar is a <button> placed with
  // left and width in % of the run, so its width is its share of the course; its data-i is the
  // section's index in legs (from 0). In the key moments list, data-i is the moment's index.
  box.innerHTML = `
  <p class="rv-meta">${rvEsc(rv.name || run.name || "Your run")} · ${date} · start ${clock(st, 0)}</p>
  <div class="rp-cockpit rv-cockpit" id="rvCockpit">
  <div class="rp-totals" aria-label="Your run">
    ${tile("Duration", hm(run.elapsedSec), tgt ? `target ${hm(tgt.targetSec)} · <span class="${tgt.gapSec > 0 ? "rv-b" : "rv-g"}">${rvSigned(tgt.gapSec)}</span>` : `${hm(run.movingSec)} moving · ${dur(run.stopSec)} stopped`)}
    ${tile("Distance", `${TOT.toFixed(1)}<small>km</small>`, `${Math.round(run.gain)} m D+ · ${legs.length} sections`)}
    ${tile("Pace", `${mmss(run.movingPace)}<small>/km</small>`, `grade-adjusted ${mmss(run.gapPace)}/km`)}
    ${run.hasHr ? tile("Heart rate", `${Math.round(run.hrAvg)}<small>bpm</small>`, `max ${Math.round(run.hrMax)}`) : tile("Key moments", `<span class="rv-g">${good.length}</span> · <span class="rv-b">${bad.length}</span>`, "went well · cost you")}
  </div>
  <div class="rp-legbar">
    <div class="rp-legs rv-legs" id="rvLegs" role="group" aria-label="Sections of your run">${legs.map((l) => `<button type="button" class="lg rv-${l.tone}${l.kind === "descent" ? " rv-d" : ""}" data-i="${l.i - 1}" style="left:${pct(l.startKm)};width:${pct(l.endKm - l.startKm)}" title="${l.i}. ${rvEsc(l.title)} · ${l.verdict}${l.vsPct ? ` ${l.vsPct > 0 ? "+" : ""}${l.vsPct}%` : ""} · km ${l.startKm.toFixed(1)} → ${l.endKm.toFixed(1)}" aria-label="Section ${l.i}: ${rvEsc(l.title)}, ${l.verdict}"></button>`).join("")}
      ${moments.filter((m) => m.tone !== "info").map((m) => `<i class="rv-pin ${m.tone}" style="left:${pct(m.km)}" title="${rvEsc(m.title)}"></i>`).join("")}
      <i class="lg-pos" id="rvLegPos"></i>
    </div>
    <div class="rp-legfoot">
      <div class="rp-legnow" id="rvLegNow" aria-live="polite"></div>
      <div class="rp-legend" aria-label="Legend"><span><i class="sw rv-good"></i>Stronger</span><span><i class="sw rv-ok"></i>Your average</span><span><i class="sw rv-bad"></i>Weaker</span><span><i class="sw rv-ok rv-d"></i>Descent</span><span><i class="sw ad"></i>Stop</span><span><i class="rv-pin-l good"></i>Went well</span><span><i class="rv-pin-l bad"></i>Cost you</span><span><i class="sw rv-pl-sw"></i>Pace</span></div>
    </div>
  </div>
    <div class="rp-map" id="rvMap"></div>
    <div class="panel rp-hud">
      <div class="rp-top">
        <div class="rp-clock"><span class="k">Duration</span><b id="rvClock"></b></div>
        <div class="rp-run"><span id="rvElapsed"></span><span id="rvKm"></span></div>
      </div>
      <div class="rp-prog" aria-hidden="true"><i id="rvBar"></i></div>
      <div class="rp-leg" id="rvLeg"></div>
      <div class="rp-now" id="rvNow" hidden></div>
      <div class="rp-cue" id="rvCue" aria-live="polite"></div>
      <ul class="kv rp-next" id="rvNext"></ul>
    </div>
  <div class="prof-wrap rp-prof" id="rvProf">${prof.html}</div>
  <div class="rp-controls">
    <button class="btn icon" type="button" id="rvPrev" aria-label="Previous moment" title="Previous moment (←)">⏮</button>
    <button class="btn primary rp-play" type="button" id="rvPlay"></button>
    <button class="btn icon" type="button" id="rvNextBtn" aria-label="Next moment" title="Next moment (→)">⏭</button>
    <input type="range" id="rvSeek" min="0" max="${Math.round(run.elapsedSec)}" step="5" aria-label="Run time">
    <label class="f inline">Speed<select id="rvSpeed" aria-label="Replay speed">${RV_SPEEDS.map((s) => `<option value="${s.v}" ${s.v === rv.speed ? "selected" : ""}>${s.label}</option>`).join("")}</select></label>
    <label class="chk"><input type="checkbox" id="rvPause" ${rv.pauseAt ? "checked" : ""}> Stop at each moment</label>
    <label class="chk"><input type="checkbox" id="rvFollow" ${rv.follow ? "checked" : ""}> Follow the runner</label>
  </div>
  </div>
  <div class="sub-h" id="rv-stats">Recap</div>
  ${rvStatsHtml(run, st)}
  <div class="sub-h" id="rv-target">Against your target</div>
  <div id="rvTgt">${rvTargetHtml(run, tgt)}</div>
  <div class="sub-h" id="rv-moments">Key moments · ${good.length} went well · ${bad.length} cost you</div>
  <ol class="rp-script rv-script" id="rvScript">${moments.map((m) => `<li data-i="${m.i}" class="rv-${m.tone}"><button type="button"><span class="ic">${RV_ICON[m.kind] || "•"}</span><span class="t"><b>${rvEsc(m.title)}</b><small>km ${m.km.toFixed(1)} · ${clock(st, m.sec)} · ${RV_TONE[m.tone]}</small></span><span class="cue">${rvEsc(m.text)}${m.tip ? `<em>${rvEsc(m.tip)}</em>` : ""}</span></button></li>`).join("")}</ol>
  <div class="sub-h">How to read it</div>
  <p class="note rv-how">Every section is compared with <b>your own average on the same kind of ground</b> that day: climbs with your climbs, descents with your descents, runnable stretches with your runnable stretches. The yardstick is grade-adjusted pace (GAP): your pace converted to the flat pace that would have cost the same energy, from the energy cost of running on a slope measured by Minetti and colleagues (2002). +10% on a climb = you climbed 10% faster than your average climb, for its steepness. Stops are any moment slower than 0.3 m/s; they count in the clock but not in the paces. Heart rate drift compares speed per heartbeat between the two halves (over 5% is a sign of fatigue, heat or low fuel). Your file never leaves this page.</p>`;

  // 3. $v(selector) finds an element inside this box only (querySelector returns the first match). els
  // keeps the elements draw() updates many times a second, so they are looked up once. [...list] turns
  // the NodeList returned by querySelectorAll into a real array.
  const $v = (s) => box.querySelector(s);
  const els = { leg: $v("#rvLeg"), legNow: $v("#rvLegNow"), legPos: $v("#rvLegPos"), legBtns: [...box.querySelectorAll("#rvLegs .lg")], clock: $v("#rvClock"), el: $v("#rvElapsed"), bar: $v("#rvBar"), km: $v("#rvKm"), now: $v("#rvNow"), next: $v("#rvNext"), cue: $v("#rvCue"), play: $v("#rvPlay"), seek: $v("#rvSeek"), cur: $v("#rvProf .pcur"), list: $v("#rvScript") };
  // A window resize changes the room in the panel: fit the "coming next" list again.
  // ResizeObserver calls the function whenever the observed element changes size; the typeof check
  // keeps a browser without it from failing.
  if (typeof ResizeObserver === "function") new ResizeObserver(() => fitPanel(els.next)).observe($v(".rp-hud"));
  // alignBar (ui/replay.js) lines the section bar up with the plotted part of the profile, from x(0) to
  // x(TOT), so each block sits above its stretch of the profile.
  alignBar($v(".rp-legbar"), $v("#rvProf svg"), prof.x(0), prof.x(TOT));
  // The map (ui/map.js, built on Leaflet): the route, the coloured stretches and the markers. follow()
  // keeps the runner in view, here only once the replay has moved.
  const m = rvMapStyle(run);
  rv.map = courseMap($v("#rvMap"), { route: run.route, totalKm: TOT, paint: m.paint, marks: m.marks });
  rv.map.follow(rv.follow && rv.sec > 0);

  // The section you are on: a band on the profile, the glow on the map, the button on the bar.
  const svgEl = $v("#rvProf svg");
  const profScroll = $v("#rvProf .prof-scroll");
  // As on race day: a soft band over the section and a glow drawn under its stretch of line.
  let legG = null;
  let glowG = null;
  // Two SVG groups are added with the DOM API. SVG elements must be created with createElementNS and
  // the SVG namespace (plain createElement would make HTML elements that the SVG cannot draw). legG
  // goes just before the cursor (so under it), glowG just after the grey area (so under the coloured
  // line).
  if (svgEl && els.cur) {
    const NS = "http://www.w3.org/2000/svg";
    legG = document.createElementNS(NS, "g");
    legG.setAttribute("class", "pleg");
    svgEl.insertBefore(legG, els.cur);
    glowG = document.createElementNS(NS, "g");
    glowG.setAttribute("class", "pglow");
    const area = svgEl.querySelector(".area");
    svgEl.insertBefore(glowG, area ? area.nextSibling : svgEl.firstChild);
  }
  /**
   * Light up section number `li` (its index in legs, from 0) in three places: a band and its number
   * on the profile with a glow under its line, the map highlight, and the button on the bar ("on"
   * for the current one, "past" for the ones before). On a narrow screen where the profile scrolls
   * sideways, it also scrolls to centre the section.
   */
  const drawLeg = (li) => {
    const l = legs[li];
    if (legG) {
      legG.innerHTML = `<rect class="pl-cur" x="${prof.x(l.startKm).toFixed(1)}" y="${prof.top - 4}" width="${Math.max(2, prof.x(l.endKm) - prof.x(l.startKm)).toFixed(1)}" height="${prof.base - prof.top + 4}"/>`
        + `<text class="pl-t" x="${((prof.x(l.startKm) + prof.x(l.endKm)) / 2).toFixed(1)}" y="${prof.base - 6}" text-anchor="middle">${l.i}</text>`;
      glowG.innerHTML = `<path class="pl-glow" d="${prof.line(l.startKm, l.endKm)}"/>`;
    }
    // The profile is drawn 1000 units wide; k converts SVG units to pixels of the scrolled box.
    if (profScroll && profScroll.scrollWidth > profScroll.clientWidth + 4) {
      const k = profScroll.scrollWidth / 1000;
      profScroll.scrollLeft = Math.max(0, ((prof.x(l.startKm) + prof.x(l.endKm)) / 2) * k - profScroll.clientWidth / 2);
    }
    if (rv.map) rv.map.highlight({ fromKm: l.startKm, toKm: l.endKm });
    els.legBtns.forEach((b, k) => { b.classList.toggle("on", k === li); b.classList.toggle("past", k < li); });
  };

  // What draw() showed last, so it only rebuilds a block when it changes (-1, -2 and "" mean "nothing
  // yet").
  let lastLeg = -1;
  let lastCue = -2;
  let lastNow = "";
  let lastNext = "";
  // Pace line: the clip rectangles that split it into before, the current section and after, and the dot.
  const paceG = svgEl ? svgEl.querySelector(".rv-pace") : null;
  const pcRects = paceG ? { past: svgEl.querySelector("#rvPcPast rect"), trail: svgEl.querySelector("#rvPcTrail rect"), ahead: svgEl.querySelector("#rvPcAhead rect") } : null;
  const paceDot = paceG ? paceG.querySelector(".rv-pl-dot") : null;
  const paceTxt = paceG ? paceG.querySelector(".rv-pl-v") : null;
  /**
   * 4. Put the replay at second rv.sec on screen. Called on every animation frame and after each
   * click. runStateAt (core/review.js) gives the state of the run at that second: km, elevation,
   * gradient, pace, grade-adjusted pace, heart rate, cadence, whether you were stopped, and frac
   * (the share of the run done, 0 to 1).
   */
  const draw = () => {
    const s = runStateAt(run, rv.sec);
    // Top of the panel: elapsed time, time of day, % done, progress bar, km, and the seek slider.
    els.clock.textContent = hms(s.sec);
    els.el.textContent = `clock ${clock(st, s.sec)} · ${Math.round(s.frac * 100)}%`;
    els.bar.style.width = `${(s.frac * 100).toFixed(2)}%`;
    els.km.textContent = `km ${s.km.toFixed(1)} / ${TOT.toFixed(1)}`;
    els.seek.value = Math.round(s.sec);
    // Which section the runner is on (runLegAt looks the km up in legs).
    const li = runLegAt(legs, s.km);
    const l = legs[li];
    // The section card is only rebuilt when the section changes; in between, only its "Now" cells are
    // updated.
    if (li !== lastLeg) {
      lastLeg = li;
      drawLeg(li);
      const n = legs[li + 1];
      els.leg.className = `rp-leg rv-leg rv-${l.tone}`;
      // Section (what you did over the whole section) next to Now (this moment of the replay).
      const row = (k, sec, id) => `<tr><th>${k}</th><td>${sec}</td><td class="now" id="${id}"></td></tr>`;
      els.leg.innerHTML = `
        <div class="rp-leg-h"><span class="rp-leg-n"><small>Section</small><b>${l.i}</b><small>/ ${legs.length}</small></span>
          <span class="rp-leg-t"><b>${rvEsc(l.title)}</b>${legChip(l)}<span class="rp-leg-len">${(l.endKm - l.startKm).toFixed(1)} km</span></span></div>
        <div class="rp-leg-info">
          <p class="k-${l.kind}"><span class="ic">${RV_ICON[l.kind] || "➜"}</span><b>${l.vsPct ? `${Math.abs(l.vsPct)}% ${l.vsPct > 0 ? "faster" : "slower"} than your average` : "On your average"} on ${KIND[l.kind]}</b><span class="d">${rvLegData(l)}</span></p>
          <p class="nx ${n ? `k-${n.kind}` : ""}"><span class="lab">Next</span>${n ? `<span class="ic">${RV_ICON[n.kind] || "➜"}</span><b>${n.i}. ${rvEsc(n.title)}</b><span class="d">${rvLegData(n)}</span>` : `<span class="ic">${RV_ICON.finish}</span><b>Finish</b>`}</p>
        </div>
        <table class="rp-tg">
          <thead><tr><th></th><th>Section</th><th class="now">Now</th></tr></thead>
          <tbody>
            ${row("From start", `${hm(l.startSec)} → ${hm(l.endSec)}`, "rvnClock")}
            ${row("Time", `${dur(l.durSec)}${l.stopSec >= 30 ? ` <small>${dur(l.stopSec)} stopped</small>` : ""}`, "rvnTime")}
            ${row("Pace", l.pace ? `${mmss(l.pace)}/km` : "–", "rvnPace")}
            ${tgt ? row("Target", `${dur(tgt.legs[li].tgtSec)} <small class="${tgt.legs[li].deltaSec > 15 ? "rv-b" : tgt.legs[li].deltaSec < -15 ? "rv-g" : ""}">${rvSigned(tgt.legs[li].deltaSec)}</small>`, "rvnTgt") : ""}
            ${row("Grade-adj.", l.gap ? `${mmss(l.gap)}/km` : "–", "rvnGap")}
            ${row("Gradient", `${l.avg > 0 ? "+" : ""}${l.avg.toFixed(1)}% <small>+${Math.round(l.up)} / −${Math.round(l.down)} m</small>`, "rvnGrade")}
            ${run.hasHr ? row("Heart rate", l.hr ? `${Math.round(l.hr)} bpm` : "–", "rvnHr") : ""}
            ${run.hasCad ? row("Cadence", l.cad ? `${Math.round(l.cad)} spm${l.hikeShare > 0.05 ? ` <small>${Math.round(l.hikeShare * 100)}% hiked</small>` : ""}` : "–", "rvnCad") : ""}
          </tbody>
        </table>`;
      // Keep the "Now" cells by short name (Clock, Time...) so set() can fill them. Object.fromEntries
      // turns a list of [key, value] pairs into an object; a row that is not shown gives null.
      els.tn = Object.fromEntries(["Clock", "Time", "Pace", "Tgt", "Gap", "Grade", "Hr", "Cad"].map((k) => [k, els.leg.querySelector(`#rvn${k}`)]));
      lastNext = ""; // the card changed height: fit the list below it again
    }
    // The line under the section bar, and the runner's mark on the bar.
    const left = Math.max(0, l.endKm - s.km);
    els.legNow.innerHTML = `<b>Section ${l.i}/${legs.length}</b> · ${rvEsc(l.title)} ${legChip(l)} <span class="left">${left.toFixed(1)} km to go in it</span>`;
    els.legPos.style.left = `${((s.km / TOT) * 100).toFixed(2)}%`;
    // Fill one "Now" cell if it exists. The values below are those of this very moment.
    const set = (k, v) => { if (els.tn[k]) els.tn[k].textContent = v; };
    set("Clock", hm(s.sec));
    set("Time", `${dur(s.sec - l.startSec)} in`);
    set("Pace", s.pace ? `${mmss(s.pace)}/km` : "stopped");
    // Target: compare the clock with a "ghost" who runs exactly to the target (ghostAt(km) = the second
    // the ghost reaches this km). Within 30 s counts as on target.
    if (tgt) { const d = s.sec - tgt.ghostAt(s.km); set("Tgt", Math.abs(d) < 30 ? "on target" : `${dur(Math.abs(d))} ${d > 0 ? "behind" : "ahead"}`); }
    set("Gap", s.gap ? `${mmss(s.gap)}/km` : "–");
    set("Grade", `${s.grade > 0 ? "+" : ""}${s.grade.toFixed(0)}% · ${Math.round(s.ele)} m`);
    set("Hr", s.hr ? `${Math.round(s.hr)} bpm` : "–");
    // Under 145 steps per minute you are hiking (the hiking threshold of HOW_IT_WORKS.md).
    set("Cad", s.cad ? `${Math.round(s.cad)} spm${s.cad < 145 ? " · hiking" : ""}` : "–");
    // The Play button's label follows the state.
    els.play.innerHTML = rv.playing ? "❚❚ Pause" : rv.sec >= run.elapsedSec ? "↺ Replay" : rv.sec > 0 ? "▶ Resume" : "▶ Replay my run";

    // The "Stopped" or "Done" badge, hidden when there is none.
    const now = s.stopped ? `<span class="chip aidc">Stopped</span> standing still at km ${s.km.toFixed(1)}` : s.sec >= run.elapsedSec ? `<span class="chip rv-good">Done</span> <b>${TOT.toFixed(1)} km</b> in ${hm(run.elapsedSec)}` : "";
    if (now !== lastNow) { els.now.innerHTML = now; els.now.hidden = !now; lastNow = now; }

    // The "coming next" list: the next key moment, the next stop of a minute or more, the gap to the
    // target, and the count of good and bad moments so far. The 0.5 s margin keeps a moment from
    // flickering between "next" and "done" when the replay stops right on it. (() => {...})() is a
    // function called at once, to use a local variable inside an expression.
    const nextM = moments.find((x) => x.sec > s.sec + 0.5 && x.kind !== "finish");
    const done = moments.filter((x) => x.sec <= s.sec + 0.5);
    const nextStop = run.stops.find((x) => x.durSec >= 60 && x.sec > s.sec);
    const next = [
      nextM ? `<li><span>Next moment · ${rvEsc(nextM.title)}</span><b>km ${nextM.km.toFixed(1)} · in ${dur(nextM.sec - s.sec)}</b></li>` : "",
      nextStop ? `<li><span>Next stop · ${Math.round(nextStop.durSec / 60)} min</span><b>km ${nextStop.km.toFixed(1)}</b></li>` : "",
      tgt ? (() => { const d = s.sec - tgt.ghostAt(s.km); return `<li><span>Vs target ${hm(tgt.targetSec)}</span><b class="${d > 30 ? "rv-b" : d < -30 ? "rv-g" : ""}">${Math.abs(d) < 30 ? "on target" : `${dur(Math.abs(d))} ${d > 0 ? "behind" : "ahead"}`}</b></li>`; })() : "",
      `<li><span>So far</span><b><span class="rv-g">${done.filter((x) => x.tone === "good").length} went well</span> · <span class="rv-b">${done.filter((x) => x.tone === "bad").length} cost you</span></b></li>`,
    ].join("");
    // fitPanel (ui/replay.js) leaves out the rows that do not fit, so the panel never scrolls.
    if (next !== lastNext) { els.next.innerHTML = next; lastNext = next; fitPanel(els.next); }

    // The current cue: the last moment already reached. When it changes, show it, and mark it (on) and
    // the earlier ones (past) in the list below.
    let ci = -1;
    for (let i = 0; i < moments.length && moments[i].sec <= s.sec + 0.5; i++) ci = i;
    if (ci !== lastCue) {
      lastCue = ci;
      const e = moments[Math.max(0, ci)];
      els.cue.className = `rp-cue rv-cue rv-${e.tone}`;
      els.cue.title = `${e.text}${e.tip ? ` ${e.tip}` : ""}`;
      els.cue.innerHTML = `<span class="ic">${RV_ICON[e.kind] || "•"}</span><div><div class="rp-cue-h"><b>${rvEsc(e.title)}</b><small>km ${e.km.toFixed(1)} · ${hm(e.sec)}</small></div><p>${rvEsc(e.text)}${e.tip ? ` <em>${rvEsc(e.tip)}</em>` : ""}</p></div>`;
      els.list.querySelectorAll("li").forEach((x) => { x.classList.toggle("on", Number(x.dataset.i) === ci); x.classList.toggle("past", Number(x.dataset.i) < ci); });
    }
    // The pace line: move the three clip rectangles (past, current section, ahead) and the dot, and
    // write the live pace next to the dot (on its left near the right edge, so it stays inside).
    if (paceG) {
      const cx = prof.x(s.km);
      // The whole current section is lit; the rest of the line stays faint. When the next
      // section starts, the lit part jumps to it in one go.
      const ax = prof.x(l.startKm), bx = prof.x(l.endKm);
      pcRects.past.setAttribute("width", Math.max(0, ax - prof.l).toFixed(1));
      pcRects.trail.setAttribute("x", ax.toFixed(1));
      pcRects.trail.setAttribute("width", Math.max(0, bx - ax).toFixed(1));
      pcRects.ahead.setAttribute("x", bx.toFixed(1));
      pcRects.ahead.setAttribute("width", Math.max(0, prof.W - prof.r - bx).toFixed(1));
      const v = prof.paceAt(s.km);
      const cy = prof.paceY(v);
      paceDot.setAttribute("cx", cx.toFixed(1));
      paceDot.setAttribute("cy", cy.toFixed(1));
      paceG.classList.toggle("on", s.sec > 0);
      const label = s.stopped ? "stopped" : v > 0 ? `${mmss(1000 / v)}/km` : "";
      paceTxt.textContent = s.sec > 0 ? label : "";
      const right = cx > prof.W - 120;
      paceTxt.setAttribute("x", (cx + (right ? -9 : 9)).toFixed(1));
      paceTxt.setAttribute("y", (cy - 6).toFixed(1));
      paceTxt.setAttribute("text-anchor", right ? "end" : "start");
    }
    // The cursor on the profile: shift the group sideways with an SVG transform, then set the dot's
    // height.
    if (els.cur) {
      els.cur.style.display = "";
      els.cur.setAttribute("transform", `translate(${prof.x(s.km).toFixed(1)},0)`);
      els.cur.querySelector("circle").setAttribute("cy", prof.y(s.ele).toFixed(1));
    }
    // And the runner on the map.
    if (rv.map) rv.map.setRunner(s.km);
  };

  // 5. Same animation loop as the race-day replay: requestAnimationFrame, race time += real time x
  // speed.
  // `t` is the time stamp the browser passes in (ms). dt is the real time since the last frame, in
  // seconds, capped at 0.25 s so that coming back to a hidden tab does not jump ahead. With "Stop at
  // each moment" on, a step that crosses a moment stops 1 s past it and the cue pulses. The loop goes
  // on only while playing, by asking for the next frame each time.
  const frame = (t) => {
    if (!rv.playing) return;
    const dt = Math.min(0.25, (t - (rv.last || t)) / 1000);
    rv.last = t;
    const prev = rv.sec;
    let next = Math.min(run.elapsedSec, prev + dt * rv.speed);
    if (rv.pauseAt) {
      const hit = moments.find((e) => e.sec > prev + 0.5 && e.sec <= next);
      if (hit) { next = hit.sec + 1; rv.playing = false; els.cue.classList.add("pulse"); }
    }
    rv.sec = next;
    if (rv.sec >= run.elapsedSec) rv.playing = false;
    draw();
    if (rv.playing) rv.raf = requestAnimationFrame(frame);
  };
  // Start (or start again from 0 at the end): reset the frame clock (rv.last = 0 means "first frame"),
  // follow the runner on the map, and ask for the first frame.
  const play = () => {
    if (rv.sec >= run.elapsedSec) rv.sec = 0;
    rv.playing = true;
    rv.last = 0;
    els.cue.classList.remove("pulse");
    if (rv.map && rv.follow) rv.map.follow(true);
    rv.raf = requestAnimationFrame(frame);
    draw();
  };
  // pause() cancels the frame already asked for. seek() clamps the second to the run and redraws.
  const pause = () => { rv.playing = false; cancelAnimationFrame(rv.raf); draw(); };
  const seek = (sec) => { rv.sec = Math.max(0, Math.min(run.elapsedSec, sec)); els.cue.classList.remove("pulse"); draw(); };
  // The deep dive below asks the replay to jump to a moment through this.
  rv.seekTo = (sec) => { pause(); seek(sec + 1); $v("#rvCockpit").scrollIntoView({ behavior: "smooth", block: "start" }); };
  // Jump to the next (dir = 1) or previous (dir = -1) key moment. The replay lands 1 s after the moment
  // so its cue shows; "previous" skips the moment you are on (1.5 s margin).
  const jump = (dir) => {
    const list = dir > 0 ? moments.filter((e) => e.sec > rv.sec + 0.5) : moments.filter((e) => e.sec < rv.sec - 1.5).reverse();
    if (list[0]) { pause(); seek(list[0].sec + 1); }
  };

  // 6. Wire the controls. Every action is also counted with trackEvent (ui/analytics.js). `rv.playing ?
  // pause() : play()` calls one or the other.
  els.play.addEventListener("click", () => { trackEvent(rv.playing ? "review-pause" : "review-play"); rv.playing ? pause() : play(); });
  $v("#rvPrev").addEventListener("click", () => { trackEvent("review-step", "prev"); jump(-1); });
  $v("#rvNextBtn").addEventListener("click", () => { trackEvent("review-step", "next"); jump(1); });
  // "input" fires while you drag the slider, "change" once you let go.
  els.seek.addEventListener("input", () => seek(Number(els.seek.value)));
  els.seek.addEventListener("change", () => trackEvent("review-seek"));
  $v("#rvSpeed").addEventListener("change", (e) => { rv.speed = Number(e.target.value); trackEvent("review-speed", e.target.value); });
  $v("#rvPause").addEventListener("change", (e) => { rv.pauseAt = e.target.checked; });
  $v("#rvFollow").addEventListener("change", (e) => { rv.follow = e.target.checked; if (rv.map) rv.map.follow(rv.follow); });
  // A click on a section block jumps to its start and zooms the map onto it.
  els.legBtns.forEach((b) => b.addEventListener("click", () => {
    const l = legs[Number(b.dataset.i)];
    trackEvent("review-section", l.tone);
    pause();
    seek(l.startSec + 1);
    if (rv.map) rv.map.show(l.startKm, l.endKm);
  }));
  // A click on a key moment in the list jumps there and scrolls the cockpit into view.
  els.list.querySelectorAll("li button").forEach((b) => b.addEventListener("click", () => {
    const e = moments[Number(b.parentElement.dataset.i)];
    trackEvent("review-moment", e.tone);
    pause();
    seek(e.sec + 1);
    $v("#rvCockpit").scrollIntoView({ behavior: "smooth", block: "start" });
  }));
  // A tap on the profile jumps the replay to that km. A pointer that moved 8 px or more between down
  // and up was a drag (scrolling the profile), not a tap. Pointer events cover mouse, pen and touch.
  // The tap's x is turned into SVG units (0 to 1000), then into a km, then into the run second at that
  // km.
  if (svgEl) {
    let down = null;
    svgEl.addEventListener("pointerdown", (ev) => { down = { x: ev.clientX, y: ev.clientY }; });
    svgEl.addEventListener("pointercancel", () => { down = null; });
    svgEl.addEventListener("pointerup", (ev) => {
      if (down && Math.hypot(ev.clientX - down.x, ev.clientY - down.y) < 8) {
        const b = svgEl.getBoundingClientRect();
        trackEvent("review-profile-tap");
        pause();
        seek(runSecAtKm(run, prof.km(((ev.clientX - b.left) / b.width) * 1000)));
      }
      down = null;
    });
  }
  // Keyboard: space plays or pauses, the arrows jump between moments. Only when this mode is on screen,
  // the cockpit is at least partly visible, and you are not typing in a field (the slider and the
  // checkboxes still let space through). preventDefault stops the page from scrolling.
  rv.onKey = (ev) => {
    if (!box.isConnected || document.documentElement.dataset.mode !== "run") return;
    const tag = (ev.target.tagName || "").toLowerCase();
    if (["input", "select", "textarea"].includes(tag) && ev.target.type !== "range" && ev.target.type !== "checkbox") return;
    const r = box.getBoundingClientRect();
    if (r.bottom < 0 || r.top > window.innerHeight) return;
    if (ev.key === " " && tag !== "button") { ev.preventDefault(); rv.playing ? pause() : play(); }
    else if (ev.key === "ArrowRight" && tag !== "input") { ev.preventDefault(); jump(1); }
    else if (ev.key === "ArrowLeft" && tag !== "input") { ev.preventDefault(); jump(-1); }
  };
  document.addEventListener("keydown", rv.onKey);
  // The record tiles and km bars of the recap carry data-sec: a click replays that moment.
  box.querySelectorAll(".rv-st[data-sec], .rv-km-bar[data-sec]").forEach((b) => b.addEventListener("click", () => {
    trackEvent("review-stat", b.dataset.k || "km");
    pause();
    seek(Number(b.dataset.sec) + 1);
    $v("#rvCockpit").scrollIntoView({ behavior: "smooth", block: "start" });
  }));
  // The target form: changing the kind clears the value and shows a matching example; submitting reads
  // "2:45" or "6:15" (parseTarget, core/review.js), saves it and rebuilds the whole review with the
  // comparison. ev.preventDefault() stops the browser from reloading the page on submit.
  const tf = $v("#rvTgtForm");
  if (tf) {
    const kindSel = $v("#rvTgtKind");
    const valIn = $v("#rvTgtVal");
    kindSel.addEventListener("change", () => { valIn.value = ""; valIn.placeholder = kindSel.value === "pace" ? mmss(run.avgPace * 0.95) : hm(run.elapsedSec * 0.95).replace("h", ":"); valIn.focus(); });
    tf.addEventListener("submit", (ev) => {
      ev.preventDefault();
      const t = parseTarget(kindSel.value, valIn.value);
      if (!t) { $v("#rvTgtErr").textContent = kindSel.value === "pace" ? "Type a pace like 6:15 (minutes:seconds per km)." : "Type a time like 2:45 (hours:minutes)."; return; }
      rv.target = t;
      rvSaveTarget(t);
      trackEvent("review-target", t.kind);
      mountRun(box, run);
      box.querySelector("#rv-target").scrollIntoView({ behavior: "smooth", block: "start" });
    });
    const clr = $v("#rvTgtClear");
    if (clr) clr.addEventListener("click", () => { rv.target = null; rvSaveTarget(null); trackEvent("review-target", "clear"); mountRun(box, run); });
  }
  // First draw, at the saved position.
  draw();
}

/** The run on screen, for the A4 export (ui/print.js): {run, name, target}, or null. */
export function currentRun() {
  return rv.run ? { run: rv.run, name: rv.name, target: rv.target } : null;
}

/**
 * Stop the review animation and free its map. It also removes the keyboard listener, so the keys
 * do nothing once you leave this mode. mountRun calls it before each new mount.
 */
export function stopRun() {
  rv.playing = false;
  cancelAnimationFrame(rv.raf);
  if (rv.onKey) document.removeEventListener("keydown", rv.onKey);
  rv.onKey = null;
  if (rv.map) rv.map.destroy();
  rv.map = null;
}

/** Pause without tearing down (when you switch back to the planner). */
export function pauseRun() {
  rv.playing = false;
  cancelAnimationFrame(rv.raf);
}

/**
 * Wire the "Check my run" drop zone and sample button, and render section #s5. `onLoaded(summaryHtml)`
 * lets the page show the run in its top bar.
 *
 * Called once by main.js at start-up. Elements used: #dropRun (the drop zone), #fileRun (the file
 * input), #stRun (the status line), #s5body (the review), #s6body (the deep dive) and every
 * [data-run-sample] button. Note: onLoaded is in fact called as onLoaded(run, {sample, name}),
 * with the analysed run, not an HTML summary.
 */
export function initRunMode({ onLoaded } = {}) {
  const drop = document.querySelector("#dropRun");
  const input = document.querySelector("#fileRun");
  const status = document.querySelector("#stRun");
  const body = document.querySelector("#s5body");
  // What the two sections show before any run is loaded.
  const empty = () => { body.innerHTML = `<div class="empty"><b>Drop the GPX of a run you did</b> above (or press Try a sample run): you get it replayed on the map with its key moments, good and bad.</div>`; emptyInsights(document.querySelector("#s6body")); };
  // Analyse a GPX text and show it. `label` is the name to show, `sample` is true for the demo run. Any
  // error (not a GPX, no points...) is caught and shown in the status line instead of breaking the
  // page.
  const load = (xml, label, sample) => {
    try {
      const run = analyseRun(parseGpx(xml));
      rv.name = label || run.name || "Your run";
      status.innerHTML = `<span class="ok">✓ ${rvEsc(rv.name)}</span> · ${run.totalKm.toFixed(1)} km · ${hm(run.elapsedSec)} · ${Math.round(run.gain)} m D+`;
      drop.classList.add("done");
      mountRun(body, run);
      mountInsights(document.querySelector("#s6body"), run, { onSeek: (sec) => { if (rv.seekTo) rv.seekTo(sec); } });
      trackOnce("review-built", sample ? "sample" : "own");
      if (onLoaded) onLoaded(run, { sample, name: rv.name });
      document.querySelector("#s5").scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (e) {
      trackEvent("gpx-error", "review");
      status.innerHTML = `<div class="err">${rvEsc(e.message)}</div>`;
    }
  };
  // A file from the input or from a drop: only the first one is used. f.text() reads it as text; it
  // returns a Promise, hence async and await. A read error gives "", which parseGpx then rejects. The
  // input is cleared, so choosing the same file again still fires "change".
  const handle = async (files) => {
    const f = [...(files || [])][0];
    if (!f) return;
    trackEvent("gpx-upload", "review");
    load(await f.text().catch(() => ""), f.name.replace(/\.gpx$/i, ""), false);
    input.value = "";
  };
  // Drag and drop: "dragover" must call preventDefault, or the browser refuses the drop (and opens the
  // file instead). The "over" class highlights the zone.
  input.addEventListener("change", () => handle(input.files));
  drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("over"));
  drop.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("over"); handle(e.dataTransfer.files); });
  // The sample run is made up in the browser (demo.js): no file needed.
  document.querySelectorAll("[data-run-sample]").forEach((b) => b.addEventListener("click", () => {
    trackEvent("review-sample");
    load(makeDemoRunGpx(), "Sample trail run (made up)", true);
  }));
  empty();
}
