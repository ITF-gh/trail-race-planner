// model.js: predict the time to run a course from a personal effort profile.

import { bandIndex } from "./terrain.js";

// The gradient (%) each band stands for: its middle, and for the two open-ended bands a value 6 points past their edge.
export const BAND_CENTRES = [-26, -16, -9, -4, 0, 4, 8, 12.5, 18.5, 26];

/** Pace (s/km) on a gradient, at `frac` of the course (0 = start, fresh; 1 = finish, tired). */
export function paceAt(bands, grade, frac) {
  const at = (b) => b.fresh + (b.tired - b.fresh) * frac;
  if (!(grade > BAND_CENTRES[0])) return at(bands[0]); // also catches NaN
  for (let i = 1; i < BAND_CENTRES.length; i++) {
    if (grade <= BAND_CENTRES[i]) {
      const t = (grade - BAND_CENTRES[i - 1]) / (BAND_CENTRES[i] - BAND_CENTRES[i - 1]);
      return at(bands[i - 1]) + (at(bands[i]) - at(bands[i - 1])) * t;
    }
  }
  return at(bands[bands.length - 1]);
}

/** Terrain presets. */
export const TERRAIN = {
  smooth: { label: "Smooth trails and paths", factor: 1.03 },
  mixed: { label: "Mixed trail (default)", factor: 1.06 },
  technical: { label: "Technical, rooty or muddy", factor: 1.09 },
};

/** The three scenarios. */
export const SCENARIOS = [
  { id: "best", label: "Best", mult: 0.965 },
  { id: "central", label: "Balanced", mult: 1.0 },
  { id: "cautious", label: "Cautious", mult: 1.035 },
];

// A Set gives a fast "is this id in the list?" test with .has().
const MILD_DESCENTS = new Set(["d1", "d2"]); // -12% to -2%: where gravity can help

/** Default model settings, also merged into the plan defaults (plan.js): terrain key of TERRAIN enduranceExp the exponent k of the race-length fade (0.05, was 0.07 before the tired gap also grew with race length... */
export const MODEL_DEFAULTS = {
  terrain: "mixed",
  enduranceExp: 0.05,
  descentBoost: 0, // 0 to 0.1: fraction faster on mild descents (needs strong quads)
  gapExp: 0.5,
  nightSlow: 0.08,
  form: 0,
};

// Limits that keep the two race-length rules sane on odd inputs (a 5 min test run, a 100-mile race).
const GAP_SCALE = [0.3, 3];
const FADE_MIN = 0.85; // a race shorter than your reference can be at most 15% faster per km

/** Cumulative seconds at every sample of the course, for one scenario. */
export function predictScenario(course, effort, scenario, params = {}) {
  // Object spread: start from the defaults, then let `params` override any field.
  const p = { ...MODEL_DEFAULTS, ...params };
  const terrain = TERRAIN[p.terrain] || TERRAIN.mixed;
  const base = terrain.factor * scenario.mult * (1 - (Number(p.form) || 0) / 100);
  const n = course.n;
  const stops = p.stops || [];
  const night = p.night && Number.isFinite(p.night.dawn) && Number.isFinite(p.night.dusk) ? p.night : null;
  /** True when a clock time (s, may pass midnight) falls between dusk and dawn. */
  const dark = (clock) => {
    const t = ((clock % 86400) + 86400) % 86400;
    return night.dusk > night.dawn ? t >= night.dusk || t < night.dawn : t >= night.dusk && t < night.dawn;
  };
  /** One prediction pass with pace table `bands` and overall multiplier `factor`. */
  const pass = (bands, factor, prev) => {
    // Float64Array: a fixed-length array of numbers, filled with 0.
    const cum = new Float64Array(n);
    const total = prev ? prev[n - 1] : 0;
    let darkM = 0, stopped = 0, k = 0;
    for (let i = 0; i < n - 1; i++) {
      const band = bands[bandIndex(course.grade[i])];
      // How tired: 0 at the start, 1 at the finish, by time when we have a clock, else by distance.
      const frac = prev && total > 0 ? prev[i] / total : i / (n - 1);
      // Pace for this gradient (blended between band centres), sliding from fresh to tired.
      let pace = paceAt(bands, course.grade[i], frac);
      if (p.descentBoost > 0 && MILD_DESCENTS.has(band.id)) pace *= 1 - p.descentBoost;
      if (night && prev) {
        while (k < stops.length && stops[k].idx <= i) stopped += stops[k++].sec;
        if (dark(night.startSec + prev[i] + stopped)) { pace *= 1 + p.nightSlow; darkM += course.step; }
      }
      // Seconds for this step: pace is per 1000 m, the step is course.step metres.
      cum[i + 1] = cum[i] + (pace * factor * course.step) / 1000;
    }
    return { cum, darkM };
  };
  const first = pass(effort.bands, base, null).cum;
  // How much longer (or shorter) the race is than the reference run, in time.
  const ratio = first[n - 1] / effort.durationSec;
  // (ratio)^k.
  const fade = Math.pow(ratio, p.enduranceExp);
  const durationFactor = p.fadeBoth ? Math.max(FADE_MIN, fade) : Math.max(1, fade);
  // The tired gap grows (or shrinks) with the race-to-run ratio.
  const gapScale = Math.min(GAP_SCALE[1], Math.max(GAP_SCALE[0], Math.pow(ratio, p.gapExp)));
  const bands = effort.bands.map((b) => ({ ...b, tired: b.fresh + (b.tired - b.fresh) * gapScale }));
  const factor = base * durationFactor;
  let r = pass(bands, factor, null);
  for (let it = 0; it < 3; it++) r = pass(bands, factor, r.cum);
  return { cum: r.cum, finishSec: r.cum[n - 1], factor, durationFactor, gapScale, darkM: r.darkM };
}

/** Run predictScenario for each of the three scenarios. */
export function predictAll(course, effort, params = {}) {
  const out = {};
  for (const s of SCENARIOS) out[s.id] = predictScenario(course, effort, s, params);
  return out;
}
