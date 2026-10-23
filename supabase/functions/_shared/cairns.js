// cairns.js: paying out the edelweiss of the achievements, written as a plain function so the tests
// can run it in Node with a fake database. The Deno entry point (claim-cairns/index.ts) only plugs
// in the real Supabase client. The AI call is in aicall.js.
//
// `db` is a small interface over the database (see makeDb in server.ts):
//   listRuns(userId)              -> [run summary]
//   listLedger(userId)            -> [{ delta, reason, ref }]
//   addLedger(rows)               -> rows that were new (an achievement already paid is skipped)
//   (spendCairn, runningJob, createJob, finishJob: used by aicall.js)
//
// Passing the database in as a parameter (instead of creating it here) is called "dependency
// injection": the same functions run against the real Supabase database in production and
// against a fake in-memory one in the tests.
//
// Cairns are the app's small reward currency (shown as "edelweiss" in the app; the code and the
// database keep the old name): achievements earn them, one AI analysis costs one.
// The balance is never stored; it is the sum of the `delta` column of the ledger (see the SQL
// migration in supabase/migrations for the tables and the rules that protect them).

import { historySummary, checkRecord } from "./core/history.js";

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
