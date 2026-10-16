// model.js: predict the time to run a course from a personal effort profile.
//
// For every 10 m of the course we look up the gradient band, take your pace in
// that band, and slide it from "fresh" to "tired" as the race goes on. Summing
// seconds over the whole course gives a finish time and a clock time at every
// point of the course. Then three adjustments that stand in for what a
// reference run cannot tell us:
//
//   terrain   Technical ground (roots, mud, leaves, crowds) is slower than the
//             park path you trained on. Presets: smooth / mixed / technical.
//   duration  A race longer than your reference run cannot be held at the same
//             effort. We scale pace by (race time / reference time)^k. The
//             exponent k plays the role of the Riegel exponent: bigger k means
//             you fade faster with duration.
//   scenario  Best / central / cautious are +/-3.5% around the central guess.
//
// Honest limits: the model slides from fresh to tired by position along the
// course, not by elapsed time, and it assumes your reference run is
// representative of your current fitness. See docs/HOW_IT_WORKS.md.
//
// Where it sits in the data flow: plan.js calls predictAll() with the analysed
// course (terrain.js analyseCourse) and the effort profile (effort.js
// analyseEffort). The cumulative-time arrays it returns are the backbone of the
// plan: every clock time, gel, checkpoint and replay position is read from them.

import { bandIndex } from "./terrain.js";

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
  { id: "central", label: "Average", mult: 1.0 },
  { id: "cautious", label: "Cautious", mult: 1.035 },
];

// A Set gives a fast "is this id in the list?" test with .has().
const MILD_DESCENTS = new Set(["d1", "d2"]); // -12% to -2%: where gravity can help

/**
 * Default model settings, also merged into the plan defaults (plan.js):
 *   terrain       key of TERRAIN
 *   enduranceExp  the exponent k of the duration adjustment (0.07)
 *   descentBoost  see below
 */
export const MODEL_DEFAULTS = {
  terrain: "mixed",
  enduranceExp: 0.07,
  descentBoost: 0, // 0 to 0.1: fraction faster on mild descents (needs strong quads)
};

/**
 * Cumulative seconds at every sample of the course, for one scenario.
 * Returns {cum: Float64Array (n), finishSec, factor, durationFactor}.
 *
 * Inputs: `course` from analyseCourse (uses n, step, grade), `effort` from
 * analyseEffort (uses bands and durationSec), `scenario` one entry of
 * SCENARIOS, `params` overrides of MODEL_DEFAULTS.
 * cum[i] is the predicted moving time (s) from the start to sample i, so
 * cum[0] = 0 and the last entry is the finish time. `factor` is the total
 * multiplier applied to the pace table (terrain x scenario x duration).
 *
 * Two passes: the duration adjustment depends on the predicted race time,
 * which we only know after a first prediction. So pass 1 predicts without it,
 * then pass 2 predicts again with the duration factor applied.
 */
export function predictScenario(course, effort, scenario, params = {}) {
  // Object spread: start from the defaults, then let `params` override any field.
  const p = { ...MODEL_DEFAULTS, ...params };
  const terrain = TERRAIN[p.terrain] || TERRAIN.mixed;
  const base = terrain.factor * scenario.mult;
  /**
   * One prediction pass with an overall pace multiplier `factor`.
   * Returns the cumulative seconds array.
   */
  const pass = (factor) => {
    // Float64Array: a fixed-length array of numbers, filled with 0.
    const cum = new Float64Array(course.n);
    for (let i = 0; i < course.n - 1; i++) {
      const bi = bandIndex(course.grade[i]);
      const band = effort.bands[bi];
      // How far along the course we are, from 0 (start) to 1 (finish).
      const frac = i / (course.n - 1);
      // Linear slide from fresh pace (s/km) at the start to tired pace at the finish.
      let pace = band.fresh + (band.tired - band.fresh) * frac;
      if (p.descentBoost > 0 && MILD_DESCENTS.has(band.id)) pace *= 1 - p.descentBoost;
      // Seconds for this step: pace is per 1000 m, the step is course.step metres.
      cum[i + 1] = cum[i] + (pace * factor * course.step) / 1000;
    }
    return cum;
  };
  const first = pass(base);
  // How much longer the race is than the reference run, in time.
  const ratio = first[course.n - 1] / effort.durationSec;
  // (ratio)^k, but never below 1: a race shorter than the reference run is not sped up.
  const durationFactor = Math.max(1, Math.pow(ratio, p.enduranceExp));
  const cum = pass(base * durationFactor);
  return { cum, finishSec: cum[course.n - 1], factor: base * durationFactor, durationFactor };
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
