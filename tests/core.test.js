import { test } from "node:test";
import assert from "node:assert/strict";
import { parseGpx, haversine, resample } from "../src/core/track.js";
import { analyseCourse, zigzag, bandIndex, BANDS } from "../src/core/terrain.js";
import { analyseEffort } from "../src/core/effort.js";
import { predictScenario, SCENARIOS } from "../src/core/model.js";
import { buildPlan } from "../src/core/plan.js";
import { planToMarkdown } from "../src/core/markdown.js";
import { mmss, hm, clock, parseDuration, parseClock } from "../src/core/format.js";
import { makeDemoRaceGpx, makeDemoEffortGpx, DEMO_RACE_PROFILE } from "../src/demo.js";

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
    assert.equal(inside, undefined, `gel at km ${g.km} lands inside climb ${inside && inside.n}`);
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
