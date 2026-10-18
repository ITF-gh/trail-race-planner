// insights.js: the "Deep dive" of Rewind my run (once called Check my run). Numbers a coach would ask for after a run, several
// of them with a setting you can change (a distance, a band width, your max heart rate...).
//
// Everything starts from the arrays analyseRun already built, one value per 10 m sample:
//   T  elapsed seconds, M moving seconds (running total), ele, grade (%), hr, cad.
// Most answers are "group the samples by something and add up": group by gradient band, by pace
// bin, by heart-rate zone. A few are "slide a window and keep the best": the best effort for any
// distance. And the scatter explorer works on 100 m chunks, small enough to show detail, big
// enough to smooth out GPS noise.
//
// Where it sits: review.js analyseRun builds the `run` object; src/ui/insights.js calls the
// functions below with it and draws the tables and charts. Pure maths: no page, no storage.
//
// Main exports:
//   bestEffort, bestCurve   fastest stretch for a distance, and the pace-distance curve
//   gradeBands              pace, GAP, heart rate, cadence per gradient band
//   hrZones                 time in heart-rate zones Z1..Z5, and the TRIMP training load
//   runChunks, paceHistogram, fitLine   the 100 m points of the scatter explorer, the pace
//                           histogram, and a least-squares line with Pearson's r
//   paceHeatmap             pace per gradient band per slice of the run (the heat map)
//   runKpis                 the ~20 headline numbers ("Key numbers")
//   climbTable              one row per climb and descent
//
// "Group and add up" uses a Map (a dictionary): the key is the group number (a gradient band,
// a pace bin), the value an object of running sums. Averages are taken at the end, weighted by
// moving time: sum(value x seconds) / sum(seconds).

import { minettiCost, effortFactor } from "./review.js";

const IN_HIKE_CAD = 145; // steps per minute: below it you were hiking (same rule as the review)
const IN_CHUNK_M = 100; // the scatter explorer and the pace histogram use 100 m chunks

/**
 * Moving seconds, heart rate and cadence of sample i (the 10 m that end at i).
 * Returns {mv (moving s, from the running total M), hr (bpm or null), cad (steps per minute,
 * already doubled for per-foot watches, or null), g (gradient %)}. i must be 1 or more.
 */
function inSample(run, i) {
  const mv = run.M[i] - run.M[i - 1];
  const hr = run.hr && run.hr[i] ? run.hr[i] : null;
  const cad = run.cad && run.cad[i] > 0 ? run.cad[i] * run.cadMul : null;
  return { mv, hr, cad, g: run.grade[i] };
}

/**
 * Best effort over `m` metres: the stretch of that length that took the least time on the clock
 * (a stop inside it counts, like in a race). One pass with a window of m / 10 samples.
 *
 * Inputs: the run, a distance in metres. Returns {m (the distance actually used: a whole
 * number of samples), sec, pace (s/km), km and toKm (where), startSec}, or null when the run
 * is shorter. T[i + w] - T[i] is the time from sample i to sample i + w: one subtraction per
 * position, so the scan is fast even on a 100 km run.
 */
export function bestEffort(run, m) {
  const w = Math.max(1, Math.round(m / run.step));
  if (w >= run.n) return null;
  let best = 0, bestT = Infinity;
  for (let i = 0; i + w < run.n; i++) { const t = run.T[i + w] - run.T[i]; if (t < bestT) { bestT = t; best = i; } }
  const dist = w * run.step;
  return { m: dist, sec: bestT, pace: (bestT / dist) * 1000, km: (best * run.step) / 1000, toKm: ((best + w) * run.step) / 1000, startSec: run.T[best] };
}

/**
 * Best efforts on a ladder of distances up to the whole run: the pace-distance curve.
 * The ladder holds classic race distances (21097 m is a half marathon, 42195 m a marathon).
 * Only the ones shorter than the run are tried; the whole run is added last as the longest point.
 * `.filter(Boolean)` drops any null result. Returns a list of bestEffort objects, shortest first.
 */
export function bestCurve(run) {
  const ladder = [100, 200, 400, 800, 1000, 1500, 2000, 3000, 5000, 10000, 15000, 21097, 30000, 42195, 50000, 75000, 100000];
  const max = (run.n - 1) * run.step;
  const list = ladder.filter((m) => m < max).map((m) => bestEffort(run, m)).filter(Boolean);
  list.push({ m: max, sec: run.elapsedSec, pace: (run.elapsedSec / max) * 1000, km: 0, toKm: run.totalKm, startSec: 0 });
  return list;
}

/**
 * Time, pace, grade-adjusted pace, heart rate and cadence per gradient band `width` % wide
 * (-2.5..2.5 for 5%, centred on flat). Moving time only.
 *
 * Returns one object per band that has data, steepest descent first: {from, to, mid (%), km,
 * sec, share (of moving time), pace, gap (s/km), hr, cad, hikeShare (0..1), vam (m/h on
 * climbing bands), descentRate (m/h on descending bands)}.
 */
export function gradeBands(run, width = 5) {
  const bands = new Map();
  // 1. Walk every 10 m sample and add it to its band.
  for (let i = 1; i < run.n; i++) {
    const s = inSample(run, i);
    if (s.mv <= 0) continue;
    // Band number: the gradient (clamped to -45..+45%) divided by the width and rounded.
    // With width 5: -2.5..+2.5% is band 0, +2.5..+7.5% is band 1, -7.5..-2.5% is band -1.
    const k = Math.round(Math.max(-45, Math.min(45, s.g)) / width);
    // First sample in this band: create its running sums and store them in the Map.
    let b = bands.get(k);
    if (!b) { b = { k, from: (k - 0.5) * width, to: (k + 0.5) * width, m: 0, sec: 0, eq: 0, hrSec: 0, hrSum: 0, cadSec: 0, cadSum: 0, hikeSec: 0, up: 0, down: 0 }; bands.set(k, b); }
    b.m += run.step;
    b.sec += s.mv;
    b.eq += run.step * effortFactor(s.g);
    if (s.hr) { b.hrSec += s.mv; b.hrSum += s.hr * s.mv; }
    if (s.cad) { b.cadSec += s.mv; b.cadSum += s.cad * s.mv; if (s.cad < IN_HIKE_CAD) b.hikeSec += s.mv; }
    const d = run.ele[i] - run.ele[i - 1];
    if (d > 0) b.up += d; else b.down -= d;
  }
  // 2. Turn the sums into averages. `[...bands.values()]` copies the Map's values into an array
  // (spread) so it can be sorted by band number. `|| 1` avoids dividing by zero.
  const total = run.movingSec || 1;
  return [...bands.values()].sort((a, b) => a.k - b.k).map((b) => ({
    from: b.from, to: b.to, mid: b.k * width, km: b.m / 1000, sec: b.sec, share: b.sec / total,
    pace: b.m > 0 ? (b.sec / b.m) * 1000 : null, gap: b.eq > 0 ? (b.sec / b.eq) * 1000 : null,
    hr: b.hrSec > 0 ? b.hrSum / b.hrSec : null, cad: b.cadSec > 0 ? b.cadSum / b.cadSec : null,
    hikeShare: b.cadSec > 0 ? b.hikeSec / b.cadSec : null,
    vam: b.up > 0 && b.k > 0 ? (b.up / b.sec) * 3600 : null, descentRate: b.down > 0 && b.k < 0 ? (b.down / b.sec) * 3600 : null,
  }));
}

/**
 * Time in the five classic heart-rate zones, as % of max heart rate: Z1 under 60%, Z2 60-70,
 * Z3 70-80, Z4 80-90, Z5 over 90. Plus TRIMP, Banister's training impulse: each minute weighted
 * by how far your heart rate sits between rest and max, growing exponentially with it
 * (minutes x HRr x 0.64 x e^(1.92 x HRr), the coefficients Banister fitted for men; women's
 * are 0.86 and 1.67).
 *
 * Inputs: the run, max and resting heart rate (bpm), female (true/false). Returns null without
 * heart-rate data or a max, else {zones: [{z, name, sec, share, fromBpm, toBpm}], trimp, hrSec}.
 * HRr ("heart-rate reserve" fraction) = (HR - rest) / (max - rest), clamped to 0..1.
 */
export function hrZones(run, hrMax, hrRest = 60, female = false) {
  if (!run.hasHr || !(hrMax > 0)) return null;
  const edges = [0.6, 0.7, 0.8, 0.9];
  const zones = [0, 0, 0, 0, 0];
  let trimp = 0, hrSec = 0;
  // Array destructuring: ka and kb take the two coefficients for women or for men.
  const [ka, kb] = female ? [0.86, 1.67] : [0.64, 1.92];
  for (let i = 1; i < run.n; i++) {
    const s = inSample(run, i);
    if (s.mv <= 0 || !s.hr) continue;
    const f = s.hr / hrMax;
    // Zone index 0..4: step up while the heart rate is at or above the next edge.
    let z = 0;
    while (z < 4 && f >= edges[z]) z++;
    zones[z] += s.mv;
    hrSec += s.mv;
    const r = Math.max(0, Math.min(1, (s.hr - hrRest) / Math.max(1, hrMax - hrRest)));
    // TRIMP for this sample: minutes x HRr x ka x e^(kb x HRr). Math.exp(x) is e to the power x.
    trimp += (s.mv / 60) * r * ka * Math.exp(kb * r);
  }
  const names = ["Z1 Recovery", "Z2 Endurance", "Z3 Tempo", "Z4 Threshold", "Z5 Max"];
  // Lower and upper edges of each zone as a fraction of max: lo = [0, 0.6, 0.7, 0.8, 0.9],
  // hi = [0.6, 0.7, 0.8, 0.9, Infinity]. Z5 has no upper bpm (toBpm null).
  const lo = [0, ...edges], hi = [...edges, Infinity];
  return {
    zones: zones.map((sec, z) => ({ z: z + 1, name: names[z], sec, share: hrSec > 0 ? sec / hrSec : 0, fromBpm: Math.round(lo[z] * hrMax), toBpm: hi[z] === Infinity ? null : Math.round(hi[z] * hrMax) - 1 })),
    trimp, hrSec,
  };
}

/**
 * One point per 100 m: where, when, how steep, how fast, heart and feet. For the scatter explorer.
 * Returns [{km (middle of the chunk), startSec, ele (m), grade (%), pace, gap (s/km), hr, cad,
 * speed (km/h: m/s x 3.6), frac (share of the elapsed time, 0..1, used to colour the dot)}].
 * Chunks with no moving time (a full stop) are skipped.
 */
export function runChunks(run) {
  const w = Math.max(1, Math.round(IN_CHUNK_M / run.step));
  const out = [];
  for (let a = 0; a + w < run.n; a += w) {
    const b = a + w;
    const o = run.over(a, b);
    if (!(o.mv > 0)) continue;
    out.push({
      km: ((a + b) / 2 * run.step) / 1000, startSec: run.T[a], ele: (run.ele[a] + run.ele[b]) / 2,
      grade: ((run.ele[b] - run.ele[a]) / (w * run.step)) * 100,
      pace: o.pace, gap: o.gap, hr: o.hr, cad: o.cad, speed: (w * run.step) / o.mv * 3.6,
      frac: run.T[a] / run.elapsedSec,
    });
  }
  return out;
}

/**
 * Moving time per pace bin `binSec` seconds wide, from the 100 m chunks. Very slow chunks (over 20:00/km) are left out.
 *
 * Inputs: the run, the bin width in seconds of pace (15 = bins 5:00-5:15, 5:15-5:30...), and
 * optionally the chunk list (a default parameter: runChunks(run) is only computed when the
 * caller does not pass one). Returns {bins: [{from, to (s/km), sec, share}], total (s)}, with
 * empty bins kept between the fastest and the slowest so the histogram has no holes.
 */
export function paceHistogram(run, binSec = 15, list = runChunks(run)) {
  const bins = new Map();
  let total = 0;
  for (const c of list) {
    if (!c.pace || c.pace > 1200) continue;
    // Bin number, and the time this 100 m chunk took (pace in s/km x 0.1 km).
    const k = Math.floor(c.pace / binSec);
    const sec = (c.pace * IN_CHUNK_M) / 1000;
    bins.set(k, (bins.get(k) || 0) + sec);
    total += sec;
  }
  if (!bins.size) return { bins: [], total: 0 };
  const keys = [...bins.keys()];
  const lo = Math.min(...keys), hi = Math.max(...keys);
  const out = [];
  for (let k = lo; k <= hi; k++) out.push({ from: k * binSec, to: (k + 1) * binSec, sec: bins.get(k) || 0, share: (bins.get(k) || 0) / total });
  return { bins: out, total };
}

// The 7 gradient bands of the heat map, steepest descent first (Boss's bands, 2026-10-18).
export const HEAT_BANDS = [
  { from: -Infinity, to: -10, label: "< -10%" }, { from: -10, to: -5, label: "-10 to -5%" }, { from: -5, to: -2, label: "-5 to -2%" },
  { from: -2, to: 2, label: "-2 to +2%" }, { from: 2, to: 5, label: "+2 to +5%" }, { from: 5, to: 10, label: "+5 to +10%" },
  { from: 10, to: Infinity, label: "> +10%" },
];

/**
 * The pace heat map: the run cut into `cols` equal slices of distance (10 = every 10% of the run)
 * and each 100 m chunk put in its gradient band (HEAT_BANDS) and its slice. A cell holds the
 * distance and moving time there, so its pace = time / distance.
 *
 * `ratio` compares the cell's pace with the band's pace over the whole run: under 1 = faster than
 * your other moments on that gradient, over 1 = slower. Chunks slower than 30:00/km (a pause
 * that GPS still saw as moving) are left out.
 *
 * Returns {cols, maxM (the biggest cell, in m), bands: [{label, from, to, m, pace, cells: [cell or
 * null]}]}, cell = {m, sec, pace, ratio, startSec (where the cell's first chunk starts, to replay it)}.
 */
export function paceHeatmap(run, cols = 10, list = runChunks(run)) {
  const total = run.totalKm || 1;
  const bands = HEAT_BANDS.map((b) => ({ ...b, m: 0, sec: 0, cells: Array.from({ length: cols }, () => null) }));
  for (const c of list) {
    if (!c.pace || c.pace > 1800) continue;
    const b = bands.find((x) => c.grade >= x.from && c.grade < x.to);
    const k = Math.min(cols - 1, Math.floor((c.km / total) * cols));
    const sec = c.pace * (IN_CHUNK_M / 1000);
    const cell = b.cells[k] || (b.cells[k] = { m: 0, sec: 0, startSec: c.startSec });
    cell.m += IN_CHUNK_M; cell.sec += sec; b.m += IN_CHUNK_M; b.sec += sec;
  }
  let maxM = 0;
  for (const b of bands) {
    b.pace = b.m > 0 ? (b.sec / b.m) * 1000 : null;
    for (const c of b.cells) if (c) { c.pace = (c.sec / c.m) * 1000; c.ratio = c.pace / b.pace; maxM = Math.max(maxM, c.m); }
  }
  return { cols, maxM, bands };
}

/**
 * Pearson correlation and least-squares line of y on x, for the scatter explorer.
 *
 * Inputs: two arrays of numbers of the same length. Returns {slope, intercept, r}, or null
 * with fewer than 3 points or when all x (or all y) are equal.
 * Least squares: the line y = slope x x + intercept that makes the sum of squared vertical
 * gaps smallest. With mx, my the means: slope = sum(dx x dy) / sum(dx^2), intercept = my -
 * slope x mx. Pearson's r = sum(dx x dy) / sqrt(sum(dx^2) x sum(dy^2)), from -1 to +1: how
 * well the dots follow a straight line (0 = not at all).
 */
export function fitLine(xs, ys) {
  const n = xs.length;
  if (n < 3) return null;
  let sx = 0, sy = 0;
  for (let i = 0; i < n; i++) { sx += xs[i]; sy += ys[i]; }
  const mx = sx / n, my = sy / n;
  let sxx = 0, syy = 0, sxy = 0;
  for (let i = 0; i < n; i++) { const dx = xs[i] - mx, dy = ys[i] - my; sxx += dx * dx; syy += dy * dy; sxy += dx * dy; }
  if (sxx <= 0 || syy <= 0) return null;
  const slope = sxy / sxx;
  return { slope, intercept: my - slope * mx, r: sxy / Math.sqrt(sxx * syy) };
}

/**
 * The headline numbers. `athlete` = {weight (kg), hrMax, hrRest, female}: the energy needs a
 * weight, the heart-rate numbers need a max and a resting heart rate. Each KPI: {key, group,
 * label, value, unit, hint}.
 *
 * Defaults when a setting is missing: 70 kg, the run's own peak heart rate as max, 60 bpm at
 * rest. unit tells the UI how to format the value: "dur" (seconds), "n" (count), "%" (a
 * fraction, 0.25 = 25%), "pace" (s/km), "ratio", "m/km", "m/h", "spm", "m", "num", "num0",
 * "kcal". KPIs without a value (no heart rate, no cadence...) are left out of the list.
 */
export function runKpis(run, athlete = {}) {
  const weight = athlete.weight || 70;
  const hrMax = athlete.hrMax || run.hrMax || null;
  const hrRest = athlete.hrRest || 60;
  // 1. One pass over the samples. Gradients of +3% or more count as climbing, -3% or less as
  // descending, the rest as flat. Energy (J) = Minetti cost (J/kg/m) x weight (kg) x 10 m; it is
  // added before the `continue`, so samples that held a stop count too. Cadence 145 spm and up is
  // running, below is hiking.
  let climbSec = 0, flatSec = 0, descSec = 0, upOnClimbs = 0, downOnDesc = 0, energyJ = 0;
  let runSec = 0, runM = 0, runCadSec = 0, runCadSum = 0, hikeSec = 0, cadSec = 0;
  for (let i = 1; i < run.n; i++) {
    const s = inSample(run, i);
    const d = run.ele[i] - run.ele[i - 1];
    energyJ += minettiCost(s.g) * weight * run.step;
    if (s.mv <= 0) continue;
    if (s.g >= 3) { climbSec += s.mv; if (d > 0) upOnClimbs += d; } else if (s.g <= -3) { descSec += s.mv; if (d < 0) downOnDesc -= d; } else flatSec += s.mv;
    if (s.cad) {
      cadSec += s.mv;
      if (s.cad >= IN_HIKE_CAD) { runSec += s.mv; runM += run.step; runCadSec += s.mv; runCadSum += s.cad * s.mv; } else hikeSec += s.mv;
    }
  }
  // 2. Derived numbers. Stops of 10 s or more are counted.
  const stops = run.stops.filter((s) => s.durSec >= 10);
  const mv = run.movingSec || 1;
  const runCad = runCadSec > 0 ? runCadSum / runCadSec : null;
  // Stride length while running: metres per minute divided by steps per minute.
  const stride = runCad && runSec > 0 ? ((runM / runSec) * 60) / runCad : null;
  // Efficiency factor: grade-adjusted speed (m/min) per heartbeat per minute.
  // 60000 / gapPace turns a pace in s/km into a speed in m/min.
  const ef = run.hasHr && run.gapPace && run.hrAvg ? (60000 / run.gapPace) / run.hrAvg : null;
  const z = hrMax ? hrZones(run, hrMax, hrRest, athlete.female) : null;
  const h = run.halves;
  const pct = (x) => `${Math.round(x * 100)}%`;
  // 3. The list, in display order. 4184 J = 1 kcal.
  const list = [
    { key: "moving", group: "Time", label: "Moving time", value: mv, unit: "dur", hint: `${pct(mv / run.elapsedSec)} of the clock` },
    { key: "stops", group: "Time", label: "Stops", value: stops.length, unit: "n", hint: `${Math.round(stops.reduce((s, x) => s + x.durSec, 0) / 60)} min in total, ${stops.filter((s) => s.durSec >= 60).length} of a minute or more` },
    { key: "climbT", group: "Time", label: "Time climbing", value: climbSec / mv, unit: "%", hint: "moving time on gradients of +3% or more" },
    { key: "descT", group: "Time", label: "Time descending", value: descSec / mv, unit: "%", hint: "moving time on gradients of -3% or less" },
    { key: "flatT", group: "Time", label: "Time on the flat", value: flatSec / mv, unit: "%", hint: "between -3% and +3%" },
    { key: "gap", group: "Pace", label: "Grade-adjusted pace", value: run.gapPace, unit: "pace", hint: "the flat pace that would have cost the same energy" },
    { key: "split", group: "Pace", label: "Split ratio", value: h.second.pace && h.first.pace ? h.second.pace / h.first.pace : null, unit: "ratio", hint: "second-half pace / first-half pace (by moving time); under 1.00 is a negative split" },
    { key: "fade", group: "Pace", label: "Fade (grade-adjusted)", value: h.fadePct / 100, unit: "%", hint: "second half against the first, on the same kind of ground" },
    { key: "dens", group: "Climbing", label: "Climb density", value: run.gain / Math.max(0.1, run.totalKm), unit: "m/km", hint: "metres of climbing per km" },
    { key: "vam", group: "Climbing", label: "Climbing speed (VAM)", value: climbSec > 0 ? (upOnClimbs / climbSec) * 3600 : null, unit: "m/h", hint: "vertical metres per hour on +3% and steeper" },
    { key: "desc", group: "Climbing", label: "Descending speed", value: descSec > 0 ? (downOnDesc / descSec) * 3600 : null, unit: "m/h", hint: "vertical metres per hour on -3% and steeper" },
    { key: "hike", group: "Climbing", label: "Hiked", value: cadSec > 0 ? hikeSec / cadSec : null, unit: "%", hint: `moving time with a cadence under ${IN_HIKE_CAD} spm` },
    { key: "cad", group: "Form", label: "Running cadence", value: runCad, unit: "spm", hint: `average while running (${IN_HIKE_CAD} spm and up)` },
    { key: "stride", group: "Form", label: "Stride length", value: stride, unit: "m", hint: "distance per step while running" },
    { key: "ef", group: "Heart", label: "Efficiency factor", value: ef, unit: "num", hint: "grade-adjusted speed (m/min) per bpm: higher = more speed for the same heart; compare it between runs" },
    { key: "dec", group: "Heart", label: "Aerobic decoupling", value: h.decouplingPct !== null ? h.decouplingPct / 100 : null, unit: "%", hint: "speed per heartbeat, second half against the first: under 5% = durable" },
    { key: "hrPct", group: "Heart", label: "Average heart rate", value: run.hasHr && hrMax ? run.hrAvg / hrMax : null, unit: "%", hint: run.hasHr ? `${Math.round(run.hrAvg)} bpm, of a max of ${hrMax}` : "" },
    { key: "trimp", group: "Heart", label: "Training load (TRIMP)", value: z ? z.trimp : null, unit: "num0", hint: "Banister's training impulse: minutes weighted by heart rate; about 100 per hour at threshold" },
    { key: "kcal", group: "Energy", label: "Energy", value: energyJ / 4184, unit: "kcal", hint: `from the energy cost of running on each slope (Minetti 2002), for ${weight} kg` },
    { key: "kcalh", group: "Energy", label: "Energy per hour", value: (energyJ / 4184) / (mv / 3600), unit: "kcal", hint: "what to plan to eat and drink against (you absorb about 250 to 350 kcal/h)" },
  ];
  // Keep only real numbers (drops null, undefined, NaN and Infinity).
  return list.filter((k) => k.value !== null && k.value !== undefined && Number.isFinite(k.value));
}

/**
 * Climbs and descents of the run with their numbers, for the table.
 * One row per non-runnable section of analyseRun: position, D+/D-, average gradient, moving
 * time, pace, GAP, heart rate, cadence, hiked share, VAM (climbs) or descent rate in m/h
 * (descents), and the verdict against your average for that kind of ground.
 */
export function climbTable(run) {
  return run.legs.filter((l) => l.kind !== "flat").map((l) => ({
    i: l.i, kind: l.kind, title: l.title, label: l.label, startKm: l.startKm, endKm: l.endKm, km: l.km, startSec: l.startSec,
    up: l.up, down: l.down, avg: l.avg, movSec: l.movSec, pace: l.pace, gap: l.gap, hr: l.hr, cad: l.cad, hikeShare: l.hikeShare,
    vam: l.kind === "climb" ? l.vam : null, rate: l.kind === "descent" && l.movSec > 0 ? (l.down / l.movSec) * 3600 : null,
    verdict: l.verdict, vsPct: l.vsPct, tone: l.tone,
  }));
}
