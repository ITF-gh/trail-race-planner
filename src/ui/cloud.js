// cloud.js: the online account, talking to Supabase with plain fetch() calls (no library, like the rest of the app). Two parts of Supabase are used, each through its HTTP API: Auth /auth/v1/... sign in with a one-time email link, refresh the session REST /rest/v1/<table> READ the user's rows only (Row Level Security in the database makes sure a token only reaches its own rows), and WRITE the user's own profile and saved items (Boss, 2026-10-18) The server functions (/functions/v1/...): delete-account, and ai-analyse (one AI request, one edelweiss) once CLOUD.ai is switched on (Boss, 2026-10-23).
import { captchaToken } from "./captcha.js";


export const CLOUD = {
  url: "https://vjhzcuvxucpldhsjpqrl.supabase.co", // the project address (Project settings > API)
  anonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZqaHpjdXZ4dWNwbGRoc2pwcXJsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTIzMTk4OTUsImV4cCI6MjEwNzg5NTg5NX0.I6XJP6XyZmxwFOsosDkEP2HvDirC8tUA7XkNPfrPhxk",
  // the "anon public" key: safe to publish, Row Level Security does the protecting
  connect: true, // true = read-only: sign in and read, never write (supabase/SETUP.md, step 6)
  // The online AI (ai-analyse). On 2026-10-23 to 2026-10-27, OFF again on Boss's word (2026-10-27):
  // the AI button is blocked and nothing is sent. Removing the App1 secret in Supabase stops the
  // server side too (it then answers "not switched on yet" and spends nothing).
  ai: false,
  // New accounts: true = open sign-ups (Boss, 2026-11-03), with email confirmation, bot check and 10 new accounts an hour (step 10 SQL).
  signup: true,
  // Cloudflare Turnstile site key (public). Set = every sign-up, sign-in and reset sends a bot-check token.
  captcha: "0x4AAAAAAFx3ksz20HjpY2fQ",
};

/** The message every write call throws while the account is read-only (account.js shows it). */
export const CL_READONLY = "Only your profile is saved to the online account for now.";

// The writes the app may make (Boss, 2026-10-18): the user's own profile row, and the items they choose to keep ("Save to my account": add one, delete one).
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

/** Read and write the saved session in localStorage, as JSON text. */
function clRead() { try { return JSON.parse(localStorage.getItem(CL_SESSION) || "null"); } catch (e) { return null; } }
function clWrite(s) { try { if (s) localStorage.setItem(CL_SESSION, JSON.stringify(s)); else localStorage.removeItem(CL_SESSION); } catch (e) { /* private mode: signed in for this visit only */ } }
// The session in memory, read from storage on first use (see cloudUser).
let clSession = null;

/** The signed-in user ({ id, email }) or null. */
export function cloudUser() {
  if (!clSession) clSession = clRead();
  return clSession ? { id: clSession.userId, email: clSession.email } : null;
}

// A sign-in waiting for its 2-step code: { access, refresh, expiresIn, user, factorId }, never stored.
let clPending = null;
const clVerified = (user) => ((user && user.factors) || []).find((f) => f.factor_type === "totp" && f.status === "verified");
/** Keep a new session, or hold it until the 2-step code when the user has set one up. Returns "mfa" or "ok". */
function clStart(access, refresh, expiresIn, user) {
  const f = clVerified(user);
  if (f) { clPending = { access, refresh, expiresIn, user, factorId: f.id }; return "mfa"; }
  clSession = { access, refresh, expiresAt: Date.now() + (Number(expiresIn) || 3600) * 1000, userId: user.id, email: user.email || "" };
  clWrite(clSession);
  return "ok";
}
/** True while a sign-in waits for its 2-step code. */
export const cloudMfaPending = () => Boolean(clPending);
/** Drop a sign-in waiting for its code. */
export function cloudMfaCancel() {
  const p = clPending;
  clPending = null;
  if (p) clFetch("/auth/v1/logout", { method: "POST", token: p.access }).catch(() => {});
}
// Challenge then verify one 6-digit code; Supabase answers with a 2-step (aal2) session.
async function clMfaCheck(factorId, code, token) {
  const ch = await clFetch(`/auth/v1/factors/${encodeURIComponent(factorId)}/challenge`, { method: "POST", body: {}, token });
  return clFetch(`/auth/v1/factors/${encodeURIComponent(factorId)}/verify`, { method: "POST", body: { challenge_id: ch.id, code: String(code).replace(/\s/g, "") }, token });
}
/** Finish a waiting sign-in with the code of the authenticator app. */
export async function cloudMfaVerify(code) {
  if (!clPending) throw new Error("Sign in again");
  const r = await clMfaCheck(clPending.factorId, code, clPending.access);
  const user = r.user || clPending.user;
  clPending = null;
  clSession = { access: r.access_token, refresh: r.refresh_token, expiresAt: Date.now() + (r.expires_in || 3600) * 1000, userId: user.id, email: user.email || "" };
  clWrite(clSession);
}
/** The verified 2-step factors of the signed-in user. */
export async function cloudMfaList() {
  const u = await clAuthed("/auth/v1/user");
  return ((u && u.factors) || []).filter((f) => f.status === "verified");
}
/** Start 2-step login: drop half-made factors, then make one ({ id, qr, secret }). */
export async function cloudMfaEnroll() {
  const u = await clAuthed("/auth/v1/user");
  for (const f of (u && u.factors) || []) if (f.status !== "verified") await clAuthed(`/auth/v1/factors/${encodeURIComponent(f.id)}`, { method: "DELETE" }).catch(() => {});
  const r = await clAuthed("/auth/v1/factors", { method: "POST", body: { factor_type: "totp", friendly_name: `Prep my race ${Date.now()}` } });
  return { id: r.id, qr: clQr(r.totp && r.totp.qr_code), secret: r.totp && r.totp.secret };
}
// Supabase's QR (an SVG data URI, raw or percent-encoded) as one clean encoded data URI.
function clQr(qr) {
  if (!qr || !/^data:image\/svg\+xml/.test(qr)) return "";
  let svg = qr.slice(qr.indexOf(",") + 1);
  if (/^%3C/i.test(svg)) try { svg = decodeURIComponent(svg); } catch (e) { return ""; }
  return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
}
/** Confirm the new factor with a first code: from then on, sign-in asks for a code. */
export async function cloudMfaConfirm(factorId, code) {
  const r = await clMfaCheck(factorId, code, await clToken());
  clSession = { ...clSession, access: r.access_token, refresh: r.refresh_token, expiresAt: Date.now() + (r.expires_in || 3600) * 1000 };
  clWrite(clSession);
}
/** Turn 2-step login off (needs the 2-step session the sign-in gave). */
export async function cloudMfaRemove(factorId) {
  await clAuthed(`/auth/v1/factors/${encodeURIComponent(factorId)}`, { method: "DELETE" });
}

// The bot-check part of an auth request body (empty while no site key is set).
const clBot = async () => { const t = await captchaToken(CLOUD.captcha); return t ? { gotrue_meta_security: { captcha_token: t } } : {}; };

/** Turn the tokens Supabase puts in the URL after a sign-in link into a session (then tidy the URL). */
export async function cloudFromUrl() {
  if (!cloudOn() || !location.hash.includes("access_token=")) return false;
  // "recovery" when the link came from Forgot password, "signup" from the confirm email.
  const kind = new URLSearchParams(location.hash.slice(1)).get("type") || "magiclink";
  // location.hash is "#access_token=...&..."; slice(1) drops the "#" and URLSearchParams reads the key=value pairs.
  const p = new URLSearchParams(location.hash.slice(1));
  // replaceState changes the address shown without reloading the page, so the tokens do not stay visible (or in a bookmark).
  try { history.replaceState(null, "", location.pathname + location.search); } catch (e) { /* sandboxed frame */ }
  const access = p.get("access_token"), refresh = p.get("refresh_token");
  if (!access || !refresh) return false;
  // Ask Supabase who this token belongs to; a bad token gives null (the .catch).
  const user = await clFetch("/auth/v1/user", { token: access }).catch(() => null);
  if (!user || !user.id) return false;
  // expires_in is in seconds (3600 when missing); expiresAt is the moment in milliseconds.
  clStart(access, refresh, p.get("expires_in"), user);
  return kind;
}

/** Sign in with email and password (the password is set on the user in the Supabase dashboard). */
export async function cloudSignInPassword(email, password) {
  const r = await clFetch("/auth/v1/token?grant_type=password", { method: "POST", body: { email, password, ...(await clBot()) } });
  if (!r || !r.access_token || !r.user) throw new Error("Sign-in failed");
  return clStart(r.access_token, r.refresh_token, r.expires_in, r.user);
}

/** Ask Supabase to email a one-time sign-in link that brings the user back to this page. */
export async function cloudSendLink(email) {
  const back = location.origin + location.pathname;
  // create_user false: a link goes only to an account that already exists, none is made.
  await clFetch(`/auth/v1/otp?redirect_to=${encodeURIComponent(back)}`, { method: "POST", body: { email, create_user: false, ...(await clBot()) } });
}

// Where the emails' links bring the user back: this page, without its address extras.
const clBack = () => encodeURIComponent(location.origin + location.pathname);

/** Create an account with email and password; the consent date goes in the user's metadata. */
export async function cloudSignUp(email, password) {
  await clFetch(`/auth/v1/signup?redirect_to=${clBack()}`, { method: "POST", body: { email, password, data: { consent: new Date().toISOString().slice(0, 10) }, ...(await clBot()) } });
}

/** Forgot password: Supabase emails a link that signs the user in to choose a new password. */
export async function cloudSendReset(email) {
  await clFetch(`/auth/v1/recover?redirect_to=${clBack()}`, { method: "POST", body: { email, ...(await clBot()) } });
}

/** Set a new password for the signed-in user (after a Forgot password link, or to change it). */
export async function cloudSetPassword(password) {
  await clAuthed("/auth/v1/user", { method: "PUT", body: { password } });
}

/** Delete the account on the server (the delete-account function: the user and, through ON DELETE CASCADE, their profile, saves, runs, edelweiss and AI jobs), then forget the session. */
export async function cloudDeleteAccount() {
  await clAuthed(CL_DELETE, { method: "POST", body: {} });
  clSession = null;
  clWrite(null);
}

/** Sign out: forget the session here at once, then tell Supabase to end it (a network failure is ignored: the session is already gone from this browser). */
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
  // Keep the user fields, replace the tokens and the expiry ({ ...a, x: 1 } copies a, then sets x).
  clSession = { ...clSession, access: r.access_token, refresh: r.refresh_token, expiresAt: Date.now() + r.expires_in * 1000 };
  clWrite(clSession);
  return clSession.access;
}

/** One HTTP request to Supabase. */
async function clFetch(path, { method = "GET", body, token, headers = {} } = {}) {
  // Read-only app: only reads, plus the sign-in API (send link, refresh, sign out) may go out.
  if (method !== "GET" && !clMayWrite(path)) throw new Error(CL_READONLY);
  const res = await fetch(CLOUD.url + path, {
    method,
    // ...(body ? {...} : {}) adds the Content-Type header only when there is a body; ...headers lets the caller add or override headers.
    headers: { apikey: CLOUD.anonKey, Authorization: `Bearer ${token || CLOUD.anonKey}`, ...(body ? { "Content-Type": "application/json" } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
  // res.ok is true for statuses 200 to 299.
  if (!res.ok) { const err = new Error((data && (data.error || data.msg || data.message)) || `HTTP ${res.status}`); err.status = res.status; throw err; }
  return data;
}
// The same request as the signed-in user (gets or refreshes the access token first).
const clAuthed = async (path, opts = {}) => clFetch(path, { ...opts, token: await clToken() });

// The data calls. The only writes are the profile and the saved items (Boss, 2026-10-18); no upload of the run log, no token claim, no AI job.
/** The profile stored in the account (the data of profile.js), or null when there is none yet. */
export async function cloudProfile() {
  const rows = await clAuthed("/rest/v1/profiles?select=data");
  return rows && rows[0] ? rows[0].data : null;
}
/** Save the profile (one row per user): an "upsert", meaning insert the row, or update it when the user already has one (Prefer: resolution=merge-duplicates, matched on user_id). */
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
/** The token ledger, newest first: [{ delta, reason, created_at }]. */
export async function cloudLedger() {
  return (await clAuthed("/rest/v1/edelweiss_ledger?select=delta,reason,created_at&order=created_at.desc")) || [];
}
/** Send one AI request (the ai-analyse function): mode "prep_race" or "prep_run" and the input the app built for it. */
export async function cloudAi(mode, input) {
  if (!cloudAiOn()) throw new Error("The AI opens with the online account, soon.");
  return clAuthed(CL_AI, { method: "POST", body: { mode, input } });
}
/** One analysis job by id: { id, status ("running", "done" or "failed"), result, error, created_at }. */
export async function cloudJob(id) {
  const rows = await clAuthed(`/rest/v1/ai_jobs?id=eq.${encodeURIComponent(id)}&select=id,status,result,error,created_at`);
  return rows && rows[0];
}
