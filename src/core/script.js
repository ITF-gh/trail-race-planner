// script.js: the race told as a story in time, for the race-day replay.
//
// The plan knows WHERE things happen (km of each climb, gel, aid station) and, per scenario,
// WHEN you get there (a timeline: seconds since the start at every 100 m, stops included).
// Two functions turn that into something you can rehearse:
//   raceScript(plan, sid)   the key moments in time order, each with a short cue to say to
//                           yourself (what is coming, how to run it, what to eat)
//   raceStateAt(plan, sid, sec)   where you are at any second of the race: km, altitude,
//                           gradient, pace, the climb you are on, the next gel and aid station
//   raceLegs(plan, sid)     the whole course cut into numbered sections, end to end: every
//                           climb (or climb section) and descent of the briefing, with the
//                           runnable stretches between them, each with its own targets
//   raceTotals(plan, sid)   the targets for the whole race: finish, pace, gels, heart rate
// Both work in Node (tests) and in the browser (the replay plays them back).
//
// Where it sits in the data flow: plan.js builds the plan (buildPlan), then the UI
// (src/ui/replay.js, src/ui/main.js) and Prep my run call the functions below to animate
// it. This file only reads the plan; it never changes it and never touches the page.
//
// Shapes it relies on (all built in plan.js):
//   plan.course.profile    [[km, altitude m], ...] one point every 100 m, sorted by km
//   plan.scenarios[sid].timeline   [seconds, ...] same length as the profile: the race clock
//                          (seconds since the start, aid-station stops included) at each point
//   sid                    the scenario id: "best", "central" or "cautious"
//   plan.startSec          the start time of day, in seconds since midnight
//
// Key idea: the timeline is sorted (time only moves forward), so finding "where am I at
// second t" is a BINARY SEARCH in it, then a LINEAR INTERPOLATION inside the 100 m step:
// if t is 40% of the way between the times of two points, the runner is 40% of the way
// between their km and altitudes.

import { LEVELS, DESCENT_LABELS } from "./plan.js";
import { clock, hm } from "./format.js";

/**
 * First index i with arr[i] > v (arr sorted ascending): a binary search.
 *
 * Instead of checking every element (slow on a 100 km course: 1000 points), keep a range
 * [lo, hi) that surely holds the answer and halve it at each step: about 10 steps for
 * 1000 points. Returns arr.length when every value is <= v.
 * Inputs: arr, an ascending array of numbers (km or seconds); v, the value looked for.
 */
function upperBound(arr, v) {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    // `>> 1` shifts the bits right by one: a fast whole-number division by 2 (rounds down).
    const mid = (lo + hi) >> 1;
    // The middle value is still <= v: the answer is to its right. Otherwise it is mid or left of it.
    if (arr[mid] <= v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Seconds since the start when the runner reaches `km`, in scenario `sid`.
 * Inputs: the plan, a scenario id, a distance in km. Returns seconds (stops included).
 * The reverse question ("where am I at second t") is raceStateAt below.
 */
export function secAtKm(plan, sid, km) {
  const P = plan.course.profile;
  const tl = plan.scenarios[sid].timeline;
  // Just the km column of the profile, so the binary search compares plain numbers.
  const kms = P.map((p) => p[0]);
  // i = the profile point just before `km`. Math.max/Math.min "clamp" it to 0..length-2 so
  // that i + 1 always exists, even for a km before the start or past the finish.
  const i = Math.max(0, Math.min(P.length - 2, upperBound(kms, km) - 1));
  // f = how far (0 to 1) `km` sits between points i and i+1. `|| 1` avoids a division by
  // zero if two points share the same km.
  const f = Math.max(0, Math.min(1, (km - P[i][0]) / (P[i + 1][0] - P[i][0] || 1)));
  // Linear interpolation: the same fraction of the time between the two points.
  return tl[i] + f * (tl[i + 1] - tl[i]);
}

// The pep talk added at the end of each climb's cue, by difficulty level
// (1 Easy, 2 Moderate, 3 Hard, 4 Crux, the same levels as LEVELS in plan.js).
const CLIMB_CUE = {
  1: "Easy one: stay relaxed and keep the breathing calm.",
  2: "Keep it smooth: a rhythm you could hold for twice as long.",
  3: "A hard one. Settle in early, short steps, do not chase anyone.",
  4: "A crux climb. Shorten the stride, hands on knees on the steep pitches, long breaths out. It ends.",
};
// Round to a whole number (short name because it is used inside many text templates).
const r0 = (x) => Math.round(x);

/**
 * Key moments of the race for scenario `sid`, in time order.
 *
 * Returns an array of moments, each {kind, sec, km, level, title, cue}:
 *   kind   "start", "climb", "top", "descent", "gel", "aid", "phase", "key" or "finish"
 *   sec    seconds since the start when it happens (this scenario's timing)
 *   km     where it happens
 *   level  0 for a plain moment, 1 to 4 for the difficulty of a climb/descent/key zone
 *   title  a short heading; cue: one or two sentences to say to yourself at that moment
 * The replay shows the cue when the runner crosses `sec`, and can pause there.
 */
export function raceScript(plan, sid) {
  const sc = plan.scenarios[sid];
  const st = plan.startSec;
  const total = plan.course.totalKm;
  // at(sec): the clock time of day ("9:47") at `sec` seconds into the race.
  const at = (sec) => clock(st, sec);
  const ev = [];
  // add(e): store one moment. `{ level: 0, ...e }` is the spread syntax: copy every field
  // of e into a new object, with level 0 as the default when e does not set its own.
  const add = (e) => ev.push({ level: 0, ...e });
  // The heart-rate guide: three phases (early, middle, late) or null when the runs had no HR.
  const hr = plan.hrGuide;

  // 1. The start. `${hr ? ... : ""}` adds the heart-rate sentence only when there is a guide.
  add({ kind: "start", sec: 0, km: 0, title: "Start", cue: `Start easy: the first hour should feel too slow.${hr ? ` Heart rate ${hr[0].text}.` : ""} ${plan.climbs.length} climbs and ${r0(plan.course.gain)} m of climbing ahead.` });

  // 2. Each climb: one moment at its foot, plus one at the top of the hard ones (level 3+).
  // c.start[sid] and c.dur[sid] are the clock at the foot and the time on the climb, in seconds.
  plan.climbs.forEach((c) => {
    if (c.gain < 40 && c.level < 2) return; // bumps are not worth a cue
    // Minutes on the climb, at least 1 so the cue never says "About 0 min".
    const min = Math.max(1, r0(c.dur[sid] / 60));
    // For a long climb split into sections: " In 3 sections: 4a run, 4b hike, ..." (else empty).
    const secs = c.sections.length ? ` In ${c.sections.length} sections: ${c.sections.map((x) => `${x.n} ${x.tactic.toLowerCase()}`).join(", ")}.` : "";
    add({
      kind: "climb", sec: c.start[sid], km: c.startKm, level: c.level,
      title: `Climb ${c.n} · ${LEVELS[c.level]}`,
      cue: `${r0(c.gain)} m up over ${(c.lenM / 1000).toFixed(1)} km at ${c.avg.toFixed(0)}% (steepest 100 m: ${r0(c.steep)}%). ${c.tactic}. About ${min} min, top at ${at(c.start[sid] + c.dur[sid])}.${secs} ${CLIMB_CUE[c.level]}`,
    });
    if (c.level >= 3) {
      add({ kind: "top", sec: c.start[sid] + c.dur[sid], km: c.endKm, level: c.level, title: `Top of climb ${c.n}`, cue: "Shake out your arms, reset your breathing, let the legs turn over for a minute before you push the descent." });
    }
  });

  // 3. Descents worth a warning: every "Brake" descent (level 4), and "Control" descents
  // (level 2) that drop 150 m or more. "Let it run" descents get no cue.
  // d.avg and d.steep are negative gradients, hence Math.abs for the text.
  plan.descents.forEach((d) => {
    if (d.level === 4) {
      add({ kind: "descent", sec: d.start[sid], km: d.startKm, level: 4, title: `Descent ${d.n} · Brake`, cue: `${r0(d.loss)} m down at ${Math.abs(d.avg).toFixed(0)}% (steepest 100 m: ${Math.abs(r0(d.steep))}%). Brake, short quick steps, eyes three metres ahead. Your quads are needed later.` });
    } else if (d.level === 2 && d.loss >= 150) {
      add({ kind: "descent", sec: d.start[sid], km: d.startKm, level: 2, title: `Descent ${d.n} · Control`, cue: `${r0(d.loss)} m down at ${Math.abs(d.avg).toFixed(0)}%. Quick light steps, stay in control, no heroics.` });
    }
  });

  // 4. Each gel of this scenario. g.at is an optional place name ("top of climb 3").
  sc.gels.forEach((g, i) => {
    // An AI plan names the intake (gel, bar, drink, food) and its carbs.
    const what = g.item ? `${g.item[0].toUpperCase()}${g.item.slice(1)}${g.carbsG ? ` (${r0(g.carbsG)} g carbs)` : ""}` : "Gel";
    add({ kind: "gel", sec: g.sec, km: g.km, title: `${what} · ${i + 1} of ${sc.gels.length}`, cue: `${g.at ? `At ${g.at}. ` : ""}Eat it now with a few sips of water, even if you do not feel hungry. Fuel taken now is energy in 30 min.` });
  });

  // 5. Each aid station: a stop with a "leave by" time, or a pass-through when stopMin is 0.
  plan.aidStations.forEach((a) => {
    const arrive = a.arrive[sid];
    add({ kind: "aid", sec: arrive, km: a.km, title: a.name, cue: a.stopMin ? `${a.stopMin} min stop: refill bottles, eat something real, out by ${at(arrive + a.stopMin * 60)}. Walk out eating.` : "Pass through: grab a drink and go." });
  });

  // 6. Race phases: the start of the middle and late heart-rate phases (when there is a
  // guide), then halfway. Their time comes from their km through secAtKm.
  if (hr) {
    add({ kind: "phase", sec: secAtKm(plan, sid, hr[1].fromKm), km: hr[1].fromKm, title: "Middle of the race", cue: `Heart rate ${hr[1].text}. Keep eating on time: this is where the fade starts if you skip fuel.` });
    add({ kind: "phase", sec: secAtKm(plan, sid, hr[2].fromKm), km: hr[2].fromKm, title: "Final third", cue: `Heart rate ${hr[2].text}. From here, effort you saved is time you gain.` });
  }
  add({ kind: "phase", sec: secAtKm(plan, sid, total / 2), km: total / 2, title: "Halfway", cue: `Halfway at ${at(secAtKm(plan, sid, total / 2))}, ${hm(secAtKm(plan, sid, total / 2))} on course. Check in: fuel, feet, chafing. The second half is the race.` });
  // Key zones come last so that, at the same spot as a climb, the key-zone cue is the one shown.
  (plan.keyZones || []).forEach((z) => {
    add({ kind: "key", sec: secAtKm(plan, sid, z.fromKm), km: z.fromKm, level: 4, title: `Key zone ${z.n} · ${z.modeLabel} · ${z.title}`, cue: `${z.why} ${z.how}` });
  });
  // The AI's key moments (an AI plan only), with the AI's own cue.
  ((plan.ai && plan.ai.moments) || []).forEach((m) => {
    add({ kind: "ai", sec: secAtKm(plan, sid, m.km), km: m.km, level: m.level, title: m.title, cue: m.cue || "Key moment chosen by the AI." });
  });
  // 7. The finish.
  add({ kind: "finish", sec: sc.finishSec, km: total, title: "Finish", cue: `Finish at ${at(sc.finishSec)}, ${hm(sc.finishSec)} on course. Picture the arch, the clock, the people. You earned it climb by climb.` });

  // 8. Sort by time. The comparator returns a negative number when a comes first. When two
  // moments share the same second (a - b is 0, which counts as false), `||` falls back to km.
  // Array.sort is stable, so equal moments keep the order they were added in.
  return ev.sort((a, b) => a.sec - b.sec || a.km - b.km);
}

/**
 * Where the runner is at `sec` seconds after the start, in scenario `sid`.
 *
 * Returns one object, read by the replay at every animation frame:
 *   sec, km, ele (altitude m), grade (% over the current 100 m), pace (s/km, null while
 *   standing at an aid station), frac (share of the course done, 0 to 1),
 *   aid (the aid station you are stopped at, or null),
 *   climb / section / descent (the one you are on, or null),
 *   nextGel, nextAid, nextClimb, keyZone (the one you are in), nextKey, phase (HR phase).
 */
export function raceStateAt(plan, sid, sec) {
  const P = plan.course.profile;
  const sc = plan.scenarios[sid];
  const tl = sc.timeline;
  // 1. Clamp the time to the race: before the start is the start, after the finish is the finish.
  const t = Math.max(0, Math.min(sc.finishSec, sec));
  // 2. Binary search in the timeline: i is the last 100 m point the runner has passed.
  const i = Math.max(0, Math.min(P.length - 2, upperBound(tl, t) - 1));
  // span: seconds the runner takes over this 100 m step. f: share of the step done (0 to 1).
  const span = tl[i + 1] - tl[i];
  const f = span > 0 ? Math.max(0, Math.min(1, (t - tl[i]) / span)) : 0;
  // 3. Linear interpolation of km and altitude inside the step.
  let km = P[i][0] + f * (P[i + 1][0] - P[i][0]);
  let ele = P[i][1] + f * (P[i + 1][1] - P[i][1]);
  // Step length in km (0.1 = 100 m as a fallback when two points share a km).
  const dKm = P[i + 1][0] - P[i][0] || 0.1;
  // Gradient in %: rise in metres / run in metres x 100.
  const grade = ((P[i + 1][1] - P[i][1]) / (dKm * 1000)) * 100;
  let pace = span / dKm; // seconds per km over this 100 m
  // At an aid station the clock runs while you stand still.
  // The timeline includes stop time, so during a stop the interpolation above would creep
  // forward. Instead, pin the runner at the station: its km, no pace, and the altitude of the
  // nearest profile point (the station's share of the course times the number of steps).
  const aid = plan.aidStations.find((a) => t >= a.arrive[sid] && t < a.arrive[sid] + a.stopMin * 60);
  if (aid) { km = aid.km; pace = null; ele = P[Math.min(P.length - 1, Math.round((aid.km / plan.course.totalKm) * (P.length - 1)))][1]; }
  // 4. Look up what the runner is on and what comes next. `find` returns the first match or
  // undefined; `|| null` turns "not found" into null so the result is always an object or null.
  // inside(x): true when the current km lies in [x.startKm, x.endKm).
  const inside = (x) => km >= x.startKm && km < x.endKm;
  const climb = plan.climbs.find(inside) || null;
  const section = climb ? climb.sections.find(inside) || null : null;
  const descent = plan.descents.find(inside) || null;
  const nextGel = sc.gels.find((g) => g.sec > t) || null;
  const nextAid = plan.aidStations.find((a) => a.arrive[sid] > t) || null;
  // Next climb worth announcing: the same "not a bump" rule as in raceScript.
  const nextClimb = plan.climbs.find((c) => c.startKm > km && (c.gain >= 40 || c.level >= 2)) || null;
  const zones = plan.keyZones || [];
  const keyZone = zones.find((z) => km >= z.fromKm && km < z.toKm) || null;
  const nextKey = zones.find((z) => z.fromKm > km) || null;
  const frac = km / plan.course.totalKm;
  const phase = plan.hrGuide ? plan.hrGuide.find((h) => km >= h.fromKm && km <= h.toKm) || null : null;
  return { sec: t, km, ele, grade, pace, frac, aid, climb, section, descent, nextGel, nextAid, nextClimb, keyZone, nextKey, phase };
}

/**
 * Altitude at `km` on the profile (linear between the 100 m points).
 * Inputs: P, the profile [[km, altitude m], ...]; km. Returns metres. Same search and
 * interpolation as secAtKm, applied to altitude instead of time.
 */
function eleAtKm(P, km) {
  const kms = P.map((p) => p[0]);
  const i = Math.max(0, Math.min(P.length - 2, upperBound(kms, km) - 1));
  const f = Math.max(0, Math.min(1, (km - P[i][0]) / (P[i + 1][0] - P[i][0] || 1)));
  return P[i][1] + f * (P[i + 1][1] - P[i][1]);
}

/**
 * Metres up and down on the profile between two km.
 * Inputs: P, the profile [[km, altitude m], ...]; a and b, start and end in km (a < b).
 * Returns {up, down}, both positive metres (D+ and D-).
 * Walks every profile point strictly between a and b, plus the interpolated altitudes at
 * a and b themselves, and adds each rise to `up` and each drop to `down`.
 */
export function gainLoss(P, a, b) {
  let up = 0, down = 0, prev = eleAtKm(P, a);
  // `const [k, e] of P` is destructuring: each profile point [km, ele] is unpacked into k and e.
  for (const [k, e] of P) {
    // `continue` skips to the next point: only points strictly inside (a, b) count here.
    if (k <= a || k >= b) continue;
    const d = e - prev;
    // A rise adds to up; a drop (negative d) adds its size to down (minus a negative is a plus).
    if (d > 0) up += d; else down -= d;
    prev = e;
  }
  // Last piece: from the last point inside to the exact end b.
  const d = eleAtKm(P, b) - prev;
  if (d > 0) up += d; else down -= d;
  return { up, down };
}

const RUNNABLE_MIN_KM = 0.3; // a gap shorter than this between two climbs is part of the one before

/**
 * The course cut into sections, start to finish with no gap: the climbs (split ones section by
 * section) and descents of the briefing, and "runnable" stretches where nothing climbs or drops
 * for long. Each section: {i (1..n), kind, n (its number in the briefing), level, title, label,
 * startKm, endKm, km, up, down, avg, startSec, endSec, durSec, stopSec, pace (moving, s/km),
 * tactic, gels, aids, keyZone, hr}. In course order, so section i+1 starts where i ends.
 */
export function raceLegs(plan, sid) {
  const P = plan.course.profile;
  const total = plan.course.totalKm;
  const sc = plan.scenarios[sid];
  // 1. Collect the pieces the briefing already knows: each climb (or each of its sections
  // when a long climb was split) and each descent. `(cond ? a : b).forEach` picks which list
  // to walk: the sections when there are some, else the climb itself as a one-item list.
  const parts = [];
  plan.climbs.forEach((c) => (c.sections.length ? c.sections : [c]).forEach((x) => parts.push({
    kind: "climb", n: x.n, level: x.level, startKm: x.startKm, endKm: x.endKm,
    title: `${c.sections.length ? "Climb section" : "Climb"} ${x.n}`, label: LEVELS[x.level], tactic: x.tactic,
  })));
  plan.descents.forEach((d) => parts.push({
    kind: "descent", n: d.n, level: d.level, startKm: d.startKm, endKm: d.endKm,
    title: `Descent ${d.n}`, label: DESCENT_LABELS[d.level], tactic: d.tactic,
  }));
  // 2. Put them in course order.
  parts.sort((a, b) => a.startKm - b.startKm);
  // A filler section for the ground between two climbs/descents (kind "flat", level 0).
  const runnable = (a, b) => ({ kind: "flat", n: null, level: 0, startKm: a, endKm: b, title: "Runnable", label: "Runnable", tactic: "Run tall and relaxed, drink, eat on time" });
  // 3. Walk the pieces in order and fill every gap, so the sections touch end to end.
  // `at` is the km where the previous section ended (0 at the start).
  const legs = [];
  let at = 0;
  for (const p of parts) {
    // A piece that starts before `at` (an overlap) is trimmed to start at `at`.
    const from = Math.max(at, p.startKm);
    if (from >= p.endKm) continue; // fully inside the previous one (should not happen)
    if (from - at >= RUNNABLE_MIN_KM) legs.push(runnable(at, from));
    else if (legs.length) legs[legs.length - 1].endKm = from; // a short gap joins the section before
    // Copy the piece with its (possibly trimmed) start. The very first section starts at 0,
    // so a short gap before the first climb is folded into it.
    legs.push({ ...p, startKm: legs.length ? from : 0 });
    at = p.endKm;
  }
  // 4. After the last piece: a runnable section to the finish if the gap is long enough (or
  // if there were no climbs or descents at all), else stretch the last section to the finish.
  if (total - at >= RUNNABLE_MIN_KM || !legs.length) legs.push(runnable(at, total));
  else legs[legs.length - 1].endKm = total;

  // 5. Give every section its targets for this scenario. `map` builds a new array: one
  // enriched object per section, k being its 0-based index.
  const zones = plan.keyZones || [];
  // An AI plan (core/aiprep.js) carries the AI's choices per leg id L1..Ln, in this same order.
  const A = plan.ai && plan.ai.legs;
  return legs.map((l, k) => {
    const ai = A ? A[`L${k + 1}`] || null : null;
    // Clock in and out. The last section ends exactly at the finish time.
    const startSec = secAtKm(plan, sid, l.startKm);
    const endSec = k === legs.length - 1 ? sc.finishSec : secAtKm(plan, sid, l.endKm);
    const km = l.endKm - l.startKm;
    // inLeg(x): is km x in this section? [start, end), except that the last section also
    // includes the finish line itself, so a station or gel at the very end is not lost.
    const inLeg = (x) => x >= l.startKm && (x < l.endKm || (k === legs.length - 1 && x <= l.endKm));
    const aids = plan.aidStations.filter((a) => inLeg(a.km));
    // Total stop time in the section. `reduce` folds a list into one value: start at 0 and
    // add each station's stop in seconds.
    const stopSec = aids.reduce((t, a) => t + a.stopMin * 60, 0);
    // Destructuring: take the up and down fields of gainLoss's result as two variables.
    const { up, down } = gainLoss(P, l.startKm, l.endKm);
    // The section's middle km, used to pick its heart-rate phase.
    const mid = (l.startKm + l.endKm) / 2;
    // avg: average gradient in % (net altitude change / length; Math.max avoids dividing by 0).
    // pace: moving pace in s/km, stops left out. keyZone: the first key zone that overlaps.
    return {
      ...l, i: k + 1, km, up, down,
      // The AI's tactic replaces the coded one; `ai` keeps its mode, effort, note and reason.
      tactic: ai && ai.tactic ? ai.tactic : l.tactic, ai,
      avg: ((eleAtKm(P, l.endKm) - eleAtKm(P, l.startKm)) / Math.max(1, km * 1000)) * 100,
      startSec, endSec, durSec: endSec - startSec, stopSec,
      pace: km > 0 ? Math.max(0, endSec - startSec - stopSec) / km : null,
      gels: sc.gels.filter((g) => inLeg(g.km)),
      aids,
      keyZone: zones.find((z) => z.fromKm < l.endKm && z.toKm > l.startKm) || null,
      hr: plan.hrGuide ? plan.hrGuide.find((h) => mid >= h.fromKm && mid <= h.toKm) || null : null,
    };
  });
}

/**
 * Index (0-based) of the leg that contains `km`.
 * Inputs: legs from raceLegs (in course order), a km. A simple walk from the first leg:
 * there are only a few dozen legs, so a binary search would not be worth it. A km past the
 * finish returns the last leg.
 */
export function legAtKm(legs, km) {
  let i = 0;
  while (i < legs.length - 1 && km >= legs[i].endKm) i++;
  return i;
}

/**
 * Targets for the whole race in scenario `sid`: {finishSec, durationSec, km, gain, loss,
 * paceSec (finish time / km, stops included), movingPaceSec (stops left out), stopSec,
 * gels, gelEveryMin, aids, hrAvg, hrMin, hrMax}. hrAvg is null when the runs had no heart rate:
 * otherwise the time-weighted mean of the value expected in each phase of the heart-rate guide.
 */
export function raceTotals(plan, sid) {
  const sc = plan.scenarios[sid];
  const km = plan.course.totalKm;
  // All aid-station stops, in seconds.
  const stopSec = plan.aidStations.reduce((t, a) => t + a.stopMin * 60, 0);
  let hrAvg = null, hrMin = null, hrMax = null;
  const hr = plan.hrGuide;
  // Heart-rate forecast only when every phase has a number (`every` is true when the test
  // passes for all items; Number.isFinite rejects null, undefined and NaN).
  if (hr && hr.every((h) => Number.isFinite(h.bpm))) {
    // Time-weighted mean: each phase's bpm counts in proportion to the seconds spent in it.
    // sum = bpm x seconds added up; w = total seconds; average = sum / w.
    let sum = 0, w = 0;
    for (const h of hr) {
      const dt = secAtKm(plan, sid, Math.min(km, h.toKm)) - secAtKm(plan, sid, h.fromKm);
      sum += h.bpm * dt;
      w += dt;
    }
    hrAvg = w > 0 ? Math.round(sum / w) : null;
    // `Math.min(...list)`: the spread `...` passes each array item as a separate argument.
    hrMin = Math.min(...hr.map((h) => h.bpm));
    hrMax = Math.max(...hr.map((h) => h.bpm));
  }
  // finishSec and durationSec are the same number (seconds since the start); both names are
  // kept for the callers. paceSec includes the stops, movingPaceSec leaves them out.
  return {
    finishSec: sc.finishSec, durationSec: sc.finishSec, km, gain: plan.course.gain, loss: plan.course.loss,
    paceSec: sc.finishSec / km, movingPaceSec: (sc.finishSec - stopSec) / km, stopSec,
    gels: sc.gels.length, gelEveryMin: plan.params.gelEveryMin, aids: plan.aidStations.length,
    hrAvg, hrMin, hrMax,
  };
}
