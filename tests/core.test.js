import { test } from "node:test";
import assert from "node:assert/strict";
import { parseGpx, haversine, resample } from "../src/core/track.js";
import { analyseCourse, zigzag, bandIndex, BANDS } from "../src/core/terrain.js";
import { analyseEffort, hikeThreshold } from "../src/core/effort.js";
import { predictScenario, SCENARIOS } from "../src/core/model.js";
import { buildPlan, judgeTarget, splitClimb, climbScore, climbLevel, climbTactic, parseAidStations } from "../src/core/plan.js";
import { planToMarkdown } from "../src/core/markdown.js";
import { raceScript, raceStateAt, secAtKm, raceLegs, raceTotals, legAtKm } from "../src/core/script.js";
import { keyZones, toblerClock, spreadAt } from "../src/core/keyzones.js";
import { mmss, hm, clock, parseDuration, parseClock } from "../src/core/format.js";
import { makeDemoRaceGpx, makeDemoEffortGpx, DEMO_RACE_PROFILE, DEMO_ULTRA_PROFILE, DEMO_ULTRA_AID, DEMO_LONG_RUN_PROFILE } from "../src/demo.js";

const race = parseGpx(makeDemoRaceGpx());
const effort = parseGpx(makeDemoEffortGpx());
const total = DEMO_RACE_PROFILE.reduce((s, [l]) => s + l, 0);

test("parseGpx reads elevation, time, heart rate and cadence", () => {
  assert.ok(race.points.length > 500);
  assert.equal(race.points[0].time, null);
  assert.ok(effort.points[0].time > 0);
  assert.ok(effort.points[10].hr >= 150);
  assert.ok(effort.points[10].cad > 0);
  assert.equal(race.name, "Demo Trail 20K");
});

test("parseGpx rejects things that are not GPX", () => {
  assert.throws(() => parseGpx("hello"), /GPX/);
  assert.throws(() => parseGpx("<gpx></gpx>"), /No track points/);
});

test("haversine: one degree of latitude is about 111.2 km", () => {
  const d = haversine({ lat: 45, lon: 5 }, { lat: 46, lon: 5 });
  assert.ok(Math.abs(d - 111195) < 200);
});

test("resample keeps total distance and spacing", () => {
  const rs = resample(race, 10);
  assert.ok(Math.abs(rs.totalM - total) < 30);
  assert.equal(rs.n, Math.floor(rs.totalM / 10) + 1);
  assert.equal(rs.time, null);
});

test("zigzag finds the turning points and ignores small wiggles", () => {
  assert.deepEqual(zigzag([0, 10, 0, 10], 5), [0, 1, 2, 3]);
  assert.deepEqual(zigzag([0, 10, 8, 11, 0], 5), [0, 3, 4]);
});

test("bandIndex puts gradients in the right band", () => {
  assert.equal(BANDS[bandIndex(0)].id, "f0");
  assert.equal(BANDS[bandIndex(-30)].id, "d4");
  assert.equal(BANDS[bandIndex(12)].id, "u3");
  assert.equal(BANDS[bandIndex(40)].id, "u5");
});

test("analyseCourse finds the steep pitches and a plausible total gain", () => {
  const c = analyseCourse(resample(race, 10));
  // The course holds 14%, 16% and 12% pitches; neighbouring stretches merge into longer climbs,
  // so we check the steepest-100-m figure rather than the average.
  const wall = c.climbs.find((x) => x.steep > 11);
  assert.ok(wall, "a steep climb should be found");
  assert.ok(Math.max(...c.climbs.map((x) => x.steep)) < 20, "no invented walls");
  const expectedGain = DEMO_RACE_PROFILE.reduce((s, [l, g]) => s + (g > 0 ? (l * g) / 100 : 0), 0);
  assert.ok(Math.abs(c.gain - expectedGain) / expectedGain < 0.1, `gain ${c.gain} vs ${expectedGain}`);
});

test("analyseEffort needs timestamps", () => {
  assert.throws(() => analyseEffort(race), /timestamps/);
});

test("analyseEffort recovers the generating pace table and the fatigue", () => {
  const e = analyseEffort(effort);
  const flat = e.bands.find((b) => b.id === "f0");
  assert.ok(flat.fresh > 255 && flat.fresh < 290, `flat fresh ${flat.fresh}`);
  assert.ok(flat.tired > flat.fresh, "tired must be slower than fresh");
  assert.ok(Math.abs(e.flatCad - 172) < 4, `cadence ${e.flatCad}`);
  assert.equal(e.cadenceWasPerFoot, true);
  assert.ok(e.drift.decouplingPct > 0);
  for (const b of e.bands) assert.ok(b.tired >= b.fresh, `${b.id} tired >= fresh`);
});

test("model: best < central < cautious, and harder terrain is slower", () => {
  const course = analyseCourse(resample(race, 10));
  const e = analyseEffort(effort);
  const t = Object.fromEntries(SCENARIOS.map((s) => [s.id, predictScenario(course, e, s, {})]));
  assert.ok(t.best.finishSec < t.central.finishSec);
  assert.ok(t.central.finishSec < t.cautious.finishSec);
  const tech = predictScenario(course, e, SCENARIOS[1], { terrain: "technical" });
  assert.ok(tech.finishSec > t.central.finishSec);
  const boosted = predictScenario(course, e, SCENARIOS[1], { descentBoost: 0.05 });
  assert.ok(boosted.finishSec < t.central.finishSec);
  for (let i = 1; i < t.central.cum.length; i++) assert.ok(t.central.cum[i] >= t.central.cum[i - 1]);
});

test("buildPlan: checkpoints, gels and tactics are coherent", () => {
  const plan = buildPlan(race, effort, { startTime: "09:00", gelEveryMin: 30 });
  const sc = plan.scenarios.central;
  assert.equal(sc.checkpoints.at(-1).label, "Finish");
  for (let i = 1; i < sc.checkpoints.length; i++) assert.ok(sc.checkpoints[i].sec > sc.checkpoints[i - 1].sec);
  assert.ok(sc.gels.length >= 1);
  for (const g of sc.gels) {
    const inside = plan.climbs.find((c) => g.km > c.startKm + 0.01 && g.km < c.endKm - 0.01);
    // inside a climb only when its top was too far to wait for
    const atBreak = inside && (inside.sections || []).some((x) => Math.abs(x.endKm - g.km) < 0.02);
    if (inside) assert.ok(atBreak || inside.start.central + inside.dur.central - g.sec > 20 * 60 - 1, `gel at km ${g.km} lands inside climb ${inside.n}`);
  }
  // With a low hiking threshold, every climb steeper than (threshold - 2)% is a hike.
  const low = buildPlan(race, effort, { hikeGrade: 9 });
  const steep = low.climbs.filter((c) => c.avg >= 7);
  assert.ok(steep.length > 0);
  assert.ok(steep.every((c) => /^Hike/.test(c.tactic)), "steep climbs are hiked");
  assert.ok(low.climbs.filter((c) => c.avg < 3).every((c) => !/Hike/.test(c.tactic)), "gentle climbs are run");
  assert.ok(plan.hrGuide.length === 3);
  assert.ok(plan.climbs.every((c) => c.level >= 1 && c.level <= 4));
  assert.ok(plan.climbs.every((c) => c.effortMatch));
});

test("buildPlan caps the heart-rate guide at 92% of max HR", () => {
  const plan = buildPlan(race, effort, { maxHr: 150 });
  const top = Number(/\d+/.exec(plan.hrGuide[2].text)[0]);
  assert.ok(top <= Math.round(150 * 0.92));
});

test("splitClimb cuts where the gradient changes and respects the minimum length", () => {
  // 2 km at 3% then 1.5 km at 12%, on a 10 m grid.
  const ele = [0];
  for (let i = 0; i < 350; i++) ele.push(ele[i] + (i < 200 ? 0.3 : 1.2));
  assert.deepEqual(splitClimb(ele, 0, 350, 10, 1500), [[0, 200], [200, 350]]);
  assert.deepEqual(splitClimb(ele, 0, 290, 10, 1500), [[0, 290]], "under 3 km: one piece");
  const four = splitClimb(ele.concat(ele.slice(1).map((e) => e + ele[350])), 0, 700, 10, 1500);
  assert.equal(four.length, 4);
  assert.ok(four.every(([a, b]) => (b - a) * 10 >= 1500));
  for (let i = 1; i < four.length; i++) assert.equal(four[i][0], four[i - 1][1], "sections are contiguous");
});

test("buildPlan splits climbs of 3 km or more and 100 m gain or more into sections", () => {
  const plan = buildPlan(race, effort);
  for (const c of plan.climbs) {
    if (c.lenM < 3000 || c.gain < 100) { assert.equal(c.sections.length, 0); continue; }
    assert.ok(c.sections.length >= 2, `climb ${c.n} is split`);
    assert.ok(c.sections.every((s) => s.lenM >= 1500 && s.tactic));
    for (const s of c.sections) {
      assert.equal(s.score, climbScore({ ...s, delta: s.gain }, plan.course.totalKm), `section ${s.n} is scored like a climb`);
      assert.equal(s.level, climbLevel(s.score));
      assert.ok(s.effortMatch);
    }
    assert.equal(c.sections[0].startKm, c.startKm);
    assert.ok(Math.abs(c.sections.at(-1).endKm - c.endKm) < 1e-9);
    const sum = c.sections.reduce((t, s) => t + s.dur.central, 0);
    assert.ok(Math.abs(sum - c.dur.central) < 1e-6, "section times add up to the climb");
  }
  assert.ok(plan.climbs.some((c) => c.sections.length), "the demo course has a long climb");
  const drag = buildPlan(parseGpx(makeDemoRaceGpx([[500, 0], [4000, 2], [500, -8], [500, 0]])), effort);
  assert.ok(drag.climbs.some((c) => c.lenM >= 3000 && c.gain < 100 && !c.sections.length), "a long flat-ish climb stays whole");
  assert.match(planToMarkdown(plan), /\| 5\.1 \|/);
});

test("hiking threshold: the gradient that best separates run and hike, not an average", () => {
  // Half of the 10-15% band is run at 170 spm (12%), half hiked at 124 spm (14%): the band average (147) says "run".
  const slices = [];
  for (let i = 0; i < 100; i++) slices.push([5 + (i % 5), 172, 1], [12, 170, 1], [14, 124, 1], [18, 110, 1]);
  const g = hikeThreshold(slices);
  assert.ok(g > 12 && g <= 14, `threshold ${g}`);
  assert.equal(hikeThreshold([[10, 170, 30], [12, 168, 30]]), null, "no hiking at all: nothing to learn");
  // The demo run hikes its 14% stretches and runs its 12% ones.
  const e = analyseEffort(effort);
  assert.ok(e.hikeGrade > 11 && e.hikeGrade <= 14, `demo threshold ${e.hikeGrade}`);
});

test("a wall that reaches the hiking gradient is hiked, even inside a gentle climb", () => {
  assert.equal(climbTactic({ avg: 5, steep: 16, delta: 90 }, 15, false), "Hike the steep part");
  assert.equal(climbTactic({ avg: 5, steep: 12, delta: 90 }, 15, false), "Run evenly, do not surge");
  assert.equal(climbTactic({ avg: 14, steep: 18, delta: 90 }, 15, false), "Hike");
});

test("several reference runs: the recent one weighs more", () => {
  const recent = parseGpx(makeDemoEffortGpx({ fatigue: 0.15, startIso: "2026-10-11T08:00:00Z" }));
  const old = parseGpx(makeDemoEffortGpx({ fatigue: 0.4, startIso: "2026-08-16T08:00:00Z" })); // 8 weeks older: weight 1/4
  const one = analyseEffort(recent);
  const both = analyseEffort([recent, old]);
  const oldOnly = analyseEffort(old);
  const flat = (x) => x.bands.find((b) => b.id === "f0").tired;
  assert.equal(both.runs.length, 2);
  assert.ok(Math.abs(both.runs.find((r) => r.date === "2026-08-16").weight - 0.25) < 0.01);
  assert.ok(flat(both) > flat(one) && flat(both) < flat(oldOnly), "in between");
  assert.ok(flat(both) - flat(one) < flat(oldOnly) - flat(both), "closer to the recent run");
  const plan = buildPlan(race, [recent, old]);
  assert.equal(plan.effort.runs.length, 2);
});

test("aid stations: parsed from text, stop time added after them, gels moved there", () => {
  assert.deepEqual(parseAidStations("12,6 km Col 3 min\n8.5 Refuge du Lac 2; 18 Ferme"), [
    { km: 8.5, name: "Refuge du Lac", stopMin: 2 },
    { km: 12.6, name: "Col", stopMin: 3 },
    { km: 18, name: "Ferme", stopMin: 0 },
  ]);
  const base = buildPlan(race, effort, { gelEveryMin: 45 });
  const withAid = buildPlan(race, effort, { gelEveryMin: 45, aidStations: "8.5 Refuge 2\n16 Ferme 3" });
  const c = (p) => p.scenarios.central;
  assert.ok(Math.abs(c(withAid).finishSec - c(base).finishSec - 300) < 1e-6, "5 min of stops added to the finish");
  const ref = withAid.aidStations[0];
  const noStopAt85 = buildPlan(race, effort, { checkpointKm: 8.5 }).scenarios.central.checkpoints[0].sec;
  assert.ok(Math.abs(ref.arrive.central - noStopAt85) < 1, "arrival at the first station is not delayed by its own stop");
  assert.ok(c(withAid).gels.some((g) => g.at === "Refuge" || g.at === "Ferme"), "a gel is taken at an aid station");
  for (const p of [base, withAid]) assert.ok(c(p).gels.every((g) => g.sec <= c(p).finishSec - 15 * 60), "no gel in the last 15 minutes");
  assert.match(planToMarkdown(withAid), /## Aid stations/);
});

test("climbs start where the slope starts, not at the start of the flat before it", () => {
  const plan = buildPlan(parseGpx(makeDemoRaceGpx([[2000, 0], [1500, 8], [1500, 0], [1500, -8], [500, 0]])), effort);
  assert.equal(plan.climbs.length, 1);
  assert.ok(Math.abs(plan.climbs[0].startKm - 2) < 0.15 && Math.abs(plan.climbs[0].endKm - 3.5) < 0.15, `${plan.climbs[0].startKm} to ${plan.climbs[0].endKm}`);
  assert.ok(Math.abs(plan.descents.at(-1).startKm - 5) < 0.15);
});

test("demo ultra: long climbs split into sections, no two gels at once, none left without food for long", () => {
  const ultra = parseGpx(makeDemoRaceGpx(DEMO_ULTRA_PROFILE, { startEle: 650 }));
  const run = parseGpx(makeDemoEffortGpx({ profile: DEMO_LONG_RUN_PROFILE }));
  const plan = buildPlan(ultra, run, { aidStations: DEMO_ULTRA_AID });
  assert.ok(plan.course.totalKm > 75 && plan.course.gain > 3500);
  assert.ok(plan.climbs.filter((c) => c.sections?.length > 1).length >= 3);
  assert.equal(plan.aidStations.length, 7);
  for (const s of Object.values(plan.scenarios)) {
    for (let i = 1; i < s.gels.length; i++) {
      const gap = s.gels[i].sec - s.gels[i - 1].sec;
      assert.ok(gap > 0, `${s.id}: two gels at ${s.gels[i].km} km`);
      assert.ok(gap <= (45 + 20) * 60 + 60, `${s.id}: ${Math.round(gap / 60)} min without a gel before ${s.gels[i].km} km`);
    }
  }
});

test("demo loop: the map course closes on itself and keeps the profile's length", () => {
  const loop = parseGpx(makeDemoRaceGpx(DEMO_ULTRA_PROFILE, { startEle: 650, loop: true, center: [45.05, 5.7] }));
  const rs = resample(loop, 10);
  const want = DEMO_ULTRA_PROFILE.reduce((s, [l]) => s + l, 0);
  assert.ok(Math.abs(rs.totalM - want) / want < 0.005, `${rs.totalM} m for ${want} m`);
  assert.ok(haversine(loop.points[0], loop.points.at(-1)) < 30, "finish back at the start");
  assert.ok(Math.abs(rs.lat[0] - 45.05) < 1e-6 && Math.abs(rs.lon[0] - 5.7) < 1e-6);
});

test("race-day replay: timeline, script and position follow the plan", () => {
  const ultra = parseGpx(makeDemoRaceGpx(DEMO_ULTRA_PROFILE, { startEle: 650, loop: true, center: [45.05, 5.7] }));
  const run = parseGpx(makeDemoEffortGpx({ profile: DEMO_LONG_RUN_PROFILE }));
  const plan = buildPlan(ultra, run, { aidStations: DEMO_ULTRA_AID, startTime: "06:00" });
  const P = plan.course.profile;
  assert.equal(plan.course.route.length, P.length);
  assert.ok(Math.abs(P.at(-1)[0] - plan.course.totalKm) < 1e-9, "profile reaches the finish");
  for (const s of Object.values(plan.scenarios)) {
    assert.equal(s.timeline.length, P.length);
    assert.equal(s.timeline[0], 0);
    assert.ok(Math.abs(s.timeline.at(-1) - s.finishSec) <= 1);
    for (let i = 1; i < s.timeline.length; i++) assert.ok(s.timeline[i] >= s.timeline[i - 1]);
  }
  const script = raceScript(plan, "central");
  for (let i = 1; i < script.length; i++) assert.ok(script[i].sec >= script[i - 1].sec, "in time order");
  assert.equal(script[0].kind, "start");
  assert.equal(script.at(-1).kind, "finish");
  assert.equal(script.filter((e) => e.kind === "aid").length, 7);
  assert.equal(script.filter((e) => e.kind === "gel").length, plan.scenarios.central.gels.length);
  // Halfway in distance is reached at the time the plan says, and the state agrees.
  const half = secAtKm(plan, "central", plan.course.totalKm / 2);
  assert.ok(Math.abs(raceStateAt(plan, "central", half).km - plan.course.totalKm / 2) < 0.05);
  // Standing at an aid station: the clock runs, the runner does not move.
  const a = plan.aidStations.find((x) => x.stopMin >= 5);
  const t0 = a.arrive.central + 60, t1 = a.arrive.central + a.stopMin * 60 - 60;
  const s0 = raceStateAt(plan, "central", t0), s1 = raceStateAt(plan, "central", t1);
  assert.equal(s0.aid.name, a.name);
  assert.equal(s0.km, s1.km);
  assert.equal(s0.pace, null);
  // On a climb, the state names it.
  const c = plan.climbs.find((x) => x.level >= 3);
  const mid = raceStateAt(plan, "central", c.start.central + c.dur.central / 2);
  assert.equal(mid.climb.n, c.n);
  assert.ok(mid.grade > 0);
});

test("key zones: more on a longer race, the last big climb among them, never overlapping", () => {
  const ultra = parseGpx(makeDemoRaceGpx(DEMO_ULTRA_PROFILE, { startEle: 650 }));
  const run = parseGpx(makeDemoEffortGpx({ profile: DEMO_LONG_RUN_PROFILE }));
  const plan = buildPlan(ultra, run, { aidStations: DEMO_ULTRA_AID });
  const z = plan.keyZones;
  assert.ok(z.length >= 4 && z.length <= 7, `${z.length} zones on 78 km`);
  for (let i = 1; i < z.length; i++) assert.ok(z[i].fromKm >= z[i - 1].toKm - 0.05, "in course order, no overlap");
  assert.ok(z.some((x) => /Last big climb/.test(x.title)));
  assert.ok(z.every((x) => x.stakeMin >= 1 && x.why && x.how && ["attack", "prepare", "manage"].includes(x.mode)));
  // Portions, not whole climbs: no zone covers a long climb end to end unless it merged its sections.
  assert.ok(new Set(z.map((x) => x.mode)).size >= 2, "not only attack zones");
  assert.ok(z.every((x) => x.toKm - x.fromKm <= 8));
  // A short race gets fewer zones; they appear in the replay script.
  const short = buildPlan(race, effort);
  assert.ok(short.keyZones.length >= 1 && short.keyZones.length <= 2);
  assert.equal(raceScript(short, "central").filter((e) => e.kind === "key").length, short.keyZones.length);
  // Later counts more: runners spread apart as the race goes on.
  assert.ok(spreadAt(0.9) > 4 * spreadAt(0.1));
});

test("key zones from the course alone: Tobler's hiking function as a typical runner's clock", () => {
  const P = [[0, 100], [1, 100], [2, 300], [3, 100]]; // flat, +20%, -20%
  const t = toblerClock(P);
  const flat = t(1) - t(0), up = t(2) - t(1), down = t(3) - t(2);
  assert.ok(up > 2 * flat && down > flat && up > down, `${flat} ${up} ${down}`);
  const brief = { totalKm: 3, climbs: [{ n: 1, startKm: 1, endKm: 2, gain: 200, avg: 20, lenM: 1000 }], descents: [] };
  const zones = keyZones(brief, P, [], t);
  assert.equal(zones.length, 1);
  assert.equal(zones[0].kind, "climb");
  assert.equal(zones[0].mode, "attack");
});

test("plan renders to Markdown", () => {
  const md = planToMarkdown(buildPlan(race, effort), "central");
  assert.match(md, /# Race plan/);
  assert.match(md, /## Climbs/);
  assert.match(md, /Finish:/);
});

test("format helpers", () => {
  assert.equal(mmss(207), "3:27");
  assert.equal(hm(12420), "3h27");
  assert.equal(clock(9 * 3600, 3 * 3600 + 27 * 60), "12:27");
  assert.equal(parseClock("09:30"), 34200);
  assert.equal(parseDuration("56:30", true), 3390);
  assert.equal(parseDuration("1:55"), 6900);
  assert.equal(parseDuration("1:55:30"), 6930);
  assert.equal(parseDuration("abc"), null);
});

test("race legs: the whole course in numbered sections, end to end, with the briefing's climbs", () => {
  const ultra = parseGpx(makeDemoRaceGpx(DEMO_ULTRA_PROFILE, { startEle: 650 }));
  const run = parseGpx(makeDemoEffortGpx({ profile: DEMO_LONG_RUN_PROFILE }));
  const plan = buildPlan(ultra, run, { aidStations: DEMO_ULTRA_AID });
  const legs = raceLegs(plan, "central");
  assert.equal(legs[0].startKm, 0);
  assert.equal(legs.at(-1).endKm, plan.course.totalKm);
  legs.forEach((l, i) => {
    assert.equal(l.i, i + 1);
    assert.ok(l.endKm > l.startKm);
    if (i) assert.equal(l.startKm, legs[i - 1].endKm, "no gap, no overlap");
    assert.ok(l.durSec > 0 && l.endSec >= l.startSec);
  });
  // Every climb section of the briefing is a section here, and the times add up to the finish.
  const parts = plan.climbs.flatMap((c) => (c.sections.length ? c.sections : [c]));
  assert.equal(legs.filter((l) => l.kind === "climb").length, parts.length);
  assert.equal(legs.filter((l) => l.kind === "descent").length, plan.descents.length);
  assert.ok(Math.abs(legs.reduce((t, l) => t + l.durSec, 0) - plan.scenarios.central.finishSec) < 1);
  assert.equal(legs.reduce((t, l) => t + l.gels.length, 0), plan.scenarios.central.gels.length);
  assert.equal(legs.reduce((t, l) => t + l.aids.length, 0), plan.aidStations.length);
  // A climb gains, a descent drops, and legAtKm finds the section you are in.
  const c = legs.find((l) => l.kind === "climb" && l.level >= 3);
  assert.ok(c.up > 50 && c.avg > 0);
  assert.equal(legs[legAtKm(legs, (c.startKm + c.endKm) / 2)], c);
  assert.equal(legAtKm(legs, plan.course.totalKm), legs.length - 1);

  // Totals: pace is the finish time over the distance; the heart-rate forecast sits in the guide.
  const t = raceTotals(plan, "central");
  assert.equal(t.gels, plan.scenarios.central.gels.length);
  assert.ok(Math.abs(t.paceSec * t.km - plan.scenarios.central.finishSec) < 1e-6);
  assert.ok(t.movingPaceSec < t.paceSec, "aid stops left out of the moving pace");
  assert.ok(t.hrAvg >= t.hrMin && t.hrAvg <= t.hrMax);
  assert.equal(raceTotals({ ...plan, hrGuide: null }, "central").hrAvg, null);
});

/* ---------- My run: review of a recorded run ---------- */
import { analyseRun, runStateAt, runSecAtKm, runLegAt, effortFactor, minettiCost, runTarget, parseTarget } from "../src/core/review.js";
import { makeDemoRunGpx, DEMO_REVIEW_PROFILE } from "../src/demo.js";

test("grade-adjusted pace: Minetti's energy cost, half of the downhill saving kept", () => {
  assert.equal(minettiCost(0), 3.6);
  assert.equal(effortFactor(0), 1);
  assert.ok(Math.abs(effortFactor(10) - 1.66) < 0.01);
  assert.ok(effortFactor(20) > effortFactor(10));
  assert.ok(effortFactor(-10) < 1 && effortFactor(-10) >= 0.7);
  assert.ok(effortFactor(-10) > minettiCost(-10) / 3.6); // a trail descent saves less than the lab says
});

test("review: a planned route (no timestamps) is refused", () => {
  assert.throws(() => analyseRun(race), /timestamps/);
});

test("review: totals, stops and sections of the sample run", () => {
  const run = analyseRun(parseGpx(makeDemoRunGpx()));
  const totalKm = DEMO_REVIEW_PROFILE.reduce((s, [l]) => s + l, 0) / 1000;
  assert.ok(Math.abs(run.totalKm - totalKm) < 0.3, `${run.totalKm} km`);
  // the two stops: 90 s at km 6, 4 min at km 11
  const big = run.stops.filter((s) => s.durSec >= 60);
  assert.equal(big.length, 2);
  assert.ok(Math.abs(big[0].km - 6) < 0.2 && Math.abs(big[0].durSec - 90) < 15);
  assert.ok(Math.abs(big[1].km - 11) < 0.2 && Math.abs(big[1].durSec - 240) < 20);
  assert.ok(Math.abs(run.elapsedSec - run.movingSec - run.stopSec) < 1e-6 && run.stopSec >= 320);
  // sections end to end, numbered, each with a verdict
  assert.equal(run.legs[0].startKm, 0);
  assert.ok(Math.abs(run.legs[run.legs.length - 1].endKm - run.totalKm) < 1e-9);
  run.legs.forEach((l, i) => { assert.equal(l.i, i + 1); if (i) assert.ok(Math.abs(l.startKm - run.legs[i - 1].endKm) < 1e-9); assert.ok(["good", "ok", "bad"].includes(l.tone)); });
  assert.equal(runLegAt(run.legs, 0), 0);
  assert.equal(runLegAt(run.legs, run.totalKm), run.legs.length - 1);
});

test("review: key moments find the story written into the sample run", () => {
  const run = analyseRun(parseGpx(makeDemoRunGpx()));
  const m = run.moments;
  const find = (kind, tone) => m.find((x) => x.kind === kind && x.tone === tone);
  for (let i = 1; i < m.length; i++) assert.ok(m[i].sec >= m[i - 1].sec, "in time order");
  assert.equal(m[0].kind, "start");
  assert.equal(m[m.length - 1].kind, "finish");
  assert.ok(find("climb", "good").km < 6, "the strong climb is the first one");
  assert.ok(find("climb", "bad").km > 19, "the weak climb is the last one");
  assert.ok(find("fade", "bad").km > 14, "the fade starts after 60% of the run");
  const walk = find("walk", "bad");
  assert.ok(walk && walk.km > 18.8 && walk.km < 19.4, "walking on the flat at km 19");
  assert.ok(find("drift", "bad"), "heart rate drifts upwards");
  assert.equal(m.filter((x) => x.kind === "stop").length, 2);
});

test("review: the replay state follows the recorded time, standing still during a stop", () => {
  const run = analyseRun(parseGpx(makeDemoRunGpx()));
  const stop = run.stops.find((s) => s.durSec > 200);
  const a = runStateAt(run, stop.sec + 30);
  const b = runStateAt(run, stop.sec + 200);
  assert.ok(a.stopped && b.stopped);
  assert.ok(Math.abs(a.km - b.km) < 0.011, "no more than one 10 m sample during the stop");
  let last = -1;
  for (let s = 0; s <= run.elapsedSec; s += 60) { const x = runStateAt(run, s); assert.ok(x.km >= last); last = x.km; }
  assert.ok(Math.abs(runStateAt(run, run.elapsedSec).km - run.totalKm) < 0.011);
  assert.ok(Math.abs(runSecAtKm(run, 5) - runStateAt(run, runSecAtKm(run, 5)).sec) < 1e-6);
  assert.ok(Math.abs(runStateAt(run, runSecAtKm(run, 5)).km - 5) < 0.011);
});

test("judgeTarget sorts a target finish time against the scenarios", () => {
  const plan = { course: { totalKm: 50 }, scenarios: { best: { finishSec: 9650 }, central: { finishSec: 10000 }, cautious: { finishSec: 10350 } } };
  assert.equal(judgeTarget(plan, null), null);
  assert.equal(judgeTarget(plan, 10000).verdict, "realistic");
  assert.equal(judgeTarget(plan, 9500).verdict, "ambitious");
  const far = judgeTarget(plan, 8000);
  assert.equal(far.verdict, "out-of-reach");
  assert.equal(far.ok, false);
  assert.ok(Math.abs(far.vsCentralPct - 25) < 1e-9);
  assert.equal(judgeTarget(plan, 12000).verdict, "comfortable");
  assert.equal(judgeTarget(plan, 10000).paceSec, 200);
});

test("review target: reads times and paces typed by a person", () => {
  assert.deepEqual(parseTarget("time", "2:45"), { kind: "time", value: 2 * 3600 + 45 * 60 });
  assert.deepEqual(parseTarget("time", "2h45"), { kind: "time", value: 2 * 3600 + 45 * 60 });
  assert.deepEqual(parseTarget("time", "2:45:30"), { kind: "time", value: 2 * 3600 + 45 * 60 + 30 });
  assert.deepEqual(parseTarget("pace", "6:15"), { kind: "pace", value: 375 });
  assert.deepEqual(parseTarget("pace", "6'15/km"), { kind: "pace", value: 375 });
  assert.equal(parseTarget("time", "soon"), null);
  assert.equal(parseTarget("pace", ""), null);
});

test("review target: section targets add up to the target, and the verdict follows the gap", () => {
  const run = analyseRun(parseGpx(makeDemoRunGpx()));
  const loose = runTarget(run, { kind: "time", value: run.elapsedSec + 600 });
  assert.equal(loose.status, "reached");
  const t = runTarget(run, { kind: "time", value: run.elapsedSec - 900 });
  // Moving targets + the stop allowance = the target; the ghost runner arrives on time.
  const sum = t.legs.reduce((s, l) => s + l.tgtSec, 0) + t.stopAllow;
  assert.ok(Math.abs(sum - t.targetSec) < 2, `${sum} vs ${t.targetSec}`);
  assert.ok(Math.abs(t.ghostAt(run.totalKm) - t.targetSec) < 30);
  assert.ok(t.effortPct > 0 && t.gapSec > 0);
  // The gap is split into stops, fade and speed, without counting anything twice.
  assert.ok(Math.abs(Math.min(t.gapSec, t.stopGain + t.fadeGain) + t.speedGain - t.gapSec) < 1);
  // The sample run fades: the late sections are where the time is.
  assert.ok(t.lose.length > 0 && t.lose[0].startKm > run.totalKm / 2);
  const far = runTarget(run, { kind: "time", value: run.elapsedSec * 0.7 });
  assert.equal(far.status, "far");
  assert.ok(far.realisticSec < run.elapsedSec && far.realisticSec > far.targetSec);
  const pace = runTarget(run, { kind: "pace", value: 330 });
  assert.ok(Math.abs(pace.targetSec - 330 * run.totalKm) < 1e-6);
});
