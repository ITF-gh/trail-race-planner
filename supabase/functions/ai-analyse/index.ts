// POST /functions/v1/ai-analyse  body { mode: "prep_race" | "prep_run", input }
// One AI request of the app: spends one edelweiss and asks OpenAI in the background. Answers at
// once with { job } (HTTP 202); the app polls the ai_jobs row for the answer.
// The OpenAI key is a secret of this function, named App1 (Boss, 2026-10-23; OPENAI_API_KEY still
// works): it never reaches the browser.
// Without it, the function answers 503 and spends nothing (the AI stays off).
//
// This file is only the "plumbing": the real logic (checks, edelweiss, request, saving) is in
// ../_shared/aicall.js (aiBegin, aiFinish), which the tests run in Node with fakes.
import { admin, cors, json, makeDb, userOf } from "../_shared/server.ts";
import { aiBegin, aiFinish } from "../_shared/aicall.js";

const KEY = Deno.env.get("App1") || Deno.env.get("APP1") || Deno.env.get("OPENAI_API_KEY") || "";
// The one call to the OpenAI Responses API; resolves to its JSON answer (an error is in it too).
// deno-lint-ignore no-explicit-any
const callOpenAI = async (request: any) => {
  const r = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
    body: JSON.stringify(request),
  });
  return await r.json();
};

// Deno.serve runs this function for every HTTP request.
Deno.serve(async (req) => {
  // CORS preflight: the browser asks first whether the call is allowed.
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(req) });
  // Who is calling? Without a valid sign-in token: 401.
  const sb = admin();
  const user = await userOf(req, sb);
  if (!user) return json(req, 401, { error: "Please sign in." });
  const body = await req.json().catch(() => ({}));
  const db = makeDb(sb);
  try {
    const start = await aiBegin({ db, userId: user, mode: body.mode, input: body.input, hasKey: Boolean(KEY), newId: () => crypto.randomUUID() });
    if (start.status !== 202) return json(req, start.status, { error: start.error });
    // Keep working after the answer is sent (Supabase's background tasks): EdgeRuntime.waitUntil
    // keeps the function alive until aiFinish is done. TypeScript does not know EdgeRuntime.
    // deno-lint-ignore no-explicit-any
    (globalThis as any).EdgeRuntime.waitUntil(aiFinish({ db, callOpenAI, userId: user, job: start.job, request: start.request, mode: body.mode, input: body.input }));
    return json(req, 202, { job: start.job });
  } catch (e) {
    console.error(e);
    return json(req, 500, { error: "Could not start the AI request." });
  }
});
