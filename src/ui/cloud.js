// cloud.js: the online account, talking to Supabase with plain fetch() calls (no library, like
// the rest of the app). Three parts of Supabase are used, each through its HTTP API:
//   Auth      /auth/v1/...       sign in with a one-time email link, refresh the session
//   REST      /rest/v1/<table>   read and write the user's rows (Row Level Security in the
//                                database makes sure a token only reaches its own rows)
//   Functions /functions/v1/...  server code for what the browser must not do itself: paying out
//                                cairns, spending one on an AI analysis, deleting the account
//
// The whole online part stays OFF while CLOUD.url is empty or CLOUD.open is false: the app then
// works exactly as before, with the run log on this device only, and sends nothing (no sign-in,
// no run, no cairn). The database has its own lock too (writes_open() in the migration).

export const CLOUD = {
  url: "", // e.g. "https://abcdefghijkl.supabase.co" (Project settings > API)
  anonKey: "", // the "anon public" key: safe to publish, Row Level Security does the protecting
  open: false, // writes not open yet: set to true only when the account opens (supabase/SETUP.md)
};

const CL_SESSION = "trp.session";

export const cloudOn = () => Boolean(CLOUD.url && CLOUD.anonKey && CLOUD.open);

function clRead() { try { return JSON.parse(localStorage.getItem(CL_SESSION) || "null"); } catch (e) { return null; } }
function clWrite(s) { try { if (s) localStorage.setItem(CL_SESSION, JSON.stringify(s)); else localStorage.removeItem(CL_SESSION); } catch (e) { /* private mode: signed in for this visit only */ } }
let clSession = null;

/** The signed-in user ({ id, email }) or null. */
export function cloudUser() {
  if (!clSession) clSession = clRead();
  return clSession ? { id: clSession.userId, email: clSession.email } : null;
}

/** Turn the tokens Supabase puts in the URL after a sign-in link into a session (then tidy the URL). */
export async function cloudFromUrl() {
  if (!cloudOn() || !location.hash.includes("access_token=")) return false;
  const p = new URLSearchParams(location.hash.slice(1));
  try { history.replaceState(null, "", location.pathname + location.search); } catch (e) { /* sandboxed frame */ }
  const access = p.get("access_token"), refresh = p.get("refresh_token");
  if (!access || !refresh) return false;
  const user = await clFetch("/auth/v1/user", { token: access }).catch(() => null);
  if (!user || !user.id) return false;
  clSession = { access, refresh, expiresAt: Date.now() + (Number(p.get("expires_in")) || 3600) * 1000, userId: user.id, email: user.email || "" };
  clWrite(clSession);
  return true;
}

/** Ask Supabase to email a one-time sign-in link that brings the user back to this page. */
export async function cloudSendLink(email) {
  const back = location.origin + location.pathname;
  await clFetch(`/auth/v1/otp?redirect_to=${encodeURIComponent(back)}`, { method: "POST", body: { email, create_user: true } });
}

export async function cloudSignOut() {
  const token = clSession && clSession.access;
  clSession = null;
  clWrite(null);
  if (token) await clFetch("/auth/v1/logout", { method: "POST", token }).catch(() => {});
}

/** A valid access token, refreshed when it is about to expire (tokens live about an hour). */
async function clToken() {
  if (!cloudUser()) throw new Error("Not signed in");
  if (Date.now() < clSession.expiresAt - 60000) return clSession.access;
  const r = await clFetch("/auth/v1/token?grant_type=refresh_token", { method: "POST", body: { refresh_token: clSession.refresh } }).catch(() => null);
  if (!r || !r.access_token) { await cloudSignOut(); throw new Error("Session expired, please sign in again"); }
  clSession = { ...clSession, access: r.access_token, refresh: r.refresh_token, expiresAt: Date.now() + r.expires_in * 1000 };
  clWrite(clSession);
  return clSession.access;
}

async function clFetch(path, { method = "GET", body, token, headers = {} } = {}) {
  const res = await fetch(CLOUD.url + path, {
    method,
    headers: { apikey: CLOUD.anonKey, Authorization: `Bearer ${token || CLOUD.anonKey}`, ...(body ? { "Content-Type": "application/json" } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
  if (!res.ok) { const err = new Error((data && (data.error || data.msg || data.message)) || `HTTP ${res.status}`); err.status = res.status; throw err; }
  return data;
}
const clAuthed = async (path, opts = {}) => clFetch(path, { ...opts, token: await clToken() });

/** The run summaries stored in the account. */
export async function cloudRuns() {
  return ((await clAuthed("/rest/v1/runs?select=rec")) || []).map((r) => r.rec);
}
/** Add or update run summaries (an "upsert": same id = same row). */
export async function cloudPutRuns(recs) {
  if (!recs.length) return;
  const user = cloudUser();
  await clAuthed("/rest/v1/runs?on_conflict=user_id,id", {
    method: "POST",
    body: recs.map((rec) => ({ user_id: user.id, id: rec.id, rec, updated_at: new Date().toISOString() })),
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
  });
}
export async function cloudDeleteRuns() {
  await clAuthed(`/rest/v1/runs?user_id=eq.${cloudUser().id}`, { method: "DELETE" });
}
/** The cairn ledger, newest first: [{ delta, reason, created_at }]. */
export async function cloudLedger() {
  return (await clAuthed("/rest/v1/cairn_ledger?select=delta,reason,created_at&order=created_at.desc")) || [];
}
/** Ask the server to pay out the cairns of the achievements reached. */
export const cloudClaim = () => clAuthed("/functions/v1/claim-cairns", { method: "POST", body: {} });
/** Spend a token on an AI analysis of the runs `ask` selects; answers { job } at once, the result comes later (cloudJob). */
export const cloudAnalyse = (athlete, ask) => clAuthed("/functions/v1/ai-analyse", { method: "POST", body: { athlete, ask } });
export async function cloudJob(id) {
  const rows = await clAuthed(`/rest/v1/ai_jobs?id=eq.${encodeURIComponent(id)}&select=id,status,result,error,created_at`);
  return rows && rows[0];
}
/** The past analyses, newest first. */
export async function cloudJobs() {
  return (await clAuthed("/rest/v1/ai_jobs?status=eq.done&select=id,result,created_at&order=created_at.desc&limit=10")) || [];
}
export async function cloudDeleteAccount() {
  await clAuthed("/functions/v1/delete-account", { method: "POST", body: {} });
  clSession = null;
  clWrite(null);
}
