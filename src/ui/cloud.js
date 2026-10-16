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
//
// Where it sits: only account.js calls this file. It holds no page code: every function here
// sends HTTP requests and returns data (or throws an Error with a readable message).
//
// Sign-in, step by step ("magic link", no password):
//   1. cloudSendLink(email) asks Supabase to email a link.
//   2. The link opens this page with the tokens after a "#" in the address
//      (#access_token=...&refresh_token=...&expires_in=3600...).
//   3. cloudFromUrl() reads them, checks them with /auth/v1/user, stores the session in
//      localStorage and removes them from the address bar.
// Tokens: the access token (a JWT) proves who you are on each request and lives about an hour;
// the refresh token buys a new access token when that one is about to run out (clToken).
// Every request carries two headers: apikey (the public project key) and Authorization:
// "Bearer <token>" (the user's access token, or the public key when signed out).

export const CLOUD = {
  url: "", // e.g. "https://abcdefghijkl.supabase.co" (Project settings > API)
  anonKey: "", // the "anon public" key: safe to publish, Row Level Security does the protecting
  open: false, // writes not open yet: set to true only when the account opens (supabase/SETUP.md)
};

// localStorage key of the saved session.
const CL_SESSION = "trp.session";

/** True when the online account is configured and open: every other call needs this. */
export const cloudOn = () => Boolean(CLOUD.url && CLOUD.anonKey && CLOUD.open);

/**
 * Read and write the saved session in localStorage, as JSON text. Session shape:
 * { access, refresh, expiresAt (ms since 1970), userId, email }. clWrite(null) removes it.
 * Both swallow errors: a browser that blocks storage simply keeps no session.
 */
function clRead() { try { return JSON.parse(localStorage.getItem(CL_SESSION) || "null"); } catch (e) { return null; } }
function clWrite(s) { try { if (s) localStorage.setItem(CL_SESSION, JSON.stringify(s)); else localStorage.removeItem(CL_SESSION); } catch (e) { /* private mode: signed in for this visit only */ } }
// The session in memory, read from storage on first use (see cloudUser).
let clSession = null;

/** The signed-in user ({ id, email }) or null. */
export function cloudUser() {
  if (!clSession) clSession = clRead();
  return clSession ? { id: clSession.userId, email: clSession.email } : null;
}

/**
 * Turn the tokens Supabase puts in the URL after a sign-in link into a session (then tidy the URL).
 * Returns (as a Promise, being async) true when a session was made, false otherwise.
 * Side effects: rewrites the address bar without the tokens, stores the session in localStorage.
 */
export async function cloudFromUrl() {
  if (!cloudOn() || !location.hash.includes("access_token=")) return false;
  // location.hash is "#access_token=...&..."; slice(1) drops the "#" and URLSearchParams reads
  // the key=value pairs.
  const p = new URLSearchParams(location.hash.slice(1));
  // replaceState changes the address shown without reloading the page, so the tokens do not stay
  // visible (or in a bookmark).
  try { history.replaceState(null, "", location.pathname + location.search); } catch (e) { /* sandboxed frame */ }
  const access = p.get("access_token"), refresh = p.get("refresh_token");
  if (!access || !refresh) return false;
  // Ask Supabase who this token belongs to; a bad token gives null (the .catch).
  const user = await clFetch("/auth/v1/user", { token: access }).catch(() => null);
  if (!user || !user.id) return false;
  // expires_in is in seconds (3600 when missing); expiresAt is the moment in milliseconds.
  clSession = { access, refresh, expiresAt: Date.now() + (Number(p.get("expires_in")) || 3600) * 1000, userId: user.id, email: user.email || "" };
  clWrite(clSession);
  return true;
}

/**
 * Ask Supabase to email a one-time sign-in link that brings the user back to this page.
 * create_user: true makes the account on first sign-in. encodeURIComponent escapes the return
 * address so its ":" and "/" survive inside the query string.
 */
export async function cloudSendLink(email) {
  const back = location.origin + location.pathname;
  await clFetch(`/auth/v1/otp?redirect_to=${encodeURIComponent(back)}`, { method: "POST", body: { email, create_user: true } });
}

/**
 * Sign out: forget the session here at once, then tell Supabase to end it (a network failure
 * is ignored: the session is already gone from this browser).
 */
export async function cloudSignOut() {
  const token = clSession && clSession.access;
  clSession = null;
  clWrite(null);
  if (token) await clFetch("/auth/v1/logout", { method: "POST", token }).catch(() => {});
}

/**
 * A valid access token, refreshed when it is about to expire (tokens live about an hour).
 * "About to expire" = less than 60 s (60000 ms) left. A failed refresh signs the user out and
 * throws "Session expired, please sign in again" (account.js shows that exact message).
 */
async function clToken() {
  if (!cloudUser()) throw new Error("Not signed in");
  if (Date.now() < clSession.expiresAt - 60000) return clSession.access;
  const r = await clFetch("/auth/v1/token?grant_type=refresh_token", { method: "POST", body: { refresh_token: clSession.refresh } }).catch(() => null);
  if (!r || !r.access_token) { await cloudSignOut(); throw new Error("Session expired, please sign in again"); }
  // Keep the user fields, replace the tokens and the expiry ({ ...a, x: 1 } copies a, then sets x).
  clSession = { ...clSession, access: r.access_token, refresh: r.refresh_token, expiresAt: Date.now() + r.expires_in * 1000 };
  clWrite(clSession);
  return clSession.access;
}

/**
 * One HTTP request to Supabase. Inputs: `path` (after the project URL), and options: method
 * ("GET" by default), body (sent as JSON), token (the user's access token; the public key
 * otherwise), extra headers. Returns the answer parsed as JSON (or as raw text when it is not
 * JSON, or null when empty). Throws an Error on an HTTP error status, with Supabase's own
 * message when it gives one, and the status number in err.status.
 */
async function clFetch(path, { method = "GET", body, token, headers = {} } = {}) {
  const res = await fetch(CLOUD.url + path, {
    method,
    // ...(body ? {...} : {}) adds the Content-Type header only when there is a body; ...headers
    // lets the caller add or override headers.
    headers: { apikey: CLOUD.anonKey, Authorization: `Bearer ${token || CLOUD.anonKey}`, ...(body ? { "Content-Type": "application/json" } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
  // res.ok is true for statuses 200 to 299. Supabase puts its message in error, msg or message
  // depending on the API.
  if (!res.ok) { const err = new Error((data && (data.error || data.msg || data.message)) || `HTTP ${res.status}`); err.status = res.status; throw err; }
  return data;
}
// The same request as the signed-in user (gets or refreshes the access token first).
const clAuthed = async (path, opts = {}) => clFetch(path, { ...opts, token: await clToken() });

// The data calls. REST paths use Supabase's query syntax (PostgREST): select=... picks the
// columns, column=eq.value filters (equals), order=column.desc sorts newest first, limit=N caps.
/** The run summaries stored in the account. */
export async function cloudRuns() {
  // Each row holds one summary in its `rec` column: return the list of summaries.
  return ((await clAuthed("/rest/v1/runs?select=rec")) || []).map((r) => r.rec);
}
/**
 * Add or update run summaries (an "upsert": same id = same row).
 * on_conflict=user_id,id names the columns that identify a row; the Prefer header asks to merge
 * on such a conflict and to send nothing back.
 */
export async function cloudPutRuns(recs) {
  if (!recs.length) return;
  const user = cloudUser();
  await clAuthed("/rest/v1/runs?on_conflict=user_id,id", {
    method: "POST",
    body: recs.map((rec) => ({ user_id: user.id, id: rec.id, rec, updated_at: new Date().toISOString() })),
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
  });
}
/** Delete every run of the signed-in user from the account. */
export async function cloudDeleteRuns() {
  await clAuthed(`/rest/v1/runs?user_id=eq.${cloudUser().id}`, { method: "DELETE" });
}
/** The cairn ledger, newest first: [{ delta, reason, created_at }]. */
export async function cloudLedger() {
  return (await clAuthed("/rest/v1/cairn_ledger?select=delta,reason,created_at&order=created_at.desc")) || [];
}
/** Ask the server to pay out the cairns of the achievements reached. */
export const cloudClaim = () => clAuthed("/functions/v1/claim-cairns", { method: "POST", body: {} });
/** Spend a cairn on an AI analysis; answers { job } at once, the result comes later (cloudJob). */
export const cloudAnalyse = (athlete) => clAuthed("/functions/v1/ai-analyse", { method: "POST", body: { athlete } });
/** One analysis job by id: { id, status ("running", "done" or "failed"), result, error, created_at }. */
export async function cloudJob(id) {
  const rows = await clAuthed(`/rest/v1/ai_jobs?id=eq.${encodeURIComponent(id)}&select=id,status,result,error,created_at`);
  return rows && rows[0];
}
/** The past analyses, newest first. */
export async function cloudJobs() {
  return (await clAuthed("/rest/v1/ai_jobs?status=eq.done&select=id,result,created_at&order=created_at.desc&limit=10")) || [];
}
/** Delete the account on the server (a server function), then forget the session here. */
export async function cloudDeleteAccount() {
  await clAuthed("/functions/v1/delete-account", { method: "POST", body: {} });
  clSession = null;
  clWrite(null);
}
