// Tune my engine (signed-in users): the saved settings (src/core/profile.js tuneClean) and how they
// reach the plan (src/core/plan.js tuneEffort and buildPlan's params.tune).
import { test } from "node:test";
import assert from "node:assert/strict";
import { tuneClean, tuneIsDefault, profileClean } from "../src/core/profile.js";
import { buildPlan, tuneEffort } from "../src/core/plan.js";
import { parseGpx } from "../src/core/track.js";
import { makeDemoRaceGpx, makeDemoEffortGpx } from "../src/demo.js";

test("tuning: defaults, out of range values dropped, kept in the profile", () => {
  const d = tuneClean(null);
  assert.equal(d.on, false);
  assert.ok(tuneIsDefault(d));
  const t = tuneClean({ on: true, level: -5, fatigue: 999, k: 0.08, night: "x", bands: [[10, 20], [99, -3]] });
  assert.equal(t.level, -5);
  assert.equal(t.fatigue, 100);
  assert.equal(t.k, 0.08);
  assert.equal(t.night, 8);
  assert.deepEqual(t.bands[0], [10, 20]);
  assert.deepEqual(t.bands[1], [0, -3]);
  assert.equal(t.bands.length, 10);
  assert.equal(profileClean({ tune: { on: true, level: 3 } }).tune.level, 3);
  // Small enough for the online profile (4 KB) and no heart or weight key.
  assert.ok(JSON.stringify(t).length < 600);
  assert.ok(!/(hr|heart|weight)/i.test(Object.keys(t).join()));
});

test("tuneEffort: level on every pace, fatigue on the tired gap only", () => {
  const eff = { flatPace: 360, bands: [{ id: "f0", fresh: 360, tired: 400, pace: 370 }, { id: "u3", fresh: 600, tired: 700, pace: 640 }] };
  const base = tuneClean({});
  const fast = tuneEffort(eff, { ...base, level: -10 });
  assert.equal(fast.flatPace, 324);
  const noGap = tuneEffort(eff, { ...base, fatigue: 0 });
  assert.equal(noGap.bands[1].tired, 600);
  const steep = tuneEffort(eff, { ...base, bands: [[0, 0], [20, 0]] });
  assert.equal(steep.bands[1].fresh, 720);
});

test("buildPlan: a tuning changes the plan, none leaves it as before", () => {
  const race = parseGpx(makeDemoRaceGpx());
  const runs = [parseGpx(makeDemoEffortGpx())];
  const plain = buildPlan(race, runs, {});
  const same = buildPlan(race, runs, { tune: tuneClean({ on: true }) });
  const slow = buildPlan(race, runs, { tune: tuneClean({ on: true, level: 5, night: 20 }) });
  assert.equal(plain.tuned, false);
  assert.equal(same.tuned, true);
  assert.ok(Math.abs(same.scenarios.central.finishSec - plain.scenarios.central.finishSec) < 2);
  assert.ok(slow.scenarios.central.finishSec > plain.scenarios.central.finishSec * 1.04);
});
