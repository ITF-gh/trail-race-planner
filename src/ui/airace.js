// airace.js: the AI plan in section 04 Your race (Prep my race), and its Calculated / AI switch.
//
// The last AI answer for a race is kept in localStorage (key "trp.ai.race"): the INPUT that was
// sent and the AI's raw OUTPUT, not the rebuilt plan. Each time Your race is drawn, the code
// takes the whole process again: aiPrepMerge (core/aiprep.js) checks the output against the
// input and rebuilds a plan with the same shape as the calculated one, so the cockpit (map,
// section bar, profile, section cards, race script) plays it exactly like the calculated plan.
//
// The answer only fits the plan it was made from. When the race or its calculated plan changed
// since (another GPX, other runs, other settings), the AI side is "stale" and stays off until the
// runner asks again: the AI's leg times were judged against the old calculation.
//
// Main exports: arSave (keep a new answer), arState (is there an AI plan for this plan, and
// which), arBarHtml (the switch and the AI summary above the cockpit).

import { aiPrepMerge } from "../core/aiprep.js";
import { hm } from "../core/format.js";
import { raceLegs } from "../core/script.js";

const AR_KEY = "trp.ai.race";
// Escape text for HTML: AI texts are never read as HTML.
const arEsc = (s) => String(s === null || s === undefined ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
// The last merge, so redraws (scenario change, theme) do not rebuild it: same plan, same answer.
let arCache = { plan: null, at: null, result: null };

/** Keep a new AI answer for `race` (the race key "name|km"): { input, output, tokens }. */
export function arSave(race, x) {
  const rec = { race, at: new Date().toISOString(), input: x.input, output: x.output, tokens: x.tokens };
  try { localStorage.setItem(AR_KEY, JSON.stringify(rec)); } catch (e) { /* full or blocked: kept for this visit only */ }
  arMem = rec;
}
let arMem = null; // the answer of this visit, when localStorage is blocked
function arLoad() {
  if (arMem) return arMem;
  try { arMem = JSON.parse(localStorage.getItem(AR_KEY) || "null"); } catch (e) { arMem = null; }
  return arMem;
}

/**
 * The AI side for the calculated `plan` of race `race`.
 * Returns { state, rec, result }:
 *   state   "none" (no answer for this race), "stale" (an answer made from an older plan),
 *           "empty" (the AI or the referee returned nothing usable), "ok"
 *   result  aiPrepMerge's result when ok: result.plan is the AI plan to play
 */
export function arState(plan, race) {
  const rec = arLoad();
  if (!plan || !rec || rec.race !== race) return { state: "none", rec: null, result: null };
  const legs = rec.input && rec.input.race && rec.input.race.legs;
  const calc = rec.input && rec.input.calc && rec.input.calc.finishSec;
  // Same plan: same number of sections and the same calculated finish (within a minute).
  const same = legs && calc && Math.abs(calc.central - plan.scenarios.central.finishSec) < 60 && legs.length === raceLegs(plan, "central").length;
  if (!same) return { state: "stale", rec, result: null };
  if (arCache.plan !== plan || arCache.at !== rec.at) arCache = { plan, at: rec.at, result: aiPrepMerge(plan, rec.input, rec.output) };
  const result = arCache.result;
  return { state: result.status === "ok" ? "ok" : "empty", rec, result };
}

/**
 * HTML of the bar above the cockpit: the Calculated / AI switch, then, with AI on, the AI's
 * headline, its verdict on the target, both finish times, its answer to the question and its
 * strengths and weaknesses. `on`: the AI side is shown. `calcSec`: the calculated finish of the
 * scenario shown, `aiSec` the AI one.
 */
export function arBarHtml(s, on, calcSec, aiSec) {
  const can = s.state === "ok";
  const note = {
    none: `No AI plan for this race yet. <button class="ar-link" type="button" data-ar="ask">✦ Ask the AI</button>`,
    stale: `Your plan changed since the AI answer (other files or settings). <button class="ar-link" type="button" data-ar="ask">✦ Ask again</button>`,
    empty: `The last AI answer was empty (${arEsc(s.result && s.result.reason)}): nothing to show. <button class="ar-link" type="button" data-ar="ask">✦ Ask again</button>`,
    ok: on ? "" : `An AI plan is ready: switch to AI to play it.`,
  }[s.state];
  const sw = `<div class="ar-switch" role="group" aria-label="Plan shown">
      <button type="button" data-ar="calc" class="${on && can ? "" : "on"}" aria-pressed="${!(on && can)}">Calculated</button>
      <button type="button" data-ar="ai" class="${on && can ? "on" : ""}" aria-pressed="${on && can}"${can ? "" : " disabled"}>✦ AI</button>
    </div>`;
  if (!(on && can)) return `<div class="ar-bar">${sw}<p class="ar-note">${note}</p></div>`;
  const T = s.result.texts || {};
  const D = s.result.dataset;
  const diff = aiSec - calcSec;
  const pts = (a) => (a || []).slice(0, 3).map((p) => `<li><b>${arEsc(p.what)}</b> ${arEsc(p.effect)}</li>`).join("");
  return `<div class="ar-bar on">${sw}
    <div class="ar-sum">
      <p class="ar-k">✦ AI plan · ${arEsc(D.target.verdict)} · ${hm(aiSec)} <small>(calculated ${hm(calcSec)}, ${diff > 0 ? "+" : diff < 0 ? "−" : ""}${hm(Math.abs(diff))})</small></p>
      <h3>${arEsc(T.headline)}</h3>
      ${T.answer ? `<p class="ar-answer">${arEsc(T.answer)}</p>` : ""}
      <details><summary>Why, strengths and weaknesses</summary>
        <p>${arEsc(T.synthesis)}</p>
        <div class="ar-cols"><div><h4>Strengths</h4><ul>${pts(T.strengths)}</ul></div><div><h4>Weaknesses</h4><ul>${pts(T.weaknesses)}</ul></div></div>
        ${T.nextSteps ? `<h4>Next steps</h4><p>${arEsc(T.nextSteps)}</p>` : ""}
        ${s.result.fixes.length ? `<h4>Corrected by the app</h4><ul>${s.result.fixes.map((f) => `<li>${arEsc(f)}</li>`).join("")}</ul>` : ""}
      </details>
    </div></div>`;
}
