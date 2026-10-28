// cloud.js: the online account, talking to Supabase with plain fetch() calls (no library, like
// the rest of the app). Two parts of Supabase are used, each through its HTTP API:
//   Auth      /auth/v1/...       sign in with a one-time email link, refresh the session
//   REST      /rest/v1/<table>   READ the user's rows only (Row Level Security in the database
//                                makes sure a token only reaches its own rows), and WRITE the
//                                user's own profile and saved items (Boss, 2026-10-18)
// The server functions (/functions/v1/...): delete-account, and ai-analyse (one AI request,
// one edelweiss) once CLOUD.ai is switched on (Boss, 2026-10-23).
//
// Two states, set in CLOUD below:
//   off        (url empty, or connect false): the app works exactly as before, with the run log
//              on this device only, and sends nothing (no sign-in, no run, no token).
//   read-only  (connect: true): sign-in works for accounts that already exist (no new account is
//              made) and the account's data can be read. The only writes are the user's own
//              profile (cloudPutProfile) and the items they choose to keep (cloudSave,
//              cloudSavedDelete); the run log, tokens and AI have no write call (they wait in
//              supabase/app-writes-later.js), and clFetch refuses any other write (clMayWrite).
// The database has its own lock too (writes_open() in the migration), so even a hand-made
// request writes nothing.
//
// The AI tokens are called "edelweiss" on screen; the database tables
// say "edelweiss" too (edelweiss_ledger); only the server function names still say "cairn"
// (claim-cairns), which only the code sees.
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
  url: "https://vjhzcuvxucpldhsjpqrl.supabase.co", // the project address (Project settings > API)
  anonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZqaHpjdXZ4dWNwbGRoc2pwcXJsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTIzMTk4OTUsImV4cCI6MjEwNzg5NTg5NX0.I6XJP6XyZmxwFOsosDkEP2HvDirC8tUA7XkNPfrPhxk",
  // the "anon public" key: safe to publish, Row Level Security does the protecting
  connect: true, // true = read-only: sign in and read, never write (supabase/SETUP.md, step 6)
  // The online AI (ai-analyse). On 2026-10-23 to 2026-10-27, OFF again on Boss's word (2026-10-27):
  // the AI button is blocked and nothing is sent. Removing the App1 secret in Supabase stops the
  // server side too (it then answers "not switched on yet" and spends nothing).
  ai: false,
  // New accounts: false = by invitation only (Boss, 2026-10-23: sign-ups stay off in Supabase),
  // so the menu shows no "Create an account" button that could only fail.
  signup: false,
};

/** The message every write call throws while the account is read-only (account.js shows it). */
export const CL_READONLY = "Only your profile is saved to the online account for now.";

// The writes the app may make (Boss, 2026-10-18): the user's own profile row, and the items
// they choose to keep ("Save to my account": add one, delete one). Nothing else is ever written.
const CL_PROFILE_WRITE = "/rest/v1/profiles?on_conflict=user_id";
const CL_SAVED = "/rest/v1/saved_items";
// 2026-10-23 (Boss: "a full functional account"): also deleting the account (a server function).
const CL_DELETE = "/functions/v1/delete-account";
// And one AI request (the server spends the edelweiss and calls OpenAI), when CLOUD.ai is on.
const CL_AI = "/functions/v1/ai-analyse";
const clMayWrite = (path) => path.startsWith("/auth/v1/") || path === CL_PROFILE_WRITE || path === CL_SAVED || path.startsWith(`${CL_SAVED}?id=eq.`) || path === CL_DELETE || (path === CL_AI && cloudAiOn());

// localStorage key of the saved session.
const CL_SESSION = "trp.session";

/** True when the online account is configured and connected (read-only or open): every other call needs this. */
export const cloudOn = () => Boolean(CLOUD.url && CLOUD.anonKey && CLOUD.connect);
/** True when the online AI is switched on too (CLOUD.ai): the AI windows can spend an edelweiss. */
export const cloudAiOn = () => cloudOn() && CLOUD.ai === true;
/** Writes are not part of this app yet: always false (account.js asks before any write step). */
export const cloudWritable = () => false;
// What account.js calls for a write: always refused here, nothing is sent.
const clNoWrite = async () => { throw new Error(CL_READONLY); };
export const cloudPutRuns = clNoWrite;
export const cloudDeleteRuns = clNoWrite;
export const cloudClaim = clNoWrite;

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
 * Returns (as a Promise, being async) the kind of link ("recovery", "signup", "magiclink") when a
 * session was made, false otherwise.
 * Side effects: rewrites the address bar without the tokens, stores the session in localStorage.
 */
export async function cloudFromUrl() {
  if (!cloudOn() || !location.hash.includes("access_token=")) return false;
  // "recovery" when the link came from Forgot password, "signup" from the confirm email.
  const kind = new URLSearchParams(location.hash.slice(1)).get("type") || "magiclink";
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
  return kind;
}

/**
 * Sign in with email and password (the password is set on the user in the Supabase dashboard).
 * Supabase answers with the same tokens as a sign-in link, plus the user. Returns the user
 * ({ id, email }); throws on a wrong password ("Invalid login credentials").
 */
export async function cloudSignInPassword(email, password) {
  const r = await clFetch("/auth/v1/token?grant_type=password", { method: "POST", body: { email, password } });
  if (!r || !r.access_token || !r.user) throw new Error("Sign-in failed");
  clSession = { access: r.access_token, refresh: r.refresh_token, expiresAt: Date.now() + (r.expires_in || 3600) * 1000, userId: r.user.id, email: r.user.email || email };
  clWrite(clSession);
  return cloudUser();
}

/**
 * Ask Supabase to email a one-time sign-in link that brings the user back to this page.
 * No account is ever created from here (create_user: false). encodeURIComponent escapes the return
 * address so its ":" and "/" survive inside the query string.
 */
export async function cloudSendLink(email) {
  const back = location.origin + location.pathname;
  // create_user false: a link goes only to an account that already exists, none is made.
  await clFetch(`/auth/v1/otp?redirect_to=${encodeURIComponent(back)}`, { method: "POST", body: { email, create_user: false } });
}

// Where the emails' links bring the user back: this page, without its address extras.
const clBack = () => encodeURIComponent(location.origin + location.pathname);

/**
 * Create an account with email and password. Supabase emails a link to confirm the address; the
 * link signs the user in (cloudFromUrl). While sign-ups are closed in the Supabase dashboard,
 * the answer is "Signups not allowed for this instance" (account.js says so in plain words).
 */
export async function cloudSignUp(email, password) {
  await clFetch(`/auth/v1/signup?redirect_to=${clBack()}`, { method: "POST", body: { email, password } });
}

/** Forgot password: Supabase emails a link that signs the user in to choose a new password. */
export async function cloudSendReset(email) {
  await clFetch(`/auth/v1/recover?redirect_to=${clBack()}`, { method: "POST", body: { email } });
}

/** Set a new password for the signed-in user (after a Forgot password link, or to change it). */
export async function cloudSetPassword(password) {
  await clAuthed("/auth/v1/user", { method: "PUT", body: { password } });
}

/**
 * Delete the account on the server (the delete-account function: the user and, through
 * ON DELETE CASCADE, their profile, saves, runs, edelweiss and AI jobs), then forget the session.
 */
export async function cloudDeleteAccount() {
  await clAuthed(CL_DELETE, { method: "POST", body: {} });
  clSession = null;
  clWrite(null);
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
  // Read-only app: only reads, plus the sign-in API (send link, refresh, sign out) may go out.
  if (method !== "GET" && !clMayWrite(path)) throw new Error(CL_READONLY);
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
// The only writes are the profile and the saved items (Boss, 2026-10-18); no upload of the run
// log, no token claim, no AI job. They are kept for later in supabase/app-writes-later.js.
// clFetch also refuses any request that is not a GET outside the sign-in API (/auth/v1/).
/** The profile stored in the account (the data of profile.js), or null when there is none yet. */
export async function cloudProfile() {
  const rows = await clAuthed("/rest/v1/profiles?select=data");
  return rows && rows[0] ? rows[0].data : null;
}
/**
 * Save the profile (one row per user): an "upsert", meaning insert the row, or update it when the
 * user already has one (Prefer: resolution=merge-duplicates, matched on user_id). The database
 * checks the owner (Row Level Security) and refuses heart or weight data.
 */
export async function cloudPutProfile(data) {
  await clAuthed(CL_PROFILE_WRITE, { method: "POST", body: { user_id: cloudUser().id, data, updated_at: new Date().toISOString() }, headers: { Prefer: "resolution=merge-duplicates,return=minimal" } });
}

/** The saved items, newest first: [{ id, kind, title, data, created_at }]. */
export async function cloudSaved() {
  return (await clAuthed(`${CL_SAVED}?select=id,kind,title,data,created_at&order=created_at.desc`)) || [];
}
/** Keep one item ({ kind, title, data }, checked by savedCheck in core/saved.js first). */
export async function cloudSave(item) {
  await clAuthed(CL_SAVED, { method: "POST", body: { kind: item.kind, title: item.title, data: item.data }, headers: { Prefer: "return=minimal" } });
}
/** Delete one saved item by its id (a uuid; encodeURIComponent keeps the address safe). */
export async function cloudSavedDelete(id) {
  await clAuthed(`${CL_SAVED}?id=eq.${encodeURIComponent(id)}`, { method: "DELETE" });
}

/** The run summaries stored in the account. */
export async function cloudRuns() {
  // Each row holds one summary in its `rec` column: return the list of summaries.
  return ((await clAuthed("/rest/v1/runs?select=rec")) || []).map((r) => r.rec);
}
/**
 * The token ledger, newest first: [{ delta, reason, created_at }]. Each line is one movement:
 * +N earned (reason "ach:<code>" or "event:<code>"), -1 spent on an analysis (reason "ai"),
 * +1 "refund" when an analysis failed.
 */
export async function cloudLedger() {
  return (await clAuthed("/rest/v1/edelweiss_ledger?select=delta,reason,created_at&order=created_at.desc")) || [];
}
/**
 * Send one AI request (the ai-analyse function): mode "prep_race" or "prep_run" and the input the
 * app built for it. The server checks, spends one edelweiss and starts the OpenAI call; it answers
 * at once with { job } (then poll cloudJob). Throws the server's message: no edelweiss left, a
 * request already running, the AI not switched on (nothing spent in those cases).
 */
export async function cloudAi(mode, input) {
  if (!cloudAiOn()) throw new Error("The AI opens with the online account, soon.");
  return clAuthed(CL_AI, { method: "POST", body: { mode, input } });
}
/** One analysis job by id: { id, status ("running", "done" or "failed"), result, error, created_at }. */
export async function cloudJob(id) {
  const rows = await clAuthed(`/rest/v1/ai_jobs?id=eq.${encodeURIComponent(id)}&select=id,status,result,error,created_at`);
  return rows && rows[0];
}
