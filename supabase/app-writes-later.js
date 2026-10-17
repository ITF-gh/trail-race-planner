// The app's WRITE calls to Supabase, taken out of the live app on Boss's rule (2026-10-17):
// "no risk about writing, do not connect any writing function". The live app (src/ui/cloud.js)
// only signs in and reads. This file is NOT part of the build: when the account opens, these
// functions go back into src/ui/cloud.js (see supabase/SETUP.md, "Opening the account").
// They rely on clAuthed, cloudUser, clWrite, clSession and recordClean from cloud.js.

/**
 * Add or update run summaries (an "upsert": same id = same row).
 * on_conflict=user_id,id names the columns that identify a row; the Prefer header asks to merge
 * on such a conflict and to send nothing back.
 */
export async function cloudPutRuns(recs) {
  clWriteGuard();
  if (!recs.length) return;
  const user = cloudUser();
  await clAuthed("/rest/v1/runs?on_conflict=user_id,id", {
    method: "POST",
    body: recs.map(recordClean).map((rec) => ({ user_id: user.id, id: rec.id, rec, updated_at: new Date().toISOString() })),
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
  });
}
/** Delete every run of the signed-in user from the account. */
export async function cloudDeleteRuns() {
  clWriteGuard();
  await clAuthed(`/rest/v1/runs?user_id=eq.${cloudUser().id}`, { method: "DELETE" });
}
/** Ask the server to pay out the tokens of the achievements reached. */
export const cloudClaim = async () => { clWriteGuard(); return clAuthed("/functions/v1/claim-cairns", { method: "POST", body: {} }); };
/**
 * Spend a token on an AI analysis of the runs `ask` selects; answers { job } at once, the result
 * comes later (cloudJob). `athlete` is { hrMax, hrRest, weight } (null when not set); `ask` is
 * { ids } or { from, to } (ms), plus focus (an AI_FOCUS code) and question (text); the Prep my
 * race window also sends mode, goal, risk, targetSec, notes and forced (read by the server later).
 */
export const cloudAnalyse = async (athlete, ask) => { clWriteGuard(); return clAuthed("/functions/v1/ai-analyse", { method: "POST", body: { athlete, ask } }); };
/** Delete the account on the server (a server function), then forget the session here. */
export async function cloudDeleteAccount() {
  clWriteGuard();
  await clAuthed("/functions/v1/delete-account", { method: "POST", body: {} });
  clSession = null;
  clWrite(null);
}
