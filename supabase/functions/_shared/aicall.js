// aicall.js: one AI request of the app (Prep my race or the Prep my run coach), on the server, as plain functions so the tests can run them in Node with a fake database and a fake OpenAI. Edelweiss rule (Boss, 2026-10-16): spent once the call is made.

import { aiPrepRequest, aiPrepRead, AI_PREP_MODEL } from "./core/aiprep.js";
import { aiRunRequest } from "./core/airun.js";

// The modes the server accepts, and how each builds its request.
export const AI_MODES = { prep_race: aiPrepRequest, prep_run: aiRunRequest };
// The model is the server's choice (Boss: gpt-4o-mini, cheap enough).
export const AI_MODEL = AI_PREP_MODEL;
// Largest input accepted, in characters of JSON (a long race with a full run history is ~100 k).
export const AI_INPUT_MAX = 400000;
// A job still "running" after this long is treated as stuck, and no longer blocks a new one.
const AI_STUCK_MS = 6 * 60000;

/** A copy of `x` without any heart rate or body weight (keys starting with athlete, hr, maxhr, resthr, heart or weight, at any depth): what is kept online in the ai_jobs row. Heart rate and weight are never stored online (Boss's rule); they only travel to OpenAI for the one call. */
export function aiNoBody(x) {
  if (Array.isArray(x)) return x.map(aiNoBody);
  if (!x || typeof x !== "object") return x;
  const out = {};
  for (const [k, v] of Object.entries(x)) if (!/^(athlete|hr|maxhr|resthr|heart|weight)/i.test(k)) out[k] = aiNoBody(v);
  return out;
}

/** First step. */
export async function aiBegin({ db, userId, mode, input, hasKey, now = Date.now(), newId }) {
  if (!Object.prototype.hasOwnProperty.call(AI_MODES, mode)) return { status: 400, error: "Unknown AI mode." };
  if (!input || typeof input !== "object" || Array.isArray(input)) return { status: 400, error: "Nothing to send." };
  if (JSON.stringify(input).length > AI_INPUT_MAX) return { status: 413, error: "This race is too large for the AI." };
  if (!hasKey) return { status: 503, error: "The AI is not switched on yet. Nothing was spent." };
  if (await db.runningJob(userId, now - AI_STUCK_MS)) return { status: 409, error: "An AI request is already running." };
  // The request is built before anything is spent: a broken input fails here, for free.
  let request;
  try { request = AI_MODES[mode](input, { model: AI_MODEL }); } catch (e) { return { status: 400, error: "This input cannot be read." }; }
  const id = newId();
  await db.createJob({ id, user_id: userId, status: "running", model: AI_MODEL, mode });
  if (!(await db.spendCairn(userId, id))) {
    await db.finishJob(id, { status: "failed", error: "no edelweiss", finished_at: new Date(now).toISOString() });
    return { status: 402, error: "No edelweiss left." };
  }
  return { status: 202, job: id, request };
}

/** Second step. */
export async function aiFinish({ db, callOpenAI, userId, job, request, mode, input }) {
  let res;
  try { res = await callOpenAI(request); } catch (e) { res = { error: { message: `OpenAI could not be reached (${(e && e.message) || e}).` } }; }
  const read = aiPrepRead(res, mode);
  const finished_at = new Date().toISOString();
  if (!read.tokens.total) {
    await db.addLedger([{ user_id: userId, delta: 1, reason: "refund", ref: job }]);
    const patch = { status: "failed", error: String(read.error || "No answer.").slice(0, 500), finished_at };
    await db.finishJob(job, patch);
    return patch;
  }
  const patch = {
    status: read.output ? "done" : "failed",
    error: read.output ? null : String(read.error).slice(0, 500),
    model: read.tokens.model || AI_MODEL,
    result: { mode, input: aiNoBody(input), output: read.output, tokens: read.tokens },
    input_tokens: read.tokens.input, output_tokens: read.tokens.output, finished_at,
  };
  await db.finishJob(job, patch);
  return patch;
}
