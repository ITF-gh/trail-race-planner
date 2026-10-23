// The Prep my race AI call, without any network (src/core/aiprep.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { planFromGpx } from "../src/core/plan.js";
import { raceLegs, secAtKm, racePaceLine } from "../src/core/script.js";
import { demoRecords } from "../src/core/demorecords.js";
import { makeDemoRaceGpx, makeDemoEffortGpx, DEMO_ULTRA_PROFILE, DEMO_ULTRA_AID, DEMO_LONG_RUN_PROFILE } from "../src/demo.js";
import { aiPrepInput, aiPrepRequest, aiPrepRead, aiPrepMerge, aiPrepFake, AI_PREP_SCHEMA, AI_PREP_INSTRUCTIONS } from "../src/core/aiprep.js";

// The demo ultra, its two reference runs and the demo profile's stored runs: built once.
const plan = planFromGpx(
  makeDemoRaceGpx(DEMO_ULTRA_PROFILE, { name: "Ultra", startEle: 650, loop: true, center: [45.05, 5.7] }),
  [makeDemoEffortGpx({ profile: DEMO_LONG_RUN_PROFILE, startIso: "2026-10-11T07:00:00Z" }), makeDemoEffortGpx({ profile: DEMO_LONG_RUN_PROFILE, fatigue: 0.3, startIso: "2026-08-30T07:00:00Z" })],
  { aidStations: DEMO_ULTRA_AID, startTime: "06:00" },
);
const input = aiPrepInput(plan, { raceName: "Ultra\n<b>", history: demoRecords(), user: { targetSec: 36000, notes: "Knee\u0000 pain", question: "Is 10:00 realistic?" } });
// An AI answer that keeps every calculated value: the rebuild must give back the same plan.
const same = () => { const f = aiPrepFake(input); f.dataset.legs.forEach((l) => { l.durSec = input.calc.legs.find((c) => c.id === l.id).durSec; }); return f; };

test("input: legs L1..Ln end to end, calc times, engine, history, cleaned texts", () => {
  const legs = raceLegs(plan, "central");
  assert.equal(input.race.legs.length, legs.length);
  assert.deepEqual(input.race.legs.map((l) => l.id), legs.map((l, i) => `L${i + 1}`));
  assert.equal(input.race.legs[0].startKm, 0);
  assert.ok(Math.abs(input.race.legs.at(-1).endKm - plan.course.totalKm) < 0.01);
  assert.equal(input.race.aid.length, 7);
  assert.equal(input.engine.bands.length, 10);
  assert.ok(input.engine.historyRuns > 10 && input.engine.history.startsWith("date,km"));
  assert.equal(input.user.goal, "target", "a target time makes the goal 'target'");
  assert.equal(input.user.notes, "Knee pain", "control characters removed");
  assert.equal(input.race.name, "Ultra <b>");
  // Moving times plus the typed stops add up to the calculated finish.
  const sum = input.calc.legs.reduce((t, l) => t + l.durSec, 0) + input.race.aid.reduce((t, s) => t + s.stopMin * 60, 0);
  assert.ok(Math.abs(sum - plan.scenarios.central.finishSec) < 60);
});

test("request: fixed instructions, data with tagged notes and question, strict schema", () => {
  const r = aiPrepRequest(input, { model: "test-model" });
  assert.equal(r.model, "test-model");
  assert.equal(r.instructions, AI_PREP_INSTRUCTIONS);
  assert.match(r.instructions, /CHECK FIRST/);
  assert.match(r.input, /^PARAMETERS/);
  assert.match(r.input, /dataset check: LEGS has \d+ rows over [\d.]+ km.*NOT empty/);
  assert.match(r.input, /<athlete_notes>Knee pain<\/athlete_notes>/);
  assert.match(r.input, /<question>Is 10:00 realistic\?<\/question>/);
  assert.equal(r.text.format.strict, true);
  assert.equal(r.store, false);
  // gpt-4o-mini (the default) takes no reasoning setting; a gpt-5 model does.
  assert.equal(aiPrepRequest(input).model, "gpt-4o-mini");
  assert.equal(aiPrepRequest(input).reasoning, undefined);
  assert.equal(aiPrepRequest(input).max_output_tokens, 16000);
  assert.equal(aiPrepRequest(input, { model: "gpt-5.4-mini" }).reasoning.effort, "medium");
  // Strict mode: every object lists all its fields as required and forbids others.
  const walk = (s) => {
    if (s.anyOf) return s.anyOf.forEach(walk);
    if (s.type === "object") { assert.deepEqual(s.required, Object.keys(s.properties)); assert.equal(s.additionalProperties, false); Object.values(s.properties).forEach(walk); }
    if (s.type === "array") walk(s.items);
  };
  walk(AI_PREP_SCHEMA);
});

test("read: output text, tokens from usage, refusal, cut short", () => {
  const res = {
    model: "m", status: "completed",
    output: [{ type: "reasoning" }, { type: "message", content: [{ type: "output_text", text: JSON.stringify({ check: { status: "null", reason: "out_of_scope" }, dataset: null, texts: null }) }] }],
    usage: { input_tokens: 5000, input_tokens_details: { cached_tokens: 1200 }, output_tokens: 300, output_tokens_details: { reasoning_tokens: 250 }, total_tokens: 5300 },
  };
  const r = aiPrepRead(res);
  assert.equal(r.error, "");
  assert.equal(r.output.check.reason, "out_of_scope");
  assert.deepEqual([r.tokens.input, r.tokens.inputCached, r.tokens.output, r.tokens.reasoning, r.tokens.total], [5000, 1200, 300, 250, 5300]);
  assert.match(aiPrepRead({ ...res, output: [{ type: "message", content: [{ type: "refusal", refusal: "no" }] }] }).error, /Refused/);
  assert.match(aiPrepRead({ ...res, status: "incomplete", incomplete_details: { reason: "max_output_tokens" } }).error, /Cut short/);
  assert.match(aiPrepRead({ error: { message: "bad key" } }).error, /bad key/);
});

test("merge: the calculated values given back rebuild the same finish", () => {
  const m = aiPrepMerge(plan, input, same());
  assert.equal(m.status, "ok");
  assert.ok(Math.abs(m.finishSec - plan.scenarios.central.finishSec) < 30, `${m.finishSec} vs ${plan.scenarios.central.finishSec}`);
  assert.equal(m.legs.filter((l) => l.mark).length, 0);
});

test("merge: AI leg times move the finish by exactly their sum, the app's functions run on it", () => {
  const out = same();
  out.dataset.legs[1].durSec += 600; // 10 minutes slower on L2
  out.dataset.aid[0].stopMin += 5; // 5 more minutes at the first aid station
  out.dataset.target.finishSec = plan.scenarios.central.finishSec + 900; // the AI added it up right
  const m = aiPrepMerge(plan, input, out);
  assert.ok(Math.abs(m.finishSec - plan.scenarios.central.finishSec - 900) < 30);
  assert.ok(m.legs[1].mark && m.legs[1].pct > 3);
  assert.equal(m.aid[0].aiStopMin, input.race.aid[0].stopMin + 5);
  // The rebuilt plan has the shape the screens read: raceLegs works on it, leg 2 is 10 min longer.
  const legs = raceLegs(m.plan, "central"), calc = raceLegs(plan, "central");
  assert.ok(Math.abs(legs[1].durSec - calc[1].durSec - 600) < 30);
  assert.ok(m.plan.scenarios.best.finishSec < m.finishSec && m.plan.scenarios.cautious.finishSec > m.finishSec);
  // The pace line of the AI replay: one moving speed per profile point, slower on the slower leg.
  const pl = racePaceLine(m.plan, "central"), plc = racePaceLine(plan, "central");
  assert.equal(pl.length, m.plan.course.profile.length);
  assert.ok(pl.every((p) => p.v > 0), "aid stops (longer here) never drop the line");
  const mid = (legs[1].startKm + legs[1].endKm) / 2;
  const at = (line) => line.reduce((a, p) => (Math.abs(p.km - mid) < Math.abs(a.km - mid) ? p : a));
  assert.ok(at(pl).v < at(plc).v, "10 min slower on leg 2: the line drops there");
});

test("merge: the referee drops unknown ids, replaces impossible times, keeps missing legs", () => {
  const out = same();
  out.dataset.legs.push({ id: "L999", durSec: 100, mode: "run", effort: 2 });
  out.dataset.legs[0].durSec = 5; // a few seconds for a whole leg: impossible
  out.dataset.legs.splice(2, 1); // one leg left out
  out.dataset.aid.push({ id: "A99", stopMin: 3 });
  out.dataset.scenarios.cautiousFactor = 3;
  out.texts.watchTexts = [{ legId: "L1", text: "A WATCH TEXT FAR TOO LONG TO FIT" }];
  const m = aiPrepMerge(plan, input, out);
  assert.equal(m.status, "ok");
  assert.equal(m.legs[0].aiSec, input.calc.legs[0].durSec);
  assert.equal(m.fixes.length, 5);
  assert.equal(m.plan.scenarios.cautious.factor, 1.25);
  assert.equal(m.texts.watchTexts[0].text.length, 24);
});

test("merge: null answers, and too few legs, give an empty result", () => {
  assert.equal(aiPrepMerge(plan, input, { check: { status: "null", reason: "out_of_scope" }, dataset: null, texts: null }).reason, "out_of_scope");
  // "Empty" said of a dataset that has legs is the AI's mistake: an invalid answer.
  const wrong = aiPrepMerge(plan, input, { check: { status: "null", reason: "empty_dataset" }, dataset: null, texts: null });
  assert.equal(wrong.reason, "invalid_answer");
  assert.match(wrong.fixes[0], /dataset was empty/);
  assert.equal(aiPrepMerge(plan, { ...input, race: { ...input.race, legs: [] } }, { check: { status: "null", reason: "empty_dataset" }, dataset: null, texts: null }).reason, "empty_dataset");
  assert.equal(aiPrepMerge(plan, input, null).reason, "invalid_answer");
  const out = same();
  out.dataset.legs = out.dataset.legs.slice(0, 5);
  const m = aiPrepMerge(plan, input, out);
  assert.equal(m.status, "null");
  assert.equal(m.reason, "invalid_answer");
  assert.equal(m.plan, null);
});

test("merge: Your race reads the AI plan (tactics, notes, gels, moments, climb clocks)", async () => {
  const { raceScript } = await import("../src/core/script.js");
  const out = aiPrepFake(input);
  const m = aiPrepMerge(plan, input, out);
  const legs = raceLegs(m.plan, "central");
  const climb = legs.find((l) => l.kind === "climb");
  assert.equal(climb.tactic, { run: "Run it", hike: "Power hike it", mix: "Run the easy parts, hike the steep ones" }[out.dataset.legs[climb.i - 1].mode]);
  assert.match(climb.ai.note, /fake/);
  // The gels are the AI intakes, on the AI clock.
  assert.equal(m.plan.scenarios.central.gels.length, out.dataset.fuel.items.length);
  assert.ok(m.plan.scenarios.central.gels.every((g) => g.item === "gel" && g.sec > 0));
  // A climb's clock is read again on the AI timeline: its start matches the new clock at its foot.
  const c = m.plan.climbs[3];
  assert.equal(c.start.central, secAtKm(m.plan, "central", c.startKm));
  assert.notEqual(c.dur.central, plan.climbs[3].dur.central);
  // The AI key moment is in the race script with its cue; the calculated plan has none.
  const s = raceScript(m.plan, "central");
  assert.ok(s.some((e) => e.kind === "ai" && /hold back/.test(e.cue)));
  assert.ok(!raceScript(plan, "central").some((e) => e.kind === "ai"));
  assert.equal(raceLegs(plan, "central")[0].ai, null);
});

test("merge: legs scaled to the AI's own finish when its sum disagrees, so doc and Your race show one finish", () => {
  const f = same();
  const sum = input.calc.legs.reduce((t, l) => t + l.durSec, 0) + f.dataset.aid.reduce((t, s) => t + s.stopMin * 60, 0);
  f.dataset.target.finishSec = Math.round(sum * 0.92);
  const m = aiPrepMerge(plan, input, f);
  assert.ok(Math.abs(m.finishSec - f.dataset.target.finishSec) < 30, `${m.finishSec} vs ${f.dataset.target.finishSec}`);
  assert.equal(m.finishes.central, m.plan.scenarios.central.finishSec);
  assert.equal(m.finishes.best, m.plan.scenarios.best.finishSec);
  assert.ok(m.fixes.some((x) => x.includes("scaled")));
  // Too far apart: not trusted, the sum stays.
  f.dataset.target.finishSec = Math.round(sum * 0.5);
  const n = aiPrepMerge(plan, input, f);
  assert.ok(Math.abs(n.finishSec - sum) < 60);
  assert.ok(n.fixes.some((x) => x.includes("too far")));
});
