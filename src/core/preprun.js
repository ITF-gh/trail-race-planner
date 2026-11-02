// preprun.js: a plan for any run to come, from its GPX alone (the "Prep my run" mode).

import { resample } from "./track.js";
import { analyseCourse } from "./terrain.js";
import { briefCourse, coarseIndices, climbTactic, PLAN_DEFAULTS } from "./plan.js";
import { keyZones, toblerClock, clockFromTimeline } from "./keyzones.js";
import { parseClock } from "./format.js";
import { predictScenario } from "./model.js";
import { refsEffort, calibParams } from "./refs.js";

// The tactic shown for a descent, by its level (1 Let it run, 2 Control, 4 Brake; see DESCENT_LABELS in plan.js).
const PREP_DESCENT_TACTIC = { 1: "Let it run, recover", 2: "Quick steps, stay light", 4: "Brake, short steps" };

/** Plan of an upcoming run from its parsed GPX. opts: {targetSec (finish time wanted, optional), startTime ("09:00"), hikeGrade (% from which you hike, default 15), calib (your references at a level, refs.js refsCalib... */
export function prepRunPlan(parsed, opts = {}) {
  // 1.
  const rs = resample(parsed, 10);
  const course = analyseCourse(rs);
  const brief = briefCourse(course, PLAN_DEFAULTS);
  const coarse = coarseIndices(course.n);
  const kmAt = (i) => (i * course.step) / 1000;
  const profile = coarse.map((i) => [kmAt(i), course.ele[i]]);
  // [lat, lon] every 100 m, or null when the GPX has no positions. toFixed(6) keeps 6 decimals (about 10 cm), and the unary `+` turns the resulting text back into a number.
  const route = rs.lat ? coarse.map((i) => [+rs.lat[i].toFixed(6), +rs.lon[i].toFixed(6)]) : null;

  // Time: Tobler's estimate, stretched so the finish lands on the target when there is one. tob(km) = seconds to reach km at Tobler's speed. raw = that time at each profile point. k = the stretch factor...
  const tob = toblerClock(profile);
  let raw = profile.map(([km]) => tob(km));
  if (opts.calib && !(opts.targetSec > 0)) {
    const pred = predictScenario(course, refsEffort(opts.calib), { mult: 1 }, calibParams({ ...PLAN_DEFAULTS, calib: opts.calib }));
    raw = coarse.map((i) => pred.cum[i]);
  }
  const est = raw[raw.length - 1] || 1;
  const k = opts.targetSec > 0 ? opts.targetSec / est : 1;
  const timeline = raw.map((t) => Math.round(t * k));
  const finishSec = timeline[timeline.length - 1];
  // timeAt(km): seconds since the start at any km, interpolated between the profile points.
  const timeAt = clockFromTimeline(profile, timeline);

  // 2.
  const hikeGrade = opts.hikeGrade > 0 ? opts.hikeGrade : 15;
  const maxGain = Math.max(0, ...brief.climbs.map((c) => c.delta));
  const timing = (x) => ({ start: { central: timeAt(x.startKm) }, dur: { central: timeAt(x.endKm) - timeAt(x.startKm) } });
  const climbs = brief.climbs.map((c) => ({
    ...c, tactic: climbTactic(c, hikeGrade, c.delta === maxGain && c.delta >= 60), ...timing(c),
    sections: c.sections.map((x) => ({ ...x, tactic: climbTactic(x, hikeGrade, false), ...timing(x) })),
  }));
  const descents = brief.descents.map((d) => ({ ...d, tactic: PREP_DESCENT_TACTIC[d.level], ...timing(d) }));

  // 3.
  return {
    kind: "run",
    params: { ...PLAN_DEFAULTS, hikeGrade },
    startSec: parseClock(opts.startTime || PLAN_DEFAULTS.startTime),
    timeSource: opts.targetSec > 0 ? "target" : opts.calib ? "refs" : "estimate",
    estimateSec: Math.round(est),
    course: { totalKm: course.totalKm, gain: course.gain, loss: course.loss, minClimb: brief.minClimb, climbCount: climbs.filter((c) => !c.bump).length, descentCount: descents.length, profile, route },
    climbs,
    descents,
    aidStations: [],
    hrGuide: null,
    keyZones: keyZones({ totalKm: course.totalKm, climbs, descents }, profile, [], timeAt),
    scenarios: { central: { id: "central", label: "Your run", finishSec, gels: [], checkpoints: [], timeline } },
  };
}
