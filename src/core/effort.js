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

/** Analyse a reference effort (a parsed GPX with times). */
export function analyseEffort(parsed, opts = {}) {
  // halfWin is used both for gradient and for speed, and matches the race course window.
  const { step = 10, halfWin = GRADE_HALF_WINDOW, minSpeed = 0.6 } = opts;
  const rs = resample(parsed, step);
  if (!rs.time) throw new Error("The effort file needs timestamps (a recorded activity, not a planned route).");
  const ele = smooth(rs.ele, 3);
  const grade = gradeSeries(ele, step, halfWin); // same window as the speed estimate below
  const t0 = rs.time[0];
  const tEnd = rs.time[rs.n - 1];
  const tMid = t0 + (tEnd - t0) / 2;

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
  const cadDoubled = cadMedian !== null && cadMedian < 120;

  const acc = BANDS.map(() => ({
    all: zero(), first: zero(), second: zero(),
  }));
  for (let i = halfWin; i < rs.n - halfWin; i += 5) {
    const dtWin = (rs.time[i + halfWin] - rs.time[i - halfWin]) / 1000;
    if (dtWin <= 0) continue;
    const speed = (2 * halfWin * step) / dtWin;
    if (speed < minSpeed) continue; // stopped, or a long pause with the watch running
    const secs = (5 * step) / speed; // time covered by this 5-sample slice
    const bi = bandIndex(grade[i]);
    const half = rs.time[i] < tMid ? "first" : "second";
    const hr = rs.hr && rs.hr[i] ? rs.hr[i] : null;
    const cad = rs.cad && rs.cad[i] ? rs.cad[i] * (cadDoubled ? 2 : 1) : null;
    for (const key of ["all", half]) add(acc[bi][key], 5 * step, secs, hr, cad, (ele[i + halfWin] - ele[i - halfWin]) / dtWin);
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

  // Hiking threshold: the first uphill band where your cadence falls under 145 spm.
  let hikeGrade = null;
  if (cadMedian !== null) {
    for (let i = FLAT + 1; i < BANDS.length; i++) {
      if (bands[i].cad !== null && bands[i].secs >= MIN_SECONDS && bands[i].cad < 145) { hikeGrade = BANDS[i].lo; break; }
    }
  }

  let hrSum = 0, hrN = 0, hrMax = 0;
  if (rs.hr) for (let i = 0; i < rs.n; i++) if (rs.hr[i]) { hrSum += rs.hr[i]; hrN++; hrMax = Math.max(hrMax, rs.hr[i]); }

  return {
    durationSec: (tEnd - t0) / 1000,
    distKm: rs.totalM / 1000,
    flatPace,
    flatHr: flatAll.hrSecs > 0 ? flatAll.hrSum / flatAll.hrSecs : null,
    flatCad: flatAll.cadSecs > 0 ? flatAll.cadSum / flatAll.cadSecs : null,
    avgHr: hrN ? hrSum / hrN : null,
    maxHrSeen: hrN ? hrMax : null,
    cadenceWasPerFoot: cadDoubled,
    bands,
    drift,
    hikeGrade,
    resampled: rs,
  };
}

function zero() { return { m: 0, secs: 0, hrSum: 0, hrSecs: 0, cadSum: 0, cadSecs: 0, vertSum: 0 }; }
function add(a, m, secs, hr, cad, vert) {
  a.m += m; a.secs += secs; a.vertSum += vert * secs;
  if (hr !== null) { a.hrSum += hr * secs; a.hrSecs += secs; }
  if (cad !== null) { a.cadSum += cad * secs; a.cadSecs += secs; }
}
function pace(a) { return (a.secs / a.m) * 1000; } // seconds per km
