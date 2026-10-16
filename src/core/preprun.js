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
//
// Where it sits: src/ui/preprun.js reads the GPX file, parses it (track.js parseGpx) and calls
// prepRunPlan. The result goes to the same cockpit as a race (script.js raceLegs and
// raceStateAt, src/ui/replay.js) and to the watch export (garmin.js). Pure maths: no page, no
// storage, no network.
//
// The trick is the "same shape": the plan built here has the fields the rest of the app reads
// from a race plan (course.profile, climbs with start/dur per scenario, descents, keyZones,
// scenarios.central.timeline...), but only one scenario ("central"), no aid stations, no gels
// and no heart-rate guide. So the replay and the watch code work on it without knowing the
// difference.

import { resample } from "./track.js";
import { analyseCourse } from "./terrain.js";
import { briefCourse, coarseIndices, climbTactic, PLAN_DEFAULTS } from "./plan.js";
import { keyZones, toblerClock, clockFromTimeline } from "./keyzones.js";
import { parseClock } from "./format.js";

// The tactic shown for a descent, by its level (1 Let it run, 2 Control, 4 Brake; see DESCENT_LABELS
// in plan.js). Level 3 is not used for descents.
const PREP_DESCENT_TACTIC = { 1: "Let it run, recover", 2: "Quick steps, stay light", 4: "Brake, short steps" };

/**
 * Plan of an upcoming run from its parsed GPX. opts: {targetSec (finish time wanted, optional),
 * startTime ("09:00"), hikeGrade (% from which you hike, default 15)}. One scenario, "central".
 *
 * Returns a plan object: {kind: "run", params, startSec (time of day in seconds), timeSource
 * ("target" or "estimate"), estimateSec (Tobler's finish time before stretching), course,
 * climbs, descents, aidStations: [], hrGuide: null, keyZones, scenarios: {central}}.
 */
export function prepRunPlan(parsed, opts = {}) {
  // 1. Read the course exactly as for a race: resample to 10 m, find climbs and descents, and
  // keep one point every 100 m for the profile and the map.
  const rs = resample(parsed, 10);
  const course = analyseCourse(rs);
  const brief = briefCourse(course, PLAN_DEFAULTS);
  const coarse = coarseIndices(course.n);
  const kmAt = (i) => (i * course.step) / 1000;
  const profile = coarse.map((i) => [kmAt(i), course.ele[i]]);
  // [lat, lon] every 100 m, or null when the GPX has no positions. toFixed(6) keeps 6 decimals
  // (about 10 cm), and the unary `+` turns the resulting text back into a number.
  const route = rs.lat ? coarse.map((i) => [+rs.lat[i].toFixed(6), +rs.lon[i].toFixed(6)]) : null;

  // Time: Tobler's estimate, stretched so the finish lands on the target when there is one.
  // tob(km) = seconds to reach km at Tobler's speed. raw = that time at each profile point.
  // k = the stretch factor: target / Tobler's finish (1 without a target). `|| 1` avoids a
  // division by zero on an empty profile.
  const tob = toblerClock(profile);
  const raw = profile.map(([km]) => tob(km));
  const est = raw[raw.length - 1] || 1;
  const k = opts.targetSec > 0 ? opts.targetSec / est : 1;
  const timeline = raw.map((t) => Math.round(t * k));
  const finishSec = timeline[timeline.length - 1];
  // timeAt(km): seconds since the start at any km, interpolated between the profile points.
  const timeAt = clockFromTimeline(profile, timeline);

  // 2. Tactics. hikeGrade: the gradient (%) from which you hike, 15 when not given.
  // maxGain: the biggest climb's gain (Math.max of 0 and every climb's delta, via spread).
  // timing(x): start and duration of a climb or descent, in the {central: seconds} shape the
  // race plan uses (one value per scenario; here only "central").
  // The biggest climb (60 m or more) is flagged so climbTactic can treat it as the main one.
  // `{ ...c, tactic, ...timing(c) }` copies the climb and adds or overrides those fields.
  const hikeGrade = opts.hikeGrade > 0 ? opts.hikeGrade : 15;
  const maxGain = Math.max(0, ...brief.climbs.map((c) => c.delta));
  const timing = (x) => ({ start: { central: timeAt(x.startKm) }, dur: { central: timeAt(x.endKm) - timeAt(x.startKm) } });
  const climbs = brief.climbs.map((c) => ({
    ...c, tactic: climbTactic(c, hikeGrade, c.delta === maxGain && c.delta >= 60), ...timing(c),
    sections: c.sections.map((x) => ({ ...x, tactic: climbTactic(x, hikeGrade, false), ...timing(x) })),
  }));
  const descents = brief.descents.map((d) => ({ ...d, tactic: PREP_DESCENT_TACTIC[d.level], ...timing(d) }));

  // 3. The plan, in the same shape as buildPlan's (plan.js). params keeps the race defaults with
  // your hiking gradient. Key zones are computed with no aid stations ([]).
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
