// POST /functions/v1/ai-analyse  body { athlete: { hrMax, hrRest, weight } }
// Spends one cairn and starts an AI analysis of the runs stored in the account. Answers at once
// with { job } (HTTP 202); the analysis runs in the background and the app polls the ai_jobs row.
// The Anthropic API key is a secret of this function (ANTHROPIC_API_KEY): it never reaches the browser.
//
// This file is only the "plumbing": the real logic (checks, cairn, prompt, saving) is in
// ../_shared/cairns.js (aiStart, aiRun), which the tests run in Node with fakes.
import Anthropic from "npm:@anthropic-ai/sdk@0.131.0";
import { admin, cors, json, makeDb, userOf } from "../_shared/server.ts";
import { aiStart, aiRun } from "../_shared/cairns.js";

// One Anthropic client for the life of the function, created when it starts.
const anthropic = new Anthropic({ apiKey: Deno.env.get("ANTHROPIC_API_KEY") });
// Send a request and wait for the complete answer. The answer is streamed (received piece by
// piece) and finalMessage() assembles the whole Message; `beta` because the request uses a beta
// feature (the server-side fallback, see aiRequest in cairns.js).
// deno-lint-ignore no-explicit-any
const callClaude = (request: any) => anthropic.beta.messages.stream(request).finalMessage();

// Deno.serve runs this function for every HTTP request.
Deno.serve(async (req) => {
  // 1. Browsers first send an OPTIONS "preflight" request to ask whether the call is allowed
  //    (CORS); answer it with the CORS headers only.
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(req) });
  // 2. Who is calling? Without a valid sign-in token: 401.
  const sb = admin();
  const user = await userOf(req, sb);
  if (!user) return json(req, 401, { error: "Please sign in." });
  // 3. Read the JSON body; a missing or broken body becomes an empty object instead of an error.
  const body = await req.json().catch(() => ({}));
  const db = makeDb(sb);
  try {
    // 4. Checks, job row, cairn spent. crypto.randomUUID() makes the job's random unique id.
    const start = await aiStart({ db, userId: user, athlete: body.athlete, newId: () => crypto.randomUUID() });
    if (start.status !== 202) return json(req, start.status, { error: start.error });
    // Keep working after the answer is sent (Supabase's background tasks).
    // EdgeRuntime.waitUntil(promise) keeps the function alive until aiRun finishes, even though
    // the HTTP answer below has already been sent. TypeScript does not know EdgeRuntime, hence
    // the `as any`.
    // deno-lint-ignore no-explicit-any
    (globalThis as any).EdgeRuntime.waitUntil(aiRun({ db, callClaude, userId: user, job: start.job, digest: start.digest }));
    // 5. Answer at once with the job id (the app then polls the ai_jobs row for the result).
    return json(req, 202, { job: start.job, runs: start.digest!.runs });
  } catch (e) {
    console.error(e);
    return json(req, 500, { error: "Could not start the analysis." });
  }
});
