// terrain.js: from a resampled track, find gradients, climbs and descents.
//
// Three ideas worth knowing:
//  1. GPS elevation is noisy (a flat road can wobble by 2-3 m), so we smooth it
//     before computing anything. Too little smoothing invents climbs, too much
//     erases real ones. A +/-30 m moving average is a good compromise.
//  2. Gradient (%) = rise / run * 100, measured over a short window (+/-40 m) so
//     it does not flip sign on every small bump.
//  3. A "climb" is found with a zigzag filter: a climb ends only when the track
//     drops by more than a threshold (8 m) from its highest point. That keeps a
//     small dip in the middle of a long climb from splitting it in two.
//
// Where it sits in the data flow: plan.js passes the resampled race course
// (from track.js) to analyseCourse(); effort.js uses gradeSeries() and the
// BANDS table on your own run. The same BANDS table is the row structure of
// the pace model (model.js), so "band 6" means the same thing everywhere.
//
// Main exports:
//   BANDS, bandIndex(grade)   the 10 gradient bands and a lookup
//   GRADE_HALF_WINDOW         the shared gradient window (see its comment)
//   gradeSeries(...)          gradient in % at every sample
//   zigzag(...)               turning points of the elevation curve
//   steepest100(...)          steepest 100 m inside a stretch
//   analyseCourse(rs)         all of the above in one call, plus total D+ / D-

import { smooth } from "./track.js";

/**
 * Gradient bands used everywhere (course, effort profile, pace model).
 *
 * Each band covers gradients from `lo` (included) to `hi` (excluded), in %.
 * `id` is a short code: "d" for down, "f" for flat, "u" for up, the digit
 * grows with steepness. `label` is what the tables show. The bands are
 * ordered from steepest descent to steepest climb, so an index into this array also works for arrays built
 * from it (the effort bands, FALLBACK_MULT in effort.js...).
 */
export const BANDS = [
  { id: "d4", lo: -Infinity, hi: -20, label: "Steeper than -20%" },
  { id: "d3", lo: -20, hi: -12, label: "-20 to -12%" },
  { id: "d2", lo: -12, hi: -6, label: "-12 to -6%" },
  { id: "d1", lo: -6, hi: -2, label: "-6 to -2%" },
  { id: "f0", lo: -2, hi: 2, label: "Flat (-2 to +2%)" },
  { id: "u1", lo: 2, hi: 6, label: "+2 to +6%" },
  { id: "u2", lo: 6, hi: 10, label: "+6 to +10%" },
  { id: "u3", lo: 10, hi: 15, label: "+10 to +15%" },
  { id: "u4", lo: 15, hi: 22, label: "+15 to +22%" },
  { id: "u5", lo: 22, hi: Infinity, label: "Steeper than +22%" },
];

/**
 * Which band a gradient (%) falls in: returns its index in BANDS (0 to 9).
 * A simple linear scan is fine with only 10 bands. The final return is a
 * safety net for values no band accepts (NaN, for example): they count as
 * the steepest climb band.
 */
export function bandIndex(grade) {
  for (let i = 0; i < BANDS.length; i++) if (grade >= BANDS[i].lo && grade < BANDS[i].hi) return i;
  return BANDS.length - 1;
}

/**
 * Half-window (in 10 m samples) used to measure gradient, on the race course
 * AND on your effort file. They MUST match. If you measure steepness over 20 m
 * on your run (where short steep pitches look brutal and slow) but over 80 m on
 * the race (where the same pitches are averaged out), the pace table will not
 * fit the course and the prediction comes out too optimistic. Measured on the
 * real data: windows of +/-20 m versus +/-50 m moved the central finish time by
 * 14 minutes. Same window on both sides removes that bias.
 * 4 samples x 10 m = +/-40 m, so each gradient is measured over 80 m of ground.
 */
export const GRADE_HALF_WINDOW = 4;

/**
 * Gradient in % at every sample, from smoothed elevation over +/- halfWin samples.
 *
 * Inputs: `eleSmooth` elevations in metres (already smoothed), `step` the
 * distance between samples in metres, `halfWin` in samples.
 * For sample i: (elevation at i + halfWin - elevation at i - halfWin) divided
 * by the ground distance between them, x 100. Near the ends the window is cut
 * short. Returns an array of percentages, same length as the input.
 */
export function gradeSeries(eleSmooth, step, halfWin = 4) {
  const n = eleSmooth.length;
  const g = new Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - halfWin);
    const b = Math.min(n - 1, i + halfWin);
    g[i] = b > a ? ((eleSmooth[b] - eleSmooth[a]) / ((b - a) * step)) * 100 : 0;
  }
  return g;
}

/**
 * Zigzag filter: indices of the turning points (local tops and bottoms).
 *
 * Inputs: `S` an elevation series (metres), `threshold` in metres (8 in the app).
 * The filter walks the series while remembering the highest (maxI) and lowest
 * (minI) point seen so far in the current leg. A top is confirmed only once
 * the track has dropped `threshold` metres below it, and a bottom only once it
 * has risen `threshold` metres above it. Smaller wiggles never confirm a
 * turning point, so they are absorbed into the surrounding climb or descent.
 * Returns an array of sample indices, starting with 0; each pair of
 * neighbours delimits one climb or one descent.
 */
export function zigzag(S, threshold) {
  const ext = [0];
  let dir = 0; // 0 undecided, 1 going up, -1 going down
  let maxI = 0;
  let minI = 0;
  for (let i = 1; i < S.length; i++) {
    // Keep track of the extremes of the current leg.
    if (S[i] > S[maxI]) maxI = i;
    if (S[i] < S[minI]) minI = i;
    if (dir === 0) {
      // At the start we do not know yet whether the course goes up or down:
      // wait until it has moved `threshold` metres one way or the other.
      if (S[i] - S[minI] >= threshold) {
        if (minI !== 0) ext.push(minI);
        dir = 1;
        maxI = i;
      } else if (S[maxI] - S[i] >= threshold) {
        if (maxI !== 0) ext.push(maxI);
        dir = -1;
        minI = i;
      }
    } else if (dir === 1) {
      // Going up: the top is confirmed when we are `threshold` below it.
      if (S[maxI] - S[i] >= threshold) {
        ext.push(maxI);
        dir = -1;
        minI = i;
      }
    } else if (S[i] - S[minI] >= threshold) {
      // Going down: the bottom is confirmed when we are `threshold` above it.
      ext.push(minI);
      dir = 1;
      maxI = i;
    }
  }
  // Close the last leg at its extreme (or at the end of a course too flat to
  // ever pass the threshold).
  ext.push(dir === 1 ? maxI : dir === -1 ? minI : S.length - 1);
  return ext;
}

/**
 * Steepest gradient (%) over any 100 m between samples a and b: the highest for
 * a climb (`up` true), the lowest (most negative) for a descent.
 *
 * Inputs: `ele` elevations (m), `a` and `b` sample indices, `step` in metres.
 * It slides a 100 m window from a towards b and keeps the extreme gradient.
 * When the stretch is shorter than 100 m the window is cut at b, so a short
 * stretch still gets a value.
 */
export function steepest100(ele, a, b, step, up = true) {
  // Number of samples in 100 m (10 on the 10 m grid), at least 1.
  const hundred = Math.max(1, Math.round(100 / step));
  let steep = up ? -Infinity : Infinity;
  // Last window start; at least one window (from a) is always measured.
  const last = Math.max(a + 1, b - hundred);
  for (let i = a; i < last; i++) {
    const j = Math.min(b, i + hundred);
    const pct = ((ele[j] - ele[i]) / ((j - i) * step)) * 100;
    steep = up ? Math.max(steep, pct) : Math.min(steep, pct);
  }
  return steep;
}

/**
 * Analyse a resampled course.
 * Returns smoothed elevation, gradient per sample, climbs and descents.
 * Each segment: {kind, a, b (sample indices), startKm, lenM, delta (m, +gain / -loss),
 *                avg (%), steep (% over the steepest 100 m)}
 *
 * Input: `rs` from resample() in track.js. Options (all have defaults):
 *   eleWin      elevation smoothing half-window, samples (3 = +/-30 m)
 *   gradeWin    gradient half-window, samples (GRADE_HALF_WINDOW)
 *   hysteresis  zigzag threshold in metres (8)
 *   minDelta    a climb or descent smaller than this many metres is ignored (10)
 * Full return shape: {step, n, totalKm, ele, grade, climbs, descents,
 * gain (total D+, m), loss (total D-, m, positive)}.
 */
export function analyseCourse(rs, opts = {}) {
  // Destructuring with defaults: take these fields from `opts`, or use the
  // value after "=" when the caller did not give one.
  const { eleWin = 3, gradeWin = GRADE_HALF_WINDOW, hysteresis = 8, minDelta = 10 } = opts;
  // 1. Smooth the elevation, then measure gradient and find the turning points.
  const ele = smooth(rs.ele, eleWin);
  const grade = gradeSeries(ele, rs.step, gradeWin);
  const ext = zigzag(ele, hysteresis);
  const climbs = [];
  const descents = [];
  // 2. Total elevation gain and loss (D+ / D-) on the smoothed profile:
  //    add up every rise, and every drop, from one 10 m sample to the next.
  let gain = 0;
  let loss = 0;
  for (let i = 1; i < ele.length; i++) {
    const d = ele[i] - ele[i - 1];
    if (d > 0) gain += d;
    else loss -= d;
  }
  // 3. Turn each pair of neighbouring turning points into a climb or descent.
  // Turning points sit at the very first metre of a flat valley or plateau, so a climb would start
  // with the flat run-in before it. Trim both ends until the next (or last) 100 m tilt by 0.5% or more.
  // W = samples in 100 m. tilt(i, j, sign) is true when the ground from i to j
  // rises (sign +1) or drops (sign -1) by at least 0.5% (0.005 as a fraction).
  const W = Math.max(1, Math.round(100 / rs.step));
  const tilt = (i, j, sign) => (sign * (ele[j] - ele[i])) / ((j - i) * rs.step) >= 0.005;
  for (let k = 0; k + 1 < ext.length; k++) {
    let a = ext[k];
    let b = ext[k + 1];
    // +1 for a climb, -1 for a descent.
    const sign = Math.sign(ele[b] - ele[a]);
    while (b - a > W && !tilt(a, a + W, sign)) a++;
    while (b - a > W && !tilt(b - W, b, sign)) b--;
    const delta = ele[b] - ele[a];
    // Skip tiny bumps: under minDelta metres of gain or loss.
    if (Math.abs(delta) < minDelta) continue;
    const lenM = (b - a) * rs.step;
    const steep = steepest100(ele, a, b, rs.step, delta > 0);
    const seg = {
      kind: delta > 0 ? "climb" : "descent",
      a,
      b,
      startKm: (a * rs.step) / 1000,
      lenM,
      delta,
      avg: (delta / lenM) * 100,
      steep,
    };
    // Push onto whichever list fits: the ternary picks the array itself.
    (delta > 0 ? climbs : descents).push(seg);
  }
  return {
    step: rs.step,
    n: rs.n,
    totalKm: ((rs.n - 1) * rs.step) / 1000,
    ele,
    grade,
    climbs,
    descents,
    gain,
    loss,
  };
}
