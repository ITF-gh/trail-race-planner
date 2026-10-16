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
// Prep my run works the same way with its AI coach (core/airun.js): its own answer is kept under
// "trp.ai.prep_run", checked again by aiRunMerge, and its switch sits above the run's cockpit.
//
// Main exports: arUse (make an AI doc the one played), arState (is there an AI plan for this
// plan, and which), arBarHtml (the switch and the AI summary above the cockpit).

import { aiPrepMerge } from "../core/aiprep.js";
import { aiRunMerge } from "../core/airun.js";
import { hm } from "../core/format.js";
import { raceLegs } from "../core/script.js";

// Per mode: where its answer is kept and which referee rebuilds it.
const AR_MODES = { prep_race: { key: "trp.ai.race", merge: aiPrepMerge }, prep_run: { key: "trp.ai.prep_run", merge: aiRunMerge } };
// Escape text for HTML: AI texts are never read as HTML.
const arEsc = (s) => String(s === null || s === undefined ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
// The last merge per mode, so redraws (scenario change, theme) do not rebuild it.
const arCache = { prep_race: { plan: null, at: null, result: null }, prep_run: { plan: null, at: null, result: null } };
const arMode = (m) => (m === "prep_run" ? "prep_run" : "prep_race");

/**
 * Make an AI doc (aidocs.js) the one its mode plays (doc.mode: "prep_race", the default, plays in
 * Your race; "prep_run" in Prep my run): { id, mode, race, raceName, at, input, output, tokens }.
 */
export function arUse(doc) {
  const mode = arMode(doc.mode);
  const rec = { id: doc.id, mode, race: doc.race, raceName: doc.raceName, at: doc.at, input: doc.input, output: doc.output, tokens: doc.tokens };
  try { localStorage.setItem(AR_MODES[mode].key, JSON.stringify(rec)); } catch (e) { /* full or blocked: kept for this visit only */ }
  arMem[mode] = rec;
}
const arMem = { prep_race: null, prep_run: null }; // the answers of this visit, when localStorage is blocked
function arLoad(mode) {
  if (arMem[mode]) return arMem[mode];
  try { arMem[mode] = JSON.parse(localStorage.getItem(AR_MODES[mode].key) || "null"); } catch (e) { arMem[mode] = null; }
  return arMem[mode];
}

/**
 * The AI side for the calculated `plan` of race (or run) `race`, in `mode` ("prep_race" by default).
 * Returns { state, rec, result }:
 *   state   "none" (no answer for this race), "stale" (an answer made from an older plan),
 *           "empty" (the AI or the referee returned nothing usable), "ok"
 *   result  aiPrepMerge's result when ok: result.plan is the AI plan to play
 */
export function arState(plan, race, mode = "prep_race") {
  mode = arMode(mode);
  const rec = arLoad(mode);
  if (!plan || !rec) return { state: "none", mode, rec: null, result: null };
  if (rec.race !== race) return { state: "other", mode, rec, result: null };
  const legs = rec.input && rec.input.race && rec.input.race.legs;
  const calc = rec.input && rec.input.calc && rec.input.calc.finishSec;
  // Same plan: same number of sections and the same calculated finish (within a minute).
  const same = legs && calc && Math.abs(calc.central - plan.scenarios.central.finishSec) < 60 && legs.length === raceLegs(plan, "central").length;
  if (!same) return { state: "stale", mode, rec, result: null };
  const C = arCache[mode];
  if (C.plan !== plan || C.at !== rec.at) Object.assign(C, { plan, at: rec.at, result: AR_MODES[mode].merge(plan, rec.input, rec.output) });
  const result = C.result;
  return { state: result.status === "ok" ? "ok" : "empty", mode, rec, result };
}

/**
 * HTML of the bar above the cockpit: the Calculated / AI switch, then, with AI on, the AI's
 * headline, its verdict on the target, both finish times, its answer to the question and its
 * strengths and weaknesses. `on`: the AI side is shown. `calcSec`: the calculated finish of the
 * scenario shown, `aiSec` the AI one.
 */
export function arBarHtml(s, on, calcSec, aiSec) {
  const can = s.state === "ok";
  if (s.mode === "prep_run") return arRunBarHtml(s, on && can, calcSec, aiSec);
  const note = {
    other: `The AI doc in use is for another race (${arEsc(s.rec && s.rec.raceName)}). Pick one for this race in the account menu > AI docs, or <button class="ar-link" type="button" data-ar="ask">✦ Ask the AI</button>`,
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

// The switch alone (both modes); `on` = the AI side is shown, `can` = there is one to show.
const arSwitch = (on, can) => `<div class="ar-switch" role="group" aria-label="Plan shown">
    <button type="button" data-ar="calc" class="${on ? "" : "on"}" aria-pressed="${!on}">Calculated</button>
    <button type="button" data-ar="ai" class="${on ? "on" : ""}" aria-pressed="${on}"${can ? "" : " disabled"}>✦ AI</button>
  </div>`;

/**
 * The bar above the Prep my run cockpit: the switch, then, with the AI coach on, its session:
 * headline, the exercises (dose, km, clock), its answer, and the why in a fold.
 */
function arRunBarHtml(s, on, calcSec, aiSec) {
  const can = s.state === "ok";
  const ask = (t) => `<button class="ar-link" type="button" data-ar="ask">✦ ${t}</button>`;
  const note = {
    other: `The coach's last session is for another run (${arEsc(s.rec && s.rec.raceName)}). ${ask("Ask the AI coach")}`,
    none: `No AI session for this run yet. ${ask("Ask the AI coach")}`,
    stale: `This run changed since the coach's answer (target or start time). ${ask("Ask again")}`,
    empty: `The last answer was empty (${arEsc(s.result && s.result.reason)}): nothing to show. ${ask("Ask again")}`,
    ok: "A session from the AI coach is ready: switch to AI to play it.",
  }[s.state];
  if (!on) return `<div class="ar-bar">${arSwitch(false, can)}<p class="ar-note">${note}</p></div>`;
  const R = s.result, T = R.texts || {}, D = R.dataset || {};
  const ex = R.exercises.length
    ? `<ol class="ar-ex">${R.exercises.map((e) => `<li><b>${arEsc(e.title)}</b> <span class="ar-dose">${arEsc(e.dose)}</span> <small>km ${e.startKm}–${e.endKm} · ${hm(e.atSec)} · effort ${e.effort}/5</small></li>`).join("")}</ol>`
    : `<p class="ar-note">No exercise: an easy run.</p>`;
  return `<div class="ar-bar on">${arSwitch(true, true)}
    <div class="ar-sum">
      <p class="ar-k">✦ AI coach · ${arEsc(D.session && D.session.type)} · ${R.exercises.length} exercise${R.exercises.length === 1 ? "" : "s"} · ${hm(aiSec)} <small>(easy pace ${hm(calcSec)}, hard work ${Math.round(R.workSec / 60)} min)</small></p>
      <h3>${arEsc(T.headline)}</h3>
      ${ex}
      ${T.answer ? `<p class="ar-answer">${arEsc(T.answer)}</p>` : ""}
      <details><summary>Why this session, warm-up and spots left out</summary>
        <p>${arEsc(T.synthesis)}</p>
        ${T.warmup ? `<p><b>Warm-up:</b> ${arEsc(T.warmup)}<br><b>Cool-down:</b> ${arEsc(T.cooldown)}</p>` : ""}
        ${R.exercises.map((e) => (e.why ? `<p><b>${arEsc(e.title)}:</b> ${arEsc(e.why)}</p>` : "")).join("")}
        ${(T.skipped || []).length ? `<h4>Spots left out</h4><ul>${T.skipped.slice(0, 5).map((x) => `<li>${arEsc(x.spotId)}: ${arEsc(x.why)}</li>`).join("")}</ul>` : ""}
        ${T.loadNote ? `<h4>Load</h4><p>${arEsc(T.loadNote)}</p>` : ""}
        ${T.nextSteps ? `<h4>Next steps</h4><p>${arEsc(T.nextSteps)}</p>` : ""}
        ${R.fixes.length ? `<h4>Corrected by the app</h4><ul>${R.fixes.map((f) => `<li>${arEsc(f)}</li>`).join("")}</ul>` : ""}
      </details>
    </div></div>`;
}
