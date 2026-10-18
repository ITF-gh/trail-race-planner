// saved.js: the summary kept when a signed-in runner presses "Save to my account" (Boss's rule,
// 2026-10-18: saving is a choice, never automatic, and only COMPUTED numbers are kept, never the
// GPX file). Pure functions, no page code.
//
// Three kinds, one per mode:
//   plan     Prep my race: the race, the three predicted finishes, the target, the sections
//   session  Prep my run: the same summary, for a run to come
//   run      Rewind my run: the run summary of the run log (runRecord, core/runrecord.js)
// A plan or session keeps per section: start and end km, climbing, the time to get there, so a
// later version can put a run next to the plan it followed (after the feature freeze).
//
// No heart rate and no weight (the database refuses them too). Each summary stays far under the
// 16 KB the database accepts: 60 sections at about 80 bytes each is under 5 KB.
//
// Main exports: planSummary, savedCheck, SAVED_KINDS.

import { raceLegs } from "./script.js";

/** The kinds of saved item and how the account window names them. */
export const SAVED_KINDS = { plan: "Race plan", session: "Run session", run: "Run" };

// Round to `d` decimals (a number, not text).
const rnd = (v, d = 0) => (Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : null);

/**
 * The summary of a plan (buildPlan's object), for kind "plan" or "session".
 * `meta`: { name (the race or run), targetSec (the finish time aimed at, or null) }.
 * Returns { v, name, km, gain, loss, startSec, targetSec, finish: {best, central, cautious},
 * aid, sections: [{ t (title), k (kind), a (start km), b (end km), up, down, s (seconds from
 * the start at the end of the section, central scenario) }] }.
 */
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

/**
 * Check an item before it is sent: { kind, title, data }. Returns "" when fine, else the reason.
 * Mirrors the database rules, so a refusal is explained here instead of failing online.
 */
export function savedCheck(item) {
  if (!item || !SAVED_KINDS[item.kind]) return "Unknown kind";
  if (!item.title || item.title.length > 80) return "A title of 1 to 80 characters is needed";
  const text = JSON.stringify(item.data || null);
  if (!item.data || typeof item.data !== "object" || Array.isArray(item.data)) return "No data to save";
  if (new TextEncoder().encode(text).length > 16384) return "Too big to save (over 16 KB)";
  if (/"(hr|heart|weight)/i.test(text)) return "Heart rate and weight are never saved online";
  return "";
}
