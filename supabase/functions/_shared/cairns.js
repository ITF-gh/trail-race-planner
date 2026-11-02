// cairns.js: paying out the edelweiss of the achievements, written as a plain function so the tests can run it in Node with a fake database.

import { historySummary, checkRecord } from "./core/history.js";

/** Pay out the cairns of every achievement the user has reached, once each. */
export async function claimCairns(db, userId, now = Date.now()) {
  // 1.
  const runs = (await db.listRuns(userId)).filter((r) => !checkRecord(r, now));
  // 2. Recompute the achievements from those runs (the browser's claim is never trusted).
  const S = historySummary(runs, now);
  // 3.
  const due = S.achievements.filter((a) => a.done && a.cairns > 0)
    .map((a) => ({ user_id: userId, delta: a.cairns, reason: `ach:${a.code}`, ref: null }));
  const added = due.length ? await db.addLedger(due) : [];
  // 4. The balance is the sum of every movement in the ledger (+ earned, - spent).
  const ledger = await db.listLedger(userId);
  return { added: added.map((r) => r.reason), balance: ledger.reduce((s, r) => s + r.delta, 0) };
}
