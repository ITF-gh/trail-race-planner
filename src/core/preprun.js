// preprun.js: a plan for any run to come, from its GPX alone (the "Prep my run" mode).
//
// A race plan needs your reference runs to predict your pace (plan.js buildPlan). For a training
// run you just want the course read for you and turned into watch messages, so this builds a
// lighter plan with the same shape (what raceLegs, keyZones and garmin.js need):
//   terrain  the same course reading as a race: climbs (long ones in sections), descents
//   tactic   each climb and descent gets its tactic; hiking from `hikeGrade` (15% by default)
//   time     Tobler's hiking function (keyzones.js toblerClock), stretched to your target time
//            when you give one, so the messages show when you get there
// With reference runs loaded, the UI uses the full buildPlan instead: your own pace beats Tobler.

import { resample } from "./track.js";
import { analyseCourse } from "./terrain.js";
import { briefCourse, coarseIndices, climbTactic, PLAN_DEFAULTS } from "./plan.js";
import { keyZones, toblerClock, clockFromTimeline } from "./keyzones.js";
import { parseClock } from "./format.js";

const PREP_DESCENT_TACTIC = { 1: "Let it run, recover", 2: "Quick steps, stay light", 4: "Brake, short steps" };

/**
 * Plan of an upcoming run from its parsed GPX. opts: {targetSec (finish time wanted, optional),
 * startTime ("09:00"), hikeGrade (% from which you hike, default 15)}. One scenario, "central".
 */
export function prepRunPlan(parsed, opts = {}) {
  const rs = resample(parsed, 10);
  const course = analyseCourse(rs);
  const brief = briefCourse(course, PLAN_DEFAULTS);
  const coarse = coarseIndices(course.n);
  const kmAt = (i) => (i * course.step) / 1000;
  const profile = coarse.map((i) => [kmAt(i), course.ele[i]]);
  const route = rs.lat ? coarse.map((i) => [+rs.lat[i].toFixed(6), +rs.lon[i].toFixed(6)]) : null;

  // Time: Tobler's estimate, stretched so the finish lands on the target when there is one.
  const tob = toblerClock(profile);
  const raw = profile.map(([km]) => tob(km));
  const est = raw[raw.length - 1] || 1;
  const k = opts.targetSec > 0 ? opts.targetSec / est : 1;
  const timeline = raw.map((t) => Math.round(t * k));
  const finishSec = timeline[timeline.length - 1];
  const timeAt = clockFromTimeline(profile, timeline);

  const hikeGrade = opts.hikeGrade > 0 ? opts.hikeGrade : 15;
  const maxGain = Math.max(0, ...brief.climbs.map((c) => c.delta));
  const timing = (x) => ({ start: { central: timeAt(x.startKm) }, dur: { central: timeAt(x.endKm) - timeAt(x.startKm) } });
  const climbs = brief.climbs.map((c) => ({
    ...c, tactic: climbTactic(c, hikeGrade, c.delta === maxGain && c.delta >= 60), ...timing(c),
    sections: c.sections.map((x) => ({ ...x, tactic: climbTactic(x, hikeGrade, false), ...timing(x) })),
  }));
  const descents = brief.descents.map((d) => ({ ...d, tactic: PREP_DESCENT_TACTIC[d.level], ...timing(d) }));

  return {
    kind: "run",
    params: { ...PLAN_DEFAULTS, hikeGrade },
    startSec: parseClock(opts.startTime || PLAN_DEFAULTS.startTime),
    timeSource: opts.targetSec > 0 ? "target" : "estimate",
    estimateSec: Math.round(est),
    course: { totalKm: course.totalKm, gain: course.gain, loss: course.loss, climbCount: climbs.length, descentCount: descents.length, profile, route },
    climbs,
    descents,
    aidStations: [],
    hrGuide: null,
    keyZones: keyZones({ totalKm: course.totalKm, climbs, descents }, profile, [], timeAt),
    scenarios: { central: { id: "central", label: "Your run", finishSec, gels: [], checkpoints: [], timeline } },
  };
}
