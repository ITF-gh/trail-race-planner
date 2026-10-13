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

import { smooth } from "./track.js";

/** Gradient bands used everywhere (course, effort profile, pace model). */
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
 */
export const GRADE_HALF_WINDOW = 4;

/** Gradient in % at every sample, from smoothed elevation over +/- halfWin samples. */
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

/** Zigzag filter: indices of the turning points (local tops and bottoms). */
export function zigzag(S, threshold) {
  const ext = [0];
  let dir = 0; // 0 undecided, 1 going up, -1 going down
  let maxI = 0;
  let minI = 0;
  for (let i = 1; i < S.length; i++) {
    if (S[i] > S[maxI]) maxI = i;
    if (S[i] < S[minI]) minI = i;
    if (dir === 0) {
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
      if (S[maxI] - S[i] >= threshold) {
        ext.push(maxI);
        dir = -1;
        minI = i;
      }
    } else if (S[i] - S[minI] >= threshold) {
      ext.push(minI);
      dir = 1;
      maxI = i;
    }
  }
  ext.push(dir === 1 ? maxI : dir === -1 ? minI : S.length - 1);
  return ext;
}

/**
 * Steepest gradient (%) over any 100 m between samples a and b: the highest for
 * a climb (`up` true), the lowest (most negative) for a descent.
 */
export function steepest100(ele, a, b, step, up = true) {
  const hundred = Math.max(1, Math.round(100 / step));
  let steep = up ? -Infinity : Infinity;
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
 */
export function analyseCourse(rs, opts = {}) {
  const { eleWin = 3, gradeWin = GRADE_HALF_WINDOW, hysteresis = 8, minDelta = 10 } = opts;
  const ele = smooth(rs.ele, eleWin);
  const grade = gradeSeries(ele, rs.step, gradeWin);
  const ext = zigzag(ele, hysteresis);
  const climbs = [];
  const descents = [];
  let gain = 0;
  let loss = 0;
  for (let i = 1; i < ele.length; i++) {
    const d = ele[i] - ele[i - 1];
    if (d > 0) gain += d;
    else loss -= d;
  }
  // Turning points sit at the very first metre of a flat valley or plateau, so a climb would start
  // with the flat run-in before it. Trim both ends until the next (or last) 100 m tilt by 0.5% or more.
  const W = Math.max(1, Math.round(100 / rs.step));
  const tilt = (i, j, sign) => (sign * (ele[j] - ele[i])) / ((j - i) * rs.step) >= 0.005;
  for (let k = 0; k + 1 < ext.length; k++) {
    let a = ext[k];
    let b = ext[k + 1];
    const sign = Math.sign(ele[b] - ele[a]);
    while (b - a > W && !tilt(a, a + W, sign)) a++;
    while (b - a > W && !tilt(b - W, b, sign)) b--;
    const delta = ele[b] - ele[a];
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
