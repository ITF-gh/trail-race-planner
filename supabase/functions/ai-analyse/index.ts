// POST /functions/v1/ai-analyse  body { athlete: { hrMax, hrRest, weight }, ask: { from, to, ids, focus, question } }
// Spends one cairn and starts an AI analysis of the runs stored in the account. Answers at once
// with { job } (HTTP 202); the analysis runs in the background and the app polls the ai_jobs row.
// The Anthropic API key is a secret of this function (ANTHROPIC_API_KEY): it never reaches the browser.
import Anthropic from "npm:@anthropic-ai/sdk@0.131.0";
import { admin, cors, json, makeDb, userOf } from "../_shared/server.ts";
import { aiStart, aiRun } from "../_shared/cairns.js";

const anthropic = new Anthropic({ apiKey: Deno.env.get("ANTHROPIC_API_KEY") });
// deno-lint-ignore no-explicit-any
const callClaude = (request: any) => anthropic.beta.messages.stream(request).finalMessage();

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(req) });
  const sb = admin();
  const user = await userOf(req, sb);
  if (!user) return json(req, 401, { error: "Please sign in." });
  const body = await req.json().catch(() => ({}));
  const db = makeDb(sb);
  try {
    const start = await aiStart({ db, userId: user, athlete: body.athlete, ask: body.ask, newId: () => crypto.randomUUID() });
    if (start.status !== 202) return json(req, start.status, { error: start.error });
    // Keep working after the answer is sent (Supabase's background tasks).
    // deno-lint-ignore no-explicit-any
    (globalThis as any).EdgeRuntime.waitUntil(aiRun({ db, callClaude, userId: user, job: start.job, digest: start.digest, ask: start.ask }));
    return json(req, 202, { job: start.job, runs: start.digest!.runs });
  } catch (e) {
    console.error(e);
    return json(req, 500, { error: "Could not start the analysis." });
  }
});
