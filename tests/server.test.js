// The server functions' logic (supabase/functions/_shared/cairns.js and aicall.js) with a fake
// database and a fake OpenAI: cairns are paid once, impossible runs do not count, an AI request
// spends one edelweiss and gives it back only when OpenAI never answered.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { claimCairns } from "../supabase/functions/_shared/cairns.js";
import { aiBegin, aiFinish, aiNoBody, AI_MODEL } from "../supabase/functions/_shared/aicall.js";
import { aiPrepFake } from "../src/core/aiprep.js";
import { checkRecord, aiDigest, aiAsk, aiSelect, recordClean, AI_FOCUS } from "../src/core/history.js";
import { profileClean, profileBests, flagEmoji } from "../src/core/profile.js";
import { demoRecords } from "../src/core/demorecords.js";

const DAY = 86400000;
const NOW = Date.UTC(2026, 9, 15);
const run = (i, over = {}) => ({ id: `${1790000000 + i}-${2000 + i}`, v: 1, date: NOW - i * DAY, name: `Run ${i}`, km: 20 + i, gain: 900,
  movingSec: 3 * 3600, elapsedSec: 3.2 * 3600, gapPace: 330, fadePct: 4, vam: 700, best1k: 260, best5k: 1500, best10k: 3200, ...over });

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

test("server copy of src/core is up to date (run npm run build)", () => {
  for (const f of readdirSync("src/core")) assert.equal(readFileSync(`supabase/functions/_shared/core/${f}`, "utf8"), readFileSync(`src/core/${f}`, "utf8"), f);
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

test("online writes are closed until the account opens", async () => {
  const { CLOUD, cloudOn, cloudWritable } = await import("../src/ui/cloud.js");
  const { cloudPutRuns, CL_READONLY } = await import("../src/ui/cloud.js");
  assert.equal(cloudWritable(), false, "the app has no write call");
  await assert.rejects(cloudPutRuns([]), { message: CL_READONLY });
  assert.doesNotMatch(CLOUD.anonKey, /service_role/, "only the public anon key may sit in the app");
  assert.equal(JSON.parse(Buffer.from(CLOUD.anonKey.split(".")[1], "base64url")).role, "anon");
  const saved = { ...CLOUD };
  Object.assign(CLOUD, { connect: false });
  assert.equal(cloudOn(), false, "a filled URL alone must not switch the online part on");
  Object.assign(CLOUD, saved);
  const sql = readFileSync(new URL("../supabase/migrations/20261015220000_accounts.sql", import.meta.url), "utf8");
  assert.match(sql, /function public\.writes_open\(\)[^;]*select false/);
  for (const t of ["runs", "edelweiss_ledger", "ai_jobs"]) assert.match(sql, new RegExp(`before insert or update on public\\.${t} for each row execute function public\\.refuse_closed_writes`));
});

test("the profile and saved items are the only tables the app may write, without heart data", () => {
  const sql = readFileSync(new URL("../supabase/migrations/20261018160000_profiles.sql", import.meta.url), "utf8");
  assert.match(sql, /enable row level security/);
  for (const op of ["select using", "insert with check", "update using"]) assert.match(sql, new RegExp(`on public\\.profiles for ${op} \\(user_id = auth\\.uid\\(\\)\\)`));
  assert.match(sql, /profiles_no_body check/);
  const js = readFileSync(new URL("../src/ui/cloud.js", import.meta.url), "utf8");
  // 7 sign-in calls (password, link, sign-out, refresh, sign-up, forgot password, new password),
  // the profile save, saving or deleting a saved item, deleting the account, and one AI request
  // (only when CLOUD.ai is on): nothing else writes.
  assert.equal([...js.matchAll(/method: "(POST|PATCH|PUT|DELETE)"/g)].length, 12);
  assert.match(js, /CL_DELETE = "\/functions\/v1\/delete-account"/);
  const sv = readFileSync(new URL("../supabase/migrations/20261018170000_saved_items.sql", import.meta.url), "utf8");
  for (const op of ["select using", "insert with check", "delete using"]) assert.match(sv, new RegExp(`on public\\.saved_items for ${op} \\(user_id = auth\\.uid\\(\\)\\)`));
  assert.doesNotMatch(sv, /for update/, "a saved item is never changed, only added or deleted");
  assert.match(sv, /saved_no_body check/);
  assert.match(js, /CL_PROFILE_WRITE = "\/rest\/v1\/profiles\?on_conflict=user_id"/);
});

test("demo profile User1: plausible made-up runs that fill every part of the menu", async () => {
  const { demoRecords, DEMO_USER } = await import("../src/core/demorecords.js");
  const { historySummary } = await import("../src/core/history.js");
  const now = Date.UTC(2026, 9, 16);
  const R = demoRecords(now);
  assert.equal(DEMO_USER, "User1");
  assert.deepEqual(R.map((r) => checkRecord(r, now)).filter(Boolean), []);
  const S = historySummary(R, now);
  assert.ok(S.count >= 20 && S.unlocked >= 5 && S.cairns > 0 && S.bests.best10k && S.bests.vam);
});

test("the runner chooses the runs (dates or a list), the axis and the question", async () => {
  const runs = [run(1), run(2), run(3), run(40)];
  const recent = aiSelect(runs, { from: NOW - 10 * DAY, to: NOW });
  assert.equal(recent.length, 3, "date range");
  assert.deepEqual(aiSelect(runs, { ids: [runs[3].id, "bad id"] }).map((r) => r.id), [runs[3].id], "chosen runs win over dates");
  const a = aiAsk({ focus: "speed", question: "How can I go\nsub-40 in 10K   in a month?" + "x".repeat(400), ids: [1, {}] });
  assert.equal(a.focus, "speed");
  assert.ok(a.question.startsWith("How can I go sub-40 in 10K in a month?") && a.question.length === 300);
  assert.deepEqual(a.ids, [], "invalid ids leave an empty pick");
  assert.deepEqual(aiSelect(runs, { ids: [] }), [], "every run unticked selects nothing, not everything");
  assert.deepEqual(aiSelect(runs, { ids: [], from: NOW - 10 * DAY }), [], "an empty pick ignores the dates");
  assert.equal(aiAsk({ focus: "hack" }).focus, "overall", "unknown axis falls back");
});

test("no heart data from runs: summaries, demo runs, the AI table and the database", () => {
  // An older summary with heart data is cleaned; nothing else changes.
  const old = { ...run(1), hrAvg: 150, decouplingPct: 6 };
  const clean = recordClean(old);
  assert.ok(!("hrAvg" in clean) && !("decouplingPct" in clean));
  assert.equal(clean.km, old.km);
  assert.ok(demoRecords().every((r) => !("hrAvg" in r) && !("decouplingPct" in r)));
  const d = aiDigest([run(1)], { hrMax: 188 });
  assert.ok(!/hr_avg|decoupling/.test(d.table), "the AI table has no heart columns");
  assert.equal(d.athlete.hrMax, 188, "the profile's heart rate is still sent");
  assert.ok(!AI_FOCUS.some((f) => f.code === "heart"), "no heart-rate axis");
  // The database refuses a summary with heart data.
  assert.ok(/runs_no_heart check \(not \(rec \? 'hrAvg'\)/.test(readFileSync(new URL("../supabase/migrations/20261015220000_accounts.sql", import.meta.url), "utf8")));
});

test("profile: cleaned, limited, and bests found in the run log", () => {
  const p = profileClean({ name: "  Ann\nTrail  ", flag: "FR", about: "Line 1\nLine 2", tags: ["ultra", "ultra", "nope", "sky", "trail", "road", "night", "snow"],
    goals: { "5k": { goal: 1200, best: 30 }, "50k": { goal: 6 * 3600 } }, extra: [{ label: "VO2max", value: "54" }] });
  assert.equal(p.name, "Ann Trail");
  assert.equal(p.about, "Line 1\nLine 2");
  assert.equal(p.flag, "FR");
  assert.equal(flagEmoji("FR"), "\u{1F1EB}\u{1F1F7}");
  assert.equal(profileClean({ flag: "XX" }).flag, "");
  assert.deepEqual(p.tags, ["ultra", "sky", "trail", "road", "night"], "known badges, no duplicates, 5 at most");
  assert.deepEqual(p.goals["5k"], { goal: 1200, best: null }, "a best under a minute is dropped");
  assert.deepEqual(p.goals["100k"], { goal: null, best: null });
  assert.equal(p.extra, undefined, "the old My data lines are dropped");
  // Bests: 5K from the fastest 5 km inside a run; 50K from a whole run of 46.5 to 55 km.
  const runs = [run(1, { best5k: 1300 }), run(2, { best5k: 1250 }), run(3, { km: 52, elapsedSec: 7 * 3600 }), run(4, { km: 60, elapsedSec: 6 * 3600 })];
  const b = profileBests(runs);
  assert.equal(b["5k"].sec, 1250);
  assert.equal(b["50k"].sec, 7 * 3600, "a 60 km run does not count as a 50K");
  assert.equal(b["100k"], null);
});

test("an AI request spends one edelweiss, keeps the answer without heart or weight, refunds only when OpenAI never answered", async () => {
  const { planFromGpx } = await import("../src/core/plan.js");
  const { makeDemoRaceGpx, makeDemoEffortGpx, DEMO_ULTRA_PROFILE, DEMO_ULTRA_AID, DEMO_LONG_RUN_PROFILE } = await import("../src/demo.js");
  const { aiPrepInput } = await import("../src/core/aiprep.js");
  const plan = planFromGpx(makeDemoRaceGpx(DEMO_ULTRA_PROFILE, { name: "Ultra", startEle: 650, loop: true, center: [45.05, 5.7] }),
    [makeDemoEffortGpx({ profile: DEMO_LONG_RUN_PROFILE, startIso: "2026-10-11T07:00:00Z" })], { aidStations: DEMO_ULTRA_AID, startTime: "06:00" });
  const input = aiPrepInput(plan, { raceName: "Ultra", history: demoRecords(), athlete: { maxHr: 188, restHr: 50, weightKg: 70 }, user: { notes: "", question: "" } });
  const db = fakeDb([], [{ delta: 4, reason: "welcome" }]);
  const begin = (o) => aiBegin({ db, userId: "u", mode: "prep_race", input, hasKey: true, now: NOW, newId: () => "job1", ...o });
  // Nothing spent: unknown mode, no input, no key (the AI is off), too large.
  assert.equal((await begin({ mode: "hack" })).status, 400);
  assert.equal((await begin({ input: null })).status, 400);
  assert.equal((await begin({ hasKey: false })).status, 503);
  assert.equal((await begin({ input: { big: "x".repeat(500000) } })).status, 413);
  assert.equal(balance(db), 4);
  // A good request: one spent, the server's model and prompt, whatever the browser asked.
  const s = await begin({});
  assert.equal(s.status, 202);
  assert.equal(balance(db), 3);
  assert.equal(s.request.model, AI_MODEL);
  assert.equal((await begin({ newId: () => "job2" })).status, 409, "one request at a time");
  const answer = aiPrepFake(input);
  const ok = async (req) => ({ model: req.model, status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(answer) }] }], usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 } });
  const done = await aiFinish({ db, callOpenAI: ok, userId: "u", job: s.job, request: s.request, mode: "prep_race", input });
  assert.equal(done.status, "done");
  assert.deepEqual(done.result.output, answer);
  assert.equal(done.result.tokens.total, 150);
  assert.doesNotMatch(JSON.stringify(done.result), /"(athlete|hr|maxHr|restHr|heart|weight)/i, "no heart rate or weight online");
  assert.ok(JSON.stringify(s.request).includes("188"), "the heart rate does go to OpenAI for the one call");
  assert.equal(balance(db), 3, "an answer keeps the edelweiss spent");
  // OpenAI down: nothing billed, the edelweiss comes back, once.
  const s2 = await begin({ newId: () => "job3", now: NOW + 3600000 });
  assert.equal(balance(db), 2);
  const down = async () => { throw new Error("network"); };
  const failed = await aiFinish({ db, callOpenAI: down, userId: "u", job: s2.job, request: s2.request, mode: "prep_race", input });
  assert.equal(failed.status, "failed");
  assert.equal(balance(db), 3);
  // A refusal was billed: spent, kept as failed.
  const s3 = await begin({ newId: () => "job4", now: NOW + 7200000 });
  const refused = async () => ({ model: "m", status: "completed", output: [{ type: "message", content: [{ type: "refusal", refusal: "no" }] }], usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 } });
  assert.equal((await aiFinish({ db, callOpenAI: refused, userId: "u", job: s3.job, request: s3.request, mode: "prep_race", input })).status, "failed");
  assert.equal(balance(db), 2);
  // No edelweiss left: refused, nothing spent.
  const poor = fakeDb([], []);
  assert.equal((await aiBegin({ db: poor, userId: "u", mode: "prep_race", input, hasKey: true, now: NOW, newId: () => "j" })).status, 402);
  assert.equal(balance(poor), 0);
  assert.deepEqual(aiNoBody({ a: [{ hrGuide: 1, km: 2 }], athlete: {}, weightKg: 70 }), { a: [{ km: 2 }] });
});

test("the AI step SQL: ledger and AI jobs open to the server only, runs stay closed, 4 edelweiss at sign-up", () => {
  const sql = readFileSync(new URL("../supabase/migrations/20261023120000_ai_open.sql", import.meta.url), "utf8");
  assert.match(sql, /drop trigger if exists ledger_closed on public\.edelweiss_ledger/);
  assert.match(sql, /drop trigger if exists ai_jobs_closed on public\.ai_jobs/);
  assert.doesNotMatch(sql, /runs_closed|writes_open|create policy/, "no browser write and the runs stay closed");
  assert.match(sql, /values \(new\.id, 4, 'welcome'\)/);
  assert.match(sql, /select id, 4, 'welcome' from auth\.users/);
  assert.doesNotMatch(sql.replace(/^\s*--.*$/gm, ""), /\$\$/, "the Supabase SQL editor breaks on double dollar signs");
});
