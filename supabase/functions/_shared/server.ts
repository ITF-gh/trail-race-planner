// server.ts: what every function needs: CORS, the signed-in user, and the database interface
// that cairns.js expects, built on the Supabase client with the service role (which bypasses
// Row Level Security, so this code must always filter by the user id itself).

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.117.2";

// Pages allowed to call the functions: the live site and a local dev server.
const ORIGINS = ["https://itf-gh.github.io", "http://localhost:5173", "http://127.0.0.1:5173"];

export function cors(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") || "";
  return {
    "Access-Control-Allow-Origin": ORIGINS.includes(origin) ? origin : ORIGINS[0],
    "Access-Control-Allow-Headers": "authorization, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

export function json(req: Request, status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...cors(req), "Content-Type": "application/json" } });
}

export function admin(): SupabaseClient {
  return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** The user behind the request's token, or null. */
export async function userOf(req: Request, sb: SupabaseClient): Promise<string | null> {
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return null;
  const { data, error } = await sb.auth.getUser(token);
  return error || !data.user ? null : data.user.id;
}

export function makeDb(sb: SupabaseClient) {
  // deno-lint-ignore no-explicit-any
  const must = (r: { data: any; error: unknown }): any => { if (r.error) throw r.error; return r.data ?? []; };
  return {
    async listRuns(userId: string) {
      return must(await sb.from("runs").select("rec").eq("user_id", userId)).map((r: { rec: unknown }) => r.rec);
    },
    async listLedger(userId: string) {
      return must(await sb.from("cairn_ledger").select("delta, reason, ref").eq("user_id", userId));
    },
    // One row at a time: a row already there (an achievement paid before) is skipped, not an error.
    async addLedger(rows: Array<Record<string, unknown>>) {
      const added = [];
      for (const row of rows) {
        const { error } = await sb.from("cairn_ledger").insert(row);
        if (!error) added.push(row);
        else if ((error as { code?: string }).code !== "23505") throw error;
      }
      return added;
    },
    async spendCairn(userId: string, jobId: string) {
      return must(await sb.rpc("spend_cairn", { p_user: userId, p_job: jobId })) === true;
    },
    async runningJob(userId: string, sinceMs: number) {
      const rows = must(await sb.from("ai_jobs").select("id").eq("user_id", userId).eq("status", "running")
        .gte("created_at", new Date(sinceMs).toISOString()).limit(1));
      return rows.length > 0;
    },
    async createJob(job: Record<string, unknown>) { must(await sb.from("ai_jobs").insert(job)); },
    async finishJob(id: string, patch: Record<string, unknown>) { must(await sb.from("ai_jobs").update(patch).eq("id", id)); },
  };
}
