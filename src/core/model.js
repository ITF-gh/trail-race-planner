// model.js: predict the time to run a course from a personal effort profile.
//
// For every 10 m of the course we take your pace on that gradient (blended
// between the two nearest gradient bands, see paceAt), and slide it from "fresh" to "tired" as the race goes on. Summing
// seconds over the whole course gives a finish time and a clock time at every
// point of the course. Then a few adjustments that stand in for what a
// reference run cannot tell us:
//
//   terrain   Technical ground (roots, mud, leaves, crowds) is slower than the
//             park path you trained on. Presets: smooth / mixed / technical.
//   duration  A race longer than your reference run cannot be held at the same
//             effort. We scale pace by (race time / reference time)^k (k = 0.05). The
//             exponent k plays the role of the Riegel exponent: bigger k means
//             you fade faster with duration. The tired gap also grows with that
//             ratio, and shrinks on a race shorter than your runs.
//   night     With a race date, steps run between civil dusk and dawn are 8% slower.
//   scenario  Best / central / cautious are +/-3.5% around the central guess.
//
// Fatigue slides from fresh to tired by the share of race TIME gone (a slow climb
// tires you more than a fast flat). Honest limit: it assumes your reference run is
// representative of your current fitness. See docs/HOW_IT_WORKS.md.
//
// Where it sits in the data flow: plan.js calls predictAll() with the analysed
// course (terrain.js analyseCourse) and the effort profile (effort.js
// analyseEffort). The cumulative-time arrays it returns are the backbone of the
// plan: every clock time, gel, checkpoint and replay position is read from them.

import { bandIndex } from "./terrain.js";

// The gradient (%) each band stands for: its middle, and for the two open-ended bands a value
// 6 points past their edge. Paces are interpolated in a straight line between these points.
export const BAND_CENTRES = [-26, -16, -9, -4, 0, 4, 8, 12.5, 18.5, 26];

/**
 * Pace (s/km) on a gradient, at `frac` of the course (0 = start, fresh; 1 = finish, tired).
 * Each band's fresh and tired pace holds at the band's centre; between two centres the pace is
 * blended in a straight line (linear interpolation), and beyond the outer centres it stays flat.
 * Why: a plain band lookup makes the pace jump each time the ground crosses a band edge (from
 * 5:57 to 6:11 at exactly +6%), so the pace line saw-tooths along any climb hovering around an
 * edge. Interpolated, the pace changes smoothly with the gradient.
 */
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

/**
 * Terrain presets. `factor` multiplies every pace: 1.06 means 6% slower than
 * on the ground of your reference run. `label` is shown in the settings.
 */
export const TERRAIN = {
  smooth: { label: "Smooth trails and paths", factor: 1.03 },
  mixed: { label: "Mixed trail (default)", factor: 1.06 },
  technical: { label: "Technical, rooty or muddy", factor: 1.09 },
};

/**
 * The three scenarios. `mult` multiplies every pace: 0.965 is 3.5% faster
 * than the central guess, 1.035 is 3.5% slower. `id` is the key used in every
 * per-scenario object of the plan ({best, central, cautious}).
 */
export const SCENARIOS = [
  { id: "best", label: "Best", mult: 0.965 },
  { id: "central", label: "Balanced", mult: 1.0 },
  { id: "cautious", label: "Cautious", mult: 1.035 },
];

// A Set gives a fast "is this id in the list?" test with .has().
const MILD_DESCENTS = new Set(["d1", "d2"]); // -12% to -2%: where gravity can help

/**
 * Default model settings, also merged into the plan defaults (plan.js):
 *   terrain       key of TERRAIN
 *   enduranceExp  the exponent k of the race-length fade (0.05, was 0.07 before the tired gap
 *                 also grew with race length: both cover the same fatigue)
 *   descentBoost  see below
 *   gapExp        the tired gap (tired pace minus fresh pace) is multiplied by
 *                 (race time / reference time)^gapExp, both ways: a race shorter than your runs
 *                 gets a smaller gap, a longer one a bigger gap
 *   nightSlow     share slower in the dark (0.08 = 8%), used only when the plan gives `night`
 *   form          how you feel on race day, % faster on every step: 0 normal, 3 in shape, 5 top
 *                 shape (Boss, 2026-10-29: plans come from your runs only, this is your say)
 * (Calculation review, 2026-10-28: Boss picked fatigue by elapsed time, the growing tired gap,
 * steep bands from your climbing speed (effort.js) and the night slowdown.)
 */
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

/**
 * Cumulative seconds at every sample of the course, for one scenario.
 * Returns {cum: Float64Array (n), finishSec, factor, durationFactor, gapScale, darkM}.
 *
 * Inputs: `course` from analyseCourse (uses n, step, grade), `effort` from
 * analyseEffort (uses bands and durationSec), `scenario` one entry of
 * SCENARIOS, `params` overrides of MODEL_DEFAULTS, plus (all optional):
 *   fadeBoth  true when your level comes from a race reference (refs.js calibParams): then a race
 *             shorter than the reference is run faster (Riegel works both ways); else never faster
 *   night     {startSec, dawn, dusk} in seconds of the day (plan.js): steps run in the dark are
 *             `nightSlow` slower
 *   stops     [{idx, sec}] aid-station stops, so the night clock includes them
 * cum[i] is the predicted moving time (s) from the start to sample i, so
 * cum[0] = 0 and the last entry is the finish time. `factor` is the overall
 * multiplier (terrain x scenario x race-length fade); darkM is the metres run in the dark.
 *
 * Several passes: the race-length rules need the race time, and "how tired" and "is it dark"
 * need the clock at each step, which we only know after a prediction. Pass 1 predicts as a first
 * guess (fatigue by distance, no extras); it sets the fade and the tired gap. Then the race is
 * predicted again three times, each pass reading fatigue (share of the race TIME gone) and the
 * clock from the pass before; three passes are enough for the clock to settle to the second.
 */
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
  /**
   * One prediction pass with pace table `bands` and overall multiplier `factor`. With `prev`
   * (the cumulative times of the pass before), fatigue follows the share of race time and the
   * night slowdown reads the clock; without it, fatigue follows the share of distance.
   * Returns {cum, darkM}.
   */
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
  // (ratio)^k. Without a race reference, never below 1: your runs are training efforts, so a
  // race shorter than them is not sped up. With one (fadeBoth), a shorter race is run faster.
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

/**
 * Run predictScenario for each of the three scenarios.
 * Returns {best, central, cautious}, each the result of predictScenario.
 */
export function predictAll(course, effort, params = {}) {
  const out = {};
  for (const s of SCENARIOS) out[s.id] = predictScenario(course, effort, s, params);
  return out;
}
