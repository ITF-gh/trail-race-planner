// server.ts: what every function needs: CORS, the signed-in user, and the database interface
// that cairns.js expects, built on the Supabase client with the service role (which bypasses
// Row Level Security, so this code must always filter by the user id itself).
//
// This file is TypeScript (JavaScript with type annotations such as `userId: string`), run by
// Deno, the JavaScript runtime that Supabase Edge Functions use. The annotations only help
// catch mistakes; they do not change what the code does.
// The "npm:" prefix in the import below is how Deno loads a package from npm, pinned to a version.
//
// Exports: cors (CORS headers), json (a JSON response), admin (a database client with full
// rights), userOf (who sent the request), makeDb (the `db` interface used by cairns.js).

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.117.2";

// Pages allowed to call the functions: the live site and a local dev server.
const ORIGINS = ["https://itf-gh.github.io", "http://localhost:5173", "http://127.0.0.1:5173"];

/**
 * CORS headers for a response. CORS (Cross-Origin Resource Sharing) is the browser rule that
 * stops a page from reading answers from another site unless that site says it is allowed.
 * The page's address arrives in the request's "origin" header; if it is in ORIGINS it is echoed
 * back (allowed), otherwise the first origin is sent, which the browser will not match.
 * "Vary: Origin" tells caches that the answer depends on the origin header.
 * Returns a plain object of header name -> value.
 */
export function cors(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") || "";
  return {
    "Access-Control-Allow-Origin": ORIGINS.includes(origin) ? origin : ORIGINS[0],
    "Access-Control-Allow-Headers": "authorization, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

/**
 * A JSON response with an HTTP status (200 ok, 401 not signed in, 500 server error...) and the
 * CORS headers. `{ ...cors(req), ... }` is the spread syntax: copy every header from cors()
 * into a new object, then add Content-Type.
 */
export function json(req: Request, status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...cors(req), "Content-Type": "application/json" } });
}

/**
 * A Supabase client with the service role key, read from the function's environment (secrets
 * set in Supabase, never sent to the browser). It has full rights on the database, so every
 * query below filters by user id itself. The `!` after Deno.env.get(...) tells TypeScript
 * "this value is not missing". No session is stored or refreshed: each request is independent.
 */
export function admin(): SupabaseClient {
  return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * The user behind the request's token, or null.
 * The browser sends "Authorization: Bearer <token>" (the signed-in user's access token).
 * The regex ^Bearer\s+ (case-insensitive, `i`) removes the word "Bearer" and its spaces, then
 * Supabase checks the token and tells us whose it is. Returns the user id (a uuid) or null.
 */
export async function userOf(req: Request, sb: SupabaseClient): Promise<string | null> {
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return null;
  const { data, error } = await sb.auth.getUser(token);
  return error || !data.user ? null : data.user.id;
}

/**
 * The `db` interface that cairns.js expects, on top of the Supabase client `sb`.
 * Every method is a query on one of the three tables (runs, edelweiss_ledger, ai_jobs) or a call to
 * the spend_edelweiss database function, restricted to one user id (finishJob uses the job id,
 * a random uuid created for that user's job).
 * Each Supabase call returns { data, error } instead of throwing; `must` turns an error into a
 * thrown exception (so the caller's try/catch sees it) and returns the data, or [] when empty.
 */
export function makeDb(sb: SupabaseClient) {
  // deno-lint-ignore no-explicit-any
  const must = (r: { data: any; error: unknown }): any => { if (r.error) throw r.error; return r.data ?? []; };
  return {
    // The stored run summaries (the `rec` JSON column) of one user.
    async listRuns(userId: string) {
      return must(await sb.from("runs").select("rec").eq("user_id", userId)).map((r: { rec: unknown }) => r.rec);
    },
    // Every movement of the user's cairn ledger.
    async listLedger(userId: string) {
      return must(await sb.from("edelweiss_ledger").select("delta, reason, ref").eq("user_id", userId));
    },
    // One row at a time: a row already there (an achievement paid before) is skipped, not an error.
    // 23505 is PostgreSQL's error code for "unique violation" (the unique indexes on the ledger).
    // Any other error is thrown. Returns the rows that were actually inserted.
    async addLedger(rows: Array<Record<string, unknown>>) {
      const added = [];
      for (const row of rows) {
        const { error } = await sb.from("edelweiss_ledger").insert(row);
        if (!error) added.push(row);
        else if ((error as { code?: string }).code !== "23505") throw error;
      }
      return added;
    },
    // Calls the database function spend_edelweiss (an RPC, "remote procedure call"); true = spent.
    async spendCairn(userId: string, jobId: string) {
      return must(await sb.rpc("spend_edelweiss", { p_user: userId, p_job: jobId })) === true;
    },
    // Is there a job of this user with status "running" created at or after sinceMs (gte =
    // greater than or equal)? limit(1): one row is enough to answer yes.
    async runningJob(userId: string, sinceMs: number) {
      const rows = must(await sb.from("ai_jobs").select("id").eq("user_id", userId).eq("status", "running")
        .gte("created_at", new Date(sinceMs).toISOString()).limit(1));
      return rows.length > 0;
    },
    // Insert a new job row; update a job row by id with the fields in `patch`.
    async createJob(job: Record<string, unknown>) { must(await sb.from("ai_jobs").insert(job)); },
    async finishJob(id: string, patch: Record<string, unknown>) { must(await sb.from("ai_jobs").update(patch).eq("id", id)); },
  };
}
