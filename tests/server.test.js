// The server functions' logic (supabase/functions/_shared/cairns.js) with a fake database and a
// fake Claude: cairns are paid once, impossible runs do not count, a failed analysis refunds.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { claimCairns, aiStart, aiRun, aiRequest, AI_SCHEMA } from "../supabase/functions/_shared/cairns.js";
import { checkRecord, aiDigest } from "../src/core/history.js";

const DAY = 86400000;
const NOW = Date.UTC(2026, 9, 15);
const run = (i, over = {}) => ({ id: `${1790000000 + i}-${2000 + i}`, v: 1, date: NOW - i * DAY, name: `Run ${i}`, km: 20 + i, gain: 900,
  movingSec: 3 * 3600, elapsedSec: 3.2 * 3600, gapPace: 330, hrAvg: 150, fadePct: 4, decouplingPct: 6, vam: 700, best1k: 260, best5k: 1500, best10k: 3200, ...over });

function fakeDb(runs, ledger = []) {
  const jobs = new Map();
  return {
    ledger, jobs,
    listRuns: async () => runs,
    listLedger: async () => ledger,
    addLedger: async (rows) => rows.filter((r) => {
      const once = r.reason.startsWith("ach:") ? ledger.some((l) => l.reason === r.reason) : r.reason === "refund" && ledger.some((l) => l.reason === "refund" && l.ref === r.ref);
      if (!once) ledger.push(r);
      return !once;
    }),
    spendCairn: async (u, job) => { if (ledger.reduce((s, r) => s + r.delta, 0) < 1) return false; ledger.push({ delta: -1, reason: "ai", ref: job }); return true; },
    runningJob: async () => [...jobs.values()].some((j) => j.status === "running"),
    createJob: async (j) => { jobs.set(j.id, { ...j }); },
    finishJob: async (id, patch) => { Object.assign(jobs.get(id), patch); },
  };
}
const balance = (db) => db.ledger.reduce((s, r) => s + r.delta, 0);

test("server copy of history.js is up to date (run npm run build)", () => {
  assert.equal(readFileSync("supabase/functions/_shared/history.js", "utf8"), readFileSync("src/core/history.js", "utf8"));
});

test("checkRecord accepts real runs and rejects impossible ones", () => {
  assert.equal(checkRecord(run(1), NOW), null);
  assert.ok(checkRecord(run(1, { best1k: 100 }), NOW), "1 km under world record");
  assert.ok(checkRecord(run(1, { movingSec: 600 }), NOW), "21 km in 10 min");
  assert.ok(checkRecord(run(1, { gain: 20000 }), NOW), "20 km of climbing in 3 h");
  assert.ok(checkRecord(run(1, { date: NOW + 5 * DAY }), NOW), "a run in the future");
  assert.ok(checkRecord({ ...run(1), km: "21" }, NOW), "a string instead of a number");
});

test("claimCairns pays each achievement once, from believable runs only", async () => {
  const db = fakeDb([run(1), run(2), run(3, { km: 52 })]);
  const a = await claimCairns(db, "u", NOW);
  // first (1) + half (0) + marathon (1) + ultra (2) = 4
  assert.deepEqual(a.added.sort(), ["ach:first", "ach:marathon", "ach:ultra"]);
  assert.equal(a.balance, 4);
  const b = await claimCairns(db, "u", NOW);
  assert.deepEqual(b.added, []);
  assert.equal(b.balance, 4);
  const fake = fakeDb([run(1, { km: 120, movingSec: 1800 })]);
  const c = await claimCairns(fake, "u", NOW);
  assert.equal(c.balance, 0, "a 120 km run in 30 min earns nothing");
});

test("an AI analysis spends one cairn, saves the answer, and refunds on failure", async () => {
  const runs = [run(1), run(2), run(3)];
  const answer = { headline: "h", summary: "s", kpis: [], strengths: [], focus: [], next_weeks: "n" };
  const db = fakeDb(runs, [{ delta: 1, reason: "ach:first" }]);
  let sent = null;
  const ok = async (req) => { sent = req; return { stop_reason: "end_turn", model: req.model, content: [{ type: "text", text: JSON.stringify(answer) }], usage: { input_tokens: 10, output_tokens: 5 } }; };
  const s = await aiStart({ db, userId: "u", athlete: { hrMax: 188, weight: 71, evil: "x" }, now: NOW, newId: () => "job1" });
  assert.equal(s.status, 202);
  assert.equal(balance(db), 0);
  assert.equal((await aiStart({ db, userId: "u", now: NOW, newId: () => "job2" })).status, 409, "one analysis at a time");
  assert.deepEqual(await aiRun({ db, callClaude: ok, userId: "u", job: s.job, digest: s.digest }), answer);
  assert.equal(db.jobs.get("job1").status, "done");
  assert.equal(sent.model, "claude-opus-5-5");
  assert.equal(sent.fallbacks, "default");
  assert.ok(!JSON.stringify(sent).includes("Run 1"), "run names are not sent");
  assert.ok(!JSON.stringify(sent).includes("evil"), "only known athlete settings are sent");
  // No cairn left: refused before anything is spent.
  assert.equal((await aiStart({ db, userId: "u", now: NOW, newId: () => "job3" })).status, 402);
  // A failure gives the cairn back, once.
  const db2 = fakeDb(runs, [{ delta: 1, reason: "event:launch" }]);
  const s2 = await aiStart({ db: db2, userId: "u", now: NOW, newId: () => "job4" });
  const refused = async () => ({ stop_reason: "refusal", content: [] });
  assert.equal(await aiRun({ db: db2, callClaude: refused, userId: "u", job: s2.job, digest: s2.digest }), null);
  assert.equal(balance(db2), 1);
  assert.equal(db2.jobs.get("job4").status, "failed");
  // Too few runs.
  assert.equal((await aiStart({ db: fakeDb([run(1)], [{ delta: 1, reason: "ach:first" }]), userId: "u", now: NOW, newId: () => "j" })).status, 400);
});

test("the AI request is built from the digest and asks for the app's JSON shape", () => {
  const d = aiDigest([run(1), run(2)], { hrMax: 188 });
  assert.equal(d.runs, 2);
  assert.ok(d.table.startsWith("date,km"));
  const r = aiRequest(d);
  assert.deepEqual(r.output_config.format.schema, AI_SCHEMA);
  assert.ok(r.messages[0].content.includes("max heart rate 188"));
  assert.ok(!("thinking" in r) && !("temperature" in r));
});
