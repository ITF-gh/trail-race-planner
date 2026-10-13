// effort.js: learn "how I run" from one of your own GPX files.
//
// The model behind the whole app is a pace table: how many seconds per km you
// run at each gradient band (flat, +6 to +10%, -12 to -6%...). We measure it
// from a reference run you did at a sustained effort, and we measure it twice:
//   - "fresh":  the first half of that run
//   - "tired":  the second half
// The gap between the two is your personal fatigue curve. That is more honest
// than a generic formula, because a runner who is great on climbs and weak on
// descents gets a different plan from one with the opposite profile.
//
// Needs timestamps in the reference file. Heart rate and cadence are optional
// and unlock the heart-rate caps, the hiking threshold and the drift check.

import { resample, smooth } from "./track.js";
import { BANDS, bandIndex, gradeSeries, GRADE_HALF_WINDOW } from "./terrain.js";

/**
 * Fallbacks used when your reference file has too little data in a band
 * (for example no steep descents). Pace is expressed as a multiple of your
 * flat pace; the tired ratio is how much slower the band gets late in a run.
 * Both come from one trail runner's measured data, so they are only a guess.
 */
export const FALLBACK_MULT = [1.58, 1.31, 1.06, 1.04, 1.0, 1.12, 1.3, 1.62, 2.14, 3.04];
export const FALLBACK_TIRED = [1.1, 1.23, 0.99, 1.0, 1.06, 1.13, 1.17, 1.22, 1.24, 1.17];

const MIN_SECONDS = 60; // minimum data in a band (per half) before we trust it
const FLAT = BANDS.findIndex((b) => b.id === "f0");

const HIKE_CAD = 145; // steps per minute: below this you are hiking, not running
const DAY = 86400000;

/**
 * Analyse one reference effort, or several. With several runs, each one counts
 * with a weight that halves every `halfLifeDays` of age (relative to the most
 * recent run), so last week's long run matters more than one from two months ago.
 * Accepts a parsed GPX with times, or an array of them.
 */
export function analyseEffort(parsedOrList, opts = {}) {
  // halfWin is used both for gradient and for speed, and matches the race course window.
  const { step = 10, halfWin = GRADE_HALF_WINDOW, minSpeed = 0.6, halfLifeDays = 28 } = opts;
  const list = Array.isArray(parsedOrList) ? parsedOrList : [parsedOrList];
  if (!list.length) throw new Error("Add at least one recorded run.");
  const runs = list.map((parsed, k) => {
    const rs = resample(parsed, step);
    if (!rs.time) throw new Error(`${list.length > 1 ? `Run ${k + 1}: ` : ""}the effort file needs timestamps (a recorded activity, not a planned route).`);
    return { parsed, rs, start: rs.time[0], end: rs.time[rs.n - 1] };
  });
  const newest = Math.max(...runs.map((r) => r.start));
  for (const r of runs) r.weight = Math.pow(0.5, (newest - r.start) / DAY / halfLifeDays);

  const acc = BANDS.map(() => ({ all: zero(), first: zero(), second: zero() }));
  const slices = []; // [grade, cadence, weighted seconds] on uphill running slices, for the hiking threshold
  let cadenceWasPerFoot = false;
  let hrSum = 0, hrW = 0, hrMax = 0;
  for (const run of runs) {
    const { rs, weight: w } = run;
    const ele = smooth(rs.ele, 3);
    const grade = gradeSeries(ele, step, halfWin); // same window as the speed estimate below
    const tMid = run.start + (run.end - run.start) / 2;
    // Cadence is stored per foot by many devices (about 85 instead of 170).
    const cadVals = [];
    if (rs.cad) {
      for (let i = halfWin; i < rs.n - halfWin; i += 5) {
        const v = 2 * halfWin * step / ((rs.time[i + halfWin] - rs.time[i - halfWin]) / 1000);
        if (v > 2.5 && rs.cad[i] > 0) cadVals.push(rs.cad[i]);
      }
    }
    cadVals.sort((a, b) => a - b);
    const cadMedian = cadVals.length ? cadVals[Math.floor(cadVals.length / 2)] : null;
    const doubled = cadMedian !== null && cadMedian < 120;
    cadenceWasPerFoot = cadenceWasPerFoot || doubled;
    for (let i = halfWin; i < rs.n - halfWin; i += 5) {
      const dtWin = (rs.time[i + halfWin] - rs.time[i - halfWin]) / 1000;
      if (dtWin <= 0) continue;
      const speed = (2 * halfWin * step) / dtWin;
      if (speed < minSpeed) continue; // stopped, or a long pause with the watch running
      const secs = (5 * step) / speed; // time covered by this 5-sample slice
      const bi = bandIndex(grade[i]);
      const half = rs.time[i] < tMid ? "first" : "second";
      const hr = rs.hr && rs.hr[i] ? rs.hr[i] : null;
      const cad = rs.cad && rs.cad[i] ? rs.cad[i] * (doubled ? 2 : 1) : null;
      const vert = (ele[i + halfWin] - ele[i - halfWin]) / dtWin;
      for (const key of ["all", half]) add(acc[bi][key], 5 * step * w, secs * w, hr, cad, vert);
      if (cad !== null && grade[i] > 2) slices.push([grade[i], cad, secs * w]);
    }
    if (rs.hr) for (let i = 0; i < rs.n; i++) if (rs.hr[i]) { hrSum += rs.hr[i] * w; hrW += w; hrMax = Math.max(hrMax, rs.hr[i]); }
  }

  const flatAll = acc[FLAT].all;
  if (flatAll.secs < 120) {
    throw new Error("The effort file has too little flat running to anchor the model (need at least 2 minutes).");
  }
  const flatPace = pace(flatAll);
  const bands = BANDS.map((b, i) => {
    const a = acc[i];
    const measuredAll = a.all.secs >= MIN_SECONDS;
    const measuredBoth = a.first.secs >= MIN_SECONDS && a.second.secs >= MIN_SECONDS;
    let fresh;
    let tired;
    let source;
    if (measuredBoth) {
      fresh = pace(a.first);
      tired = pace(a.second);
      source = "measured";
    } else if (measuredAll) {
      fresh = pace(a.all);
      tired = fresh * FALLBACK_TIRED[i];
      source = "partly measured";
    } else {
      fresh = flatPace * FALLBACK_MULT[i];
      tired = fresh * FALLBACK_TIRED[i];
      source = "estimated";
    }
    // Fatigue cannot make you faster. A band with little data can show that by chance, so clamp it.
    tired = Math.max(tired, fresh);
    return {
      id: b.id,
      label: b.label,
      secs: a.all.secs,
      km: a.all.m / 1000,
      fresh,
      tired,
      pace: measuredAll ? pace(a.all) : fresh,
      hr: a.all.hrSecs > 0 ? a.all.hrSum / a.all.hrSecs : null,
      cad: a.all.cadSecs > 0 ? a.all.cadSum / a.all.cadSecs : null,
      vam: a.all.secs > 0 ? (a.all.vertSum / a.all.secs) * 3600 : null, // vertical metres per hour
      source,
    };
  });

  // Heart-rate drift on the flat: speed per heartbeat, first half vs second half.
  let drift = null;
  const fa = acc[FLAT];
  if (fa.first.hrSecs > MIN_SECONDS && fa.second.hrSecs > MIN_SECONDS && fa.first.secs >= MIN_SECONDS && fa.second.secs >= MIN_SECONDS) {
    const ef1 = (fa.first.m / fa.first.secs) / (fa.first.hrSum / fa.first.hrSecs);
    const ef2 = (fa.second.m / fa.second.secs) / (fa.second.hrSum / fa.second.hrSecs);
    drift = {
      firstPace: pace(fa.first), firstHr: fa.first.hrSum / fa.first.hrSecs,
      secondPace: pace(fa.second), secondHr: fa.second.hrSum / fa.second.hrSecs,
      decouplingPct: (1 - ef2 / ef1) * 100,
    };
  }

  const totalW = runs.reduce((t, r) => t + r.weight, 0);
  const latest = runs.reduce((a, r) => (r.start > a.start ? r : a));
  return {
    // Weighted means over the runs; the race-length fade compares against this duration.
    durationSec: runs.reduce((t, r) => t + r.weight * (r.end - r.start) / 1000, 0) / totalW,
    distKm: runs.reduce((t, r) => t + r.weight * r.rs.totalM / 1000, 0) / totalW,
    flatPace,
    flatHr: flatAll.hrSecs > 0 ? flatAll.hrSum / flatAll.hrSecs : null,
    flatCad: flatAll.cadSecs > 0 ? flatAll.cadSum / flatAll.cadSecs : null,
    avgHr: hrW ? hrSum / hrW : null,
    maxHrSeen: hrW ? hrMax : null,
    cadenceWasPerFoot,
    bands,
    drift,
    hikeGrade: hikeThreshold(slices),
    runs: runs.map((r) => ({ name: r.parsed.name || "", date: new Date(r.start).toISOString().slice(0, 10), distKm: r.rs.totalM / 1000, durationSec: (r.end - r.start) / 1000, weight: r.weight / Math.max(...runs.map((x) => x.weight)) })),
    resampled: latest.rs, // climbs of the most recent run are the reference for "closest climb"
  };
}

/**
 * Gradient (%) where you switch from running to hiking, learned from cadence.
 *
 * Each uphill slice is either run (cadence at or above 145 spm) or hiked (below).
 * We look for the one gradient g that best separates them with the rule
 * "hike when the slope is g or steeper": the g that misclassifies the fewest
 * seconds. In machine learning this is a decision stump, a one-question
 * classifier. Averaging cadence per band instead would blur the two: a band
 * half run at 170 and half hiked at 124 averages 147, which is neither.
 * Returns null when there is under a minute of hiking to learn from.
 */
export function hikeThreshold(slices) {
  const hikedSecs = slices.reduce((t, [, cad, w]) => t + (cad < HIKE_CAD ? w : 0), 0);
  if (hikedSecs < MIN_SECONDS) return null;
  let best = null;
  let bestErr = Infinity;
  for (let g = 4; g <= 35; g += 0.5) {
    let err = 0;
    for (const [grade, cad, w] of slices) if ((grade >= g) !== (cad < HIKE_CAD)) err += w;
    if (err < bestErr) { bestErr = err; best = g; }
  }
  return best;
}

function zero() { return { m: 0, secs: 0, hrSum: 0, hrSecs: 0, cadSum: 0, cadSecs: 0, vertSum: 0 }; }
function add(a, m, secs, hr, cad, vert) {
  a.m += m; a.secs += secs; a.vertSum += vert * secs;
  if (hr !== null) { a.hrSum += hr * secs; a.hrSecs += secs; }
  if (cad !== null) { a.cadSum += cad * secs; a.cadSecs += secs; }
}
function pace(a) { return (a.secs / a.m) * 1000; } // seconds per km
