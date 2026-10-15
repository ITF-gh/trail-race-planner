// review.js (ui): the "Check my run" mode. Drop the GPX of a run you just did and replay it: the runner
// moves along the map and the profile at your real pace, with your real stops, the clock shows
// the real time of day, and every key moment (strong climb, fade, stop, heart rate drift...) stops
// the replay with what it means. Same cockpit as the race-day replay (same CSS grid and classes),
// but everything in it comes from what you recorded, not from a plan.
//
// Colours: the section bar, the map and the profile are coloured by how you ran each stretch
// compared with your own average on the same kind of ground (green: better, red: worse), so a
// glance shows where the run went well and where it cost you.

import { parseGpx } from "../core/track.js";
import { analyseRun, runStateAt, runLegAt, runSecAtKm, runTarget, parseTarget, runStats, runPaceLine } from "../core/review.js";
import { courseMap } from "./map.js";
import { fitPanel } from "./replay.js";
import { mmss, hm, hms, clock } from "../core/format.js";
import { trackEvent, trackOnce } from "./analytics.js";
import { makeDemoRunGpx } from "../demo.js";

const rvEsc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const RV_SPEEDS = [
  { v: 60, label: "1 h in 1 min" },
  { v: 180, label: "1 h in 20 s" },
  { v: 480, label: "1 h in 7.5 s" },
];
// Length and climb of a section, written out under its title.
const rvLegData = (l) => `${(l.endKm - l.startKm).toFixed(1)} km · +${Math.round(l.up)} / −${Math.round(l.down)} m`;
const RV_ICON = { start: "▶", finish: "🏁", climb: "▲", descent: "▼", flat: "➜", stop: "❚❚", fade: "↘", even: "=", "finish-strong": "↗", "finish-weak": "↘", drift: "♥", hr: "♥", walk: "⋯" };
const RV_TONE = { good: "Went well", bad: "Cost you", info: "Worth knowing" };
const RV_FORM = ["", "Much weaker", "Weaker", "Your average", "Stronger", "Much stronger"];

/** The target typed last time (kept in this browser only). */
function rvLoadTarget() {
  try { return JSON.parse(localStorage.getItem("trp.runTarget") || "null"); } catch { return null; }
}
function rvSaveTarget(t) {
  try { if (t) localStorage.setItem("trp.runTarget", JSON.stringify(t)); else localStorage.removeItem("trp.runTarget"); } catch { /* private mode: keep it for this visit only */ }
}
const rvSigned = (sec) => `${sec >= 0 ? "+" : "−"}${dur(Math.abs(sec))}`;
const RV_STATUS = {
  reached: ["rv-good", "Target reached"],
  reach: ["rv-good", "Within reach"],
  stretch: ["rv-ok", "A stretch"],
  far: ["rv-bad", "Far for now"],
};

/**
 * The "Against your target" block: the form, the verdict, where the gap comes from, and the
 * sections where changing the effort would have changed the result.
 */
function rvTargetHtml(run, t) {
  const kind = rv.target ? rv.target.kind : "time";
  const val = rv.target ? (rv.target.kind === "pace" ? mmss(rv.target.value) : hm(rv.target.value).replace("h", ":")) : "";
  const form = `<form class="rv-tgt-form" id="rvTgtForm">
    <label class="f">Target<select id="rvTgtKind"><option value="time" ${kind === "time" ? "selected" : ""}>Finish time (h:mm)</option><option value="pace" ${kind === "pace" ? "selected" : ""}>Average pace (m:ss /km)</option></select></label>
    <label class="f">Value<input type="text" id="rvTgtVal" value="${val}" placeholder="${kind === "pace" ? mmss(run.avgPace * 0.95) : hm(run.elapsedSec * 0.95).replace("h", ":")}" autocomplete="off" inputmode="numeric" size="8"></label>
    <button class="btn primary" type="submit">Compare</button>
    ${rv.target ? `<button class="btn" type="button" id="rvTgtClear">Clear</button>` : ""}
    <span class="rv-tgt-err" id="rvTgtErr" role="alert"></span>
  </form>`;
  if (!t) return `<div class="panel rv-tgt">${form}<p class="note">Type the time (or the pace) you were aiming for. The review then shows how far you were from it, where the time went, and how to spread your effort to get there next time.</p></div>`;
  const [cls, head] = RV_STATUS[t.status];
  const tgtTxt = t.target.kind === "pace" ? `${mmss(t.target.value)}/km (${hm(t.targetSec)} for ${run.totalKm.toFixed(1)} km)` : `${hm(t.targetSec)} (${mmss(t.targetPace)}/km)`;
  const more = (x) => `${x >= 0 ? "+" : "−"}${Math.abs(x).toFixed(1)}%`;
  const why = {
    reached: `You finished in ${hm(run.elapsedSec)}, ${dur(-t.gapSec)} inside your target of ${tgtTxt}.${t.realisticSec < t.targetSec - 120 ? ` On this run you could aim for about <b>${hm(t.realisticSec)}</b> next time: your first-half effort held to the end, and stops kept to 1 min per hour.` : ""}`,
    reach: `You were ${dur(t.gapSec)} over ${tgtTxt}. The legs were there: shorter stops and holding your first-half effort to the end cover the gap.`,
    stretch: `You were ${dur(t.gapSec)} over ${tgtTxt}. It needs ${more(t.vsFirstPct)} on the effort you showed in the first half: realistic after a block of training.`,
    far: `You were ${dur(t.gapSec)} over ${tgtTxt}. It needs ${more(t.vsFirstPct)} on the effort you showed in the first half. Aim for about <b>${hm(t.realisticSec)}</b> next time on this kind of course, then build from there.`,
  }[t.status];
  const tile = (k, v, sub) => `<div class="rp-tot"><span class="k">${k}</span><b>${v}</b>${sub ? `<small>${sub}</small>` : ""}</div>`;
  const sec = (l) => `${l.i}. ${rvEsc(l.title)} <small>km ${l.startKm.toFixed(1)} → ${l.endKm.toFixed(1)}</small>`;
  const tgtLine = (l) => (l.kind === "climb" && l.tgtVam ? `${Math.round(l.tgtVam)} m/h climbing instead of ${Math.round(l.vam)}` : l.tgtPace ? `${mmss(l.tgtPace)}/km instead of ${mmss(l.pace)}` : "");
  const adapt = t.status === "reached" ? "" : `
    <div class="rv-tgt-adapt">
      <div><div class="sub-h">Where to find the time</div><ul class="rv-tgt-list">${t.lose.map((l) => `<li class="rv-bad"><b>${sec(l)}</b><span>${dur(l.deltaSec)} slower than the target asked: ${tgtLine(l)}.${l.startKm >= run.halves.km ? " Late in the run: this is fuel and pacing, not fitness." : ""}</span></li>`).join("") || `<li>No section stands out: the gap is spread evenly.</li>`}</ul></div>
      ${t.ease.length ? `<div><div class="sub-h">Where to ease off</div><ul class="rv-tgt-list">${t.ease.map((l) => `<li class="rv-good"><b>${sec(l)}</b><span>${dur(-l.deltaSec)} faster than the target needed, before your fade: easing off here keeps legs for the end.</span></li>`).join("")}</ul></div>` : ""}
    </div>`;
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
 */
function rvStatsHtml(run, st) {
  const S = runStats(run);
  const where = (o) => `km ${o.km.toFixed(1)} · ${clock(st, o.startSec)}`;
  const tile = (k, key, v, sub, o) => `<button type="button" class="rv-st" data-k="${key}"${o ? ` data-sec="${Math.round(o.startSec)}"` : ""}><span class="k">${k}</span><b>${v}</b><small>${sub}</small></button>`;
  const fast = (o, label, key) => (o ? tile(label, key, `${mmss(o.sec)}`, `${mmss(o.pace)}/km · ${where(o)}`, o) : "");
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
  const sp = S.splits.filter((x) => x.pace);
  let bars = "";
  if (sp.length > 1) {
    const vmax = Math.max(...sp.map((x) => 1000 / x.pace)), vmin = Math.min(...sp.map((x) => 1000 / x.pace)) * 0.85;
    const W = 1000, H = 120, top = 16, base = 96, gap = 2;
    const bw = (W - 40) / sp.length;
    const yv = (v) => base - ((v - vmin) / Math.max(1e-6, vmax - vmin)) * (base - top);
    const avgV = 1000 / S.movingPace;
    let svg = "";
    sp.forEach((x, k) => {
      const v = 1000 / x.pace, yy = yv(v), xx = 34 + k * bw;
      const tag = x === S.fastestSplit ? " best" : x === S.slowestSplit ? " worst" : "";
      svg += `<g class="rv-km-bar${tag}" data-sec="${Math.round(runSecAtKm(run, x.km - (x.part || 1)))}"><rect x="${(xx + gap / 2).toFixed(1)}" y="${yy.toFixed(1)}" width="${Math.max(1, bw - gap).toFixed(1)}" height="${(base - yy).toFixed(1)}"/><title>${x.part ? `Last ${(x.part * 1000).toFixed(0)} m` : `Km ${x.km}`}: ${mmss(x.pace)}/km · +${Math.round(x.up)} / −${Math.round(x.down)} m</title></g>`;
      if (sp.length <= 30 || k % 2 === 0) svg += `<text x="${(xx + bw / 2).toFixed(1)}" y="${base + 14}" text-anchor="middle">${x.part ? "end" : x.km}</text>`;
      if (tag) svg += `<text class="rv-km-lab" x="${(xx + bw / 2).toFixed(1)}" y="${(yy - 4).toFixed(1)}" text-anchor="middle">${mmss(x.pace)}</text>`;
    });
    svg += `<line class="rv-km-avg" x1="34" x2="${W - 6}" y1="${yv(avgV).toFixed(1)}" y2="${yv(avgV).toFixed(1)}"/><text class="rv-km-lab" x="30" y="${(yv(avgV) + 3).toFixed(1)}" text-anchor="end">${mmss(S.movingPace)}</text>`;
    bars = `<div class="rv-kms"><div class="rv-kms-h"><b>Pace per km</b><small>taller = faster · line = your moving average · click a bar to replay that km</small></div><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Pace of each km">${svg}</svg></div>`;
  }
  const table = `<details class="rv-tgt-all"><summary>Every km: time, pace, grade-adjusted pace, climbing${run.hasHr ? ", heart rate" : ""}</summary>
    <table class="rp-tg rv-km-t"><thead><tr><th>Km</th><th>Time</th><th>Pace</th><th>Grade-adj.</th><th>D+ / D−</th>${run.hasHr ? "<th>HR</th>" : ""}</tr></thead><tbody>
    ${S.splits.map((x) => `<tr${x === S.fastestSplit ? ' class="best"' : x === S.slowestSplit ? ' class="worst"' : ""}><th>${x.part ? `+${(x.part * 1000).toFixed(0)} m` : x.km}</th><td>${mmss(x.sec)}${x.stopSec >= 30 ? ` <small>${dur(x.stopSec)} stopped</small>` : ""}</td><td>${x.pace ? `${mmss(x.pace)}/km` : "–"}</td><td>${x.gap ? `${mmss(x.gap)}/km` : "–"}</td><td>+${Math.round(x.up)} / −${Math.round(x.down)} m</td>${run.hasHr ? `<td>${x.hr ? Math.round(x.hr) : "–"}</td>` : ""}</tr>`).join("")}
    </tbody></table></details>`;
  return `<div class="panel rv-stats"><div class="rv-st-grid">${tiles}</div>${bars}${table}</div>`;
}

// Survives a re-render, so the replay keeps its place.
const rv = { run: null, name: "", target: rvLoadTarget(), sec: 0, playing: false, speed: 180, pauseAt: true, follow: true, raf: 0, map: null, onKey: null };

/** Seconds since midnight, local time, when the run started (for clock times of day). */
const startOfDay = (ms) => { const d = new Date(ms); return d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds(); };
const dur = (sec) => (sec < 3600 ? `${Math.max(0, Math.round(sec / 60))} min` : hm(sec));

/**
 * The profile of the run (SVG, viewBox 1000 wide): the line coloured by form, a pin over each key
 * moment (green good, red bad) and a triangle at each stop. Returns {html, x, y, km, top, base}.
 */
function rvProfile(run) {
  const P = run.profile;
  const TOT = run.totalKm;
  const eles = P.map((p) => p[1]);
  const EMIN = Math.min(...eles), EMAX = Math.max(...eles);
  // Flat: it runs the full width of the cockpit, right under the section bar.
  const W = 1000, l = 52, r = 14, top = 26, base = 92, H = 114;
  const plotH = base - top - 12;
  const x = (km) => l + (km / TOT) * (W - l - r);
  const y = (e) => base - 8 - ((e - EMIN) / Math.max(1, EMAX - EMIN)) * plotH;
  const km = (vx) => Math.max(0, Math.min(TOT, ((vx - l) / (W - l - r)) * TOT));
  const eAt = (k) => { let i = 1; while (i < P.length - 1 && P[i][0] < k) i++; const a = P[i - 1], b = P[i]; return a[1] + Math.max(0, Math.min(1, (k - a[0]) / (b[0] - a[0] || 1))) * (b[1] - a[1]); };
  const line = (a, b) => [[a, eAt(a)], ...P.filter((p) => p[0] > a && p[0] < b), [b, eAt(b)]].map((p, i) => `${i ? "L" : "M"}${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join("");
  let s = `<path class="area" d="M${x(0)},${base} ${P.map((p) => `L${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join(" ")} L${x(TOT)},${base} Z"/>`;
  run.effortBands.forEach((b) => { s += `<path class="rv-pf rv-f${b.cls}" d="${line(b.fromKm, b.toKm)}"/>`; });
  s += `<line class="axis" x1="${l}" x2="${W - r}" y1="${base}" y2="${base}"/>`;
  const tick = TOT > 60 ? 10 : TOT > 25 ? 5 : TOT > 8 ? 2 : 1;
  for (let k = 0; k <= TOT + 1e-9; k += tick) s += `<line class="axis" x1="${x(k)}" x2="${x(k)}" y1="${base}" y2="${base + 5}"/><text x="${x(k)}" y="${base + 18}" text-anchor="middle">${k}</text>`;
  s += `<text x="${W - r}" y="${base + 18}" text-anchor="end">km</text>`;
  [Math.ceil(EMIN / 10) * 10, Math.floor(EMAX / 10) * 10].forEach((e) => { s += `<text x="${l - 6}" y="${(y(e) + 3).toFixed(1)}" text-anchor="end">${e} m</text>`; });
  run.stops.filter((st) => st.durSec >= 60).forEach((st) => { const yy = y(eAt(st.km)); s += `<path class="aid" d="M${x(st.km).toFixed(1)},${(yy - 5).toFixed(1)} l-6,-10 h12 z"><title>Stopped ${Math.round(st.durSec / 60)} min at km ${st.km.toFixed(1)}</title></path>`; });
  run.moments.filter((m) => m.tone !== "info").forEach((m) => {
    const xx = x(m.km);
    s += `<g class="rv-pin-p ${m.tone}"><line x1="${xx.toFixed(1)}" x2="${xx.toFixed(1)}" y1="${top - 8}" y2="${y(eAt(m.km)).toFixed(1)}"/><circle cx="${xx.toFixed(1)}" cy="${top - 14}" r="8"/><text x="${xx.toFixed(1)}" y="${top - 10.5}" text-anchor="middle">${m.tone === "good" ? "+" : "−"}</text><title>${rvEsc(m.title)}</title></g>`;
  });
  // Pace line: speed (higher = faster) over the same band, scaled between your slow 5% and fast
  // 5% so a stop or a sprint does not squash the rest. Three copies of one path, each clipped to
  // a part of the run: done (faded), the last stretch behind the runner (bright), still to come.
  const pl = runPaceLine(run);
  const vs = pl.map((p) => p.v).filter((v) => v > 0).sort((a, b) => a - b);
  let paceY = null;
  if (vs.length > 4) {
    const vlo = vs[Math.floor(vs.length * 0.05)] * 0.95, vhi = vs[Math.floor(vs.length * 0.95)] * 1.03;
    const yHi = top + 4, yLo = base - 10;
    paceY = (v) => yLo - (Math.max(vlo, Math.min(vhi, v)) - vlo) / Math.max(1e-6, vhi - vlo) * (yLo - yHi);
    const d = pl.filter((p) => p.v > 0).map((p, i) => `${i ? "L" : "M"}${x(p.km).toFixed(1)},${paceY(p.v).toFixed(1)}`).join("");
    const clip = (id) => `<clipPath id="${id}"><rect x="${l}" y="0" width="0" height="${H}"/></clipPath>`;
    s += `<defs>${clip("rvPcPast")}${clip("rvPcTrail")}${clip("rvPcAhead")}</defs><g class="rv-pace">`
      + `<path class="rv-pl ahead" clip-path="url(#rvPcAhead)" d="${d}"/><path class="rv-pl past" clip-path="url(#rvPcPast)" d="${d}"/><path class="rv-pl trail" clip-path="url(#rvPcTrail)" d="${d}"/>`
      + `<text class="rv-pl-t" x="${W - r - 2}" y="${(yHi + 3).toFixed(1)}" text-anchor="end">${mmss(1000 / vhi)}/km</text><text class="rv-pl-t" x="${W - r - 2}" y="${(yLo + 3).toFixed(1)}" text-anchor="end">${mmss(1000 / vlo)}/km</text>`
      + `<circle class="rv-pl-dot" r="4.5" cx="${x(0)}" cy="${paceY(pl[0].v || vlo).toFixed(1)}"/><text class="rv-pl-v" x="${x(0)}" y="0"></text></g>`;
  }
  s += `<g class="pcur" style="display:none"><line x1="0" x2="0" y1="${top - 4}" y2="${base}"/><circle cx="0" cy="${base}" r="6"/></g>`;
  // Where the pace line is at `k` km (interpolated between its 100 m points).
  const paceAt = (k) => { let i = 1; while (i < pl.length - 1 && pl[i].km < k) i++; const a = pl[i - 1], b = pl[i]; const f = Math.max(0, Math.min(1, (k - a.km) / (b.km - a.km || 1))); return a.v + f * (b.v - a.v); };
  return { x, y, km, top, base, line, paceY, paceAt, l, W, r, html: `<div class="prof-scroll"><svg viewBox="0 0 1000 ${H}" role="img" aria-label="Elevation profile of your run, coloured by how you ran each stretch">${s}</svg></div>` };
}

/** Map styling: the route coloured by form, a glow under each good or bad moment, stops as triangles. */
function rvMapStyle(run) {
  const paint = run.moments.filter((m) => m.tone !== "info" && m.toKm - m.km >= 0.1).map((m) => ({ fromKm: m.km, toKm: m.toKm, cls: `rv-mglow ${m.tone}`, title: `${m.tone === "good" ? "+" : "−"} ${rvEsc(m.title)}` }));
  run.effortBands.forEach((b) => paint.push({ fromKm: b.fromKm, toKm: b.toKm, cls: `rv-rt rv-f${b.cls}`, title: RV_FORM[b.cls] }));
  const marks = [{ km: 0, kind: "start", label: "Start" }];
  const every = run.totalKm > 60 ? 10 : run.totalKm > 25 ? 5 : 2;
  for (let k = every; k < run.totalKm - 0.5; k += every) marks.push({ km: k, kind: "km", label: String(k) });
  run.stops.filter((st) => st.durSec >= 60).forEach((st) => marks.push({ km: st.km, kind: "aid", label: "Stop", title: `Stopped ${Math.round(st.durSec / 60)} min · km ${st.km.toFixed(1)}` }));
  return { paint, marks };
}

/** Mount the review cockpit for `run` in `box`. */
export function mountRun(box, run) {
  stopRun();
  if (rv.run !== run) { rv.run = run; rv.sec = 0; }
  const st = startOfDay(run.startMs);
  const legs = run.legs;
  const moments = run.moments;
  const TOT = run.totalKm;
  const pct = (k) => `${((k / TOT) * 100).toFixed(3)}%`;
  const prof = rvProfile(run);
  const tgt = rv.target ? runTarget(run, rv.target) : null;
  const good = moments.filter((m) => m.tone === "good");
  const bad = moments.filter((m) => m.tone === "bad");
  const date = new Date(run.startMs).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric" });
  const tile = (k, v, sub) => `<div class="rp-tot"><span class="k">${k}</span><b>${v}</b>${sub ? `<small>${sub}</small>` : ""}</div>`;
  const KIND = { climb: "climbs", descent: "descents", flat: "runnable stretches" };
  const legChip = (l) => `<span class="chip rv-${l.tone}">${l.verdict}${l.vsPct ? ` ${l.vsPct > 0 ? "+" : ""}${l.vsPct}%` : ""}</span>`;

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
  <div class="sub-h" id="rv-stats">Your numbers</div>
  ${rvStatsHtml(run, st)}
  <div class="sub-h" id="rv-target">Against your target</div>
  <div id="rvTgt">${rvTargetHtml(run, tgt)}</div>
  <div class="sub-h" id="rv-moments">Key moments · ${good.length} went well · ${bad.length} cost you</div>
  <ol class="rp-script rv-script" id="rvScript">${moments.map((m) => `<li data-i="${m.i}" class="rv-${m.tone}"><button type="button"><span class="ic">${RV_ICON[m.kind] || "•"}</span><span class="t"><b>${rvEsc(m.title)}</b><small>km ${m.km.toFixed(1)} · ${clock(st, m.sec)} · ${RV_TONE[m.tone]}</small></span><span class="cue">${rvEsc(m.text)}${m.tip ? `<em>${rvEsc(m.tip)}</em>` : ""}</span></button></li>`).join("")}</ol>
  <div class="sub-h">How to read it</div>
  <p class="note rv-how">Every section is compared with <b>your own average on the same kind of ground</b> that day: climbs with your climbs, descents with your descents, runnable stretches with your runnable stretches. The yardstick is grade-adjusted pace (GAP): your pace converted to the flat pace that would have cost the same energy, from the energy cost of running on a slope measured by Minetti and colleagues (2002). +10% on a climb = you climbed 10% faster than your average climb, for its steepness. Stops are any moment slower than 0.3 m/s; they count in the clock but not in the paces. Heart rate drift compares speed per heartbeat between the two halves (over 5% is a sign of fatigue, heat or low fuel). Your file never leaves this page.</p>`;

  const $v = (s) => box.querySelector(s);
  const els = { leg: $v("#rvLeg"), legNow: $v("#rvLegNow"), legPos: $v("#rvLegPos"), legBtns: [...box.querySelectorAll("#rvLegs .lg")], clock: $v("#rvClock"), el: $v("#rvElapsed"), bar: $v("#rvBar"), km: $v("#rvKm"), now: $v("#rvNow"), next: $v("#rvNext"), cue: $v("#rvCue"), play: $v("#rvPlay"), seek: $v("#rvSeek"), cur: $v("#rvProf .pcur"), list: $v("#rvScript") };
  // A window resize changes the room in the panel: fit the "coming next" list again.
  if (typeof ResizeObserver === "function") new ResizeObserver(() => fitPanel(els.next)).observe($v(".rp-hud"));
  const m = rvMapStyle(run);
  rv.map = courseMap($v("#rvMap"), { route: run.route, totalKm: TOT, paint: m.paint, marks: m.marks });
  rv.map.follow(rv.follow && rv.sec > 0);

  // The section you are on: a band on the profile, the glow on the map, the button on the bar.
  const svgEl = $v("#rvProf svg");
  const profScroll = $v("#rvProf .prof-scroll");
  // As on race day: a soft band over the section and a glow drawn under its stretch of line.
  let legG = null;
  let glowG = null;
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
  const drawLeg = (li) => {
    const l = legs[li];
    if (legG) {
      legG.innerHTML = `<rect class="pl-cur" x="${prof.x(l.startKm).toFixed(1)}" y="${prof.top - 4}" width="${Math.max(2, prof.x(l.endKm) - prof.x(l.startKm)).toFixed(1)}" height="${prof.base - prof.top + 4}"/>`
        + `<text class="pl-t" x="${((prof.x(l.startKm) + prof.x(l.endKm)) / 2).toFixed(1)}" y="${prof.base - 6}" text-anchor="middle">${l.i}</text>`;
      glowG.innerHTML = `<path class="pl-glow" d="${prof.line(l.startKm, l.endKm)}"/>`;
    }
    if (profScroll && profScroll.scrollWidth > profScroll.clientWidth + 4) {
      const k = profScroll.scrollWidth / 1000;
      profScroll.scrollLeft = Math.max(0, ((prof.x(l.startKm) + prof.x(l.endKm)) / 2) * k - profScroll.clientWidth / 2);
    }
    if (rv.map) rv.map.highlight({ fromKm: l.startKm, toKm: l.endKm });
    els.legBtns.forEach((b, k) => { b.classList.toggle("on", k === li); b.classList.toggle("past", k < li); });
  };

  let lastLeg = -1;
  let lastCue = -2;
  let lastNow = "";
  let lastNext = "";
  // Pace line: the clip rectangles that split it into done, just done and to come, and the dot.
  const paceG = svgEl ? svgEl.querySelector(".rv-pace") : null;
  const pcRects = paceG ? { past: svgEl.querySelector("#rvPcPast rect"), trail: svgEl.querySelector("#rvPcTrail rect"), ahead: svgEl.querySelector("#rvPcAhead rect") } : null;
  const paceDot = paceG ? paceG.querySelector(".rv-pl-dot") : null;
  const paceTxt = paceG ? paceG.querySelector(".rv-pl-v") : null;
  const trailKm = Math.max(0.8, Math.min(2, TOT * 0.06));
  const draw = () => {
    const s = runStateAt(run, rv.sec);
    els.clock.textContent = hms(s.sec);
    els.el.textContent = `clock ${clock(st, s.sec)} · ${Math.round(s.frac * 100)}%`;
    els.bar.style.width = `${(s.frac * 100).toFixed(2)}%`;
    els.km.textContent = `km ${s.km.toFixed(1)} / ${TOT.toFixed(1)}`;
    els.seek.value = Math.round(s.sec);
    const li = runLegAt(legs, s.km);
    const l = legs[li];
    if (li !== lastLeg) {
      lastLeg = li;
      drawLeg(li);
      const n = legs[li + 1];
      els.leg.className = `rp-leg rv-leg rv-${l.tone}`;
      // Section (what you did over the whole section) next to Now (this moment of the replay).
      const row = (k, sec, id) => `<tr><th>${k}</th><td>${sec}</td><td class="now" id="${id}"></td></tr>`;
      els.leg.innerHTML = `
        <div class="rp-leg-h"><span class="rp-leg-n"><small>Section</small><b>${l.i}</b><small>/ ${legs.length}</small></span>
          <span class="rp-leg-t"><b>${rvEsc(l.title)}</b>${legChip(l)}</span></div>
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
      els.tn = Object.fromEntries(["Clock", "Time", "Pace", "Tgt", "Gap", "Grade", "Hr", "Cad"].map((k) => [k, els.leg.querySelector(`#rvn${k}`)]));
      lastNext = ""; // the card changed height: fit the list below it again
    }
    const left = Math.max(0, l.endKm - s.km);
    els.legNow.innerHTML = `<b>Section ${l.i}/${legs.length}</b> · ${rvEsc(l.title)} ${legChip(l)} <span class="left">${left.toFixed(1)} km to go in it</span>`;
    els.legPos.style.left = `${((s.km / TOT) * 100).toFixed(2)}%`;
    const set = (k, v) => { if (els.tn[k]) els.tn[k].textContent = v; };
    set("Clock", hm(s.sec));
    set("Time", `${dur(s.sec - l.startSec)} in`);
    set("Pace", s.pace ? `${mmss(s.pace)}/km` : "stopped");
    if (tgt) { const d = s.sec - tgt.ghostAt(s.km); set("Tgt", Math.abs(d) < 30 ? "on target" : `${dur(Math.abs(d))} ${d > 0 ? "behind" : "ahead"}`); }
    set("Gap", s.gap ? `${mmss(s.gap)}/km` : "–");
    set("Grade", `${s.grade > 0 ? "+" : ""}${s.grade.toFixed(0)}% · ${Math.round(s.ele)} m`);
    set("Hr", s.hr ? `${Math.round(s.hr)} bpm` : "–");
    set("Cad", s.cad ? `${Math.round(s.cad)} spm${s.cad < 145 ? " · hiking" : ""}` : "–");
    els.play.innerHTML = rv.playing ? "❚❚ Pause" : rv.sec >= run.elapsedSec ? "↺ Replay" : rv.sec > 0 ? "▶ Resume" : "▶ Replay my run";

    const now = s.stopped ? `<span class="chip aidc">Stopped</span> standing still at km ${s.km.toFixed(1)}` : s.sec >= run.elapsedSec ? `<span class="chip rv-good">Done</span> <b>${TOT.toFixed(1)} km</b> in ${hm(run.elapsedSec)}` : "";
    if (now !== lastNow) { els.now.innerHTML = now; els.now.hidden = !now; lastNow = now; }

    const nextM = moments.find((x) => x.sec > s.sec + 0.5 && x.kind !== "finish");
    const done = moments.filter((x) => x.sec <= s.sec + 0.5);
    const nextStop = run.stops.find((x) => x.durSec >= 60 && x.sec > s.sec);
    const next = [
      nextM ? `<li><span>Next moment · ${rvEsc(nextM.title)}</span><b>km ${nextM.km.toFixed(1)} · in ${dur(nextM.sec - s.sec)}</b></li>` : "",
      nextStop ? `<li><span>Next stop · ${Math.round(nextStop.durSec / 60)} min</span><b>km ${nextStop.km.toFixed(1)}</b></li>` : "",
      tgt ? (() => { const d = s.sec - tgt.ghostAt(s.km); return `<li><span>Vs target ${hm(tgt.targetSec)}</span><b class="${d > 30 ? "rv-b" : d < -30 ? "rv-g" : ""}">${Math.abs(d) < 30 ? "on target" : `${dur(Math.abs(d))} ${d > 0 ? "behind" : "ahead"}`}</b></li>`; })() : "",
      `<li><span>So far</span><b><span class="rv-g">${done.filter((x) => x.tone === "good").length} went well</span> · <span class="rv-b">${done.filter((x) => x.tone === "bad").length} cost you</span></b></li>`,
    ].join("");
    if (next !== lastNext) { els.next.innerHTML = next; lastNext = next; fitPanel(els.next); }

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
    if (paceG) {
      const cx = prof.x(s.km);
      const tx = prof.x(Math.max(0, s.km - trailKm));
      pcRects.past.setAttribute("width", Math.max(0, tx - prof.l).toFixed(1));
      pcRects.trail.setAttribute("x", tx.toFixed(1));
      pcRects.trail.setAttribute("width", Math.max(0, cx - tx).toFixed(1));
      pcRects.ahead.setAttribute("x", cx.toFixed(1));
      pcRects.ahead.setAttribute("width", Math.max(0, prof.W - prof.r - cx).toFixed(1));
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
    if (els.cur) {
      els.cur.style.display = "";
      els.cur.setAttribute("transform", `translate(${prof.x(s.km).toFixed(1)},0)`);
      els.cur.querySelector("circle").setAttribute("cy", prof.y(s.ele).toFixed(1));
    }
    if (rv.map) rv.map.setRunner(s.km);
  };

  // Same animation loop as the race-day replay: requestAnimationFrame, race time += real time x speed.
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
  const play = () => {
    if (rv.sec >= run.elapsedSec) rv.sec = 0;
    rv.playing = true;
    rv.last = 0;
    els.cue.classList.remove("pulse");
    if (rv.map && rv.follow) rv.map.follow(true);
    rv.raf = requestAnimationFrame(frame);
    draw();
  };
  const pause = () => { rv.playing = false; cancelAnimationFrame(rv.raf); draw(); };
  const seek = (sec) => { rv.sec = Math.max(0, Math.min(run.elapsedSec, sec)); els.cue.classList.remove("pulse"); draw(); };
  const jump = (dir) => {
    const list = dir > 0 ? moments.filter((e) => e.sec > rv.sec + 0.5) : moments.filter((e) => e.sec < rv.sec - 1.5).reverse();
    if (list[0]) { pause(); seek(list[0].sec + 1); }
  };

  els.play.addEventListener("click", () => { trackEvent(rv.playing ? "review-pause" : "review-play"); rv.playing ? pause() : play(); });
  $v("#rvPrev").addEventListener("click", () => { trackEvent("review-step", "prev"); jump(-1); });
  $v("#rvNextBtn").addEventListener("click", () => { trackEvent("review-step", "next"); jump(1); });
  els.seek.addEventListener("input", () => seek(Number(els.seek.value)));
  els.seek.addEventListener("change", () => trackEvent("review-seek"));
  $v("#rvSpeed").addEventListener("change", (e) => { rv.speed = Number(e.target.value); trackEvent("review-speed", e.target.value); });
  $v("#rvPause").addEventListener("change", (e) => { rv.pauseAt = e.target.checked; });
  $v("#rvFollow").addEventListener("change", (e) => { rv.follow = e.target.checked; if (rv.map) rv.map.follow(rv.follow); });
  els.legBtns.forEach((b) => b.addEventListener("click", () => {
    const l = legs[Number(b.dataset.i)];
    trackEvent("review-section", l.tone);
    pause();
    seek(l.startSec + 1);
    if (rv.map) rv.map.show(l.startKm, l.endKm);
  }));
  els.list.querySelectorAll("li button").forEach((b) => b.addEventListener("click", () => {
    const e = moments[Number(b.parentElement.dataset.i)];
    trackEvent("review-moment", e.tone);
    pause();
    seek(e.sec + 1);
    $v("#rvCockpit").scrollIntoView({ behavior: "smooth", block: "start" });
  }));
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
  box.querySelectorAll(".rv-st[data-sec], .rv-km-bar[data-sec]").forEach((b) => b.addEventListener("click", () => {
    trackEvent("review-stat", b.dataset.k || "km");
    pause();
    seek(Number(b.dataset.sec) + 1);
    $v("#rvCockpit").scrollIntoView({ behavior: "smooth", block: "start" });
  }));
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
  draw();
}

/** Stop the review animation and free its map. */
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
 */
export function initRunMode({ onLoaded } = {}) {
  const drop = document.querySelector("#dropRun");
  const input = document.querySelector("#fileRun");
  const status = document.querySelector("#stRun");
  const body = document.querySelector("#s5body");
  const empty = () => { body.innerHTML = `<div class="empty"><b>Drop the GPX of a run you did</b> above (or press Try a sample run): you get it replayed on the map with its key moments, good and bad.</div>`; };
  const load = (xml, label, sample) => {
    try {
      const run = analyseRun(parseGpx(xml));
      rv.name = label || run.name || "Your run";
      status.innerHTML = `<span class="ok">✓ ${rvEsc(rv.name)}</span> · ${run.totalKm.toFixed(1)} km · ${hm(run.elapsedSec)} · ${Math.round(run.gain)} m D+`;
      drop.classList.add("done");
      mountRun(body, run);
      trackOnce("review-built", sample ? "sample" : "own");
      if (onLoaded) onLoaded(run);
      document.querySelector("#s5").scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (e) {
      trackEvent("gpx-error", "review");
      status.innerHTML = `<div class="err">${rvEsc(e.message)}</div>`;
    }
  };
  const handle = async (files) => {
    const f = [...(files || [])][0];
    if (!f) return;
    trackEvent("gpx-upload", "review");
    load(await f.text().catch(() => ""), f.name.replace(/\.gpx$/i, ""), false);
    input.value = "";
  };
  input.addEventListener("change", () => handle(input.files));
  drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("over"));
  drop.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("over"); handle(e.dataTransfer.files); });
  document.querySelectorAll("[data-run-sample]").forEach((b) => b.addEventListener("click", () => {
    trackEvent("review-sample");
    load(makeDemoRunGpx(), "Sample trail run (made up)", true);
  }));
  empty();
}
