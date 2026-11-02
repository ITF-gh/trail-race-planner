// effort.js: learn "how I run" from one of your own GPX files.

import { resample, smooth } from "./track.js";
import { BANDS, bandIndex, gradeSeries, GRADE_HALF_WINDOW } from "./terrain.js";
import { BAND_CENTRES } from "./model.js";

/** Fallbacks used when your reference file has too little data in a band (for example no steep descents). */
export const FALLBACK_MULT = [1.58, 1.31, 1.06, 1.04, 1.0, 1.12, 1.3, 1.62, 2.14, 3.04];
export const FALLBACK_TIRED = [1.1, 1.23, 0.99, 1.0, 1.06, 1.13, 1.17, 1.22, 1.24, 1.17];

const MIN_SECONDS = 60; // minimum data in a band (per half) before we trust it
// Index of the flat band ("f0") in BANDS: the anchor of the whole model.
const FLAT = BANDS.findIndex((b) => b.id === "f0");

const HIKE_CAD = 145; // steps per minute: below this you are hiking, not running
// One day in milliseconds (24 x 60 x 60 x 1000), to turn timestamp gaps into days.
const DAY = 86400000;

/** Analyse one reference effort, or several. */
export function analyseEffort(parsedOrList, opts = {}) {
  // halfWin is used both for gradient and for speed, and matches the race course window. minSpeed 0.6 m/s (about 28 min/km): slower than that, you are stopped, not moving.
  const { step = 10, halfWin = GRADE_HALF_WINDOW, minSpeed = 0.6, halfLifeDays = 28 } = opts;
  // Accept a single run or a list: always work on a list.
  const list = Array.isArray(parsedOrList) ? parsedOrList : [parsedOrList];
  if (!list.length) throw new Error("Add at least one recorded run.");
  // 1. Resample every run onto the 10 m grid and note its start and end time (ms).
  const runs = list.map((parsed, k) => {
    const rs = resample(parsed, step);
    if (!rs.time) throw new Error(`${list.length > 1 ? `Run ${k + 1}: ` : ""}the effort file needs timestamps (a recorded activity, not a planned route).`);
    return { parsed, rs, start: rs.time[0], end: rs.time[rs.n - 1] };
  });
  // 2.
  const newest = Math.max(...runs.map((r) => r.start));
  for (const r of runs) r.weight = Math.pow(0.5, (newest - r.start) / DAY / halfLifeDays);

  // 3. One set of accumulators per band: "all" of the run, "first" half, "second" half.
  const acc = BANDS.map(() => ({ all: zero(), first: zero(), second: zero() }));
  const slices = []; // [grade, cadence, weighted seconds] on uphill running slices, for the hiking threshold
  let cadenceWasPerFoot = false;
  // Weighted heart-rate sum, total weight, and highest value seen.
  let hrSum = 0, hrW = 0, hrMax = 0;
  for (const run of runs) {
    const { rs, weight: w } = run;
    const ele = smooth(rs.ele, 3);
    const grade = gradeSeries(ele, step, halfWin); // same window as the speed estimate below
    // Halfway point of the run in time: before it is "fresh", after it is "tired".
    const tMid = run.start + (run.end - run.start) / 2;
    // Cadence is stored per foot by many devices (about 85 instead of 170).
    const cadVals = [];
    if (rs.cad) {
      for (let i = halfWin; i < rs.n - halfWin; i += 5) {
        // Speed over the window: distance (2 x halfWin x step metres) / time (s).
        const v = 2 * halfWin * step / ((rs.time[i + halfWin] - rs.time[i - halfWin]) / 1000);
        if (v > 2.5 && rs.cad[i] > 0) cadVals.push(rs.cad[i]);
      }
    }
    // Sort numerically (the default sort compares as text), then take the middle value.
    cadVals.sort((a, b) => a - b);
    const cadMedian = cadVals.length ? cadVals[Math.floor(cadVals.length / 2)] : null;
    const doubled = cadMedian !== null && cadMedian < 120;
    cadenceWasPerFoot = cadenceWasPerFoot || doubled;
    // 4.
    for (let i = halfWin; i < rs.n - halfWin; i += 5) {
      const dtWin = (rs.time[i + halfWin] - rs.time[i - halfWin]) / 1000;
      if (dtWin <= 0) continue;
      // Speed in m/s over the same window as the gradient.
      const speed = (2 * halfWin * step) / dtWin;
      if (speed < minSpeed) continue; // stopped, or a long pause with the watch running
      const secs = (5 * step) / speed; // time covered by this 5-sample slice
      const bi = bandIndex(grade[i]);
      const half = rs.time[i] < tMid ? "first" : "second";
      const hr = rs.hr && rs.hr[i] ? rs.hr[i] : null;
      const cad = rs.cad && rs.cad[i] ? rs.cad[i] * (doubled ? 2 : 1) : null;
      // Vertical speed in m/s (positive up), for the VAM (vertical metres per hour).
      const vert = (ele[i + halfWin] - ele[i - halfWin]) / dtWin;
      // Add the slice (weighted by its run's weight) to "all" and to its half.
      for (const key of ["all", half]) add(acc[bi][key], 5 * step * w, secs * w, hr, cad, vert);
      // Uphill slices (above 2%) with cadence feed the hiking-threshold search.
      if (cad !== null && grade[i] > 2) slices.push([grade[i], cad, secs * w]);
    }
    if (rs.hr) for (let i = 0; i < rs.n; i++) if (rs.hr[i]) { hrSum += rs.hr[i] * w; hrW += w; hrMax = Math.max(hrMax, rs.hr[i]); }
  }

  // 5. The flat band anchors everything (fallbacks are multiples of flat pace).
  const flatAll = acc[FLAT].all;
  if (flatAll.secs < 120) {
    throw new Error("The effort file has too little flat running to anchor the model (need at least 2 minutes).");
  }
  const flatPace = pace(flatAll);
  // 6.
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

  fromClimbs(bands);

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

  // 7.
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
    // One summary per run. toISOString().slice(0, 10) keeps "YYYY-MM-DD"; weight is shown relative to the heaviest run (which is 1).
    runs: runs.map((r) => ({ name: r.parsed.name || "", date: new Date(r.start).toISOString().slice(0, 10), distKm: r.rs.totalM / 1000, durationSec: (r.end - r.start) / 1000, weight: r.weight / Math.max(...runs.map((x) => x.weight)) })),
    resampled: latest.rs, // climbs of the most recent run are the reference for "closest climb"
  };
}

/** Gradient (%) where you switch from running to hiking, learned from cadence. */
export function hikeThreshold(slices) {
  // Total seconds hiked. [, cad, w] destructures each slice and skips the grade.
  const hikedSecs = slices.reduce((t, [, cad, w]) => t + (cad < HIKE_CAD ? w : 0), 0);
  if (hikedSecs < MIN_SECONDS) return null;
  let best = null;
  let bestErr = Infinity;
  for (let g = 4; g <= 35; g += 0.5) {
    let err = 0;
    // A slice is misclassified when the rule ("hike if grade >= g") and what you actually did (cadence below 145) disagree: !== on two booleans is "differ".
    for (const [grade, cad, w] of slices) if ((grade >= g) !== (cad < HIKE_CAD)) err += w;
    if (err < bestErr) { bestErr = err; best = g; }
  }
  return best;
}

/** Uphill bands without full data, from your own climbing (calculation review, 2026-10-28). */
function fromClimbs(bands) {
  const up = bands.map((b, i) => i).filter((i) => i > FLAT);
  const meas = up.filter((i) => bands[i].source === "measured" && bands[i].vam > 50);
  if (!meas.length) return;
  const steepVam = bands[meas[meas.length - 1]].vam;
  for (const i of up) {
    const b = bands[i];
    if (b.source === "measured") continue;
    // Nearest measured band: smallest distance in rows, the steeper one first on a tie.
    const near = bands[meas.slice().sort((x, y) => Math.abs(x - i) - Math.abs(y - i) || y - x)[0]];
    if (b.source === "estimated" && BAND_CENTRES[i] >= 10) b.fresh = (36000 * BAND_CENTRES[i]) / steepVam;
    b.tired = b.fresh * (near.tired / near.fresh);
    if (b.source === "estimated") b.pace = b.fresh;
    b.source = "from your climbs";
  }
}

/** A fresh, empty accumulator for one band (or one half of one band): m metres covered secs seconds spent hrSum heart rate x seconds, over the seconds that had heart rate (hrSecs) cadSum cadence x seconds... */
function zero() { return { m: 0, secs: 0, hrSum: 0, hrSecs: 0, cadSum: 0, cadSecs: 0, vertSum: 0 }; }
/** Add one slice to accumulator `a` (modified in place): `m` metres, `secs` seconds, heart rate `hr` and cadence `cad` (or null when missing), and vertical speed `vert` (m/s). */
function add(a, m, secs, hr, cad, vert) {
  a.m += m; a.secs += secs; a.vertSum += vert * secs;
  if (hr !== null) { a.hrSum += hr * secs; a.hrSecs += secs; }
  if (cad !== null) { a.cadSum += cad * secs; a.cadSecs += secs; }
}
function pace(a) { return (a.secs / a.m) * 1000; } // seconds per km
