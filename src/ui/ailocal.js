// ailocal.js: the local test mode of the Ask the AI window (Prep my race), in the browser.
//
// Only when the page is opened from `npm run ai-browser` (scripts/ai-serve.js) on this computer:
// that small server answers GET /local-ai, and the window then sends the request to it instead of
// the online account. The live site never has it, so this file does nothing there.
//
// The work is split the same way as it will be online:
//   browser  builds the INPUT and the ONE request (core/aiprep.js), then, with the answer, runs
//            the referee and the rebuild (aiPrepMerge) and shows the result
//   server   adds the OpenAI key (from .env.local, it never reaches the page), makes the call,
//            and saves every step in ai-runs/<date-time>/ for later reading
// A "fake answer" (aiPrepFake, made by code) runs the whole chain without a key and for free.
//
// Second way, with nothing to install: the built page opened as a file (double-click on
// index.html of the test folder, address file:///...). There is no server, so the runner types
// the key in the window: it stays in this tab's memory only (never saved, never in the page's
// storage, gone when the tab closes) and goes straight to OpenAI, whose API accepts calls from
// a browser. The test is then offered as a download instead of being saved in ai-runs/.

import { aiPrepInput, aiPrepRequest, aiPrepRead, aiPrepMerge, aiPrepFake } from "../core/aiprep.js";
import { hms } from "../core/format.js";

// Escape text for HTML (& < > " become entities): AI texts are never read as HTML.
const alEsc = (s) => String(s === null || s === undefined ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/**
 * Is the local test server there? Only asked on localhost / 127.0.0.1 (the live site skips it).
 * Resolves to { key, model } (key: true when .env.local holds an OpenAI key) or null.
 */
export async function aiLocalProbe() {
  if (typeof location === "undefined") return null;
  // Opened as a file: the direct way, the key is typed in the window.
  if (location.protocol === "file:") return { key: false, model: "gpt-5.4-mini", direct: true, apiKey: "" };
  if (!/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) return null;
  try {
    const r = await fetch("/local-ai", { cache: "no-store" });
    const j = r.ok ? await r.json() : null;
    return j && j.local ? { key: Boolean(j.key), model: j.model || "" } : null;
  } catch (e) {
    return null;
  }
}

/**
 * The direct way: the one call from this page to OpenAI, with the key typed in the window.
 * Resolves to the API's answer (or { error } when the network fails), like the server's.
 */
async function alDirect(request, apiKey) {
  try {
    const r = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(request),
    });
    return await r.json();
  } catch (e) {
    return { error: { message: `OpenAI could not be reached (${e.message}).` } };
  }
}

/**
 * Run one local test. `x` = { plan, raceName, user, athlete, history, fake, model, direct, apiKey }.
 * Returns { input, read, result, stamp } (result is aiPrepMerge's), or { error } when nothing
 * could be sent. One POST sends the request (the server calls OpenAI, or not when fake); a second
 * one sends back what the referee made of it, so the folder holds the whole story.
 */
export async function aiLocalRun(x) {
  if (!x.plan) return { error: "Load a race GPX and at least one run in Your runs first: the plan is what the AI reads." };
  const input = aiPrepInput(x.plan, { raceName: x.raceName, user: x.user, athlete: x.athlete, history: x.history });
  const request = aiPrepRequest(input, { model: x.model || undefined });
  if (x.direct) {
    if (!x.fake && !x.apiKey) return { error: "Paste your OpenAI key in the window first (it starts with sk-)." };
    const response = x.fake ? null : await alDirect(request, x.apiKey);
    const read = x.fake
      ? { output: aiPrepFake(input), tokens: { requestType: "prep_race", model: "fake", input: 0, inputCached: 0, output: 0, reasoning: 0, total: 0 }, error: "" }
      : aiPrepRead(response);
    const result = read.output ? aiPrepMerge(x.plan, input, read.output) : { status: "null", reason: read.error, legs: [], aid: [], fixes: [], texts: null };
    const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
    // The file to send back for tuning: everything but the key (which is only in the headers).
    const file = { input, request, response, output: read.output, result: { status: result.status, reason: result.reason, tokens: read.tokens, finishSec: result.finishSec, aiFinishSec: result.aiFinishSec, fixes: result.fixes, legs: result.legs, aid: result.aid, texts: result.texts } };
    return { input, read, result, stamp, download: URL.createObjectURL(new Blob([JSON.stringify(file, null, 2)], { type: "application/json" })) };
  }
  const post = (path, body) => fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
  let res;
  try {
    res = await post("/local-ai", { request, input, fake: Boolean(x.fake) });
  } catch (e) {
    return { error: `The local server did not answer (${e.message}). Is npm run ai-browser still running?` };
  }
  const read = x.fake
    ? { output: aiPrepFake(input), tokens: { requestType: "prep_race", model: "fake", input: 0, inputCached: 0, output: 0, reasoning: 0, total: 0 }, error: "" }
    : aiPrepRead(res.response);
  const result = read.output ? aiPrepMerge(x.plan, input, read.output) : { status: "null", reason: read.error, legs: [], aid: [], fixes: [], texts: null };
  const keep = { status: result.status, reason: result.reason, tokens: read.tokens, finishSec: result.finishSec, aiFinishSec: result.aiFinishSec, fixes: result.fixes, legs: result.legs, aid: result.aid, texts: result.texts };
  await post("/local-ai/save", { stamp: res.stamp, output: read.output, result: keep }).catch(() => null);
  return { input, read, result, stamp: res.stamp || "" };
}

/** HTML of a local test result, for the pop-up panel. */
export function aiLocalHtml(r) {
  if (r.error) return `<p class="acct-kicker">Local AI test</p><h3>Nothing sent</h3><p>${alEsc(r.error)}</p>`;
  const { input, read, result: m } = r;
  const T = m.texts || {};
  const tk = read.tokens;
  const tokens = `<table class="acct-tbl"><tr><th>Input</th><th>Cached</th><th>Output</th><th>Reasoning</th><th>Total</th><th>Model</th></tr>
    <tr><td>${tk.input}</td><td>${tk.inputCached}</td><td>${tk.output}</td><td>${tk.reasoning}</td><td>${tk.total}</td><td>${alEsc(tk.model)}</td></tr></table>`;
  const saved = r.download
    ? `<p class="acct-note"><a class="btn ghost sm" href="${r.download}" download="ai-test-${alEsc(r.stamp)}.json">Download this test</a> to send it back for tuning (it holds no key).</p>`
    : r.stamp ? `<p class="acct-note">Saved in ai-runs/${alEsc(r.stamp)}/ on your computer.</p>` : "";
  const fixes = `<h4>Referee fixes</h4>${m.fixes.length ? `<ul>${m.fixes.map((f) => `<li>${alEsc(f)}</li>`).join("")}</ul>` : "<p>None: the answer was used as given.</p>"}`;
  if (m.status !== "ok") {
    return `<p class="acct-kicker">Local AI test · empty result</p><h3>The AI answer is not used</h3>
      <p>Reason: <b>${alEsc(m.reason || "unknown")}</b>. In the app, this answer would show nothing and change nothing.</p>
      ${m.fixes.length ? fixes : ""}<h4>Tokens</h4>${tokens}${saved}`;
  }
  const pts = (a) => (a && a.length ? `<ul>${a.map((p) => `<li><b>${alEsc(p.what)}</b>: ${alEsc(p.effect)} <small>(${alEsc(p.proof)})</small></li>`).join("")}</ul>` : "<p>-</p>");
  const legs = `<div class="acct-tbl-wrap"><table class="acct-tbl"><tr><th>Leg</th><th>km</th><th>Calc.</th><th>AI</th><th>Diff</th><th>Mode</th><th>Why</th></tr>
    ${m.legs.map((l) => `<tr${l.mark ? ' class="mark"' : ""}><td>${l.id} ${alEsc(l.kind)}${l.n ? " " + alEsc(l.n) : ""}</td><td>${l.startKm}–${l.endKm}</td><td>${hms(l.calcSec)}</td><td>${hms(l.aiSec)}</td><td>${l.pct > 0 ? "+" : ""}${l.pct}%</td><td>${alEsc(l.mode || "")}</td><td>${alEsc(l.why)}</td></tr>`).join("")}</table></div>`;
  const aid = m.aid.length ? `<h4>Aid stations</h4><div class="acct-tbl-wrap"><table class="acct-tbl"><tr><th>Aid</th><th>km</th><th>Typed stop</th><th>AI stop</th><th>Arrival</th></tr>
    ${m.aid.map((s) => `<tr${s.aiStopMin !== s.stopMin ? ' class="mark"' : ""}><td>${alEsc(s.name)}</td><td>${s.km}</td><td>${s.stopMin} min</td><td>${s.aiStopMin} min</td><td>${hms(s.arriveSec)}</td></tr>`).join("")}</table></div>` : "";
  const D = m.dataset;
  return `<p class="acct-kicker">Local AI test · ${alEsc(tk.model)}</p>
    <h3>${alEsc(T.headline)}</h3>
    <div class="acct-actions"><button class="btn primary" type="button" data-acct="ai-race">▶ Play it in Your race</button></div>
    <p>Calculated finish <b>${hms(input.calc.finishSec.central)}</b> · AI finish (summed by code) <b>${hms(m.finishSec)}</b> · AI's own estimate ${hms(m.aiFinishSec)} · verdict <b>${alEsc(D.target.verdict)}</b></p>
    ${T.answer ? `<p class="acct-answer">${alEsc(T.answer)}</p>` : ""}
    <p>${alEsc(T.synthesis)}</p>
    <div class="acct-ai-cols"><div><h4>Strengths</h4>${pts(T.strengths)}</div><div><h4>Weaknesses</h4>${pts(T.weaknesses)}</div></div>
    ${m.legs.every((l) => Math.abs(l.pct) < 0.5) ? `<p class="acct-note">The AI kept the calculated time on every section: this answer adds no tailoring to the times.</p>` : ""}
    <h4>Legs (moving time; highlighted = more than 3% apart)</h4>${legs}
    ${aid}
    <h4>Fuel: ${alEsc(D.fuel.carbsPerHour)} g carbs per hour</h4>
    ${D.fuel.items.length ? `<ul>${D.fuel.items.map((f) => `<li>${alEsc(f.legId)} (${alEsc(f.at)}): ${alEsc(f.item)}, ${alEsc(f.carbsG)} g</li>`).join("")}</ul>` : ""}
    ${(T.watchTexts || []).length ? `<h4>Watch texts</h4><ul>${T.watchTexts.map((w) => `<li>${alEsc(w.legId)}: <code>${alEsc(w.text)}</code></li>`).join("")}</ul>` : ""}
    ${T.nextSteps ? `<h4>Next steps</h4><p>${alEsc(T.nextSteps)}</p>` : ""}
    ${fixes}<h4>Tokens</h4>${tokens}${saved}`;
}
