// review.js: what a run you just did says about it, for the "Rewind my run" mode (once called
// "Check my run").
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
//
// Where it sits in the data flow: src/ui/review.js reads the GPX file, parses it (track.js
// parseGpx) and calls analyseRun here once. Everything else in this file (runStateAt for the
// replay, runStats, runPaceLine, runTarget, runSummary) reads the `run` object that analyseRun
// returns; insights.js builds the "Deep dive" numbers from the same object. Nothing here touches
// the page, the network or storage: it is plain maths, tested in Node.
//
// Main exports:
//   minettiCost, effortFactor   the energy cost of a slope, and its flat-metre equivalent
//   analyseRun(parsed)          the whole analysis: sections, stops, splits, effort, moments
//   runStateAt(run, sec)        where you were and what you were doing at second `sec`
//   runMoments(run)             the key moments (strong climb, fade, stop...), in time order
//   runStats(run)               best efforts and records (fastest 1 km, steepest 100 m...)
//   runPaceLine(run)            a smoothed speed line for the profile chart
//   parseTarget, runTarget      read a goal typed by the runner, and say how to reach it

import { resample, smooth } from "./track.js";
import { gradeSeries, analyseCourse, GRADE_HALF_WINDOW } from "./terrain.js";
import { briefCourse, LEVELS, DESCENT_LABELS } from "./plan.js";
import { mmss, hm } from "./format.js";

// Tuning constants. Changing one changes what the review calls a stop, a hike or a strong section.
const STOP_SPEED = 0.3; // m/s: slower than this over 10 m means you were stopped for part of it
const STOP_MIN_SEC = 60; // stops shorter than this count in the total but are not a key moment
const HIKE_CADENCE = 145; // steps per minute, same threshold as the effort model
const LEG_MIN_KM = 0.3; // runnable stretches shorter than this join the section before
const STRONG = 1.06; // a section 6% faster (in GAP) than your average for its kind is strong
// a section 6% slower (in GAP) than your average for its kind is weak; in between is "Even"
const WEAK = 0.94;

/**
 * Energy cost of running at gradient `g` (%), in J/kg/m (Minetti et al. 2002).
 *
 * The lab measured cost on slopes from -45% to +45% and fitted a 5th-degree polynomial in
 * the slope i (a fraction: 10% is 0.10). `i ** 5` means i to the power 5. Outside that range
 * the polynomial is not valid, so the slope is clamped to -0.45..+0.45 first.
 * C(0) = 3.6 J/kg/m on the flat; uphill grows fast; downhill is cheapest around -20%.
 */
export function minettiCost(g) {
  const i = Math.max(-0.45, Math.min(0.45, g / 100));
  return 155.4 * i ** 5 - 30.4 * i ** 4 - 43.3 * i ** 3 + 46.3 * i ** 2 + 19.5 * i + 3.6;
}

/**
 * How many flat metres one metre at gradient `g` (%) is worth. Downhill keeps half the lab saving.
 *
 * Uphill: cost / flat cost (1 m at +10% = 1.66 flat metres).
 * Downhill: the lab factor f is under 1 (a saving); we keep only half of the saving,
 * 1 + 0.5 x (f - 1), because on a trail you brake. Never below 0.7, so a steep descent never
 * counts as less than 0.7 flat metres per metre.
 */
export function effortFactor(g) {
  const f = minettiCost(g) / 3.6;
  return g >= 0 ? f : Math.max(0.7, 1 + 0.5 * (f - 1));
}

/**
 * First index i with arr[i] > v (arr sorted ascending): a binary search.
 * Halves the search range [lo, hi) at each step; `>> 1` is a whole-number divide by 2.
 * Used on the elapsed-time and moving-time running totals, which only grow.
 */
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
 *
 * Input: `parsed` from parseGpx (track.js): {name, points[]} with timestamps; opts.step is the
 * sample spacing in metres (10). Throws an Error with a readable message when the file has no
 * time, is under 1 km, or its times do not move forward.
 * Returns the `run` object (see the end of the function for its fields). Besides the numbers
 * it carries the running totals (T, M, N...) and three small helper functions (over, idx,
 * formAt) so the UI and the other functions here can ask about any stretch cheaply.
 */
export function analyseRun(parsed, opts = {}) {
  // Destructuring with a default: take opts.step, or 10 when it is not given.
  // 1. Resample onto a 10 m grid, smooth the altitude, and measure the gradient.
  const { step = 10 } = opts;
  const rs = resample(parsed, step);
  if (!rs.time) throw new Error("This GPX has no timestamps: it looks like a planned route, not a recorded run.");
  if (rs.totalM < 1000) throw new Error("This run is under 1 km: too short to analyse.");
  const n = rs.n;
  // Moving average over +/-3 samples (+/-30 m) to calm GPS altitude noise.
  const ele = smooth(rs.ele, 3);
  // Gradient in % at each sample, over the same window as the race planner (GRADE_HALF_WINDOW).
  const grade = gradeSeries(ele, step, GRADE_HALF_WINDOW);
  // Float64Array: a fixed-length array of numbers, faster and lighter than a plain array.
  // rs.time is in milliseconds since 1970; T turns it into seconds since the first sample.
  const T = new Float64Array(n); // elapsed seconds at each sample
  for (let i = 0; i < n; i++) T[i] = (rs.time[i] - rs.time[0]) / 1000;
  const elapsedSec = T[n - 1];
  if (elapsedSec <= 0) throw new Error("The timestamps in this GPX do not move forward.");

  // 2. Usual moving speed: the median over 10 m samples that were not stopped.
  // The median (middle value of the sorted list) ignores a few crazy samples, unlike the mean.
  // Falls back to 2 m/s (8:20/km) if no sample moved.
  const speeds = [];
  for (let i = 1; i < n; i++) { const dt = T[i] - T[i - 1]; if (dt > 0 && step / dt >= STOP_SPEED) speeds.push(step / dt); }
  speeds.sort((a, b) => a - b);
  const usual = speeds.length ? speeds[Math.floor(speeds.length / 2)] : 2;

  // 3. Cadence: many watches store it per foot (about 85 instead of 170). Double it when the running median says so.
  // Only samples faster than 2.5 m/s (6:40/km, surely running) are used to decide.
  let cadMul = 1;
  if (rs.cad) {
    const run = [];
    for (let i = 1; i < n; i++) if (rs.cad[i] > 0 && step / Math.max(1e-6, T[i] - T[i - 1]) > 2.5) run.push(rs.cad[i]);
    run.sort((a, b) => a - b);
    if (run.length && run[Math.floor(run.length / 2)] < 120) cadMul = 2;
  }

  // 4. Running totals (prefix sums), one per sample (index i covers the 10 m that end at sample i).
  // Each array starts at 0 and adds this sample's value to the previous total, so the sum over
  // samples a..b is X[b] - X[a]: one subtraction, whatever the length of the stretch.
  const M = new Float64Array(n); // moving seconds
  const E = new Float64Array(n); // flat-equivalent metres (for GAP)
  const HB = new Float64Array(n); // heart rate x moving seconds (heartbeats / 60)
  const HS = new Float64Array(n); // moving seconds with a heart rate
  const CB = new Float64Array(n); // cadence x seconds
  const CS = new Float64Array(n); // moving seconds with a cadence
  const HK = new Float64Array(n); // moving seconds hiked (cadence under 145 spm)
  const stopAt = new Float64Array(n); // stopped seconds inside each sample
  for (let i = 1; i < n; i++) {
    // dt: seconds spent on these 10 m. If they were covered slower than STOP_SPEED, the part of dt
    // above what 10 m takes at the usual speed is stopped time; the rest is moving time (mv).
    // 1e-6 (one millionth) stands in for 0 to avoid a division by zero.
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
  // 5. Helpers built on the running totals.
  const movingSec = M[n - 1];
  const totalKm = ((n - 1) * step) / 1000;
  // idx(km): the sample index at a given km, clamped to the run.
  const idx = (km) => Math.max(0, Math.min(n - 1, Math.round((km * 1000) / step)));
  // Averages over samples a..b, all one subtraction away thanks to the running totals.
  // Returns {m (metres), mv (moving s), pace, gap, speedEq, hr (bpm), cad (spm), hikeShare (0..1),
  // sec (elapsed s, stops included), stopSec}. A value is null when there is no data for it.
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
  // The whole run, and its average flat-equivalent speed (m/s): the day's yardstick.
  const all = over(0, n - 1);
  const avgEq = all.speedEq;

  // 6. Climbs and descents are found exactly as in the race briefing, so the words mean the same.
  const course = analyseCourse(rs);
  const brief = briefCourse(course);
  // Total D+ and D- of the run, on the smoothed altitude.
  let gain = 0, loss = 0;
  for (let i = 1; i < n; i++) { const d = ele[i] - ele[i - 1]; if (d > 0) gain += d; else loss -= d; }

  // 7. Numbered sections, end to end: each climb (or section of a long climb), each descent, and the
  // runnable stretches between them. Same method as raceLegs in script.js: sort the pieces by
  // km, fill each gap of LEG_MIN_KM or more with a "Runnable" section, glue shorter gaps to the
  // section before.
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
  // 8. Measure each section: a and b are its first and last sample, `o` its averages.
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
  // 9. Verdict: GAP against the time-weighted average of the same kind of ground.
  // For each kind, eq = sum(speedEq x moving s) / sum(moving s): longer sections weigh more.
  // With a single section of a kind there is nothing to compare, so the whole run's average is used.
  // score = section speed / average for its kind (1.06 = 6% better); vsPct is the same in %.
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
  // Sections not scored above (no moving time) get a neutral verdict.
  legs.forEach((l) => { if (l.score === undefined) { l.score = 1; l.tone = "ok"; l.verdict = "Even"; l.vsPct = 0; } });
  // 10. The same comparison for any stretch: a running total of flat-equivalent metres divided by the
  // average of their kind of ground. Over a window, (N[b] - N[a]) / (M[b] - M[a]) is 1.00 when you
  // ran it exactly like your average on that ground, 1.10 when 10% better. Descents, climbs and
  // flats then sit on one scale, so a fade is a fade and not just the start of a long descent.
  const N = new Float64Array(n);
  legs.forEach((l) => { for (let i = Math.max(1, l.a + 1); i <= l.b; i++) N[i] = N[i - 1] + (E[i] - E[i - 1]) / kindEq[l.kind]; });
  const formAt = (a, b) => (M[b] - M[a] > 0 ? (N[b] - N[a]) / (M[b] - M[a]) : 1);
  // N over a section = the moving seconds it would take at exactly your average for its ground.
  legs.forEach((l) => { l.norm = N[l.b] - N[l.a]; });

  // 11. Stops: samples holding stopped time, grouped when they are less than 50 m apart.
  // (5 samples x 10 m = 50 m.) Each stop keeps its first and last sample (a, b) and its seconds.
  // Its clock time is T[s.a - 1], the moment the runner reached the sample where it stopped.
  const stops = [];
  for (let i = 1; i < n; i++) {
    if (stopAt[i] <= 0) continue;
    const last = stops[stops.length - 1];
    if (last && i - last.b <= 5) { last.durSec += stopAt[i]; last.b = i; }
    else stops.push({ a: i, b: i, durSec: stopAt[i] });
  }
  const stopList = stops.map((s) => ({ km: (s.a * step) / 1000, sec: T[s.a - 1], durSec: s.durSec }));

  // 12. Profile and map points every 100 m, each with the elapsed time and the local effort.
  // `every` = samples per 100 m (10). The last sample is always added so the finish is drawn.
  const every = Math.max(1, Math.round(100 / step));
  const pts = [];
  for (let i = 0; i < n; i += every) pts.push(i);
  if (pts[pts.length - 1] !== n - 1) pts.push(n - 1);
  const profile = pts.map((i) => [(i * step) / 1000, ele[i]]);
  const route = pts.map((i) => [rs.lat[i], rs.lon[i]]);
  // Form along the way: the comparison above over +/-300 m (1.00 = your average on that ground).
  const win = Math.round(300 / step);
  const effort = pts.map((i) => formAt(Math.max(0, i - win), Math.min(n - 1, i + win)));
  // Colour bands for the chart: each 100 m step gets a class 1 to 5 from its effort
  // (1 under 0.85, 2 under 0.95, 3 around 1.00, 4 up to 1.15, 5 above), and neighbouring steps of
  // the same class are merged into one band {fromKm, toKm, cls}.
  const effortBands = [];
  for (let k = 1; k < pts.length; k++) {
    const e = (effort[k - 1] + effort[k]) / 2;
    const cls = e < 0.85 ? 1 : e < 0.95 ? 2 : e < 1.05 ? 3 : e < 1.15 ? 4 : 5;
    const last = effortBands[effortBands.length - 1];
    if (last && last.cls === cls) last.toKm = profile[k][0];
    else effortBands.push({ fromKm: profile[k - 1][0], toKm: profile[k][0], cls });
  }

  // 13. Splits per km (only whole km; runStats adds the last partial one). 1e-9 guards against
  // a total like 9.9999999 km being rounded down to 9.
  const splits = [];
  for (let k = 0; k < Math.floor(totalKm + 1e-9); k++) {
    const o = over(idx(k), idx(k + 1));
    splits.push({ km: k + 1, sec: o.sec, pace: o.pace, gap: o.gap, speedEq: o.speedEq, hr: o.hr, stopSec: o.stopSec });
  }

  // 14. Halves by moving time: did you fade, and did your heart drift?
  // `half` is the sample where half of the moving time was reached (binary search on M).
  // f1 and f2: effort on each half (1.00 = your average). fadePct > 0: the second half was weaker.
  const half = Math.max(1, Math.min(n - 2, rvUpper(M, movingSec / 2)));
  const h1 = over(0, half);
  const h2 = over(half, n - 1);
  const f1 = formAt(0, half);
  const f2 = formAt(half, n - 1);
  const fadePct = (1 - f2 / f1) * 100;
  // Decoupling (Friel): speed (on the same scale) per heartbeat, first half against second half.
  const decouplingPct = h1.hr && h2.hr ? (1 - (f2 / h2.hr) / (f1 / h1.hr)) * 100 : null;

  // 15. The result. Fields worth knowing:
  //   T, M, N, ele, grade   per-sample arrays (elapsed s, moving s, normalised effort, m, %)
  //   avgPace               elapsed time / distance (s/km, stops included); movingPace, gapPace
  //   hrMax                 the highest heart rate recorded. `.filter((x) => x)` drops null and 0
  //                         values; `Math.max(...list)` spreads the list into separate arguments
  //   profile, route        [km, ele] and [lat, lon] every 100 m, for the chart and the map
  //   effort, effortBands   local effort every 100 m, and the colour bands built from it
  //   legs, stops, splits, halves, moments   see above and runMoments
  //   over, idx, formAt     the helper functions, handed over so other modules can reuse them
  const run = {
    name: parsed.name || "", startMs: rs.time[0], step, n, totalKm, T, ele, M, grade,
    elapsedSec, movingSec, stopSec: elapsedSec - movingSec, gain, loss,
    hasHr: Boolean(rs.hr && HS[n - 1] > 0), hasCad: Boolean(rs.cad && CS[n - 1] > 0),
    hr: rs.hr, cad: rs.cad, cadMul,
    avgPace: (elapsedSec / Math.max(1e-6, totalKm)), movingPace: all.pace, gapPace: all.gap,
    hrAvg: all.hr, hrMax: rs.hr ? Math.max(...rs.hr.filter((x) => x)) : null, cadAvg: all.cad, hikeShare: all.hikeShare,
    profile, route, effort, effortBands, legs, stops: stopList, splits,
    halves: { first: h1, second: h2, fadePct, decouplingPct, km: (half * step) / 1000 },
    N, over, idx, formAt,
  };
  run.moments = runMoments(run);
  return run;
}

/**
 * Index (0-based) of the section that contains `km`. A simple walk from the first section
 * (there are only a few dozen); a km past the finish returns the last one.
 */
export function runLegAt(legs, km) {
  let i = 0;
  while (i < legs.length - 1 && km >= legs[i].endKm) i++;
  return i;
}

/**
 * Where you were at `sec` seconds after the start: km, altitude, gradient, and what you were doing
 * then (pace and GAP over the surrounding 200 m, heart rate, cadence, stopped or not).
 *
 * Inputs: the run from analyseRun, seconds since the start. Called at every animation frame
 * of the replay. Returns {sec, km, frac (0..1 of the time), i (nearest sample), ele (m),
 * grade (%), stopped (true/false), pace and gap (s/km, null when stopped), hr, cad}.
 */
export function runStateAt(run, sec) {
  const { T, n, step } = run;
  // Clamp the time to the run, then binary-search the elapsed times: the runner is between
  // samples j-1 and j, a fraction f of the way. i is the nearer of the two samples.
  const s = Math.max(0, Math.min(run.elapsedSec, sec));
  const j = Math.max(1, Math.min(n - 1, rvUpper(T, s)));
  const f = Math.max(0, Math.min(1, (s - T[j - 1]) / Math.max(1e-6, T[j] - T[j - 1])));
  const i = f < 0.5 ? j - 1 : j;
  const km = ((j - 1 + f) * step) / 1000;
  // A sample that holds a stop: you are standing still for most of it.
  const dt = T[j] - T[j - 1];
  const stopped = dt > 0 && step / dt < STOP_SPEED;
  // Pace and GAP over +/-10 samples (+/-100 m: 200 m in all) so the number does not flicker.
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

/**
 * Elapsed seconds when the run reached `km`.
 * x is the position in samples (it can fall between two); the time is interpolated
 * linearly between the samples just before (a) and after (b).
 */
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
  // Small helpers:
  //   add(m)   store a moment. Defaults: toKm = km, tip = "". `m.sec ?? ...` (the "nullish
  //            coalescing" operator) uses m.sec when it is given (even 0), else the time at m.km.
  //   pct(x)   "+8%" / "-3%"
  //   dur(s)   "12 min" under an hour, else "1h05"
  //   gapTxt   "6:12/km grade-adjusted", or "" when there is no GAP
  const out = [];
  const add = (m) => out.push({ toKm: m.km, tip: "", ...m, sec: m.sec ?? runSecAtKm(run, m.km) });
  const pct = (x) => `${x > 0 ? "+" : ""}${Math.round(x)}%`;
  const dur = (sec) => (sec < 3600 ? `${Math.max(1, Math.round(sec / 60))} min` : hm(sec));
  const gapTxt = (l) => (l.gap ? `${mmss(l.gap)}/km grade-adjusted` : "");
  add({ kind: "start", tone: "info", km: 0, sec: 0, title: "Start", text: `${run.totalKm.toFixed(1)} km and ${Math.round(run.gain)} m of climbing ahead. Your average effort for the day is ${run.gapPace ? `${mmss(run.gapPace)}/km grade-adjusted` : "the yardstick"}: every section is compared with it.` });

  // Best and worst of each kind, when there are at least two to compare and the gap is real.
  // pick(kind, test, best): among the sections of that kind that pass `test`, the strongest
  // (best = true) or the weakest, but only if its verdict really is Strong (or Weak).
  // reduce keeps the better of each pair as it walks the list.
  const pick = (kind, min, best) => {
    const list = run.legs.filter((l) => l.kind === kind && min(l));
    if (list.length < 2) return null;
    const x = list.reduce((a, l) => ((best ? l.score > a.score : l.score < a.score) ? l : a));
    return (best ? x.tone === "good" : x.tone === "bad") ? x : null;
  };
  // Only sections with at least 30 m up (or down) over 400 m or more are worth a moment.
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
  // Only reported when the second half was at least 5% weaker and the run is 5 km or more.
  // A second half within 1% of the first, or better, is praised as even (or a negative split).
  const P = run.profile;
  const E = run.effort;
  const { fadePct, decouplingPct } = run.halves;
  if (fadePct >= 5 && run.totalKm >= 5) {
    // Mean of the rest of the run from each point: the fade starts where both it and the moment
    // itself drop under 95% of your day's average.
    // rest[k] = mean of E from point k to the end, filled in one backwards pass with a
    // running sum. findIndex returns the first point past a quarter of the run where both the rest
    // of the run and the point itself are under 0.95; -1 when none, then the halfway km is used.
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
  // r = effort over the end / effort over the whole run: 1.04 or more is strong, 0.90 or less is tough.
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
    // A sliding window with two pointers: i is the newest sample, j the oldest one still within 60 s.
    // s and c are the sum and count of heart rates in the window; adding at i and removing at j
    // keeps them right without re-adding the whole window. A window counts when it has more than
    // 3 values and spans at least 45 s.
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
  // A sample is "walk" on a gentle slope (-5% to +5%) with a hiking cadence while still moving.
  // `a` is where the current walking stretch started (-1: none). The loop runs to i = n so a
  // stretch that lasts to the very end is closed too. Stretches of 300 m or more are kept,
  // and the two longest become moments.
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

  // The finish, then everything in time order (same km as a tie-break), each with its index i.
  add({ kind: "finish", tone: "info", km: run.totalKm, sec: run.elapsedSec, title: "Finish", text: `${run.totalKm.toFixed(1)} km in ${hm(run.elapsedSec)} (${hm(run.movingSec)} moving), ${Math.round(run.gain)} m D+.` });
  out.sort((a, b) => a.sec - b.sec || a.km - b.km);
  return out.map((m, i) => ({ ...m, i }));
}

/**
 * The numbers of the run, for the "Your numbers" block: the steepest 100 m up and down, the
 * fastest 200 m, 1 km and 5 km (on the clock, so a stop inside one counts), the best pace held
 * for one minute, and the splits per km with their climbing. All of them are sliding windows on
 * the 10 m samples: for a window of w samples, (T[i + w] - T[i]) is the time it took, and the
 * best window is the smallest one, found in one pass.
 */
export function runStats(run) {
  const { n, step, T, ele, M } = run;
  // span(m): a distance in metres as a number of samples (at least 1).
  // fastest(m): slide a window of that many samples along the run and keep the shortest time.
  // Returns {m, sec, pace (s/km), km, toKm, startSec}, or null when the run is shorter than m.
  const span = (m) => Math.max(1, Math.round(m / step));
  const fastest = (m) => {
    const w = span(m);
    if (w >= n) return null;
    let best = null;
    for (let i = 0; i + w < n; i++) { const t = T[i + w] - T[i]; if (!best || t < best.sec) best = { sec: t, i }; }
    return { m, sec: best.sec, pace: (best.sec / m) * 1000, km: (best.i * step) / 1000, toKm: ((best.i + w) * step) / 1000, startSec: T[best.i] };
  };
  // steep(up): the 100 m window with the biggest rise (up = true) or the biggest drop. grade is the
  // rise in metres over 100 m, which is also the gradient in %.
  const steep = (up) => {
    const w = span(100);
    if (w >= n) return null;
    let best = null;
    for (let i = 0; i + w < n; i++) { const d = ele[i + w] - ele[i]; if (!best || (up ? d > best.d : d < best.d)) best = { d, i }; }
    const sec = T[best.i + w] - T[best.i];
    return { grade: best.d, km: (best.i * step) / 1000, toKm: ((best.i + w) * step) / 1000, sec, pace: (sec / 100) * 1000, startSec: T[best.i] };
  };
  // Best pace held for one minute: two pointers, j the first sample one minute after i.
  // j only moves forward, so the whole scan is one pass. When even the last sample is less than
  // a minute after i, no later i can make it either, so the loop stops (`break`).
  let best1 = null;
  for (let i = 0, j = 0; i < n; i++) {
    if (j < i) j = i;
    while (j < n - 1 && T[j] - T[i] < 60) j++;
    if (T[j] - T[i] < 60) break;
    const pace = ((T[j] - T[i]) / ((j - i) * step)) * 1000;
    if (!best1 || pace < best1.pace) best1 = { pace, km: (i * step) / 1000, startSec: T[i] };
  }
  // Highest and lowest points: indices of the max and min altitude.
  let hi = 0, lo = 0;
  for (let i = 1; i < n; i++) { if (ele[i] > ele[hi]) hi = i; if (ele[i] < ele[lo]) lo = i; }
  // Add D+ and D- to each whole-km split.
  const kmIdx = (k) => Math.min(n - 1, Math.round((k * 1000) / step));
  const splits = run.splits.map((sp) => {
    let up = 0, down = 0;
    for (let i = kmIdx(sp.km - 1) + 1; i <= kmIdx(sp.km); i++) { const d = ele[i] - ele[i - 1]; if (d > 0) up += d; else down -= d; }
    return { ...sp, up, down };
  });
  // The part after the last whole km, when it is at least 100 m.
  const lastKm = splits.length;
  if (run.totalKm - lastKm >= 0.1) {
    const a = kmIdx(lastKm), o = run.over(a, n - 1);
    let up = 0, down = 0;
    for (let i = a + 1; i < n; i++) { const d = ele[i] - ele[i - 1]; if (d > 0) up += d; else down -= d; }
    splits.push({ km: run.totalKm, part: run.totalKm - lastKm, sec: o.sec, pace: o.pace, gap: o.gap, speedEq: o.speedEq, hr: o.hr, stopSec: o.stopSec, up, down });
  }
  // Fastest and slowest splits, among those with a pace (a split spent stopped has none).
  const moving = splits.filter((sp) => sp.pace);
  return {
    steepestUp: steep(true), steepestDown: steep(false),
    fastest200: fastest(200), fastest1k: fastest(1000), fastest5k: run.totalKm >= 5 ? fastest(5000) : null,
    best1min: best1,
    avgPace: run.avgPace, movingPace: run.movingPace, gapPace: run.gapPace,
    high: { ele: ele[hi], km: (hi * step) / 1000 }, low: { ele: ele[lo], km: (lo * step) / 1000 },
    fastestSplit: moving.reduce((a, sp) => (!a || sp.pace < a.pace ? sp : a), null),
    slowestSplit: moving.reduce((a, sp) => (!a || sp.pace > a.pace ? sp : a), null),
    splits,
    movingSec: M[n - 1],
  };
}

/**
 * Speed along the run for the pace line on the profile: one value per profile point (every
 * 100 m), the moving speed over the 100 m around it (stops left out, so a stop does not drop
 * the line to zero), then a 3-point moving average so the line does not jitter. Returns
 * [{km, v (m/s), pace (s/km)}].
 */
export function runPaceLine(run) {
  const { n, step, M } = run;
  // +/-50 m around each point. `([km]) =>` destructures the profile point [km, ele] and keeps km.
  const half = Math.max(1, Math.round(50 / step));
  const raw = run.profile.map(([km]) => {
    const i = Math.min(n - 1, Math.round((km * 1000) / step));
    const a = Math.max(0, i - half), b = Math.min(n - 1, i + half);
    const mv = M[b] - M[a];
    return { km, v: mv > 0 ? ((b - a) * step) / mv : 0 };
  });
  // 3-point moving average: this point and its neighbours (slice(k - 1, k + 2) takes up to three),
  // leaving out points with no speed.
  return raw.map((p, k) => {
    const nb = raw.slice(Math.max(0, k - 1), k + 2).filter((q) => q.v > 0);
    const v = nb.length ? nb.reduce((s, q) => s + q.v, 0) / nb.length : 0;
    return { km: p.km, v, pace: v > 0 ? 1000 / v : null };
  });
}

/**
 * Read a target typed by a person: a finish time ("3:15", "3h15", "3:15:00": hours and minutes) or
 * a pace per km ("6:30": minutes and seconds). Returns {kind, value} with value in seconds (total
 * time, or seconds per km), or null when the text is not a time.
 */
export function parseTarget(kind, text) {
  // Normalise: text, trimmed, lower case, with every space removed (\s+ matches runs of spaces).
  const t = String(text || "").trim().toLowerCase().replace(/\s+/g, "");
  if (!t) return null;
  let m;
  if (kind === "pace") {
    // Pace regex: 1 or 2 digits (minutes), then optionally one of : ' m, then optionally 2 digits
    // (seconds), then optionally a closing " or s or /km. Matches "6:30", "6'30", "6m30", "6".
    // A pace is accepted between 2:00 and 60:00 per km.
    m = /^(\d{1,2})[:'m]?(\d{2})?(?:"|s|\/km)?$/.exec(t.replace("/km", ""));
    if (!m) return null;
    const v = Number(m[1]) * 60 + Number(m[2] || 0);
    return v >= 120 && v <= 3600 ? { kind, value: v } : null;
  }
  // Time regex: hours (1-2 digits), then optionally ":" or "h" and minutes, then optionally ":"
  // and seconds. Matches "3", "3:15", "3h15", "3:15:00". `(?: ...)` groups without capturing.
  // A trailing "min" is dropped first. At least 10 minutes (600 s) to count.
  m = /^(\d{1,2})(?:[:h](\d{1,2}))?(?::(\d{1,2}))?$/.exec(t.replace(/min$/, ""));
  if (!m) return null;
  const v = Number(m[1]) * 3600 + Number(m[2] || 0) * 60 + Number(m[3] || 0);
  return v >= 600 ? { kind: "time", value: v } : null;
}

/**
 * Compare the run with a target and say how the effort could be spread to reach it.
 *
 * `target` is {kind: "time" | "pace", value}: a finish time on the clock, or the average pace on
 * the clock (stops included, like a race result). The idea:
 *
 *  - Stops. Some are needed (water, a gate): we allow 1 min per hour of the target, and count
 *    anything above that as time to gain without running any faster.
 *  - Even effort. Every section has a "norm": the moving time it takes at exactly your average
 *    for its kind of ground (see N in analyseRun). Running the whole run at one effort f (1.00 =
 *    your average today, 1.05 = 5% stronger everywhere) takes sum(norm) / f. So the effort the
 *    target asks for is f = sum(norm) / (target - stop allowance), and each section's target time
 *    is its norm / f. Climbs get slower targets than flats, exactly in proportion to how you
 *    really run them, not to a generic model.
 *  - Where the time is. The gap splits into stops above the allowance, the fade (second half
 *    run at your first-half effort), and what is left: real speed to find in training.
 *  - Verdict. Against your first-half effort f1 (what your legs showed they can do that day):
 *    f <= f1 is within reach with better pacing and shorter stops, up to 5% more is a stretch,
 *    beyond that the target is far, and we suggest the time you can aim for next.
 */
export function runTarget(run, target) {
  // Returns null without a valid target, else {target, targetSec, targetPace, gapSec, status
  // ("reached" | "reach" | "stretch" | "far"), effort f, effortFirst f1, effortSecond f2,
  // effortPct, vsFirstPct, targetGap, stopAllow, stopGain, fadeGain, speedGain, realisticSec,
  // legs (per section: actual vs target time, pace, GAP, VAM), lose, ease, ghostAt(km)}.
  // 1. The target as a finish time in seconds (a pace x the distance).
  if (!target || !(target.value > 0)) return null;
  const targetSec = target.kind === "pace" ? target.value * run.totalKm : target.value;
  const gapSec = run.elapsedSec - targetSec; // > 0: slower than the target
  // 2. Stops: 1 minute allowed per hour of target (targetSec / 60 seconds), the rest is to gain.
  const stopAllow = Math.min(run.stopSec, targetSec / 60);
  const stopGain = run.stopSec - stopAllow;
  // 3. The even effort f the target asks for (at least 60 s of moving time, to stay sane).
  const normTotal = run.legs.reduce((s, l) => s + l.norm, 0);
  const targetMoving = Math.max(60, targetSec - stopAllow);
  const f = normTotal / targetMoving;
  const f1 = run.formAt(0, run.idx(run.halves.km));
  const f2 = run.formAt(run.idx(run.halves.km), run.n - 1);
  // Fade: what the second half would have taken at your first-half effort.
  const iHalf = run.idx(run.halves.km);
  const secondMoving = run.M[run.n - 1] - run.M[iHalf];
  const secondNorm = run.N[run.n - 1] - run.N[iHalf];
  const fadeGain = Math.max(0, secondMoving - secondNorm / Math.max(f1, 1e-6));
  // 4. Split the gap: pacing (stops + fade, never more than the gap itself), then speed for the rest.
  // status: reached; within a minute by pacing alone; needs up to 5% more than your first half;
  // or far.
  const pacingGain = Math.min(Math.max(0, gapSec), stopGain + fadeGain);
  const speedGain = Math.max(0, gapSec - pacingGain);
  const ratio = f / Math.max(f1, 1e-6);
  const status = gapSec <= 0 ? "reached" : speedGain < 60 ? "reach" : ratio <= 1.05 ? "stretch" : "far";
  // The time you could aim for next: your first-half effort all the way, stops at the allowance.
  const realisticSec = Math.min(run.elapsedSec, normTotal / Math.max(f1, 1) + Math.min(run.stopSec, run.elapsedSec / 60));
  // 5. Per-section targets: norm / f seconds. tgtGap scales the section's GAP by the time ratio.
  const legs = run.legs.map((l) => {
    const tgt = l.norm / f;
    const tgtGap = l.gap ? l.gap * (l.movSec / tgt) : null;
    return {
      i: l.i, kind: l.kind, title: l.title, startKm: l.startKm, endKm: l.endKm, km: l.km, up: l.up,
      movSec: l.movSec, tgtSec: tgt, deltaSec: l.movSec - tgt,
      pace: l.pace, tgtPace: l.km > 0 ? tgt / l.km : null, tgtGap,
      vam: l.vam, tgtVam: l.vam ? (l.up / tgt) * 3600 : null,
    };
  });
  // Where to change the effort: the sections that lost the most against the target, and, before
  // a fade, the ones run faster than the target asked (energy spent too early).
  // `(... || {}).km ?? Infinity`: the km of the fade moment, or Infinity when there is none
  // (then `ease` stays empty). lose: up to 3 sections more than 15 s behind their target;
  // ease: up to 2 sections before the fade run more than 15 s faster than asked.
  // ghostAt(km): where a "ghost" runner at the target effort would be, in seconds, for the replay.
  const fadeKm = (run.moments.find((m) => m.kind === "fade") || {}).km ?? Infinity;
  const lose = legs.filter((l) => l.deltaSec > 15).sort((a, b) => b.deltaSec - a.deltaSec).slice(0, 3);
  const ease = Number.isFinite(fadeKm) ? legs.filter((l) => l.endKm <= fadeKm + 0.01 && l.deltaSec < -15).sort((a, b) => a.deltaSec - b.deltaSec).slice(0, 2) : [];
  const ghostAt = (km) => run.N[run.idx(km)] / f + stopAllow * (km / run.totalKm);
  return {
    target, targetSec, targetPace: targetSec / run.totalKm, gapSec, status,
    effort: f, effortFirst: f1, effortSecond: f2, effortPct: (f - 1) * 100, vsFirstPct: (ratio - 1) * 100,
    targetGap: run.gapPace ? run.gapPace / f : null,
    stopAllow, stopGain, fadeGain, speedGain, realisticSec,
    legs, lose, ease, ghostAt,
  };
}

/** Short verdicts for the summary: how many strong and weak sections, the main takeaways. */
export function runSummary(run) {
  // Returns {good, bad (lists of moments), strongLegs, weakLegs (counts of sections)}.
  const good = run.moments.filter((m) => m.tone === "good");
  const bad = run.moments.filter((m) => m.tone === "bad");
  return { good, bad, strongLegs: run.legs.filter((l) => l.tone === "good").length, weakLegs: run.legs.filter((l) => l.tone === "bad").length };
}
