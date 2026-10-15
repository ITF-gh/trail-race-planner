// cairns.js: what the server functions do, written as plain functions so the tests can run them
// in Node with a fake database and a fake Claude. The Deno entry points (claim-cairns/index.ts,
// ai-analyse/index.ts) only plug in the real Supabase client and the real Anthropic client.
//
// `db` is a small interface over the database (see makeDb in db.ts):
//   listRuns(userId)              -> [run summary]
//   listLedger(userId)            -> [{ delta, reason, ref }]
//   addLedger(rows)               -> rows that were new (an achievement already paid is skipped)
//   spendCairn(userId, jobId)     -> true when a cairn was taken, false when the balance is 0
//   runningJob(userId, sinceMs)   -> true when an analysis is already running for this user
//   createJob(job), finishJob(id, patch)

import { historySummary, checkRecord, aiDigest } from "./history.js";

export const AI_MODEL = "claude-opus-5-5";

/**
 * Pay out the cairns of every achievement the user has reached, once each. The achievements are
 * computed HERE, from the runs stored in the database, with the same code as the app (history.js),
 * and runs with impossible numbers are left out. Returns { added, balance }.
 */
export async function claimCairns(db, userId, now = Date.now()) {
  const runs = (await db.listRuns(userId)).filter((r) => !checkRecord(r, now));
  const S = historySummary(runs, now);
  const due = S.achievements.filter((a) => a.done && a.cairns > 0)
    .map((a) => ({ user_id: userId, delta: a.cairns, reason: `ach:${a.code}`, ref: null }));
  const added = due.length ? await db.addLedger(due) : [];
  const ledger = await db.listLedger(userId);
  return { added: added.map((r) => r.reason), balance: ledger.reduce((s, r) => s + r.delta, 0) };
}

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
export const AI_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["headline", "summary", "kpis", "strengths", "focus", "next_weeks"],
  properties: {
    headline: { type: "string", description: "One sentence, the main finding." },
    summary: { type: "string", description: "A short paragraph." },
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

/** The request sent to Claude for a digest (exported so the tests can check it). */
export function aiRequest(digest) {
  const a = digest.athlete;
  const who = [a.hrMax && `max heart rate ${a.hrMax} bpm`, a.hrRest && `resting heart rate ${a.hrRest} bpm`, a.weight && `weight ${a.weight} kg`].filter(Boolean).join(", ");
  return {
    model: AI_MODEL,
    max_tokens: 16000,
    // A declined request is re-run on Anthropic's recommended fallback model instead of failing.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
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
 */
export async function aiStart({ db, userId, athlete, now = Date.now(), newId }) {
  const runs = (await db.listRuns(userId)).filter((r) => !checkRecord(r, now));
  if (runs.length < 3) return { status: 400, error: "At least 3 runs are needed for an analysis." };
  if (await db.runningJob(userId, now - 10 * 60000)) return { status: 409, error: "An analysis is already running." };
  const id = newId();
  const digest = aiDigest(runs, athlete || {});
  await db.createJob({ id, user_id: userId, status: "running", model: AI_MODEL, runs: digest.runs });
  if (!(await db.spendCairn(userId, id))) {
    await db.finishJob(id, { status: "failed", error: "no cairn", finished_at: new Date(now).toISOString() });
    return { status: 402, error: "No cairn left." };
  }
  return { status: 202, job: id, digest };
}

/** Second step: `callClaude(request)` returns the final Message. Resolves to the saved result or null. */
export async function aiRun({ db, callClaude, userId, job, digest }) {
  try {
    const msg = await callClaude(aiRequest(digest));
    if (msg.stop_reason === "refusal") throw new Error("The analysis was declined.");
    if (msg.stop_reason === "max_tokens") throw new Error("The analysis was cut short.");
    const text = msg.content.filter((b) => b.type === "text").map((b) => b.text).join("");
    const result = JSON.parse(text);
    await db.finishJob(job, {
      status: "done", result, model: msg.model || AI_MODEL, finished_at: new Date().toISOString(),
      input_tokens: msg.usage ? msg.usage.input_tokens : null, output_tokens: msg.usage ? msg.usage.output_tokens : null,
    });
    return result;
  } catch (e) {
    await db.addLedger([{ user_id: userId, delta: 1, reason: "refund", ref: job }]);
    await db.finishJob(job, { status: "failed", error: String((e && e.message) || e).slice(0, 500), finished_at: new Date().toISOString() });
    return null;
  }
}
