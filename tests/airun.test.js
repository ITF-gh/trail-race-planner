// The Prep my run AI coach, without any network (src/core/airun.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseGpx } from "../src/core/track.js";
import { prepRunPlan } from "../src/core/preprun.js";
import { raceScript, racePaceLine } from "../src/core/script.js";
import { aiPrepRead } from "../src/core/aiprep.js";
import { makeDemoRaceGpx, DEMO_LONG_RUN_PROFILE } from "../src/demo.js";
import { runSpots, runLoad, aiRunInput, aiRunRequest, aiRunMerge, aiRunFake, AI_RUN_SCHEMA, AI_RUN_INSTRUCTIONS, AI_RUN_EFFORT_DEFAULT } from "../src/core/airun.js";

// The sample long run of Prep my run (30 km, 4 climbs), built once.
const plan = prepRunPlan(parseGpx(makeDemoRaceGpx(DEMO_LONG_RUN_PROFILE, { name: "Run", startEle: 650, loop: true, center: [45.05, 5.7] })), {});
// Effort 5 (very hard): the referee tests below need room for several exercises.
const input = aiRunInput(plan, { name: "Sample\n<b>", user: { effort: 5, notes: "", question: "Climbing today?" } });
// One exercise answer, made from the fake one with the given exercises.
const answer = (exercises) => { const f = aiRunFake(input); f.dataset.exercises = exercises; return f; };
const spot = (kind) => input.spots.find((s) => s.kind === kind);

test("spots: found by the rules, inside the hard window, numbered in route order", () => {
  const spots = runSpots(plan);
  assert.ok(spots.length >= 6);
  assert.deepEqual(spots.map((s) => s.id), spots.map((s, i) => `S${i + 1}`));
  for (const k of ["flat", "climb", "steep", "descent", "caution"]) assert.ok(spots.some((s) => s.kind === k), `a ${k} spot`);
  for (const s of spots.filter((x) => x.kind !== "caution")) {
    assert.ok(s.startKm >= 2 && s.endKm <= plan.course.totalKm - 1, `${s.id} after the warm-up and before the last km`);
    assert.ok(s.exercises.length > 0);
  }
  assert.deepEqual(spot("caution").exercises, [], "a steep descent takes no exercise");
  assert.ok(spots.filter((s) => s.kind === "flat").every((s) => Math.abs(s.avgPct) <= 2 && s.lenKm >= 1.5));
  assert.ok(spots.filter((s) => s.kind === "descent").every((s) => s.avgPct <= -4 && s.avgPct >= -10));
});

test("load: a big week or a long run 2 days ago is heavy", () => {
  const now = Date.UTC(2026, 9, 16), d = 86400000;
  const usual = [8, 12, 15, 19, 22, 26, 29, 33].map((k) => ({ date: now - k * d, km: 10 }));
  assert.equal(runLoad(usual, now).heavy, false);
  assert.equal(runLoad([...usual, { date: now - d, km: 30 }], now).heavy, true);
  assert.equal(runLoad([], now), null);
});

test("input and request: same leg shape as Prep my race, coach prompt, strict schema", () => {
  assert.equal(input.mode, "prep_run");
  assert.equal(input.race.name, "Sample <b>");
  assert.equal(input.calc.finishSec.central, plan.scenarios.central.finishSec);
  assert.equal(input.race.legs.length, input.calc.legs.length);
  const r = aiRunRequest(input);
  assert.equal(r.model, "gpt-4o-mini");
  assert.equal(r.reasoning, undefined);
  assert.equal(r.instructions, AI_RUN_INSTRUCTIONS);
  assert.equal(r.text.format.schema, AI_RUN_SCHEMA);
  assert.ok(r.text.format.strict && r.store === false);
  assert.match(r.input, /SPOTS/);
  assert.match(r.input, /NOT empty/);
  assert.match(r.input, /<question>Climbing today\?<\/question>/);
  assert.ok(aiRunRequest(input, { model: "gpt-5.4-mini" }).reasoning);
  assert.equal(aiPrepRead({ usage: { total_tokens: 3 }, output: [] }, "prep_run").tokens.requestType, "prep_run");
});

test("merge: the fake answer plays, with the exercises as moments and a faster clock", () => {
  const m = aiRunMerge(plan, input, aiRunFake(input));
  assert.equal(m.status, "ok");
  assert.ok(m.exercises.length >= 1 && m.exercises.length <= 3);
  assert.ok(m.finishSec < input.calc.finishSec.central, "the reps go faster than the easy pace");
  assert.ok(m.workSec <= 0.25 * input.calc.finishSec.central);
  const s = raceScript(m.plan, "central");
  for (const e of m.exercises) assert.ok(s.some((x) => x.kind === "ai" && x.title.startsWith(e.label)), `${e.label} in the run script`);
  assert.ok(s.some((x) => x.kind === "ai" && x.title.startsWith("Careful")), "a safety cue on the steep descent");
  assert.equal(m.plan.scenarios.central.timeline.length, plan.scenarios.central.timeline.length);
  // The pace line of the AI session: no gap, and faster than the easy run inside the first exercise.
  const pl = racePaceLine(m.plan, "central"), easy = racePaceLine(plan, "central");
  assert.ok(pl.every((p) => p.v > 0));
  const e = m.exercises[0], k = pl.findIndex((p) => p.km > (e.startKm + e.endKm) / 2);
  assert.ok(pl[k].v > easy[k].v, "the reps show on the line");
});

test("referee: wrong spot, wrong kind, warm-up, overlap, ranges", () => {
  const f = spot("flat"), c = spot("climb");
  const m = aiRunMerge(plan, input, answer([
    { id: "E1", spotId: "S99", kind: "strides", startKm: 5, endKm: 6, reps: 6, workSec: 20, recoverySec: 40, effort: 4 },
    { id: "E2", spotId: f.id, kind: "downhill", startKm: f.startKm, endKm: f.endKm, reps: 3, workSec: 60, recoverySec: 60, effort: 3 },
    { id: "E3", spotId: f.id, kind: "strides", startKm: f.startKm, endKm: f.endKm, reps: 50, workSec: 20, recoverySec: 40, effort: 9 },
    { id: "E4", spotId: f.id, kind: "strides", startKm: f.startKm, endKm: f.endKm, reps: 6, workSec: 20, recoverySec: 40, effort: 4 },
    { id: "E5", spotId: c.id, kind: "uphill_threshold", startKm: 0.5, endKm: c.endKm, reps: 2, workSec: 300, recoverySec: 120, effort: 4 },
  ]));
  assert.equal(m.status, "ok");
  assert.deepEqual(m.exercises.map((e) => e.id).sort(), ["E3", "E5"]);
  const e3 = m.exercises.find((e) => e.id === "E3");
  assert.ok(e3.reps <= 20 && e3.effort === 5, "reps and effort clamped");
  assert.ok(e3.reps * (e3.workSec + e3.recoverySec) - e3.recoverySec <= f.calcSec + 1, "the reps fit in the stretch");
  const e5 = m.exercises.find((e) => e.id === "E5");
  assert.ok(e5.startKm >= 2, "moved out of the warm-up");
  const fx = m.fixes.join(" ");
  assert.match(fx, /S99 does not exist/);
  assert.match(fx, /not allowed on/);
  assert.match(fx, /shares km with E3/);
});

test("referee: injuries in the notes and a heavy load", () => {
  const d = spot("descent"), f = spot("flat");
  const ex = [
    { id: "E1", spotId: f.id, kind: "strides", startKm: f.startKm, endKm: f.endKm, reps: 8, workSec: 20, recoverySec: 40, effort: 4 },
    { id: "E2", spotId: d.id, kind: "downhill", startKm: d.startKm, endKm: d.endKm, reps: 3, workSec: 60, recoverySec: 60, effort: 4 },
  ];
  const sore = aiRunInput(plan, { user: { effort: 5, notes: "Mal au genou depuis lundi." } });
  const m = aiRunMerge(plan, sore, answer(ex));
  assert.deepEqual(m.exercises.map((e) => e.kind), ["strides"], "no downhill drill with a sore knee");
  const now = Date.UTC(2026, 9, 16);
  const tired = aiRunInput(plan, { user: { effort: 5 }, history: [{ date: now - 86400000, km: 32 }, { date: now - 9 * 86400000, km: 10 }], now });
  assert.equal(tired.engine.load.heavy, true);
  const h = aiRunMerge(plan, tired, answer(ex));
  assert.equal(h.exercises.length, 1);
  assert.ok(h.exercises[0].effort <= 3);
  assert.match(h.fixes.join(" "), /heavy load/);
});

test("referee: empty, out of scope, false empty, no exercise", () => {
  assert.equal(aiRunMerge(plan, input, { check: { status: "null", reason: "out_of_scope" }, dataset: null, texts: null }).reason, "out_of_scope");
  assert.equal(aiRunMerge(plan, input, { check: { status: "null", reason: "empty_dataset" }, dataset: null, texts: null }).reason, "invalid_answer");
  assert.equal(aiRunMerge(plan, input, null).reason, "invalid_answer");
  const easy = aiRunMerge(plan, input, answer([]));
  assert.equal(easy.status, "ok");
  const sum = easy.dataset.legs.reduce((t, l) => t + l.durSec, 0);
  assert.ok(Math.abs(easy.finishSec - sum) <= 2, "the clock is the AI's sections, added up by code");
});

test("effort: picked by the runner, sent, and capping the exercises", () => {
  assert.equal(aiRunInput(plan, {}).user.effort, AI_RUN_EFFORT_DEFAULT);
  assert.equal(aiRunInput(plan, { user: { effort: 9 } }).user.effort, 5);
  assert.match(aiRunRequest(input).input, /effort asked: 5 of 5, Very hard/);
  const f = spot("flat"), c = spot("climb");
  const ex = [
    { id: "E1", spotId: f.id, kind: "strides", startKm: f.startKm, endKm: f.endKm, reps: 6, workSec: 20, recoverySec: 40, effort: 5 },
    { id: "E2", spotId: c.id, kind: "uphill_threshold", startKm: c.startKm, endKm: c.endKm, reps: 2, workSec: 300, recoverySec: 120, effort: 5 },
  ];
  const at = (e) => aiRunInput(plan, { user: { effort: e } });
  const rec = aiRunMerge(plan, at(1), answer(ex));
  assert.equal(rec.exercises.length, 0, "recovery: no exercise");
  assert.match(rec.fixes.join(" "), /recovery run takes no exercise/);
  const easy = aiRunMerge(plan, at(2), answer(ex));
  assert.equal(easy.exercises.length, 1);
  assert.ok(easy.exercises[0].effort <= 3, "easy: effort 3 at most");
  assert.equal(aiRunMerge(plan, at(4), answer(ex)).exercises.length, 2);
});

test("sections: the AI times set the clock, checked like Prep my race", () => {
  const out = aiRunFake(input);
  out.dataset.legs[0].durSec = 1; // 2:30 per km at least
  out.dataset.legs.push({ id: "L999", durSec: 600, mode: "run", effort: 2 });
  const m = aiRunMerge(plan, input, out);
  assert.match(m.fixes.join(" "), /L999 does not exist/);
  assert.equal(m.legs[0].aiSec, m.legs[0].calcSec, "an absurd time falls back to the calculated one");
  assert.equal(m.legs.length, input.race.legs.length);
  const few = aiRunFake(input);
  few.dataset.legs = few.dataset.legs.slice(0, 1);
  assert.equal(aiRunMerge(plan, input, few).reason, "invalid_answer");
});
