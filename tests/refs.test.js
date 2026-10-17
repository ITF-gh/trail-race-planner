// Your references (src/core/refs.js): Daniels' VDOT, easy pace, the levels, and how they reach the
// engine (buildPlan's params.calib, prepRunPlan's opts.calib).
import { test } from "node:test";
import assert from "node:assert/strict";
import { vdot, raceTime, refsClean, refsRead, refsCalib, calibrateEffort } from "../src/core/refs.js";
import { prepRunPlan } from "../src/core/preprun.js";
import { buildPlan } from "../src/core/plan.js";
import { parseGpx } from "../src/core/track.js";
import { makeDemoRaceGpx, makeDemoEffortGpx, DEMO_LONG_RUN_PROFILE } from "../src/demo.js";

test("VDOT matches Daniels' tables and reads back the race time", () => {
  // Daniels' table: a 45:00 10K is VDOT 45, a 40:00 10K about 52.
  assert.ok(Math.abs(vdot(10000, 2700) - 45.3) < 0.2);
  assert.ok(Math.abs(vdot(10000, 2400) - 51.9) < 0.2);
  assert.ok(Math.abs(raceTime(10000, vdot(10000, 2700)) - 2700) < 1);
});

test("easy pace from a 10K or a half, and the same fitness gives the same easy pace", () => {
  const a = refsRead({ k10: 2700 }), b = refsRead({ half: 6000 });
  assert.ok(Math.abs(a.easyPace - 332) < 3, `easy ${a.easyPace}`);
  assert.ok(Math.abs(a.easyPace - b.easyPace) < 4);
  assert.ok(a.easyRange[0] < a.easyPace && a.easyPace < a.easyRange[1]);
  // A typed easy pace wins.
  assert.equal(refsRead({ k10: 2700, easy: 345 }).easyPace, 345);
  assert.equal(refsRead({}), null);
});

test("out of range references are dropped", () => {
  assert.deepEqual(refsClean({ k10: 600, half: 6000, easy: 9 }), { k10: null, half: 6000, easy: null });
});

test("levels: easy is slower than steady, steady slower than race; both races give your exponent", () => {
  const r = { k10: 2700, half: 6000 };
  const [e, s, ra] = ["easy", "steady", "race"].map((l) => refsCalib(r, l));
  assert.ok(e.flatPace > s.flatPace && s.flatPace > ra.flatPace);
  assert.ok(Math.abs(refsRead(r).riegel - 1.07) < 0.01);
  assert.ok(ra.enduranceExp > 0.05 && ra.enduranceExp < 0.08);
  assert.equal(refsCalib({ k10: 2700 }, "race").enduranceExp, null);
});

test("calibration keeps the shape of your runs and changes the level", () => {
  const eff = { flatPace: 400, durationSec: 7200, bands: [{ fresh: 600, tired: 700, pace: 620 }, { fresh: 400, tired: 420, pace: 400 }] };
  const c = calibrateEffort(eff, { flatPace: 300, durationSec: 6000 });
  assert.equal(c.flatPace, 300);
  assert.equal(c.bands[0].fresh / c.bands[1].fresh, 600 / 400);
  assert.equal(c.durationSec, 6000);
});

test("Prep my run: references time the run at the level picked; a target time still wins", () => {
  const p = parseGpx(makeDemoRaceGpx(DEMO_LONG_RUN_PROFILE, { loop: true }));
  const r = { k10: 2700, half: 6000 };
  const easy = prepRunPlan(p, { calib: refsCalib(r, "easy") });
  const race = prepRunPlan(p, { calib: refsCalib(r, "race") });
  assert.equal(easy.timeSource, "refs");
  assert.ok(easy.scenarios.central.finishSec > race.scenarios.central.finishSec);
  const t = prepRunPlan(p, { calib: refsCalib(r, "easy"), targetSec: 4 * 3600 });
  assert.equal(t.timeSource, "target");
  assert.equal(t.scenarios.central.finishSec, 4 * 3600);
});

test("Prep my race: a faster 10K plans a faster race from the same runs", () => {
  const race = parseGpx(makeDemoRaceGpx());
  const runs = [parseGpx(makeDemoEffortGpx())];
  const slow = buildPlan(race, runs, { calib: refsCalib({ k10: 3300 }, "race") });
  const fast = buildPlan(race, runs, { calib: refsCalib({ k10: 2400 }, "race") });
  assert.ok(fast.scenarios.central.finishSec < slow.scenarios.central.finishSec);
});
