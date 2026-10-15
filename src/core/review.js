// review.js: what a run you just did says about it, for the "My run" mode.
//
// The planner looks forward (how should I run this race?). This module looks back: given the GPX
// your watch recorded, where were you strong, where did it cost you, where did you stop, when did
// you fade. Four ideas carry it:
//
//  1. Grade-adjusted pace (GAP). A 7:00/km on a 15% climb is a harder effort than 5:00/km on the
//     flat. To compare them we convert every metre into "flat-equivalent metres" with the energy
//     cost of running on a slope measured by Minetti et al. (2002, J Appl Physiol): a polynomial
//     C(i) in joules per kg per metre for a gradient i. Running 1 m at +10% costs C(0.10)/C(0) =
//     1.66 times a flat metre, so it counts as 1.66 flat metres. GAP = moving time / flat-equivalent
//     distance: the flat pace that would have cost the same energy. Downhill, the lab curve says you
//     save up to 50%, but on a trail you brake (rocks, roots, your quads), so we keep only half of
//     that saving.
//  2. Stops. Distance-based resampling (one sample every 10 m, see track.js) turns a stop into one
//     10 m sample that took far too long. Any sample slower than 0.3 m/s (a very slow hike is 0.5)
//     holds a stop: the time above what that 10 m takes at your usual speed.
//  3. Fair comparisons. A climb is compared with your other climbs of the day, a descent with your
//     descents, a runnable stretch with your runnable stretches, always in GAP. So "strong" means
//     strong for you, today, on that kind of ground, not against a generic runner.
//  4. Cumulative sums. Every per-sample quantity (moving time, flat-equivalent metres, heartbeats)
//     is stored as a running total, so the average over ANY stretch [a, b] is one subtraction:
//     (S[b] - S[a]) / (M[b] - M[a]). That is what makes rolling windows and per-section numbers
//     cheap enough to compute on every animation frame.

import { resample, smooth } from "./track.js";
import { gradeSeries, analyseCourse, GRADE_HALF_WINDOW } from "./terrain.js";
import { briefCourse, LEVELS, DESCENT_LABELS } from "./plan.js";
import { mmss, hm } from "./format.js";

const STOP_SPEED = 0.3; // m/s: slower than this over 10 m means you were stopped for part of it
const STOP_MIN_SEC = 60; // stops shorter than this count in the total but are not a key moment
const HIKE_CADENCE = 145; // steps per minute, same threshold as the effort model
const LEG_MIN_KM = 0.3; // runnable stretches shorter than this join the section before
const STRONG = 1.06; // a section 6% faster (in GAP) than your average for its kind is strong
const WEAK = 0.94;

/** Energy cost of running at gradient `g` (%), in J/kg/m (Minetti et al. 2002). */
export function minettiCost(g) {
  const i = Math.max(-0.45, Math.min(0.45, g / 100));
  return 155.4 * i ** 5 - 30.4 * i ** 4 - 43.3 * i ** 3 + 46.3 * i ** 2 + 19.5 * i + 3.6;
}

/** How many flat metres one metre at gradient `g` (%) is worth. Downhill keeps half the lab saving. */
export function effortFactor(g) {
  const f = minettiCost(g) / 3.6;
  return g >= 0 ? f : Math.max(0.7, 1 + 0.5 * (f - 1));
}

/** First index i with arr[i] > v (arr sorted ascending). */
function rvUpper(arr, v) {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] <= v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Analyse one recorded run (a parsed GPX with timestamps). Returns everything the review screen
 * shows: totals, numbered sections with a verdict, stops, per-km splits, the effort along the way,
 * and the key moments (good, bad or simply worth knowing) in time order.
 */
export function analyseRun(parsed, opts = {}) {
  const { step = 10 } = opts;
  const rs = resample(parsed, step);
  if (!rs.time) throw new Error("This GPX has no timestamps: it looks like a planned route, not a recorded run.");
  if (rs.totalM < 1000) throw new Error("This run is under 1 km: too short to analyse.");
  const n = rs.n;
  const ele = smooth(rs.ele, 3);
  const grade = gradeSeries(ele, step, GRADE_HALF_WINDOW);
  const T = new Float64Array(n); // elapsed seconds at each sample
  for (let i = 0; i < n; i++) T[i] = (rs.time[i] - rs.time[0]) / 1000;
  const elapsedSec = T[n - 1];
  if (elapsedSec <= 0) throw new Error("The timestamps in this GPX do not move forward.");

  // Usual moving speed: the median over 10 m samples that were not stopped.
  const speeds = [];
  for (let i = 1; i < n; i++) { const dt = T[i] - T[i - 1]; if (dt > 0 && step / dt >= STOP_SPEED) speeds.push(step / dt); }
  speeds.sort((a, b) => a - b);
  const usual = speeds.length ? speeds[Math.floor(speeds.length / 2)] : 2;

  // Cadence: many watches store it per foot (about 85 instead of 170). Double it when the running median says so.
  let cadMul = 1;
  if (rs.cad) {
    const run = [];
    for (let i = 1; i < n; i++) if (rs.cad[i] > 0 && step / Math.max(1e-6, T[i] - T[i - 1]) > 2.5) run.push(rs.cad[i]);
    run.sort((a, b) => a - b);
    if (run.length && run[Math.floor(run.length / 2)] < 120) cadMul = 2;
  }

  // Running totals, one per sample (index i covers the 10 m that end at sample i).
  const M = new Float64Array(n); // moving seconds
  const E = new Float64Array(n); // flat-equivalent metres (for GAP)
  const HB = new Float64Array(n); // heart rate x moving seconds (heartbeats / 60)
  const HS = new Float64Array(n); // moving seconds with a heart rate
  const CB = new Float64Array(n); // cadence x seconds
  const CS = new Float64Array(n); // moving seconds with a cadence
  const HK = new Float64Array(n); // moving seconds hiked (cadence under 145 spm)
  const stopAt = new Float64Array(n); // stopped seconds inside each sample
  for (let i = 1; i < n; i++) {
    const dt = Math.max(0, T[i] - T[i - 1]);
    const stopped = step / Math.max(dt, 1e-6) < STOP_SPEED ? Math.max(0, dt - step / usual) : 0;
    const mv = dt - stopped;
    stopAt[i] = stopped;
    M[i] = M[i - 1] + mv;
    E[i] = E[i - 1] + step * effortFactor(grade[i]);
    const hr = rs.hr ? rs.hr[i] : null;
    HB[i] = HB[i - 1] + (hr ? hr * mv : 0);
    HS[i] = HS[i - 1] + (hr ? mv : 0);
    const cad = rs.cad && rs.cad[i] > 0 ? rs.cad[i] * cadMul : null;
    CB[i] = CB[i - 1] + (cad ? cad * mv : 0);
    CS[i] = CS[i - 1] + (cad ? mv : 0);
    HK[i] = HK[i - 1] + (cad && cad < HIKE_CADENCE ? mv : 0);
  }
  const movingSec = M[n - 1];
  const totalKm = ((n - 1) * step) / 1000;
  const idx = (km) => Math.max(0, Math.min(n - 1, Math.round((km * 1000) / step)));
  // Averages over samples a..b, all one subtraction away thanks to the running totals.
  const over = (a, b) => {
    const mv = M[b] - M[a];
    const m = (b - a) * step;
    return {
      m, mv,
      pace: m > 0 && mv > 0 ? (mv / m) * 1000 : null, // moving pace, s/km
      gap: E[b] - E[a] > 0 && mv > 0 ? (mv / (E[b] - E[a])) * 1000 : null, // grade-adjusted pace, s/km
      speedEq: mv > 0 ? (E[b] - E[a]) / mv : 0, // flat-equivalent speed, m/s
      hr: HS[b] - HS[a] > 0 ? (HB[b] - HB[a]) / (HS[b] - HS[a]) : null,
      cad: CS[b] - CS[a] > 0 ? (CB[b] - CB[a]) / (CS[b] - CS[a]) : null,
      hikeShare: CS[b] - CS[a] > 0 ? (HK[b] - HK[a]) / (CS[b] - CS[a]) : null,
      sec: T[b] - T[a],
      stopSec: T[b] - T[a] - mv,
    };
  };
  const all = over(0, n - 1);
  const avgEq = all.speedEq;

  // Climbs and descents are found exactly as in the race briefing, so the words mean the same.
  const course = analyseCourse(rs);
  const brief = briefCourse(course);
  let gain = 0, loss = 0;
  for (let i = 1; i < n; i++) { const d = ele[i] - ele[i - 1]; if (d > 0) gain += d; else loss -= d; }

  // Numbered sections, end to end: each climb (or section of a long climb), each descent, and the
  // runnable stretches between them.
  const parts = [];
  brief.climbs.forEach((c) => (c.sections.length ? c.sections : [c]).forEach((x) => parts.push({
    kind: "climb", n: x.n, level: x.level, startKm: x.startKm, endKm: x.endKm, label: LEVELS[x.level],
    title: `${c.sections.length ? "Climb section" : "Climb"} ${x.n}`,
  })));
  brief.descents.forEach((d) => parts.push({ kind: "descent", n: d.n, level: d.level, startKm: d.startKm, endKm: d.endKm, label: DESCENT_LABELS[d.level], title: `Descent ${d.n}` }));
  parts.sort((a, b) => a.startKm - b.startKm);
  const flat = (a, b) => ({ kind: "flat", n: null, level: 0, startKm: a, endKm: b, label: "Runnable", title: "Runnable" });
  const raw = [];
  let at = 0;
  for (const p of parts) {
    const from = Math.max(at, p.startKm);
    if (from >= p.endKm) continue;
    if (from - at >= LEG_MIN_KM) raw.push(flat(at, from));
    else if (raw.length) raw[raw.length - 1].endKm = from;
    raw.push({ ...p, startKm: raw.length ? from : 0 });
    at = p.endKm;
  }
  if (totalKm - at >= LEG_MIN_KM || !raw.length) raw.push(flat(at, totalKm));
  else raw[raw.length - 1].endKm = totalKm;
  const legs = raw.map((l, k) => {
    const a = idx(l.startKm);
    const b = k === raw.length - 1 ? n - 1 : idx(l.endKm);
    const o = over(a, b);
    let up = 0, down = 0;
    for (let i = a + 1; i <= b; i++) { const d = ele[i] - ele[i - 1]; if (d > 0) up += d; else down -= d; }
    return {
      ...l, i: k + 1, a, b, km: l.endKm - l.startKm, up, down,
      avg: ((ele[b] - ele[a]) / Math.max(1, (b - a) * step)) * 100,
      startSec: T[a], endSec: T[b], durSec: T[b] - T[a], stopSec: o.stopSec, movSec: o.mv,
      pace: o.pace, gap: o.gap, speedEq: o.speedEq, hr: o.hr, cad: o.cad, hikeShare: o.hikeShare,
      vam: l.kind === "climb" && o.mv > 0 ? (up / o.mv) * 3600 : null, // vertical metres per hour
    };
  });
  // Verdict: GAP against the time-weighted average of the same kind of ground.
  const kindEq = {};
  for (const kind of ["climb", "descent", "flat"]) {
    const same = legs.filter((l) => l.kind === kind && l.movSec > 0);
    const eq = same.reduce((s, l) => s + l.speedEq * l.movSec, 0) / Math.max(1e-6, same.reduce((s, l) => s + l.movSec, 0));
    kindEq[kind] = same.length > 1 && eq > 0 ? eq : avgEq;
    same.forEach((l) => {
      l.score = kindEq[kind] > 0 ? l.speedEq / kindEq[kind] : 1;
      l.tone = l.score >= STRONG ? "good" : l.score <= WEAK ? "bad" : "ok";
      l.verdict = l.tone === "good" ? "Strong" : l.tone === "bad" ? "Weak" : "Even";
      l.vsPct = Math.round((l.score - 1) * 100);
    });
  }
  legs.forEach((l) => { if (l.score === undefined) { l.score = 1; l.tone = "ok"; l.verdict = "Even"; l.vsPct = 0; } });
  // The same comparison for any stretch: a running total of flat-equivalent metres divided by the
  // average of their kind of ground. Over a window, (N[b] - N[a]) / (M[b] - M[a]) is 1.00 when you
  // ran it exactly like your average on that ground, 1.10 when 10% better. Descents, climbs and
  // flats then sit on one scale, so a fade is a fade and not just the start of a long descent.
  const N = new Float64Array(n);
  legs.forEach((l) => { for (let i = Math.max(1, l.a + 1); i <= l.b; i++) N[i] = N[i - 1] + (E[i] - E[i - 1]) / kindEq[l.kind]; });
  const formAt = (a, b) => (M[b] - M[a] > 0 ? (N[b] - N[a]) / (M[b] - M[a]) : 1);

  // Stops: samples holding stopped time, grouped when they are less than 50 m apart.
  const stops = [];
  for (let i = 1; i < n; i++) {
    if (stopAt[i] <= 0) continue;
    const last = stops[stops.length - 1];
    if (last && i - last.b <= 5) { last.durSec += stopAt[i]; last.b = i; }
    else stops.push({ a: i, b: i, durSec: stopAt[i] });
  }
  const stopList = stops.map((s) => ({ km: (s.a * step) / 1000, sec: T[s.a - 1], durSec: s.durSec }));

  // Profile and map points every 100 m, each with the elapsed time and the local effort.
  const every = Math.max(1, Math.round(100 / step));
  const pts = [];
  for (let i = 0; i < n; i += every) pts.push(i);
  if (pts[pts.length - 1] !== n - 1) pts.push(n - 1);
  const profile = pts.map((i) => [(i * step) / 1000, ele[i]]);
  const route = pts.map((i) => [rs.lat[i], rs.lon[i]]);
  // Form along the way: the comparison above over +/-300 m (1.00 = your average on that ground).
  const win = Math.round(300 / step);
  const effort = pts.map((i) => formAt(Math.max(0, i - win), Math.min(n - 1, i + win)));
  const effortBands = [];
  for (let k = 1; k < pts.length; k++) {
    const e = (effort[k - 1] + effort[k]) / 2;
    const cls = e < 0.85 ? 1 : e < 0.95 ? 2 : e < 1.05 ? 3 : e < 1.15 ? 4 : 5;
    const last = effortBands[effortBands.length - 1];
    if (last && last.cls === cls) last.toKm = profile[k][0];
    else effortBands.push({ fromKm: profile[k - 1][0], toKm: profile[k][0], cls });
  }

  // Splits per km.
  const splits = [];
  for (let k = 0; k < Math.floor(totalKm + 1e-9); k++) {
    const o = over(idx(k), idx(k + 1));
    splits.push({ km: k + 1, sec: o.sec, pace: o.pace, gap: o.gap, speedEq: o.speedEq, hr: o.hr, stopSec: o.stopSec });
  }

  // Halves by moving time: did you fade, and did your heart drift?
  const half = Math.max(1, Math.min(n - 2, rvUpper(M, movingSec / 2)));
  const h1 = over(0, half);
  const h2 = over(half, n - 1);
  const f1 = formAt(0, half);
  const f2 = formAt(half, n - 1);
  const fadePct = (1 - f2 / f1) * 100;
  // Decoupling (Friel): speed (on the same scale) per heartbeat, first half against second half.
  const decouplingPct = h1.hr && h2.hr ? (1 - (f2 / h2.hr) / (f1 / h1.hr)) * 100 : null;

  const run = {
    name: parsed.name || "", startMs: rs.time[0], step, n, totalKm, T, ele, M, grade,
    elapsedSec, movingSec, stopSec: elapsedSec - movingSec, gain, loss,
    hasHr: Boolean(rs.hr && HS[n - 1] > 0), hasCad: Boolean(rs.cad && CS[n - 1] > 0),
    hr: rs.hr, cad: rs.cad, cadMul,
    avgPace: (elapsedSec / Math.max(1e-6, totalKm)), movingPace: all.pace, gapPace: all.gap,
    hrAvg: all.hr, hrMax: rs.hr ? Math.max(...rs.hr.filter((x) => x)) : null, cadAvg: all.cad, hikeShare: all.hikeShare,
    profile, route, effort, effortBands, legs, stops: stopList, splits,
    halves: { first: h1, second: h2, fadePct, decouplingPct, km: (half * step) / 1000 },
    over, idx, formAt,
  };
  run.moments = runMoments(run);
  return run;
}

/** Index (0-based) of the section that contains `km`. */
export function runLegAt(legs, km) {
  let i = 0;
  while (i < legs.length - 1 && km >= legs[i].endKm) i++;
  return i;
}

/**
 * Where you were at `sec` seconds after the start: km, altitude, gradient, and what you were doing
 * then (pace and GAP over the surrounding 200 m, heart rate, cadence, stopped or not).
 */
export function runStateAt(run, sec) {
  const { T, n, step } = run;
  const s = Math.max(0, Math.min(run.elapsedSec, sec));
  const j = Math.max(1, Math.min(n - 1, rvUpper(T, s)));
  const f = Math.max(0, Math.min(1, (s - T[j - 1]) / Math.max(1e-6, T[j] - T[j - 1])));
  const i = f < 0.5 ? j - 1 : j;
  const km = ((j - 1 + f) * step) / 1000;
  // A sample that holds a stop: you are standing still for most of it.
  const dt = T[j] - T[j - 1];
  const stopped = dt > 0 && step / dt < STOP_SPEED;
  const o = run.over(Math.max(0, i - 10), Math.min(n - 1, i + 10));
  const cad = run.cad && run.cad[i] > 0 ? run.cad[i] * run.cadMul : null;
  return {
    sec: s, km, frac: s / run.elapsedSec, i,
    ele: run.ele[j - 1] + f * (run.ele[j] - run.ele[j - 1]),
    grade: run.grade[i],
    stopped,
    pace: stopped ? null : o.pace,
    gap: stopped ? null : o.gap,
    hr: run.hr && run.hr[i] ? run.hr[i] : null,
    cad: stopped ? null : cad,
  };
}

/** Elapsed seconds when the run reached `km`. */
export function runSecAtKm(run, km) {
  const x = Math.max(0, Math.min(run.n - 1, (km * 1000) / run.step));
  const a = Math.floor(x);
  const b = Math.min(run.n - 1, a + 1);
  return run.T[a] + (x - a) * (run.T[b] - run.T[a]);
}

/**
 * The key moments of the run, in time order. Each one: {kind, tone ("good" | "bad" | "info"),
 * km, toKm, sec, title, text, tip}. The text says what happened with numbers, the tip what to do
 * with it next time.
 */
export function runMoments(run) {
  const out = [];
  const add = (m) => out.push({ toKm: m.km, tip: "", ...m, sec: m.sec ?? runSecAtKm(run, m.km) });
  const pct = (x) => `${x > 0 ? "+" : ""}${Math.round(x)}%`;
  const dur = (sec) => (sec < 3600 ? `${Math.max(1, Math.round(sec / 60))} min` : hm(sec));
  const gapTxt = (l) => (l.gap ? `${mmss(l.gap)}/km grade-adjusted` : "");
  add({ kind: "start", tone: "info", km: 0, sec: 0, title: "Start", text: `${run.totalKm.toFixed(1)} km and ${Math.round(run.gain)} m of climbing ahead. Your average effort for the day is ${run.gapPace ? `${mmss(run.gapPace)}/km grade-adjusted` : "the yardstick"}: every section is compared with it.` });

  // Best and worst of each kind, when there are at least two to compare and the gap is real.
  const pick = (kind, min, best) => {
    const list = run.legs.filter((l) => l.kind === kind && min(l));
    if (list.length < 2) return null;
    const x = list.reduce((a, l) => ((best ? l.score > a.score : l.score < a.score) ? l : a));
    return (best ? x.tone === "good" : x.tone === "bad") ? x : null;
  };
  const bigClimb = (l) => l.up >= 30 && l.km >= 0.4;
  const bigDesc = (l) => l.down >= 30 && l.km >= 0.4;
  const bc = pick("climb", bigClimb, true);
  const wc = pick("climb", bigClimb, false);
  const bd = pick("descent", bigDesc, true);
  const wd = pick("descent", bigDesc, false);
  const hikeTxt = (l) => (l.hikeShare !== null ? ` You hiked ${Math.round(l.hikeShare * 100)}% of it.` : "");
  if (bc) add({ kind: "climb", tone: "good", km: bc.startKm, toKm: bc.endKm, sec: bc.startSec, leg: bc.i, title: `Strongest climb · section ${bc.i}`,
    text: `${Math.round(bc.up)} m up at ${bc.avg.toFixed(1)}% in ${dur(bc.movSec)}: ${Math.round(bc.vam)} m/h, ${pct(bc.vsPct)} on your average climb today.${hikeTxt(bc)}`,
    tip: "This is the climbing rhythm you can hold. Remember how it felt." });
  if (wc) add({ kind: "climb", tone: "bad", km: wc.startKm, toKm: wc.endKm, sec: wc.startSec, leg: wc.i, title: `Hardest climb · section ${wc.i}`,
    text: `${Math.round(wc.up)} m up at ${wc.avg.toFixed(1)}%: ${Math.round(wc.vam)} m/h, ${pct(wc.vsPct)} on your average climb.${hikeTxt(wc)}`,
    tip: wc.startKm > run.totalKm / 2 ? "Late in the run: fuel and pacing before it decide this one. Eat 20 min before the foot of a late climb." : "Early in the run: a steadier start, or hiking the steep part sooner, would keep more for it." });
  if (bd) add({ kind: "descent", tone: "good", km: bd.startKm, toKm: bd.endKm, sec: bd.startSec, leg: bd.i, title: `Best descent · section ${bd.i}`,
    text: `${Math.round(bd.down)} m down at ${Math.abs(bd.avg).toFixed(1)}%, ${bd.pace ? `${mmss(bd.pace)}/km` : ""}: ${pct(bd.vsPct)} on your average descent.`, tip: "Free time: your legs and feet were confident here." });
  if (wd) add({ kind: "descent", tone: "bad", km: wd.startKm, toKm: wd.endKm, sec: wd.startSec, leg: wd.i, title: `Slowest descent · section ${wd.i}`,
    text: `${Math.round(wd.down)} m down at ${Math.abs(wd.avg).toFixed(1)}%, ${wd.pace ? `${mmss(wd.pace)}/km` : ""}: ${pct(wd.vsPct)} on your average descent.`,
    tip: wd.level === 4 ? "A steep one: downhill technique and eccentric strength (step-downs, lunges) pay here." : "Not steep, yet slow: tired legs, or terrain? Short quick steps let gravity work." });
  // Fresh legs make the first stretch fast for everyone: it does not count as your best.
  const bf = pick("flat", (l) => l.km >= 0.8 && l.startKm > 0, true);
  const wf = pick("flat", (l) => l.km >= 0.8, false);
  if (bf) add({ kind: "flat", tone: "good", km: bf.startKm, toKm: bf.endKm, sec: bf.startSec, leg: bf.i, title: `Best runnable stretch · section ${bf.i}`, text: `${bf.km.toFixed(1)} km at ${mmss(bf.pace)}/km (${gapTxt(bf)}), ${pct(bf.vsPct)} on your runnable average.` });
  if (wf) add({ kind: "flat", tone: "bad", km: wf.startKm, toKm: wf.endKm, sec: wf.startSec, leg: wf.i, title: `Slowest runnable stretch · section ${wf.i}`, text: `${wf.km.toFixed(1)} km at ${mmss(wf.pace)}/km (${gapTxt(wf)}), ${pct(wf.vsPct)} on your runnable average.`, tip: "Runnable ground is where fatigue shows first: was it energy, or did you switch off?" });

  // Stops of a minute or more (the four longest).
  run.stops.filter((s) => s.durSec >= STOP_MIN_SEC).sort((a, b) => b.durSec - a.durSec).slice(0, 4).forEach((s) => add({
    kind: "stop", tone: s.durSec >= 300 ? "bad" : "info", km: s.km, sec: s.sec, title: `Stopped ${Math.round(s.durSec / 60)} min`,
    text: `At km ${s.km.toFixed(1)}, ${Math.round(s.durSec / 60)} min standing still.`,
    tip: s.durSec >= 300 ? "Long: on race day, plan what you do at each stop before you get there." : "",
  }));

  // Fade: the first km after which you stay under your average for the day (on the same ground).
  const P = run.profile;
  const E = run.effort;
  const { fadePct, decouplingPct } = run.halves;
  if (fadePct >= 5 && run.totalKm >= 5) {
    // Mean of the rest of the run from each point: the fade starts where both it and the moment
    // itself drop under 95% of your day's average.
    const rest = new Array(E.length);
    let sum = 0;
    for (let k = E.length - 1; k >= 0; k--) { sum += E[k]; rest[k] = sum / (E.length - k); }
    const k0 = P.findIndex((p, k) => p[0] >= run.totalKm * 0.25 && rest[k] < 0.95 && E[k] < 0.95);
    const km = k0 >= 0 ? P[k0][0] : run.halves.km;
    add({ kind: "fade", tone: "bad", km, title: "The fade starts", text: `From here you stay under your average for the day, on the same kind of ground. Second half ${pct(-fadePct)} on the first, grade-adjusted.`,
      tip: "Usually fuel or pacing: start 5% easier and eat every 30 to 40 min from the first hour." });
  } else if (fadePct <= 1 && run.totalKm >= 5) {
    add({ kind: "even", tone: "good", km: run.halves.km, title: fadePct <= -2 ? "Negative split" : "Even effort", text: `Second half ${pct(-fadePct)} on the first, grade-adjusted: you held your effort all the way.`, tip: "Well paced. This is the effort you can build on." });
  }

  // Finish: the last 10% (at least 1 km) against the whole run.
  const fk = Math.max(1, run.totalKm * 0.1);
  if (run.totalKm >= 4) {
    const r = run.formAt(run.idx(run.totalKm - fk), run.n - 1) / run.formAt(0, run.n - 1);
    if (r >= 1.04) add({ kind: "finish-strong", tone: "good", km: run.totalKm - fk, toKm: run.totalKm, title: "Strong finish", text: `Last ${fk.toFixed(1)} km ${pct((r - 1) * 100)} on your average effort.`, tip: "Something left in the tank: you could start a little faster." });
    else if (r <= 0.9) add({ kind: "finish-weak", tone: "bad", km: run.totalKm - fk, toKm: run.totalKm, title: "Tough last kilometres", text: `Last ${fk.toFixed(1)} km ${pct((r - 1) * 100)} on your average effort.`, tip: "The end of a run shows the start: an easier first hour usually fixes this." });
  }

  // Heart rate: drift between the halves, and the hardest minute.
  if (run.hasHr) {
    if (decouplingPct !== null && decouplingPct >= 5) add({ kind: "drift", tone: "bad", km: run.halves.km, title: "Heart rate drift", text: `For the same grade-adjusted speed, your heart beat ${Math.round(decouplingPct)}% more in the second half (aerobic decoupling).`, tip: "Over 5% means aerobic durability, heat or hydration limited you. Longer easy runs build it." });
    else if (decouplingPct !== null && decouplingPct < 3 && run.elapsedSec >= 3600) add({ kind: "drift", tone: "good", km: run.halves.km, title: "Steady heart", text: `Heart rate and grade-adjusted speed stayed coupled (${decouplingPct.toFixed(1)}% drift).`, tip: "Your aerobic engine handled this duration." });
    // The highest one-minute average heart rate.
    const hr = run.hr;
    let best = null;
    for (let i = 0, j = 0, s = 0, c = 0; i < run.n; i++) {
      if (hr[i]) { s += hr[i]; c++; }
      while (run.T[i] - run.T[j] > 60) { if (hr[j]) { s -= hr[j]; c--; } j++; }
      if (c > 3 && run.T[i] - run.T[j] >= 45 && (!best || s / c > best.v)) best = { v: s / c, i: j };
    }
    if (best) add({ kind: "hr", tone: "info", km: (best.i * run.step) / 1000, title: `Peak heart rate · ${Math.round(best.v)} bpm`, text: `Your hardest minute of the run (one-minute average).`, tip: "" });
  }

  // Walking on runnable ground late in the run: cadence of a hike where the slope does not ask for it.
  if (run.hasCad) {
    const { n, step, grade, cad, cadMul, T } = run;
    let a = -1;
    const found = [];
    for (let i = 1; i <= n; i++) {
      const walk = i < n && grade[i] < 5 && grade[i] > -5 && cad[i] > 0 && cad[i] * cadMul < HIKE_CADENCE && step / Math.max(1e-6, T[i] - T[i - 1]) >= STOP_SPEED;
      if (walk && a < 0) a = i;
      if (!walk && a >= 0) { if ((i - a) * step >= 300) found.push([a, i - 1]); a = -1; }
    }
    found.sort((x, y) => (y[1] - y[0]) - (x[1] - x[0])).slice(0, 2).forEach(([x, y]) => add({
      kind: "walk", tone: "bad", km: (x * step) / 1000, toKm: (y * step) / 1000, sec: T[x],
      title: "Walking on runnable ground", text: `${Math.round((y - x) * step)} m walked on a ${grade[Math.round((x + y) / 2)].toFixed(0)}% slope you could run.`,
      tip: "A sign of low energy: check what and when you ate before this point.",
    }));
  }

  add({ kind: "finish", tone: "info", km: run.totalKm, sec: run.elapsedSec, title: "Finish", text: `${run.totalKm.toFixed(1)} km in ${hm(run.elapsedSec)} (${hm(run.movingSec)} moving), ${Math.round(run.gain)} m D+.` });
  out.sort((a, b) => a.sec - b.sec || a.km - b.km);
  return out.map((m, i) => ({ ...m, i }));
}

/** Short verdicts for the summary: how many strong and weak sections, the main takeaways. */
export function runSummary(run) {
  const good = run.moments.filter((m) => m.tone === "good");
  const bad = run.moments.filter((m) => m.tone === "bad");
  return { good, bad, strongLegs: run.legs.filter((l) => l.tone === "good").length, weakLegs: run.legs.filter((l) => l.tone === "bad").length };
}
