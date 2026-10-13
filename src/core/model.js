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

import { bandIndex } from "./terrain.js";

export const TERRAIN = {
  smooth: { label: "Smooth trails and paths", factor: 1.03 },
  mixed: { label: "Mixed trail (default)", factor: 1.06 },
  technical: { label: "Technical, rooty or muddy", factor: 1.09 },
};

export const SCENARIOS = [
  { id: "best", label: "Best", mult: 0.965 },
  { id: "central", label: "Central", mult: 1.0 },
  { id: "cautious", label: "Cautious", mult: 1.035 },
];

const MILD_DESCENTS = new Set(["d1", "d2"]); // -12% to -2%: where gravity can help

export const MODEL_DEFAULTS = {
  terrain: "mixed",
  enduranceExp: 0.07,
  descentBoost: 0, // 0 to 0.1: fraction faster on mild descents (needs strong quads)
};

/**
 * Cumulative seconds at every sample of the course, for one scenario.
 * Returns {cum: Float64Array (n), finishSec, factor, durationFactor}.
 */
export function predictScenario(course, effort, scenario, params = {}) {
  const p = { ...MODEL_DEFAULTS, ...params };
  const terrain = TERRAIN[p.terrain] || TERRAIN.mixed;
  const base = terrain.factor * scenario.mult;
  const pass = (factor) => {
    const cum = new Float64Array(course.n);
    for (let i = 0; i < course.n - 1; i++) {
      const bi = bandIndex(course.grade[i]);
      const band = effort.bands[bi];
      const frac = i / (course.n - 1);
      let pace = band.fresh + (band.tired - band.fresh) * frac;
      if (p.descentBoost > 0 && MILD_DESCENTS.has(band.id)) pace *= 1 - p.descentBoost;
      cum[i + 1] = cum[i] + (pace * factor * course.step) / 1000;
    }
    return cum;
  };
  const first = pass(base);
  const ratio = first[course.n - 1] / effort.durationSec;
  const durationFactor = Math.max(1, Math.pow(ratio, p.enduranceExp));
  const cum = pass(base * durationFactor);
  return { cum, finishSec: cum[course.n - 1], factor: base * durationFactor, durationFactor };
}

export function predictAll(course, effort, params = {}) {
  const out = {};
  for (const s of SCENARIOS) out[s.id] = predictScenario(course, effort, s, params);
  return out;
}
