// saved.js: the summary kept when a signed-in runner presses "Save to my account" (Boss's rule, 2026-10-18: saving is a choice, never automatic, and only COMPUTED numbers are kept, never the GPX file).

import { raceLegs } from "./script.js";

/** The largest saved item, in bytes (the database refuses more): a long ultra with its runs fits. */
export const SAVED_MAX_BYTES = 3 * 1024 * 1024;

/** The kinds of saved item and how the account window names them. */
export const SAVED_KINDS = { plan: "Race plan", session: "Run session", run: "Run" };

// Round to `d` decimals (a number, not text).
const rnd = (v, d = 0) => (Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : null);

/** The summary of a plan (buildPlan's object), for kind "plan" or "session". */
export function planSummary(plan, meta = {}) {
  const S = plan.scenarios || {};
  const fin = (id) => (S[id] ? Math.round(S[id].finishSec) : null);
  let sections = [];
  try {
    sections = raceLegs(plan, "central").map((l) => ({
      t: String(l.title || "").slice(0, 40), k: l.kind, a: rnd(l.startKm, 2), b: rnd(l.endKm, 2),
      up: rnd(l.up), down: rnd(l.down), s: rnd(l.endSec),
    }));
  } catch (e) { sections = []; }
  return {
    v: 1,
    name: String(meta.name || "Untitled").slice(0, 80),
    km: rnd(plan.course.totalKm, 2),
    gain: rnd(plan.course.gain),
    loss: rnd(plan.course.loss),
    startSec: rnd(plan.startSec),
    targetSec: Number.isFinite(meta.targetSec) ? Math.round(meta.targetSec) : null,
    finish: { best: fin("best"), central: fin("central"), cautious: fin("cautious") },
    aid: (plan.aidStations || []).slice(0, 30).map((a) => ({ km: rnd(a.km, 2), name: String(a.name || "").slice(0, 40), stopMin: rnd(a.stopMin, 1) })),
    sections: sections.slice(0, 120),
  };
}

/** Check an item before it is sent: { kind, title, data }. */
export function savedCheck(item) {
  if (!item || !SAVED_KINDS[item.kind]) return "Unknown kind";
  if (!item.title || item.title.length > 80) return "A title of 1 to 80 characters is needed";
  const text = JSON.stringify(item.data || null);
  if (!item.data || typeof item.data !== "object" || Array.isArray(item.data)) return "No data to save";
  if (new TextEncoder().encode(text).length > SAVED_MAX_BYTES) return "Too big to save (over 3 MB)";
  if (/"(hr|heart|weight)/i.test(text)) return "Heart rate and weight are never saved online";
  return "";
}
