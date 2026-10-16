// account.js: the account icon at the top right of the hero and its see-through menu.
//
// The run log lives in this browser, in IndexedDB (a small database every browser has, much
// roomier than localStorage). Each run you open in Rewind my run, or add as one of your runs in
// Prep my race, is summarised (src/core/runrecord.js) and stored; sample and demo runs are not.
// The menu is re-drawn from the stored summaries (src/core/history.js).
//
// Signed in (cloud.js, when the online account is set up), the same summaries are also kept in
// the account, so they follow you to every device, and the account holds your AI tokens (edelweiss): earned
// with achievements (checked by the server), spent on an AI analysis of all your runs.

import { parseGpx } from "../core/track.js";
import { analyseRun } from "../core/review.js";
import { historySummary, aiSelect, AI_FOCUS, AI_QUESTION_MAX } from "../core/history.js";
import { runRecord } from "../core/runrecord.js";
import { demoRecords, DEMO_USER } from "../core/demorecords.js";
import { mmss, hms } from "../core/format.js";
import { trackEvent } from "./analytics.js";
import { cloudOn, cloudUser, cloudFromUrl, cloudSendLink, cloudSignOut, cloudRuns, cloudPutRuns, cloudDeleteRuns, cloudLedger, cloudClaim, cloudAnalyse, cloudJob, cloudJobs, cloudDeleteAccount } from "./cloud.js";

const AC_DB = "trp-history", AC_STORE = "runs";
let acCache = null; // the records, once read; also the fallback when IndexedDB is blocked
const acEsc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/** Open (and on first use create) the database. Resolves to null when the browser blocks it. */
function acOpen() {
  return new Promise((ok) => {
    try {
      const req = indexedDB.open(AC_DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(AC_STORE, { keyPath: "id" });
      req.onsuccess = () => ok(req.result);
      req.onerror = () => ok(null);
    } catch (e) { ok(null); }
  });
}
/** Run one request in a transaction; resolves with its result (or null on failure). */
async function acTx(mode, make) {
  const db = await acOpen();
  if (!db) return null;
  return new Promise((ok) => {
    try {
      const tx = db.transaction(AC_STORE, mode);
      const req = make(tx.objectStore(AC_STORE));
      tx.oncomplete = () => { db.close(); ok(req ? req.result : true); };
      tx.onerror = tx.onabort = () => { db.close(); ok(null); };
    } catch (e) { db.close(); ok(null); }
  });
}
async function acAll() {
  if (!acCache) acCache = (await acTx("readonly", (s) => s.getAll())) || [];
  return acCache;
}

/** Store the summary of an analysed run (same run twice = one copy). */
export async function acctSaveRun(run, name) {
  let rec;
  try { rec = runRecord(run, name); } catch (e) { return; }
  const list = await acAll();
  const isNew = !list.some((r) => r.id === rec.id);
  acCache = list.filter((r) => r.id !== rec.id).concat(rec);
  await acTx("readwrite", (s) => s.put(rec));
  if (isNew) trackEvent("history-save", String(acCache.length));
  acRender();
  if (cloudOn() && cloudUser()) {
    try { await cloudPutRuns([rec]); await acClaim(); } catch (e) { /* offline: the next sync sends it */ }
    acRender();
  }
}
/** Same, from a GPX file (used for the runs added in Prep my race). Files that are not runs are skipped. */
export function acctSaveGpx(xml, name) {
  try { acctSaveRun(analyseRun(parseGpx(xml)), name); } catch (e) { /* a route without times, or too short: not a run */ }
}

const acDate = (ms) => new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short" });
const acNum = (x) => Math.round(x).toLocaleString("en-US");
// The AI token: earned with achievements and events, 1 token = 1 AI analysis. Its name lives here
// only (the database and the server still call it a "cairn" internally, which nobody sees).
const AC_TOKEN = { one: "edelweiss", many: "edelweiss" }; // the same word in the singular and the plural
const acTok = (n) => `${n} ${n === 1 ? AC_TOKEN.one : AC_TOKEN.many}`;
const AC_SPARK = `<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M14 3c.9 6.2 3.8 9.1 10 10-6.2.9-9.1 3.8-10 10-.9-6.2-3.8-9.1-10-10 6.2-.9 9.1-3.8 10-10z" fill="#ffc928"/><path d="M25 18.5c.4 2.7 1.6 3.9 4.3 4.3-2.7.4-3.9 1.6-4.3 4.3-.4-2.7-1.6-3.9-4.3-4.3 2.7-.4 3.9-1.6 4.3-4.3z" fill="#fff1b8"/></svg>`;

// What the account side knows (filled by acSync): the token ledger, the analysis running, a message.
const ac = { ledger: null, jobs: [], job: null, msg: "", busy: false };
const acBalance = () => (ac.ledger ? ac.ledger.reduce((s, r) => s + r.delta, 0) : 0);
let acList = [], acDemo = false; // the runs the menu shows (yours, or User1's)

function acTokensHtml(S) {
  const signedIn = cloudOn() && cloudUser();
  const n = signedIn ? (ac.ledger ? acBalance() : "…") : S.cairns;
  let note = `Earned with achievements and events. 1 ${AC_TOKEN.one} buys 1 AI analysis of the runs you choose.`;
  if (signedIn && ac.msg) note = acEsc(ac.msg);
  else if (signedIn && ac.job) note = "Claude is reading your runs. It takes about a minute; you can close this menu.";
  const signin = cloudOn() && !signedIn ? `<form class="acct-signin" data-acct-form="signin">
        <label for="acEmail">Sign in to collect them</label>
        <div><input id="acEmail" type="email" required autocomplete="email" placeholder="you@example.com"><button class="btn ghost" type="submit"${ac.busy ? " disabled" : ""}>Send link</button></div>
      </form>` : "";
  return `<section><h4>AI ${AC_TOKEN.many}</h4>
      <div class="acct-cairns"><b>${AC_SPARK}${n}</b><button class="btn primary" type="button" data-acct="ai"${ac.job ? " disabled" : ""}>${ac.job ? "Analysing…" : `${AC_SPARK}Ask the AI`}</button></div>
      <p class="acct-note">${note}</p>${signin}
      ${signedIn && ac.jobs.length ? `<button class="acct-linkbtn" type="button" data-acct="last">See my last analysis (${acDate(Date.parse(ac.jobs[0].created_at))})</button>` : ""}
    </section>`;
}

function acMenuHtml(S, demo = false) {
  const user = cloudOn() && cloudUser();
  const where = demo ? `Demo profile · ${S.count} sample runs` : user ? `${acEsc(user.email)} · ${S.count} run${S.count === 1 ? "" : "s"} synced` : `${S.count || "No"} run${S.count === 1 ? "" : "s"} on this device`;
  const who = `<section class="acct-who"><div><b>${demo ? DEMO_USER : "My account"}</b><small>${where}</small></div></section>`;
  const links = `<section class="acct-links">${S.count ? `<button type="button" data-acct="bests">All-time bests</button>` : ""}${S.count && !demo ? `<button type="button" data-acct="export">Export</button><button type="button" data-acct="clear">Delete runs</button>` : ""}${user ? `<button type="button" data-acct="signout">Sign out</button><button type="button" data-acct="delete">Delete account</button>` : ""}</section>`;
  if (!S.count) {
    return `${who}
    <section><p class="acct-empty">Open one of your runs in <b>Rewind my run</b>, or add it to <b>Your runs</b> in Prep my race: its numbers are kept here${user ? "" : ", on this device only"}, and your stats, records and achievements build up run after run.</p></section>
    ${acTokensHtml(S)}${links}`;
  }
  const gainK = S.year.gain >= 10000 ? `${(S.year.gain / 1000).toFixed(1)}k` : acNum(S.year.gain);
  const medals = [...S.achievements].sort((a, b) => b.done - a.done || b.progress - a.progress);
  return `${who}
    <section><h4>Last 12 months</h4>
      <div class="acct-kpis"><div><b>${acNum(S.year.km)}</b><small>km</small></div><div><b>${gainK}</b><small>m D+</small></div><div><b>${acNum(S.year.movingSec / 3600)} h</b><small>moving</small></div></div>
    </section>
    <section><h4>Last runs</h4>
      ${S.last.map((r) => `<div class="acct-row"><span>${acDate(r.date)} · ${acEsc(r.name)}</span><b>${r.km.toFixed(1)} km · ${acNum(r.gain)} m</b></div>`).join("")}
    </section>
    <section><h4>Achievements · ${S.unlocked} / ${S.achievements.length}</h4>
      <div class="acct-medals mini">${medals.map((a) => `<span class="${a.done ? "" : "lock"}" title="${acEsc(a.label)}: ${acEsc(a.hint)}${a.done ? "" : ` (${Math.floor(a.progress * 100)}%)`}${a.cairns ? ` · +${acTok(a.cairns)}` : ""}">${a.icon}</span>`).join("")}</div>
    </section>
    ${acTokensHtml(S)}
    ${links}`;
}

/** All-time bests, in the pop-up (they used to make the menu too long). */
function acBestsHtml(S) {
  const B = S.bests;
  const row = (label, b, f) => (b ? `<div class="acct-row"><span>${label}</span><b>${f(b.value, b.run)} <small>${acDate(b.run.date)}</small></b></div>` : "");
  return `<p class="acct-kicker">${acDemo ? DEMO_USER : "My account"}</p><h3>All-time bests</h3>
    <div class="acct-bests">
      ${row("Fastest 1 km", B.best1k, (v) => mmss(v))}
      ${row("Fastest 5 km", B.best5k, (v) => mmss(v))}
      ${row("Fastest 10 km", B.best10k, (v) => (v < 3600 ? mmss(v) : hms(v)))}
      ${row("Best climbing speed", B.vam, (v) => `${acNum(v)} m/h`)}
      ${row("Longest run", B.longest, (v, r) => `${v.toFixed(1)} km · ${acNum(r.gain)} m`)}
    </div>`;
}

// The AI window: the runner picks the source data (a date range or chosen runs), an axis and a question.
const acAsk = { mode: "dates", from: null, to: null, ids: new Set(), focus: "overall", question: "" };
const acDay = (ms) => new Date(ms).toISOString().slice(0, 10);
const acToday = () => { const d = new Date(); return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()); };
function acAskPayload() {
  return acAsk.mode === "runs"
    ? { ids: [...acAsk.ids], focus: acAsk.focus, question: acAsk.question }
    : { from: acAsk.from, to: acAsk.to, focus: acAsk.focus, question: acAsk.question };
}
function acAskState() {
  const runs = aiSelect(acList, acAskPayload());
  const signedIn = cloudOn() && cloudUser();
  const bal = acBalance();
  let block = "";
  if (!runs.length) block = "Choose at least one run.";
  else if (!cloudOn()) block = acDemo ? "Demo profile: the AI opens with the online account." : "The AI opens with the online account, soon.";
  else if (!signedIn) block = "Sign in first (in the menu).";
  else if (bal < 1) block = `No ${AC_TOKEN.one} left: earn one with an achievement or an event.`;
  return { runs, block };
}
function acAskSummary() {
  const { runs, block } = acAskState();
  const km = runs.reduce((t, r) => t + r.km, 0);
  const span = runs.length ? `, ${acDate(Math.min(...runs.map((r) => r.date)))} to ${acDate(Math.max(...runs.map((r) => r.date)))}` : "";
  return { runs, block, text: `<b>${runs.length} run${runs.length === 1 ? "" : "s"} · ${acNum(km)} km</b>${span}` };
}
function acAskHtml() {
  if (acAsk.from === null && acAsk.to === null) { acAsk.to = acToday(); acAsk.from = acAsk.to - 90 * 86400000; }
  const sorted = [...acList].sort((a, b) => b.date - a.date);
  const sum = acAskSummary();
  const chip = (attr, label, on) => `<button type="button" class="acct-chip${on ? " on" : ""}" ${attr}>${label}</button>`;
  return `<p class="acct-kicker">${AC_SPARK} Ask the AI · 1 ${AC_TOKEN.one}</p>
    <h3>What should Claude look at?</h3>
    <h4>1 · Your data</h4>
    <div class="acct-chips">${chip('data-acct="mode:dates"', "Date range", acAsk.mode === "dates")}${chip('data-acct="mode:runs"', "Pick runs", acAsk.mode === "runs")}</div>
    ${acAsk.mode === "dates" ? `<div class="acct-range">
        <label>From <input type="date" data-ask="from" value="${acDay(acAsk.from)}"></label>
        <label>To <input type="date" data-ask="to" value="${acDay(acAsk.to)}"></label>
        <div class="acct-chips small">${[[28, "4 weeks"], [91, "3 months"], [365, "12 months"], [0, "Everything"]].map(([d, l]) => chip(`data-acct="range:${d}"`, l, false)).join("")}</div>
      </div>` : `<div class="acct-pick">${sorted.map((r) => `<label><input type="checkbox" data-ask="run" value="${acEsc(r.id)}"${acAsk.ids.has(r.id) ? " checked" : ""}><span>${acDate(r.date)} · ${acEsc(r.name)}</span><b>${r.km.toFixed(1)} km · ${acNum(r.gain)} m</b></label>`).join("")}</div>`}
    <p class="acct-ask-count">${sum.text}</p>
    <h4>2 · Axis of analysis</h4>
    <div class="acct-chips">${AI_FOCUS.map((f) => chip(`data-acct="focus:${f.code}"`, f.label, acAsk.focus === f.code)).join("")}</div>
    <h4>3 · Your question <small>(optional)</small></h4>
    <textarea class="acct-q" data-ask="question" maxlength="${AI_QUESTION_MAX}" rows="2" placeholder="How can I go sub-40 in 10K in a month?">${acEsc(acAsk.question)}</textarea>
    <p class="acct-note">Sent: the numbers of the selected runs (date, distance, climbing, times, grade-adjusted pace, heart rate, fade, heart drift, climbing speed, fastest 1, 5 and 10 km), your athlete settings, the axis and your question. <b>Not sent:</b> run names, GPS tracks, your email. If the analysis fails, your ${AC_TOKEN.one} comes back.</p>
    <div class="acct-actions"><button class="btn primary" type="button" data-acct="go"${sum.block ? " disabled" : ""}>${AC_SPARK}Spend 1 ${AC_TOKEN.one}</button><button class="btn ghost" type="button" data-acct="close">Cancel</button></div>
    <p class="acct-note acct-ask-block">${sum.block}</p>`;
}
/** Refresh the count and the button without redrawing the window (keeps the cursor where it is). */
function acAskRefresh() {
  const sum = acAskSummary();
  const c = acPanel.querySelector(".acct-ask-count"), go = acPanel.querySelector('[data-acct="go"]'), bl = acPanel.querySelector(".acct-ask-block");
  if (c) c.innerHTML = sum.text;
  if (go) go.disabled = Boolean(sum.block);
  if (bl) bl.textContent = sum.block;
}
function acAskInput(el) {
  const k = el.dataset.ask;
  if (k === "question") acAsk.question = el.value;
  else if (k === "from" || k === "to") { const v = Date.parse(el.value); if (Number.isFinite(v)) acAsk[k] = v; }
  else if (k === "run") { if (el.checked) acAsk.ids.add(el.value); else acAsk.ids.delete(el.value); }
  acAskRefresh();
}

let acEl = null, acMenu = null, acPanel = null;

async function acRender() {
  if (!acMenu) return;
  const mine = await acAll();
  // No run of your own yet (and not signed in): show the demo profile User1 and its made-up runs,
  // so the menu is never empty. Your first saved run replaces it.
  acDemo = !mine.length && !(cloudOn() && cloudUser());
  acList = acDemo ? demoRecords() : mine;
  acMenu.innerHTML = acMenuHtml(historySummary(acList), acDemo);
}

/** Ask the server for the cairns of the achievements reached, then read the ledger. */
async function acClaim() {
  await cloudClaim().catch(() => null);
  ac.ledger = await cloudLedger();
}

/** Signed in: send the runs the account does not have, fetch the ones this device lacks, then cairns. */
async function acSync() {
  if (!cloudOn() || !cloudUser()) return;
  try {
    const [local, remote] = [await acAll(), await cloudRuns()];
    const have = new Set(remote.map((r) => r.id));
    await cloudPutRuns(local.filter((r) => !have.has(r.id)));
    const mine = new Set(local.map((r) => r.id));
    const fresh = remote.filter((r) => r && r.id && !mine.has(r.id));
    if (fresh.length) {
      acCache = local.concat(fresh);
      await acTx("readwrite", (s) => { fresh.forEach((r) => s.put(r)); return null; });
    }
    await acClaim();
    ac.jobs = await cloudJobs();
    ac.msg = "";
  } catch (e) {
    ac.msg = e.message === "Session expired, please sign in again" ? e.message : "Could not reach your account. Your runs are safe on this device.";
  }
  acRender();
}

/** The see-through panel for the AI analysis: the consent before, the answer after. */
function acShowPanel(html, label = "AI analysis") {
  acPanel.innerHTML = `<div class="acct-panel-in" role="dialog" aria-modal="true" aria-label="${label}"><button class="acct-x" type="button" data-acct="close" aria-label="Close">×</button>${html}</div>`;
  acPanel.hidden = false;
  const x = acPanel.querySelector(".acct-x");
  if (x) x.focus();
}
function acResultHtml(r, when) {
  const list = (a) => (a && a.length ? `<ul>${a.map((x) => `<li>${acEsc(x)}</li>`).join("")}</ul>` : "");
  return `<p class="acct-kicker">AI analysis${when ? ` · ${acDate(Date.parse(when))}` : ""}</p>
    <h3>${acEsc(r.headline || "")}</h3>
    ${r.answer ? `<p class="acct-answer">${acEsc(r.answer)}</p>` : ""}
    <p>${acEsc(r.summary || "")}</p>
    ${r.kpis && r.kpis.length ? `<h4>New KPIs</h4><div class="acct-ai-kpis">${r.kpis.map((k) => `<div><span>${acEsc(k.name)}</span><b>${acEsc(k.value)} <small>${acEsc(k.unit)}</small></b><p>${acEsc(k.meaning)}</p><p class="how">${acEsc(k.how)}</p></div>`).join("")}</div>` : ""}
    <div class="acct-ai-cols"><div><h4>Strengths</h4>${list(r.strengths)}</div><div><h4>To work on</h4>${list(r.focus)}</div></div>
    ${r.next_weeks ? `<h4>Next weeks</h4><p>${acEsc(r.next_weeks)}</p>` : ""}`;
}
function acAthlete() {
  try { const a = JSON.parse(localStorage.getItem("trp.athlete") || "{}") || {}; return { hrMax: a.hrMax || null, hrRest: a.hrRest || null, weight: a.weight || null }; } catch (e) { return {}; }
}

async function acStartAi() {
  acPanel.hidden = true;
  ac.msg = "";
  try {
    const r = await cloudAnalyse(acAthlete(), acAskPayload());
    ac.job = r.job;
    trackEvent("ai-start");
    ac.ledger = await cloudLedger();
  } catch (e) {
    ac.msg = e.message;
    acRender();
    return;
  }
  acRender();
  // Poll the analysis row every 4 s, for up to 6 minutes.
  for (let i = 0; i < 90 && ac.job; i++) {
    await new Promise((ok) => setTimeout(ok, 4000));
    const j = await cloudJob(ac.job).catch(() => null);
    if (!j || j.status === "running") continue;
    ac.job = null;
    if (j.status === "done") {
      ac.jobs = [j, ...ac.jobs];
      acShowPanel(acResultHtml(j.result, j.created_at));
      trackEvent("ai-done");
    } else {
      ac.msg = `The analysis failed; your ${AC_TOKEN.one} was given back.`;
      ac.ledger = await cloudLedger().catch(() => ac.ledger);
    }
  }
  if (ac.job) { ac.job = null; ac.msg = "Still running: open this menu again in a minute to see it."; }
  acRender();
}

async function acAction(what) {
  if (what === "export") {
    const blob = new Blob([JSON.stringify({ app: "trail-race-planner", exported: new Date().toISOString(), runs: await acAll() }, null, 1)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "my-trail-runs.json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    trackEvent("history-export");
  } else if (what === "clear") {
    const user = cloudOn() && cloudUser();
    if (!window.confirm(`Delete all the runs stored ${user ? "on this device and in your account" : "on this device"}? Your stats, records and achievements start again from zero.${user ? " ${AC_TOKEN.many[0].toUpperCase() + AC_TOKEN.many.slice(1)} you already have stay yours." : ""}`)) return;
    if (user) { try { await cloudDeleteRuns(); } catch (e) { ac.msg = "Could not reach your account: runs deleted on this device only."; } }
    acCache = [];
    await acTx("readwrite", (s) => s.clear());
    trackEvent("history-clear");
    acRender();
  } else if (what === "signout") {
    await cloudSignOut();
    Object.assign(ac, { ledger: null, jobs: [], job: null, msg: "" });
    acRender();
  } else if (what === "delete") {
    if (!window.confirm(`Delete your account? Your runs, ${AC_TOKEN.many} and AI analyses are erased from the server for good. The runs on this device stay until you delete them too.`)) return;
    try { await cloudDeleteAccount(); Object.assign(ac, { ledger: null, jobs: [], job: null, msg: "Account deleted." }); trackEvent("account-delete"); } catch (e) { ac.msg = e.message; }
    acRender();
  } else if (what === "ai") {
    acShowPanel(acAskHtml(), "Ask the AI");
    trackEvent("ai-open");
  } else if (what.startsWith("mode:")) {
    acAsk.mode = what.slice(5);
    if (acAsk.mode === "runs" && !acAsk.ids.size) aiSelect(acList, { from: acAsk.from, to: acAsk.to }).forEach((r) => acAsk.ids.add(r.id));
    acShowPanel(acAskHtml(), "Ask the AI");
  } else if (what.startsWith("range:")) {
    const d = Number(what.slice(6));
    acAsk.to = acToday();
    acAsk.from = d ? acAsk.to - d * 86400000 : Math.min(acAsk.to, ...acList.map((r) => r.date));
    acShowPanel(acAskHtml(), "Ask the AI");
  } else if (what.startsWith("focus:")) {
    acAsk.focus = what.slice(6);
    acPanel.querySelectorAll('[data-acct^="focus:"]').forEach((b) => b.classList.toggle("on", b.dataset.acct === what));
  } else if (what === "bests") {
    acShowPanel(acBestsHtml(historySummary(acList)), "All-time bests");
  } else if (what === "go") {
    acStartAi();
  } else if (what === "last" && ac.jobs[0]) {
    acShowPanel(acResultHtml(ac.jobs[0].result, ac.jobs[0].created_at));
  } else if (what === "close") {
    acPanel.hidden = true;
  }
}

async function acSignIn(form) {
  const email = form.querySelector("input").value.trim();
  if (!email) return;
  ac.busy = true;
  acRender();
  try { await cloudSendLink(email); ac.msg = `Link sent to ${email}: open it on this device to sign in.`; trackEvent("signin-link"); } catch (e) { ac.msg = `Could not send the link: ${e.message}`; }
  ac.busy = false;
  acRender();
}

/** Add the icon and the menu to the page. */
export async function initAccount() {
  acEl = document.createElement("div");
  acEl.className = "acct";
  acEl.innerHTML = `
    <button class="acct-btn" type="button" aria-haspopup="true" aria-expanded="false" aria-label="My account">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="8.5" r="3.8"/><path d="M4.5 20c1.2-3.6 4-5.4 7.5-5.4s6.3 1.8 7.5 5.4"/></svg>
    </button>
    <div class="acct-menu" role="dialog" aria-label="My account"></div>
    <div class="acct-panel" hidden></div>`;
  // On the body, not inside the hero: the hero hides whatever overflows it, which would cut the menu.
  document.body.appendChild(acEl);
  const btn = acEl.querySelector(".acct-btn");
  acMenu = acEl.querySelector(".acct-menu");
  acPanel = acEl.querySelector(".acct-panel");
  const set = (open) => {
    acMenu.classList.toggle("open", open);
    btn.setAttribute("aria-expanded", String(open));
    if (open) { acRender(); trackEvent("account-open"); if (cloudOn() && cloudUser() && !ac.job) acSync(); }
  };
  btn.addEventListener("click", (e) => { e.stopPropagation(); set(!acMenu.classList.contains("open")); });
  acEl.addEventListener("click", (e) => { const b = e.target.closest("[data-acct]"); if (b) acAction(b.dataset.acct); });
  acEl.addEventListener("submit", (e) => { const f = e.target.closest("[data-acct-form=signin]"); if (f) { e.preventDefault(); acSignIn(f); } });
  acPanel.addEventListener("click", (e) => { if (e.target === acPanel) acPanel.hidden = true; });
  acPanel.addEventListener("input", (e) => { if (e.target.dataset && e.target.dataset.ask) acAskInput(e.target); });
  document.addEventListener("click", (e) => { if (!acEl.contains(e.target)) set(false); });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!acPanel.hidden) { acPanel.hidden = true; return; }
    if (acMenu.classList.contains("open")) { set(false); btn.focus(); }
  });
  acRender();
  // Back from a sign-in link: keep the session, sync, and show the menu so the user sees it worked.
  if (await cloudFromUrl()) { trackEvent("signin"); set(true); }
}
