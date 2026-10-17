// refs.js: your personal references (10K best, half-marathon best, easy pace) and what they mean
// for the engine. They set the LEVEL of the plan: the flat pace every other pace is built from
// (design review of Prep my run, item 2: "user personal references are key to calibrate").
//
// The science, in three steps:
//   1. VDOT (Jack Daniels, "Daniels' Running Formula"). A race time gives a fitness score: the
//      oxygen cost of the race speed (ml/kg/min), divided by the share of VO2max a runner can
//      hold for that long. Two formulas from Daniels and Gilbert (1979):
//        cost(v)  = -4.60 + 0.182258 v + 0.000104 v^2        (v in metres per minute)
//        share(t) = 0.8 + 0.1894393 e^(-0.012778 t) + 0.2989558 e^(-0.1932605 t)   (t in minutes)
//        VDOT     = cost(race speed) / share(race time)
//   2. Training paces from VDOT: the speed whose oxygen cost is a given share of VDOT. Easy pace
//      (talking in full sentences) is 59 to 74% of VO2max; we use the middle of 65 to 74%, 70%.
//      Marathon pace comes from the time T where a marathon gives the same VDOT; steady (Daniels'
//      "moderate" running) sits halfway between easy and marathon pace.
//   3. Your own fatigue. With a 10K and a half, Riegel's exponent k = ln(T2/T1) / ln(D2/D1)
//      says how much you slow down when the race gets longer (1.06 is the textbook value). The
//      engine slows a plan by (time / reference time)^e; matching the two gives e = (k - 1) / k.
//
// Where it sits: ui/refs.js reads the boxes, plan.js (buildPlan, params.calib) and preprun.js
// (prepRunPlan, opts.calib) use refsCalib's answer. Pure maths: no page, no storage.

import { BANDS } from "./terrain.js";
import { FALLBACK_MULT, FALLBACK_TIRED } from "./effort.js";

// Ranges a typed reference must fall in to be used (seconds): a 10K between 25 min and 2 h,
// a half between 55 min and 4 h, an easy pace between 3:00 and 12:00 per km.
export const REF_LIMITS = { k10: [1500, 7200], half: [3300, 14400], easy: [180, 720] };
export const REF_LEVELS = ["easy", "steady", "race"];
const HALF_M = 21097.5, MARATHON_M = 42195;
// The share of VDOT used for easy pace (see step 2), and the time an easy or steady run is
// planned for before the engine starts to add fatigue (2 h 30).
const EASY_SHARE = 0.7, EASY_HOLD_SEC = 9000;

/** Oxygen cost (ml/kg/min) of running at v metres per minute. */
const cost = (v) => -4.6 + 0.182258 * v + 0.000104 * v * v;
/** Share of VO2max that can be held for t minutes. */
const share = (t) => 0.8 + 0.1894393 * Math.exp(-0.012778 * t) + 0.2989558 * Math.exp(-0.1932605 * t);
/** Speed (m/min) whose oxygen cost is `vo2`: the positive root of the quadratic cost(v) = vo2. */
const speedFor = (vo2) => (-0.182258 + Math.sqrt(0.182258 ** 2 + 4 * 0.000104 * (4.6 + vo2))) / (2 * 0.000104);

/** VDOT from a race of `m` metres run in `sec` seconds. */
export function vdot(m, sec) {
  const t = sec / 60;
  return cost(m / t) / share(t);
}

/**
 * Race time (s) over `m` metres for a runner of fitness `v` (VDOT): the time T where vdot(m, T)
 * equals v. vdot falls as T grows, so a bisection (halve the interval until it is tiny) finds it.
 */
export function raceTime(m, v) {
  let lo = 60, hi = 86400;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (vdot(m, mid) > v) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Easy pace (s/km) for fitness `v`, at `pct` of VDOT (0.70 by default). */
export const easyPaceOf = (v, pct = EASY_SHARE) => 60000 / speedFor(v * pct);

/**
 * Clean typed references: {k10, half, easy} in seconds (easy in s/km); out of range or missing
 * gives null. Returns the cleaned object.
 */
export function refsClean(r = {}) {
  const out = {};
  for (const k of Object.keys(REF_LIMITS)) {
    const v = Number(r[k]);
    const [lo, hi] = REF_LIMITS[k];
    out[k] = Number.isFinite(v) && v >= lo && v <= hi ? Math.round(v) : null;
  }
  return out;
}

/** True when at least one reference is set. */
export const refsAny = (r) => Boolean(r && (r.k10 || r.half || r.easy));

/**
 * What the references say: {vdot, easyPace, tenKPace, halfPace, marathonPace (s/km),
 * riegel (your exponent k, or null), easyRange [fast, slow]}. null when no reference is set.
 * Fitness comes from the races (their mean when both are there), else from the easy pace
 * read backwards (cost of the easy speed / 0.70).
 */
export function refsRead(raw) {
  const r = refsClean(raw);
  const races = [];
  if (r.k10) races.push(vdot(10000, r.k10));
  if (r.half) races.push(vdot(HALF_M, r.half));
  let v;
  if (races.length) v = races.reduce((a, b) => a + b, 0) / races.length;
  else if (r.easy) v = cost(60000 / r.easy) / EASY_SHARE;
  else return null;
  const k10 = r.k10 || raceTime(10000, v);
  const half = r.half || raceTime(HALF_M, v);
  return {
    refs: r,
    vdot: v,
    easyPace: r.easy || easyPaceOf(v),
    easyRange: [easyPaceOf(v, 0.74), easyPaceOf(v, 0.65)],
    tenKPace: k10 / 10,
    halfPace: half / (HALF_M / 1000),
    marathonPace: raceTime(MARATHON_M, v) / (MARATHON_M / 1000),
    riegel: r.k10 && r.half ? Math.log(r.half / r.k10) / Math.log(HALF_M / 10000) : null,
  };
}

/**
 * The engine's calibration for a run at `level` ("easy", "steady" or "race"):
 * {level, flatPace (s/km), durationSec (how long that pace is held before fatigue adds up),
 * enduranceExp (your fatigue exponent, or null for the engine's default), from (words for the
 * page)}. null without references.
 *   easy    your easy pace (typed, or from your fitness), held 2 h 30 before fatigue
 *   steady  halfway between easy and marathon pace, held 2 h 30 before fatigue
 *   race    your half pace over a half's time (or your 10K over a 10K's time), with your own
 *           fatigue exponent when both races are set
 */
export function refsCalib(raw, level = "race") {
  const x = refsRead(raw);
  if (!x) return null;
  const r = x.refs;
  // Riegel's k turned into the engine's exponent e = (k - 1) / k, kept to a sensible 0.02-0.15.
  const exp = x.riegel ? Math.max(0.02, Math.min(0.15, (x.riegel - 1) / x.riegel)) : null;
  const names = [r.k10 ? "10K" : "", r.half ? "half" : "", r.easy ? "easy pace" : ""].filter(Boolean).join(", ");
  if (level === "easy") return { level, flatPace: x.easyPace, durationSec: EASY_HOLD_SEC, enduranceExp: exp, from: `your easy pace (${r.easy ? "typed" : `from your ${names}`})` };
  if (level === "steady") return { level, flatPace: (x.easyPace + x.marathonPace) / 2, durationSec: EASY_HOLD_SEC, enduranceExp: exp, from: `a steady effort between your easy and marathon paces (from your ${names})` };
  const half = Boolean(r.half) || !r.k10;
  return {
    level: "race",
    flatPace: half ? x.halfPace : x.tenKPace,
    durationSec: half ? x.halfPace * HALF_M / 1000 : x.tenKPace * 10,
    enduranceExp: exp,
    from: `your race level (from your ${names})`,
  };
}

/**
 * Re-level an effort profile (effort.js analyseEffort, or a made-up one) on `calib`: every band's
 * pace is multiplied by the same ratio, so the SHAPE (how you slow down on each gradient, measured
 * on your runs) is kept and only the LEVEL changes. Returns a new effort object.
 */
export function calibrateEffort(effort, calib) {
  if (!calib) return effort;
  const k = calib.flatPace / effort.flatPace;
  return {
    ...effort,
    flatPace: calib.flatPace,
    durationSec: calib.durationSec,
    bands: effort.bands.map((b) => ({ ...b, fresh: b.fresh * k, tired: b.tired * k, pace: b.pace * k })),
    calib,
  };
}

/**
 * An effort profile made from the references alone, for a run with no reference runs loaded: the
 * flat pace from `calib`, and each gradient band from the engine's generic multiples of flat pace
 * (effort.js FALLBACK_MULT, fresh, and FALLBACK_TIRED, late in the run). Same shape as
 * analyseEffort's answer for what the model reads (flatPace, durationSec, bands).
 */
export function refsEffort(calib) {
  const bands = BANDS.map((b, i) => {
    const fresh = calib.flatPace * FALLBACK_MULT[i];
    return { id: b.id, label: b.label, fresh, tired: Math.max(fresh, fresh * FALLBACK_TIRED[i]), pace: fresh, source: "references" };
  });
  return { flatPace: calib.flatPace, durationSec: calib.durationSec, bands, calib };
}

/** The model settings with your own fatigue exponent when the calibration has one. */
export const calibParams = (params) => (params.calib && params.calib.enduranceExp ? { ...params, enduranceExp: params.calib.enduranceExp } : params);
