// cairns.js: what the server functions do, written as plain functions so the tests can run them
// in Node with a fake database and a fake Claude. The Deno entry points (claim-cairns/index.ts,
// ai-analyse/index.ts) only plug in the real Supabase client and the real Anthropic client.
//
// `db` is a small interface over the database (see makeDb in server.ts):
//   listRuns(userId)              -> [run summary]
//   listLedger(userId)            -> [{ delta, reason, ref }]
//   addLedger(rows)               -> rows that were new (an achievement already paid is skipped)
//   spendCairn(userId, jobId)     -> true when a cairn was taken, false when the balance is 0
//   runningJob(userId, sinceMs)   -> true when an analysis is already running for this user
//   createJob(job), finishJob(id, patch)
//
// Passing the database in as a parameter (instead of creating it here) is called "dependency
// injection": the same functions run against the real Supabase database in production and
// against a fake in-memory one in the tests.
//
// Cairns are the app's small reward currency: achievements earn them, one AI analysis costs one.
// The balance is never stored; it is the sum of the `delta` column of the ledger (see the SQL
// migration in supabase/migrations for the tables and the rules that protect them).
//
// Main exports: claimCairns (pay out achievements), aiStart + aiRun (one AI analysis in two
// steps), aiRequest (the request sent to Claude), AI_MODEL and AI_SCHEMA.

import { historySummary, checkRecord, aiDigest } from "./history.js";

// The Claude model used for the analysis (also stored in each ai_jobs row).
export const AI_MODEL = "claude-opus-5-5";

/**
 * Pay out the cairns of every achievement the user has reached, once each. The achievements are
 * computed HERE, from the runs stored in the database, with the same code as the app (history.js),
 * and runs with impossible numbers are left out. Returns { added, balance }.
 * Inputs: db (the interface above), userId (the account's uuid), now (milliseconds since 1970,
 * a parameter so the tests can fix the date).
 * `added` is the list of reasons newly paid (each "ach:" followed by the achievement's code), `balance` the
 * number of cairns after payment. Side effect: inserts ledger rows.
 */
export async function claimCairns(db, userId, now = Date.now()) {
  // 1. Load the stored runs and keep the valid ones: checkRecord returns an error text for a run
  //    with impossible numbers and null for a good one, so `!checkRecord(r, now)` keeps good runs.
  const runs = (await db.listRuns(userId)).filter((r) => !checkRecord(r, now));
  // 2. Recompute the achievements from those runs (the browser's claim is never trusted).
  const S = historySummary(runs, now);
  // 3. One ledger row per achievement reached that is worth something. The reason "ach:<code>"
  //    is unique per user in the database, so an achievement already paid is skipped by addLedger.
  const due = S.achievements.filter((a) => a.done && a.cairns > 0)
    .map((a) => ({ user_id: userId, delta: a.cairns, reason: `ach:${a.code}`, ref: null }));
  const added = due.length ? await db.addLedger(due) : [];
  // 4. The balance is the sum of every movement in the ledger (+ earned, - spent).
  const ledger = await db.listLedger(userId);
  return { added: added.map((r) => r.reason), balance: ledger.reduce((s, r) => s + r.delta, 0) };
}

// The "system prompt": the standing instructions that tell Claude its role and what to produce.
// The run log itself goes in the user message (see aiRequest).
const SYSTEM = `You are an experienced trail and ultra running coach and a sports data analyst.
You receive one athlete's run log: one line per run (newest first) with distance, climbing, times,
grade-adjusted pace (GAP: the flat pace that would cost the same energy), average heart rate,
fade (how much the second half lost against the first on the same kind of ground, in %),
aerobic decoupling (speed per heartbeat, second half against the first, in %), climbing speed
(VAM, m/h on +3% and steeper) and the fastest 1, 5 and 10 km inside each run.

Find what the app's own charts cannot show: trends across runs and weeks, links between
measures, and new indicators. Invent 3 to 6 new KPIs computed from this log (for example a
durability index, a climbing economy trend, a training load ratio), each with its value, how it
was computed and what it means for this athlete. Be concrete and quantitative, cite the dates
or runs you rely on, and say plainly when the log is too short to conclude. Write for a runner,
not a scientist. Reply in the athlete's language only if it is obvious from the data; otherwise
in English.`;

// The answer's shape, enforced by structured outputs so the app can draw it like its other cards.
// It is a JSON Schema: a standard way to describe a JSON object (which fields, of which types).
// `required` lists the fields that must be there; `additionalProperties: false` forbids others.
// The `description` texts are read by the model as guidance for each field.
export const AI_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["headline", "summary", "kpis", "strengths", "focus", "next_weeks"],
  properties: {
    headline: { type: "string", description: "One sentence, the main finding." },
    summary: { type: "string", description: "A short paragraph." },
    // The new indicators the model invents, each with how it is computed and what it means.
    kpis: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "value", "unit", "how", "meaning"],
        properties: {
          name: { type: "string" },
          value: { type: "string" },
          unit: { type: "string" },
          how: { type: "string", description: "How it is computed from the log." },
          meaning: { type: "string", description: "What it says about this athlete." },
        },
      },
    },
    strengths: { type: "array", items: { type: "string" } },
    focus: { type: "array", items: { type: "string" } },
    next_weeks: { type: "string", description: "What to do in the next 2 to 4 weeks." },
  },
};

/**
 * The request sent to Claude for a digest (exported so the tests can check it).
 * Input: `digest` from aiDigest (history.js): { athlete: { hrMax, hrRest, weight } (null when
 * not given or out of range), runs: number of runs, table: the run log as CSV text }.
 * Returns the request object for the Anthropic Messages API (model, limits, system prompt,
 * one user message).
 */
export function aiRequest(digest) {
  const a = digest.athlete;
  // Describe the athlete in words, e.g. "max heart rate 188 bpm, weight 70 kg".
  // `a.hrMax && "..."` gives the text only when hrMax is set (otherwise null);
  // filter(Boolean) then drops the empty entries before joining with commas.
  const who = [a.hrMax && `max heart rate ${a.hrMax} bpm`, a.hrRest && `resting heart rate ${a.hrRest} bpm`, a.weight && `weight ${a.weight} kg`].filter(Boolean).join(", ");
  return {
    model: AI_MODEL,
    // Upper limit on the length of the answer, in tokens (pieces of words).
    max_tokens: 16000,
    // A declined request is re-run on Anthropic's recommended fallback model instead of failing.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    // effort: how much thinking the model spends; format: the answer must match AI_SCHEMA.
    output_config: { effort: "medium", format: { type: "json_schema", schema: AI_SCHEMA } },
    system: SYSTEM,
    messages: [{
      role: "user",
      content: `Athlete: ${who || "no settings given"}.\nRun log (${digest.runs} runs, CSV):\n${digest.table}`,
    }],
  };
}

/**
 * One AI analysis, in two steps so the browser never waits on an open connection for minutes:
 * aiStart checks, records the job and spends a cairn (answers at once with the job id), then
 * aiRun asks Claude in the background and saves the answer; the browser polls the job row.
 * If anything fails after the cairn was spent, the cairn is refunded.
 * aiStart returns { status, job?, digest?, error? } with an HTTP-like status.
 * Inputs (one object, destructured): db, userId, athlete ({ hrMax, hrRest, weight } from the
 * app's settings), now (ms), newId (a function that makes a new unique id for the job).
 * Statuses: 400 too few runs, 409 an analysis already running, 402 no cairn left,
 * 202 "accepted": the job was created and the cairn spent.
 */
export async function aiStart({ db, userId, athlete, now = Date.now(), newId }) {
  // 1. Only valid stored runs count, and at least 3 are needed for trends to mean anything.
  const runs = (await db.listRuns(userId)).filter((r) => !checkRecord(r, now));
  if (runs.length < 3) return { status: 400, error: "At least 3 runs are needed for an analysis." };
  // 2. One analysis at a time per user: refuse if one started in the last 10 minutes
  //    (10 * 60000 ms) is still running. An older "running" job is ignored (treated as stuck).
  if (await db.runningJob(userId, now - 10 * 60000)) return { status: 409, error: "An analysis is already running." };
  // 3. Build the compact run log for Claude and record the job as "running".
  const id = newId();
  const digest = aiDigest(runs, athlete || {});
  await db.createJob({ id, user_id: userId, status: "running", model: AI_MODEL, runs: digest.runs });
  // 4. Spend one cairn (atomic in the database). With no cairn left, close the job as failed.
  if (!(await db.spendCairn(userId, id))) {
    await db.finishJob(id, { status: "failed", error: "no cairn", finished_at: new Date(now).toISOString() });
    return { status: 402, error: "No cairn left." };
  }
  return { status: 202, job: id, digest };
}

/**
 * Second step: `callClaude(request)` returns the final Message. Resolves to the saved result or null.
 * Inputs (one object): db, callClaude (a function, so the tests can pass a fake Claude), userId,
 * job (the job id from aiStart), digest (from aiStart).
 * Side effects: on success the job row gets status "done", the parsed result, the model that
 * answered and the token counts; on any error the cairn is refunded (+1 "refund" ledger row)
 * and the job row gets status "failed" with the error message (cut to 500 characters).
 */
export async function aiRun({ db, callClaude, userId, job, digest }) {
  try {
    const msg = await callClaude(aiRequest(digest));
    // stop_reason says why the model stopped: "refusal" = it declined, "max_tokens" = the
    // answer hit the length limit (so the JSON would be incomplete).
    if (msg.stop_reason === "refusal") throw new Error("The analysis was declined.");
    if (msg.stop_reason === "max_tokens") throw new Error("The analysis was cut short.");
    // The answer is a list of content blocks; keep the text blocks, join them, parse the JSON.
    const text = msg.content.filter((b) => b.type === "text").map((b) => b.text).join("");
    const result = JSON.parse(text);
    await db.finishJob(job, {
      status: "done", result, model: msg.model || AI_MODEL, finished_at: new Date().toISOString(),
      input_tokens: msg.usage ? msg.usage.input_tokens : null, output_tokens: msg.usage ? msg.usage.output_tokens : null,
    });
    return result;
  } catch (e) {
    // Give the cairn back (the database allows only one refund per job), then mark the job failed.
    // `(e && e.message) || e` uses the error's message when there is one, else the value itself.
    await db.addLedger([{ user_id: userId, delta: 1, reason: "refund", ref: job }]);
    await db.finishJob(job, { status: "failed", error: String((e && e.message) || e).slice(0, 500), finished_at: new Date().toISOString() });
    return null;
  }
}
