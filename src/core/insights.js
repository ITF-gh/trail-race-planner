// insights.js: the "Deep dive" of Check my run. Numbers a coach would ask for after a run, several
// of them with a setting you can change (a distance, a band width, your max heart rate...).
//
// Everything starts from the arrays analyseRun already built, one value per 10 m sample:
//   T  elapsed seconds, M moving seconds (running total), ele, grade (%), hr, cad.
// Most answers are "group the samples by something and add up": group by gradient band, by pace
// bin, by heart-rate zone. A few are "slide a window and keep the best": the best effort for any
// distance. And the scatter explorer works on 100 m chunks, small enough to show detail, big
// enough to smooth out GPS noise.

import { minettiCost, effortFactor } from "./review.js";

const IN_HIKE_CAD = 145; // steps per minute: below it you were hiking (same rule as the review)
const IN_CHUNK_M = 100; // the scatter explorer and the pace histogram use 100 m chunks

/** Moving seconds, heart rate and cadence of sample i (the 10 m that end at i). */
function inSample(run, i) {
  const mv = run.M[i] - run.M[i - 1];
  const hr = run.hr && run.hr[i] ? run.hr[i] : null;
  const cad = run.cad && run.cad[i] > 0 ? run.cad[i] * run.cadMul : null;
  return { mv, hr, cad, g: run.grade[i] };
}

/**
 * Best effort over `m` metres: the stretch of that length that took the least time on the clock
 * (a stop inside it counts, like in a race). One pass with a window of m / 10 samples.
 */
export function bestEffort(run, m) {
  const w = Math.max(1, Math.round(m / run.step));
  if (w >= run.n) return null;
  let best = 0, bestT = Infinity;
  for (let i = 0; i + w < run.n; i++) { const t = run.T[i + w] - run.T[i]; if (t < bestT) { bestT = t; best = i; } }
  const dist = w * run.step;
  return { m: dist, sec: bestT, pace: (bestT / dist) * 1000, km: (best * run.step) / 1000, toKm: ((best + w) * run.step) / 1000, startSec: run.T[best] };
}

/** Best efforts on a ladder of distances up to the whole run: the pace-distance curve. */
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
 */
export function gradeBands(run, width = 5) {
  const bands = new Map();
  for (let i = 1; i < run.n; i++) {
    const s = inSample(run, i);
    if (s.mv <= 0) continue;
    const k = Math.round(Math.max(-45, Math.min(45, s.g)) / width);
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
 */
export function hrZones(run, hrMax, hrRest = 60, female = false) {
  if (!run.hasHr || !(hrMax > 0)) return null;
  const edges = [0.6, 0.7, 0.8, 0.9];
  const zones = [0, 0, 0, 0, 0];
  let trimp = 0, hrSec = 0;
  const [ka, kb] = female ? [0.86, 1.67] : [0.64, 1.92];
  for (let i = 1; i < run.n; i++) {
    const s = inSample(run, i);
    if (s.mv <= 0 || !s.hr) continue;
    const f = s.hr / hrMax;
    let z = 0;
    while (z < 4 && f >= edges[z]) z++;
    zones[z] += s.mv;
    hrSec += s.mv;
    const r = Math.max(0, Math.min(1, (s.hr - hrRest) / Math.max(1, hrMax - hrRest)));
    trimp += (s.mv / 60) * r * ka * Math.exp(kb * r);
  }
  const names = ["Z1 Recovery", "Z2 Endurance", "Z3 Tempo", "Z4 Threshold", "Z5 Max"];
  const lo = [0, ...edges], hi = [...edges, Infinity];
  return {
    zones: zones.map((sec, z) => ({ z: z + 1, name: names[z], sec, share: hrSec > 0 ? sec / hrSec : 0, fromBpm: Math.round(lo[z] * hrMax), toBpm: hi[z] === Infinity ? null : Math.round(hi[z] * hrMax) - 1 })),
    trimp, hrSec,
  };
}

/** One point per 100 m: where, when, how steep, how fast, heart and feet. For the scatter explorer. */
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

/** Moving time per pace bin `binSec` seconds wide, from the 100 m chunks. Very slow chunks (over 20:00/km) are left out. */
export function paceHistogram(run, binSec = 15, list = runChunks(run)) {
  const bins = new Map();
  let total = 0;
  for (const c of list) {
    if (!c.pace || c.pace > 1200) continue;
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

/** Pearson correlation and least-squares line of y on x, for the scatter explorer. */
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
 */
export function runKpis(run, athlete = {}) {
  const weight = athlete.weight || 70;
  const hrMax = athlete.hrMax || run.hrMax || null;
  const hrRest = athlete.hrRest || 60;
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
  const stops = run.stops.filter((s) => s.durSec >= 10);
  const mv = run.movingSec || 1;
  const runCad = runCadSec > 0 ? runCadSum / runCadSec : null;
  // Stride length while running: metres per minute divided by steps per minute.
  const stride = runCad && runSec > 0 ? ((runM / runSec) * 60) / runCad : null;
  // Efficiency factor: grade-adjusted speed (m/min) per heartbeat per minute.
  const ef = run.hasHr && run.gapPace && run.hrAvg ? (60000 / run.gapPace) / run.hrAvg : null;
  const z = hrMax ? hrZones(run, hrMax, hrRest, athlete.female) : null;
  const h = run.halves;
  const pct = (x) => `${Math.round(x * 100)}%`;
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
  return list.filter((k) => k.value !== null && k.value !== undefined && Number.isFinite(k.value));
}

/** Climbs and descents of the run with their numbers, for the table. */
export function climbTable(run) {
  return run.legs.filter((l) => l.kind !== "flat").map((l) => ({
    i: l.i, kind: l.kind, title: l.title, label: l.label, startKm: l.startKm, endKm: l.endKm, km: l.km, startSec: l.startSec,
    up: l.up, down: l.down, avg: l.avg, movSec: l.movSec, pace: l.pace, gap: l.gap, hr: l.hr, cad: l.cad, hikeShare: l.hikeShare,
    vam: l.kind === "climb" ? l.vam : null, rate: l.kind === "descent" && l.movSec > 0 ? (l.down / l.movSec) * 3600 : null,
    verdict: l.verdict, vsPct: l.vsPct, tone: l.tone,
  }));
}
