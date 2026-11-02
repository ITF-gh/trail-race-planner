// account.js: the account icon at the top right of the hero and its see-through menu.

import { parseGpx, resample } from "../core/track.js";
import { analyseCourse } from "../core/terrain.js";
import { packTrack, trackToGpx, unpackTrack } from "../core/snapshot.js";
import { analyseRun } from "../core/review.js";
import { recordClean, historySummary, aiSelect, AI_QUESTION_MAX } from "../core/history.js";
import { aiRaceChecks, AI_GOALS, AI_RISKS, AI_NOTES_MAX, aiRunChecks } from "../core/aichecks.js";
import { runRecord } from "../core/runrecord.js";
import { DEMO_USER, demoRecords } from "../core/demorecords.js";
import { parseDuration, hm } from "../core/format.js";
import { savedCheck } from "../core/saved.js";
import { trackEvent } from "./analytics.js";
import { profileWho, profileReplace, profileData, profileAthlete, profileHtml, profileAction, profileInput } from "./profile.js";
import { aiOnlineRun, aiLocalHtml, aiLocalRun, aiLocalProbe } from "./ailocal.js";
import { AI_PREP_MODELS, aiPrepMerge } from "../core/aiprep.js";
import { AI_RUN_EFFORT_DEFAULT, AI_RUN_EFFORTS } from "../core/airun.js";
import { aiDocsAll, aiDocsPut, aiDocsGet, aiDocsDelete } from "./aidocs.js";
import { cloudWritable, cloudUser, cloudPutRuns, cloudOn, CLOUD, cloudAiOn, cloudClaim, cloudLedger, cloudProfile, cloudPutProfile, cloudSaved, cloudRuns, cloudSave, cloudAi, cloudJob, cloudDeleteRuns, CL_READONLY, cloudSavedDelete, cloudSignOut, cloudDeleteAccount, cloudSendReset, cloudSetPassword, cloudSignUp, cloudSignInPassword, cloudSendLink, cloudFromUrl } from "./cloud.js";
import { AC_BEST_NAMES, acMedalCap, ac, acBalance, AC_TOKEN, acEsc, AC_SPARK, acDocsHtml, acNum, acToday, acDate, acDay, AC_WAIT, acFilesHtml, acSavedHtml, acDataHtml, acFileView, acDocRow } from "./acparts.js";

// Database name and its one "object store" (IndexedDB's word for a table) of run summaries.
const AC_DB = "trp-history", AC_STORE = "runs";
// "My files": the GPX files you gave the app, kept on this device (packed points, never heart rate).
const AC_FILES = "files", AC_FILES_MAX = 50;
let acCache = null; // the records, once read; also the fallback when IndexedDB is blocked

/** Open (and on first use create) the database. */
function acOpen() {
  return new Promise((ok) => {
    try {
      // Version 2 adds the "files" store; onupgradeneeded creates whichever store is missing.
      const req = indexedDB.open(AC_DB, 2);
      req.onupgradeneeded = () => {
        const db = req.result;
        [AC_STORE, AC_FILES].forEach((n) => { if (!db.objectStoreNames.contains(n)) db.createObjectStore(n, { keyPath: "id" }); });
      };
      req.onsuccess = () => ok(req.result);
      req.onerror = () => ok(null);
    } catch (e) { ok(null); }
  });
}
/** Run one request in a transaction; resolves with its result (or null on failure). */
async function acTx(mode, make, store = AC_STORE) {
  const db = await acOpen();
  if (!db) return null;
  return new Promise((ok) => {
    try {
      const tx = db.transaction(store, mode);
      const req = make(tx.objectStore(store));
      tx.oncomplete = () => { db.close(); ok(req ? req.result : true); };
      // a = b = fn sets both handlers to the same function.
      tx.onerror = tx.onabort = () => { db.close(); ok(null); };
    } catch (e) { db.close(); ok(null); }
  });
}
/** All stored run summaries, read from the database once and then served from acCache. */
async function acAll() {
  if (!acCache) {
    const raw = (await acTx("readonly", (s) => s.getAll())) || [];
    acCache = raw.map(recordClean);
    const old = raw.filter((r) => r && ("hrAvg" in r || "decouplingPct" in r));
    if (old.length) await acTx("readwrite", (s) => { old.forEach((r) => s.put(recordClean(r))); return null; });
  }
  return acCache;
}

/** Store the summary of an analysed run (same run twice = one copy). */
export async function acctSaveRun(run, name) {
  let rec;
  try { rec = runRecord(run, name); } catch (e) { return null; }
  const list = await acAll();
  const isNew = !list.some((r) => r.id === rec.id);
  // The bests before and after: a best whose run is now this one, and was not before, is new.
  const before = historySummary(list).bests, after = historySummary(list.filter((r) => r.id !== rec.id).concat(rec)).bests;
  const bests = list.length ? AC_BEST_NAMES.filter(([k]) => after[k] && after[k].run.id === rec.id && !(before[k] && before[k].run.id === rec.id)).map(([, label]) => label) : [];
  // put() adds the record, or replaces the one with the same id.
  acCache = list.filter((r) => r.id !== rec.id).concat(rec);
  await acTx("readwrite", (s) => s.put(rec));
  // The event label is the number of runs stored (a count, nothing personal).
  if (isNew) trackEvent("history-save", String(acCache.length));
  acRender();
  // Sent to the account only once writes are open (read-only: the run stays on this device).
  if (cloudWritable() && cloudUser()) {
    try { await cloudPutRuns([rec]); await acClaim(); } catch (e) { /* offline: the next sync sends it */ }
    acRender();
  }
  return { isNew, count: acCache.length, bests };
}

/** Open the Account window from anywhere in the page (closing the menu), scrolled to one of its parts when `part` names one: "bests" or "heart" (their data-pf-sec in profile.js). */
export function acctOpenProfile(part = "") {
  if (!acPanel) return;
  acMenu.classList.remove("open");
  acProfile();
  const el = part ? acPanel.querySelector(`[data-pf-sec="${part}"]`) : null;
  if (el) el.scrollIntoView({ block: "start" });
  trackEvent("profile-open", part || "link");
}
/** Same, from a GPX file (used for the runs added in Prep my race). Files that are not runs are skipped. */
export function acctSaveGpx(xml, name) {
  try { acctSaveRun(analyseRun(parseGpx(xml)), name); } catch (e) { /* a route without times, or too short: not a run */ }
}

/** "My files": keep a GPX file you gave the app (any drop box), so it can be used again from the account menu. */
export async function acctKeepFile(xml, label) {
  let parsed;
  try { parsed = parseGpx(xml); } catch (e) { return; }
  const P = parsed.points;
  if (P.length < 2) return;
  const run = P.every((p) => Number.isFinite(p.time));
  let c;
  try { c = analyseCourse(resample(parsed, 10)); } catch (e) { return; }
  const id = `${Math.round(P[0].lat * 1e5)}_${Math.round(P[0].lon * 1e5)}_${P.length}_${run ? Math.round(P[0].time / 1000) : 0}`;
  const all = (await acTx("readonly", (s) => s.getAll(), AC_FILES)) || [];
  const was = all.find((f) => f.id === id);
  const file = { id, name: String(label || parsed.name || "GPX file").slice(0, 120), kind: run ? "run" : "route", km: Math.round(c.totalKm * 10) / 10, gain: Math.round(c.gain), date: run ? P[0].time : null, added: was ? was.added : Date.now(), used: Date.now(), track: packTrack(parsed) };
  // Oldest first (sort by `added`), so the ones past the limit are at the start of the list.
  const over = all.filter((f) => f.id !== id).sort((a, b) => a.added - b.added).slice(0, Math.max(0, all.length + (was ? 0 : 1) - AC_FILES_MAX));
  await acTx("readwrite", (s) => { s.put(file); over.forEach((f) => s.delete(f.id)); return null; }, AC_FILES);
  acFiles = null;
}
// The files, newest used first (read once, then from this cache until a file changes).
let acFiles = null;
async function acFilesAll() {
  if (!acFiles) acFiles = ((await acTx("readonly", (s) => s.getAll(), AC_FILES)) || []).sort((a, b) => b.used - a.used);
  return acFiles;
}
// Uses a kept file in a mode (set by main.js through acctOnUseFile): fn(gpxText, name, use).
let acUse = null;
/** main.js gives the function that opens a kept file in a mode. */
export function acctOnUseFile(fn) { acUse = fn; }
// Opens or closes the account menu (set in initAccount), for callers outside it.
let acOpenMenu = () => {};
// Reopens a saved item in its mode (set by main.js through acctOnReopen).
let acReopen = null;
/** main.js gives the function that reopens a saved item ({ kind, title, data }). */
export function acctOnReopen(fn) { acReopen = fn; }
// acList: the run summaries the menu and the AI window work on; acDemo: true when they are the demo profile's made-up runs.
let acList = [], acDemo = false; // the runs the menu shows (yours, or User1's)
// The achievements as last drawn in the menu (for the caption line), sorted reached first.
let acMedals = [];
/** Show achievement `code` in the caption and mark its icon as the one picked. */
function acMedalShow(code) {
  const cap = acMenu.querySelector(".acct-medal-cap");
  if (!cap) return;
  cap.innerHTML = acMedalCap(acMedals.find((m) => m.code === code) || null);
  acMenu.querySelectorAll("[data-acct^='medal:']").forEach((b) => b.classList.toggle("pick", b.dataset.acct === `medal:${code}`));
}

/** HTML of the tokens section of the menu ("AI edelweiss"). */
function acTokensHtml(S) {
  const signedIn = cloudOn() && cloudUser();
  const n = signedIn ? (ac.ledger ? acBalance() : "…") : S.cairns;
  let note = `Earned with achievements and events. 1 ${AC_TOKEN.one} buys 1 AI-tailored race plan.`;
  if (!acAiOn()) note = `The AI is switched off for now: your ${AC_TOKEN.many} wait for it.`;
  if (ac.msg) note = acEsc(ac.msg);
  else if (signedIn && ac.job) note = "The AI is reading your race and runs. It takes about a minute; you can close this menu.";
  // The sign-in form, only when the account exists but nobody is signed in. data-acct-form names it for the submit listener in initAccount. ac.signup switches the same form to "Create an account"...
  const signin = cloudOn() && !signedIn ? `<form class="acct-signin" data-acct-form="signin">
        <label for="acEmail">${ac.signup ? "Create an account" : "Sign in to collect them"}</label>
        <input id="acEmail" type="email" required autocomplete="email" placeholder="you@example.com" value="${acEsc(ac.email || "")}">
        <div><input id="acPass" type="password" ${ac.signup ? 'required minlength="8" autocomplete="new-password" placeholder="Password, 8 characters or more"' : 'autocomplete="current-password" placeholder="Password (empty: email me a link)"'}><button class="btn ghost" type="submit"${ac.busy ? " disabled" : ""}>${ac.signup ? "Create" : "Sign in"}</button></div>
        <div class="acct-signin-alt">${ac.signup ? `<button class="acct-linkbtn" type="button" data-acct="signin-mode">I have an account</button>` : `<button class="acct-linkbtn" type="button" data-acct="reset">Forgot password?</button>${CLOUD.signup ? `<button class="acct-linkbtn" type="button" data-acct="signup-mode">Create an account</button>` : `<span class="acct-invite">Accounts are by invitation for now.</span>`}`}</div>
      </form>` : "";
  // The Ask the AI button opens the window of the mode on screen (data-mode on <html>, read at each redraw, and the menu is redrawn each time it opens): the race plan in Prep my race, the coach in Prep my run...
  const mode = document.documentElement.dataset.mode;
  const ask = mode === "run" || !acAiOn() ? "" : `<button class="btn primary acct-ai-ask" type="button" data-acct="${mode === "prep" ? "ai-run-ask" : "ai"}"${ac.job ? " disabled" : ""}>${ac.job ? "Analysing…" : `${AC_SPARK}${mode === "prep" ? "Ask the AI coach" : "Ask the AI"}`}</button>`;
  // data-acct="..." on a button names the action a click runs (see acAction).
  return `<section><h4>AI ${AC_TOKEN.many}</h4>
      <div class="acct-cairns"><b>${AC_SPARK}${n}</b>${ask}</div>
      <p class="acct-note">${note}</p>${signin}
    </section>`;
}

/** HTML of the whole menu from `S`, the summary of the stored runs (historySummary in core/history.js): count, bests, last runs, 12-month totals, achievements, tokens. */
function acMenuHtml(S, demo = false) {
  const user = cloudOn() && cloudUser();
  // The line under the name: demo profile, signed-in email, or runs on this device only.
  const where = demo ? `Demo profile · ${S.count} sample runs` : user ? `${acEsc(user.email)} · ${S.count} run${S.count === 1 ? "" : "s"}${cloudWritable() ? " synced" : " · profile synced"}` : `${S.count || "No"} run${S.count === 1 ? "" : "s"} on this device`;
  // The name and flag typed in the Account window, else User1 (demo) or "My account".
  const me = profileWho();
  const who = `<section class="acct-who"><div><b>${me.flag ? `${me.flag} ` : ""}${acEsc(me.name || (demo ? DEMO_USER : "My account"))}</b><small>${where}</small></div><button class="btn ghost acct-prof" type="button" data-acct="profile">Account</button></section>`;
  // The links at the bottom: bests (when there are runs), export and delete (own runs only), sign out and delete account (signed in only).
  const links = `<section class="acct-links">${S.count ? `<button type="button" data-acct="bests">Bests</button>` : ""}${S.count && !demo ? `<button type="button" data-acct="export">Export</button><button type="button" data-acct="clear">Delete runs</button>` : ""}${user ? `<button type="button" data-acct="signout">Sign out</button>` : ""}</section>`;
  if (!S.count) {
    return `${who}
    <section><p class="acct-empty">Open one of your runs in <b>Rewind my run</b>, or add it to <b>Your runs</b> in Prep my race: its numbers are kept here${user ? "" : ", on this device only"}, and your stats, records and achievements build up run after run.</p></section>
    ${acDocsHtml(ac.docs)}${acTokensHtml(S)}${links}`;
  }
  // Big climbing totals in thousands: 12345 m -> "12.3k".
  const gainK = S.year.gain >= 10000 ? `${(S.year.gain / 1000).toFixed(1)}k` : acNum(S.year.gain);
  // Achievements reached first, then the closest to being reached.
  const medals = [...S.achievements].sort((a, b) => b.done - a.done || b.progress - a.progress);
  acMedals = medals;
  return `${who}
    <section><h4>Last 12 months</h4>
      <div class="acct-kpis"><div><b>${acNum(S.year.km)}</b><small>km</small></div><div><b>${gainK}</b><small>m D+</small></div><div><b>${acNum(S.year.movingSec / 3600)} h</b><small>moving</small></div></div>
    </section>
    <section><h4>Achievements · ${S.unlocked} / ${S.achievements.length}</h4>
      <div class="acct-medals mini">${medals.map((a) => `<button type="button" class="${a.done ? "on" : "lock"}" data-acct="medal:${a.code}" aria-label="${acEsc(a.label)}${a.done ? ", reached" : `, ${Math.floor(a.progress * 100)}%`}"><span aria-hidden="true">${a.icon}</span>${a.done ? "" : `<i style="width:${Math.round(a.progress * 100)}%"></i>`}</button>`).join("")}</div>
      <p class="acct-medal-cap" aria-live="polite">${acMedalCap(null)}</p>
    </section>
    ${acDocsHtml(ac.docs)}
    ${acTokensHtml(S)}
    ${links}`;
}

// The AI window, Prep my race version: the runner sees the target race (from the race GPX), picks their old runs (the GPX files of "Your runs" plus a choice of the runs stored in the account) and gives their own input...
const acAsk = { mode: "dates", from: null, to: null, ids: new Set(), goal: "target", risk: "balanced", target: null, notes: "", question: "", checks: null };
// The Prep my run window (the AI coach) asks less: free information and a question, both optional.
const acRunAsk = { effort: AI_RUN_EFFORT_DEFAULT, notes: "", question: "", checks: null };
// What the page knows about the run to come, given by main.js (getRun): { name, km, gain, climbs, spots, plan, key } or null before a GPX is loaded.
let acGetRun = () => null;
// The stored runs the coach reads: the last 6 weeks (its load and trend), at most 60.
const acRunRuns = () => aiSelect(acList, { to: acToday(), from: acToday() - 42 * 86400000 }).slice(0, 60);
// What the page knows about the race being prepared, given by main.js to initAccount (getRace): { race: { name, km, gain, legs, aid } or null, gpxRuns, targetText, centralSec }.
let acGetRace = () => ({ race: null, gpxRuns: 0, targetText: "", centralSec: null, plan: null });
// The local test mode (ailocal.js): { key, model, fake } when the page comes from npm run ai-browser on this computer, else null.
let acLocal = null;
// Can the AI be asked here?
const acAiOn = () => cloudAiOn() || Boolean(acLocal);
const acAiShow = () => document.documentElement.classList.toggle("ai-off", !acAiOn());
/** What is sent to the server as the `ask`: the stored runs (ticked ids or the date range), the goal, target time, risk, free information and question, and `forced`... */
function acAskPayload(forced = []) {
  const runs = acAsk.mode === "runs" ? { ids: [...acAsk.ids] } : { from: acAsk.from, to: acAsk.to };
  return { ...runs, mode: "prep_race", focus: "race", goal: acAsk.goal, risk: acAsk.risk, targetSec: parseDuration(acAsk.target), notes: acAsk.notes, question: acAsk.question, forced };
}
/** The stored runs the window currently selects (aiSelect: the same rule as on the server). */
const acAskRuns = () => aiSelect(acList, acAskPayload());
/** The code checks of a click on "Spend" (aiRaceChecks in core/aichecks.js), from what the window and the page hold now. */
function acAskChecks() {
  const R = acGetRace();
  const signedIn = Boolean(cloudOn() && cloudUser());
  return aiRaceChecks({
    race: R.race, gpxRuns: R.gpxRuns, storedRuns: acAskRuns().length,
    targetText: (acAsk.target || "").trim(), targetSec: parseDuration((acAsk.target || "").trim()), centralSec: R.centralSec,
    notes: acAsk.notes, question: acAsk.question,
    // Local test: no account is needed, so the account checks pass.
    cloud: acLocal ? { open: true, signedIn: true, balance: 1 } : { open: cloudAiOn(), signedIn, balance: acBalance(), demo: acDemo },
  });
}
/** The stored runs selected, in one line of HTML: "12 runs · 240 km, 3 Jul to 14 Oct". */
function acAskSummary() {
  const runs = acAskRuns();
  const km = runs.reduce((t, r) => t + r.km, 0);
  // Math.min(...list): the spread operator passes every date as a separate argument.
  const span = runs.length ? `, ${acDate(Math.min(...runs.map((r) => r.date)))} to ${acDate(Math.max(...runs.map((r) => r.date)))}` : "";
  return `<b>${runs.length} stored run${runs.length === 1 ? "" : "s"} · ${acNum(km)} km</b>${span}`;
}
/** HTML of the Ask the AI window for Prep my race, five steps: 1. */
function acAskHtml() {
  const R = acGetRace();
  // First opening: the last 90 days (86400000 ms = one day), and the plan's own target time.
  if (acAsk.from === null && acAsk.to === null) { acAsk.to = acToday(); acAsk.from = acAsk.to - 90 * 86400000; }
  if (acAsk.target === null) acAsk.target = R.targetText || "";
  // Runs newest first, for the pick list.
  const sorted = [...acList].sort((a, b) => b.date - a.date);
  // One toggle button; `attr` is its data-acct attribute, the class "on" marks the chosen one.
  const chip = (attr, label, on) => `<button type="button" class="acct-chip${on ? " on" : ""}" ${attr}>${label}</button>`;
  const r = R.race;
  const race = r
    ? `<div class="acct-race" data-field="race"><b>${acEsc(r.name)}</b><span>${r.km.toFixed(1)} km · ${acNum(r.gain)} m D+ · ${r.legs} section${r.legs === 1 ? "" : "s"} · ${r.aid} aid station${r.aid === 1 ? "" : "s"}</span></div>`
    : `<div class="acct-race empty" data-field="race"><span>No race GPX loaded yet.</span><button class="acct-linkbtn" type="button" data-acct="goto:dropRace">Load it in 02 The race</button></div>`;
  const gpx = R.gpxRuns
    ? `<p class="acct-sub" data-field="runs"><b>${R.gpxRuns} GPX file${R.gpxRuns === 1 ? "" : "s"}</b> in Your runs: your pace on every gradient.</p>`
    : `<p class="acct-sub" data-field="runs">No GPX file in Your runs. <button class="acct-linkbtn" type="button" data-acct="goto:dropEffort">Add runs in 01 Your runs</button></p>`;
  const C = acAsk.checks;
  const stop = C && C.some((k) => k.level === "stop");
  const box = C && C.length ? `<div class="acct-checks" role="alert">
      <h4>Before sending</h4>
      <ul>${C.map((k) => `<li class="${k.level}"><span>${k.level === "stop" ? "Blocked" : "Warning"}</span>${acEsc(k.text)}</li>`).join("")}</ul>
      <p class="acct-note">${stop ? "This cannot be sent yet. Nothing is spent." : `Send anyway uses 1 ${AC_TOKEN.one}, even if the AI returns nothing.`} Everything you filled in stays.</p>
      <div class="acct-actions"><button class="btn primary" type="button" data-acct="fix">Fix and retry</button>${stop ? "" : `<button class="btn ghost" type="button" data-acct="force">${AC_SPARK}Send anyway</button>`}<button class="btn ghost" type="button" data-acct="close">Cancel</button></div>
    </div>` : acLocal ? `${acLocal.direct ? `<h4>Your OpenAI key</h4>
    <input type="password" class="acct-key" data-ask="key" autocomplete="off" spellcheck="false" placeholder="sk-..." value="${acEsc(acLocal.apiKey)}">
    <label class="acct-sub">Model <select class="acct-model" data-ask="model">${AI_PREP_MODELS.map((m) => `<option${m === acLocal.model ? " selected" : ""}>${m}</option>`).join("")}</select></label>
    <p class="acct-note">Test copy on this computer: no account, no ${AC_TOKEN.one}. The key stays in this tab only (never saved) and goes straight to OpenAI. Send to the AI costs a few cents; Fake answer is free.</p>` : `<p class="acct-note">Local test on this computer: no account, no ${AC_TOKEN.one}. ${acLocal.key ? "Send to the AI calls OpenAI with your key (it costs a few cents)." : "No key in .env.local: only the fake answer works."}</p>`}
    <div class="acct-actions">${acLocal.key || acLocal.direct ? `<button class="btn primary" type="button" data-acct="go">${AC_SPARK}Send to the AI</button>` : ""}<button class="btn ${acLocal.key || acLocal.direct ? "ghost" : "primary"}" type="button" data-acct="fake">Fake answer</button><button class="btn ghost" type="button" data-acct="close">Cancel</button></div>`
    : `<div class="acct-actions"><button class="btn primary" type="button" data-acct="go">${AC_SPARK}Spend 1 ${AC_TOKEN.one}</button><button class="btn ghost" type="button" data-acct="close">Cancel</button></div>`;
  return `<p class="acct-kicker">${AC_SPARK} Ask the AI · Prep my race · ${acLocal ? "local test" : `1 ${AC_TOKEN.one}`}</p>
    <h3>Tailor my race plan</h3>
    <h4>1 · Target race</h4>
    ${race}
    <h4>2 · Your old runs</h4>
    ${gpx}
    <p class="acct-sub">Runs stored in your account: your trend over the weeks.</p>
    <div class="acct-chips">${chip('data-acct="mode:dates"', "Date range", acAsk.mode === "dates")}${chip('data-acct="mode:runs"', "Pick runs", acAsk.mode === "runs")}</div>
    ${acAsk.mode === "dates" ? `<div class="acct-range">
        <label>From <input type="date" data-ask="from" value="${acDay(acAsk.from)}"></label>
        <label>To <input type="date" data-ask="to" value="${acDay(acAsk.to)}"></label>
        <div class="acct-chips small">${[[28, "4 weeks"], [91, "3 months"], [365, "12 months"], [0, "Everything"]].map(([d, l]) => chip(`data-acct="range:${d}"`, l, false)).join("")}</div>
      </div>` : `<div class="acct-pick">${sorted.map((x) => `<label><input type="checkbox" data-ask="run" value="${acEsc(x.id)}"${acAsk.ids.has(x.id) ? " checked" : ""}><span>${acDate(x.date)} · ${acEsc(x.name)}</span><b>${x.km.toFixed(1)} km · ${acNum(x.gain)} m</b></label>`).join("")}</div>`}
    <p class="acct-ask-count">${acAskSummary()}</p>
    <h4>3 · Your goal</h4>
    <div class="acct-chips">${AI_GOALS.map((g) => chip(`data-acct="goal:${g.code}"`, g.label, acAsk.goal === g.code)).join("")}</div>
    <div class="acct-range" data-field="target">
      <label>Target time <input type="text" class="acct-time" data-ask="target" inputmode="numeric" placeholder="h:mm" value="${acEsc(acAsk.target)}"></label>
      <span class="acct-note acct-inline">${R.centralSec ? `Calculated: ${hm(R.centralSec)}` : "Calculated time: once both files are loaded"}</span>
    </div>
    <p class="acct-sub">Risk the plan may take</p>
    <div class="acct-chips">${AI_RISKS.map((x) => chip(`data-acct="risk:${x.code}"`, x.label, acAsk.risk === x.code)).join("")}</div>
    <h4>4 · Free information <small>(optional)</small></h4>
    <textarea class="acct-q" data-ask="notes" data-field="notes" maxlength="${AI_NOTES_MAX}" rows="3" placeholder="e.g. Knee pain on long descents since August. I race with poles. Hot weather expected.">${acEsc(acAsk.notes)}</textarea>
    <h4>5 · Your question <small>(optional)</small></h4>
    <textarea class="acct-q" data-ask="question" data-field="question" maxlength="${AI_QUESTION_MAX}" rows="2" placeholder="e.g. Is 7:30 realistic if I hike every climb steeper than 12%?">${acEsc(acAsk.question)}</textarea>
    <p class="acct-note">Sent: the race sections (distance, climbing, gradients) and aid stations, your pace on each gradient learned from Your runs, the numbers of the stored runs selected, your goal, target time, risk, free information and question, and the heart rates and weight from your profile. <b>Not sent:</b> the GPX files, GPS tracks, run names and your email. The AI only analyses this data: any other request returns nothing.</p>
    ${box}`;
}
/** The code checks of a click in the Prep my run window (aiRunChecks), like acAskChecks. */
function acRunChecks() {
  const R = acGetRun();
  const signedIn = Boolean(cloudOn() && cloudUser());
  return aiRunChecks({
    route: R ? { km: R.km, gain: R.gain } : null, notes: acRunAsk.notes, question: acRunAsk.question,
    cloud: acLocal ? { open: true, signedIn: true, balance: 1 } : { open: cloudAiOn(), signedIn, balance: acBalance(), demo: acDemo },
  });
}
/** HTML of the Ask the AI coach window (Prep my run). */
function acRunHtml() {
  const R = acGetRun();
  const runs = acRunRuns();
  const C = acRunAsk.checks;
  const stop = C && C.some((k) => k.level === "stop");
  const route = R
    ? `<div class="acct-race" data-field="route"><b>${acEsc(R.name)}</b><span>${R.km.toFixed(1)} km · ${acNum(R.gain)} m D+ · ${R.climbs} climb${R.climbs === 1 ? "" : "s"} · <b>${R.spots} spot${R.spots === 1 ? "" : "s"} for an exercise</b></span></div>`
    : `<div class="acct-race empty" data-field="route"><span>No run GPX loaded yet.</span><button class="acct-linkbtn" type="button" data-acct="goto:dropPrep">Load it in Prep my run</button></div>`;
  const box = C && C.length ? `<div class="acct-checks" role="alert">
      <h4>Before sending</h4>
      <ul>${C.map((k) => `<li class="${k.level}"><span>${k.level === "stop" ? "Blocked" : "Warning"}</span>${acEsc(k.text)}</li>`).join("")}</ul>
      <p class="acct-note">${stop ? "This cannot be sent yet. Nothing is spent." : `Send anyway uses 1 ${AC_TOKEN.one}, even if the AI returns nothing.`} Everything you filled in stays.</p>
      <div class="acct-actions"><button class="btn primary" type="button" data-acct="run-fix">Fix and retry</button>${stop ? "" : `<button class="btn ghost" type="button" data-acct="run-force">${AC_SPARK}Send anyway</button>`}<button class="btn ghost" type="button" data-acct="close">Cancel</button></div>
    </div>` : acLocal ? `${acLocal.direct ? `<h4>Your OpenAI key</h4>
    <input type="password" class="acct-key" data-ask="key" autocomplete="off" spellcheck="false" placeholder="sk-..." value="${acEsc(acLocal.apiKey)}">
    <label class="acct-sub">Model <select class="acct-model" data-ask="model">${AI_PREP_MODELS.map((m) => `<option${m === acLocal.model ? " selected" : ""}>${m}</option>`).join("")}</select></label>
    <p class="acct-note">Test copy on this computer: no account, no ${AC_TOKEN.one}. The key stays in this tab only (never saved) and goes straight to OpenAI. Send to the AI costs a few cents; Fake answer is free.</p>` : `<p class="acct-note">Local test on this computer: no account, no ${AC_TOKEN.one}. ${acLocal.key ? "Send to the AI calls OpenAI with your key (it costs a few cents)." : "No key in .env.local: only the fake answer works."}</p>`}
    <div class="acct-actions">${acLocal.key || acLocal.direct ? `<button class="btn primary" type="button" data-acct="run-go">${AC_SPARK}Send to the AI</button>` : ""}<button class="btn ${acLocal.key || acLocal.direct ? "ghost" : "primary"}" type="button" data-acct="run-fake">Fake answer</button><button class="btn ghost" type="button" data-acct="close">Cancel</button></div>`
    : `<div class="acct-actions"><button class="btn primary" type="button" data-acct="run-go">${AC_SPARK}Spend 1 ${AC_TOKEN.one}</button><button class="btn ghost" type="button" data-acct="close">Cancel</button></div>`;
  return `<p class="acct-kicker">${AC_SPARK} Ask the AI coach · Prep my run · ${acLocal ? "local test" : `1 ${AC_TOKEN.one}`}</p>
    <h3>Prepare my run</h3>
    ${route}
    <p class="acct-sub">The coach prepares the whole run at the effort you pick: a pace and an effort for every section, and the exercises that suit it on the spots the app found (long flats, strings of climbs, steady climbs, runnable descents...). The app then checks everything: warm-up first, no more than 4 exercises, hard work at most a quarter of the run.</p>
    <h4>Effort</h4>
    <div class="acct-chips">${AI_RUN_EFFORTS.map((x) => `<button type="button" class="acct-chip${acRunAsk.effort === x.code ? " on" : ""}" data-acct="reff:${x.code}" title="${acEsc(x.text)}">${x.code} · ${x.label}</button>`).join("")}</div>
    <p class="acct-note" data-reff-text>${acEsc(AI_RUN_EFFORTS[acRunAsk.effort - 1].text)}.</p>
    <p class="acct-sub"><b>${runs.length} stored run${runs.length === 1 ? "" : "s"}</b> of the last 6 weeks: your load and form.</p>
    <h4>Free information <small>(optional)</small></h4>
    <textarea class="acct-q" data-ask="rnotes" data-field="notes" maxlength="${AI_NOTES_MAX}" rows="3" placeholder="e.g. Calf a bit tight since Sunday. Race in 5 weeks with long climbs. I have 2 hours.">${acEsc(acRunAsk.notes)}</textarea>
    <h4>Your question <small>(optional)</small></h4>
    <textarea class="acct-q" data-ask="rquestion" data-field="question" maxlength="${AI_QUESTION_MAX}" rows="2" placeholder="e.g. Can I work my climbing without wrecking my legs for Saturday?">${acEsc(acRunAsk.question)}</textarea>
    <p class="acct-note">Sent: the effort you picked, the route in sections (distance, climbing, gradients), the spots the app found, your pace when Your runs has GPX files, the numbers of your stored runs of the last 6 weeks, your two texts, and the heart rates and weight from your profile. <b>Not sent:</b> the GPX file, GPS track, run names and your email.</p>
    ${box}`;
}

/** Refresh the count of stored runs without redrawing the window (keeps the cursor where it is). */
function acAskRefresh() {
  // querySelector finds the first element matching a CSS selector; null when there is none.
  const c = acPanel.querySelector(".acct-ask-count");
  if (c) c.innerHTML = acAskSummary();
}
/** A field of the Ask the AI window changed (`el` is the input). */
function acAskInput(el) {
  const k = el.dataset.ask;
  if (k === "question" || k === "notes" || k === "target") acAsk[k] = el.value;
  else if (k === "rnotes") acRunAsk.notes = el.value;
  else if (k === "rquestion") acRunAsk.question = el.value;
  // The OpenAI key of the file test copy: kept in memory only, outside acAsk.
  else if (k === "key" && acLocal) acLocal.apiKey = el.value.trim();
  else if (k === "model" && acLocal) acLocal.model = el.value;
  // Date.parse("2026-10-16") gives midnight UTC of that day in ms; NaN (an empty field) is ignored.
  else if (k === "from" || k === "to") { const v = Date.parse(el.value); if (Number.isFinite(v)) acAsk[k] = v; }
  else if (k === "run") { if (el.checked) acAsk.ids.add(el.value); else acAsk.ids.delete(el.value); }
  acAskRefresh();
}
/** Redraw the Ask the AI window, keeping its scroll position. */
function acAskShow(field = "") {
  const box = acPanel.querySelector(".acct-panel-in");
  const top = box && !acPanel.hidden ? box.scrollTop : 0;
  acShowPanel(acAskHtml(), "Ask the AI");
  const nb = acPanel.querySelector(".acct-panel-in");
  if (nb) nb.scrollTop = top;
  const el = field ? acPanel.querySelector(`[data-field="${field}"]`) : null;
  if (!el) return;
  el.scrollIntoView({ block: "center" });
  // The element itself when it is a text field, else the first field or button inside it.
  const f = el.matches("input, textarea") ? el : el.querySelector("input, textarea, button");
  if (f) f.focus({ preventScroll: true });
}

// The page elements, set by initAccount: the wrapper, the drop-down menu, the pop-up panel.
let acEl = null, acMenu = null, acPanel = null;

/** Redraw the menu from the stored runs (or from the demo runs when there are none). */
/** Signed in (owner's rule, 2026-10-23): the account name shows next to the account button (the name typed in the Account window, else the start of the email). */
function acSignedBadge() {
  const user = cloudOn() && cloudUser();
  acEl.classList.toggle("signed", Boolean(user));
  const me = profileWho();
  acEl.querySelector(".acct-name").textContent = user ? `${me.flag ? `${me.flag} ` : ""}${me.name || String(user.email || "").split("@")[0]}` : "";
}
async function acRender() {
  if (!acMenu) return;
  acSignedBadge();
  const mine = await acAll();
  // No run of your own yet (and not signed in): show the demo profile User1 and its made-up runs, so the menu is never empty.
  acDemo = !mine.length && !(cloudOn() && cloudUser());
  acList = acDemo ? demoRecords() : mine;
  ac.docs = await aiDocsAll();
  acMenu.innerHTML = acMenuHtml(historySummary(acList), acDemo);
}

/** Ask the server for the tokens of the achievements reached, then read the ledger. */
async function acClaim() {
  // Read-only account: no claim (it would write the ledger), the ledger is only read.
  if (cloudWritable()) await cloudClaim().catch(() => null);
  ac.ledger = await cloudLedger();
}

/** Signed in: send the runs the account does not have, fetch the ones this device lacks, then tokens. */
async function acSync() {
  if (!cloudOn() || !cloudUser()) return;
  try {
    // 0. The profile: the account's copy wins; an account without one takes this browser's.
    const online = await cloudProfile();
    if (online) profileReplace(online); else await cloudPutProfile(profileData());
    // The account's profile may carry "Tune my engine": plan again with it.
    document.dispatchEvent(new CustomEvent("trp-refs"));
    ac.saved = await cloudSaved();
    // 1. Upload: local runs whose id the account does not have.
    const [local, remote] = [await acAll(), await cloudRuns()];
    const have = new Set(remote.map((r) => r.id));
    // Read-only account: nothing is sent up, the account's runs are only read.
    if (cloudWritable()) await cloudPutRuns(local.filter((r) => !have.has(r.id)));
    // 2. Download: account runs this device does not have, stored in the cache and the database.
    const mine = new Set(local.map((r) => r.id));
    const fresh = remote.filter((r) => r && r.id && !mine.has(r.id));
    if (fresh.length) {
      acCache = local.concat(fresh);
      await acTx("readwrite", (s) => { fresh.forEach((r) => s.put(r)); return null; });
    }
    // 3. Tokens.
    await acClaim();
    ac.msg = "";
  } catch (e) {
    ac.msg = e.message === "Session expired, please sign in again" ? e.message : "Could not reach your account. Your runs are safe on this device.";
  }
  acRender();
}

/** "Save to my account" (main.js): keep one item ({ kind, title, data }, core/saved.js) in the online account. */
export async function acctSaveItem(item) {
  if (!cloudOn()) return { ok: false, msg: "The online account is not open yet." };
  if (!cloudUser()) {
    ac.msg = "Sign in to save plans and runs to your account.";
    // After this click has finished bubbling, or the "click outside closes the menu" listener would close it again at once.
    setTimeout(() => acOpenMenu(true), 0);
    return { ok: false, msg: "Sign in first (account icon, top right)." };
  }
  const bad = savedCheck(item);
  if (bad) return { ok: false, msg: bad };
  try {
    await cloudSave(item);
    ac.saved = await cloudSaved().catch(() => ac.saved);
    trackEvent("saved-item", item.kind);
    return { ok: true, msg: "Saved: find it in your Account window." };
  } catch (e) {
    return { ok: false, msg: `Could not save: ${e.message}` };
  }
}

/** Saving the profile online. */
let acPfTimer = 0;
async function acProfilePush() {
  acPfTimer = 0;
  if (!cloudOn() || !cloudUser()) return;
  try { await cloudPutProfile(profileData()); } catch (e) { ac.msg = "Profile saved on this device only: could not reach your account."; acRender(); }
}
async function acProfileFlush() {
  if (!acPfTimer) return;
  clearTimeout(acPfTimer);
  await acProfilePush();
}
document.addEventListener("trp-profile-save", () => {
  if (!cloudOn() || !cloudUser()) return;
  clearTimeout(acPfTimer);
  acPfTimer = setTimeout(acProfilePush, 800);
});

/** The see-through pop-up panel: the Ask the AI window, the AI answer or the Account window. */
function acShowPanel(html, label = "AI analysis", cls = "") {
  acPanel.innerHTML = `<div class="acct-panel-in${cls ? ` ${cls}` : ""}" role="dialog" aria-modal="true" aria-label="${label}"><button class="acct-x" type="button" data-acct="close" aria-label="Close">×</button>${html}</div>`;
  acPanel.hidden = false;
  const x = acPanel.querySelector(".acct-x");
  if (x) x.focus();
}
/** "Spend 1 edelweiss" in the Prep my race window: the local test when the page runs on this computer (acStartLocal), else the online AI (acStartOnline). */
function acStartAi(forced = []) {
  return acLocal ? acStartLocal(forced) : acStartOnline("prep_race", forced);
}

/** Send one request to the account's AI and wait for the answer: cloudAi starts it (the server spends the edelweiss), then the job row is read every 4 s until it is done or failed, for up to 6 minutes (90 x 4 s). */
async function acAskServer(mode, input) {
  const { job } = await cloudAi(mode, input);
  trackEvent("ai-start");
  ac.ledger = await cloudLedger().catch(() => ac.ledger);
  acRender();
  for (let i = 0; i < 90; i++) {
    // A pause: a Promise that resolves after 4000 ms, awaited.
    await new Promise((ok) => setTimeout(ok, 4000));
    const j = await cloudJob(job).catch(() => null);
    // No answer (network) or still running: try again next round.
    if (j && j.status !== "running") return j;
  }
  return { status: "running" };
}

/** The online AI (CLOUD.ai on, signed in): Prep my race (mode "prep_race") or the AI coach of Prep my run ("prep_run"), with the same input as the local test. */
async function acStartOnline(mode, forced = []) {
  const run = mode === "prep_run";
  const a = profileAthlete();
  const athlete = { maxHr: a.hrMax, restHr: a.hrRest, weightKg: a.weight };
  const R = run ? acGetRun() : acGetRace();
  const x = run
    ? { mode, plan: R && R.plan, raceName: R ? R.name : "My run", user: { effort: acRunAsk.effort, notes: acRunAsk.notes, question: acRunAsk.question, forced }, athlete, history: acRunRuns() }
    : { mode, plan: R.plan, raceName: R.race ? R.race.name : "Race", user: { targetSec: parseDuration((acAsk.target || "").trim()), goal: acAsk.goal, risk: acAsk.risk, notes: acAsk.notes, question: acAsk.question, forced }, athlete, history: acAskRuns() };
  acShowPanel(`<p class="acct-kicker">${AC_SPARK}${run ? "AI coach" : "AI"}</p><h3>Asking the AI…</h3>${AC_WAIT}<p>This can take a minute or two. Keep this tab open.</p>`, "AI");
  ac.job = true;
  ac.msg = "";
  acRender();
  const r = await aiOnlineRun(x, acAskServer);
  ac.job = null;
  ac.ledger = await cloudLedger().catch(() => ac.ledger);
  if (!r.error) {
    await acKeepDoc(mode, R && R.key, x.raceName, r);
    trackEvent("ai-done");
  }
  acShowPanel(aiLocalHtml(r), "AI answer", "acct-local");
  acRender();
}

/** Keep an AI answer as an AI doc on this device (aidocs.js), and play it at once when usable (main.js and preprun.js listen to trp-ai-use). */
async function acKeepDoc(mode, key, name, r) {
  if (r.error || !(r.read.output || r.read.tokens.total)) return;
  const m = r.result;
  // The referee's summary, without the rebuilt plan (rebuilt from the output when played).
  const result = mode === "prep_run"
    ? { status: m.status, reason: m.reason, finishSec: m.finishSec, fixes: m.fixes, exercises: m.exercises, workSec: m.workSec, texts: m.texts, dataset: m.dataset || null }
    : { status: m.status, reason: m.reason, finishSec: m.finishSec, finishes: m.finishes, aiFinishSec: m.aiFinishSec, fixes: m.fixes, legs: m.legs, aid: m.aid, texts: m.texts, dataset: m.dataset || null };
  const doc = { id: `ai-${Date.now()}`, at: new Date().toISOString(), mode, race: key, raceName: name, input: r.input, output: r.read.output, tokens: r.read.tokens, result };
  await aiDocsPut(doc);
  if (m.status === "ok") document.dispatchEvent(new CustomEvent("trp-ai-use", { detail: doc }));
}

/** The local test (ailocal.js): the same ask, sent to the local server instead of the account. */
async function acStartLocal(forced) {
  const R = acGetRace();
  const fake = acLocal.fake;
  acShowPanel(`<p class="acct-kicker">Local AI test</p><h3>${fake ? "Making the fake answer…" : `Asking ${acEsc(acLocal.model)}…`}</h3>${AC_WAIT}<p>${fake ? "" : "This can take a minute or two. Keep this tab open."}</p>`, "Local AI test");
  const a = profileAthlete();
  const r = await aiLocalRun({
    plan: R.plan, raceName: R.race ? R.race.name : "Race", fake, direct: acLocal.direct, apiKey: acLocal.apiKey, model: acLocal.model,
    user: { targetSec: parseDuration((acAsk.target || "").trim()), goal: acAsk.goal, risk: acAsk.risk, notes: acAsk.notes, question: acAsk.question, forced },
    athlete: { maxHr: a.hrMax, restHr: a.hrRest, weightKg: a.weight },
    history: acAskRuns(),
  });
  // Every answer that came back is kept as an AI doc; a usable one also goes to Your race.
  await acKeepDoc("prep_race", R.key, R.race ? R.race.name : "Race", r);
  acShowPanel(aiLocalHtml(r), "Local AI test", "acct-local");
}

/** The Prep my run test (the AI coach): the same chain as acStartLocal with the run's plan and the two texts. */
async function acStartRun(forced = []) {
  if (!acLocal) return acStartOnline("prep_run", forced);
  const R = acGetRun();
  const fake = acLocal.fake;
  acShowPanel(`<p class="acct-kicker">Local AI test · Prep my run</p><h3>${fake ? "Making the fake answer…" : `Asking ${acEsc(acLocal.model)}…`}</h3>${AC_WAIT}<p>${fake ? "" : "This can take a minute. Keep this tab open."}</p>`, "Local AI test");
  const a = profileAthlete();
  const r = await aiLocalRun({
    mode: "prep_run", plan: R && R.plan, raceName: R ? R.name : "My run", fake, direct: acLocal.direct, apiKey: acLocal.apiKey, model: acLocal.model,
    user: { effort: acRunAsk.effort, notes: acRunAsk.notes, question: acRunAsk.question, forced },
    athlete: { maxHr: a.hrMax, restHr: a.hrRest, weightKg: a.weight },
    history: acRunRuns(),
  });
  await acKeepDoc("prep_run", R && R.key, R ? R.name : "My run", r);
  acShowPanel(aiLocalHtml(r), "Local AI test", "acct-local");
}
/** Open one AI doc in the panel: the same view as a fresh answer, with its own buttons. */
async function acDocShow(id) {
  const d = await aiDocsGet(id);
  if (!d) return;
  const download = URL.createObjectURL(new Blob([JSON.stringify(d, null, 2)], { type: "application/json" }));
  // A Prep my race doc for the race on screen, made from the same plan: checked again by today's referee, so the doc shows exactly what Your race plays (an older doc kept an older summary).
  let result = d.result;
  const R = d.mode === "prep_run" ? null : acGetRace();
  const calc = d.input && d.input.calc && d.input.calc.finishSec;
  if (R && R.plan && R.key === d.race && d.output && calc && Math.abs(calc.central - R.plan.scenarios.central.finishSec) < 60) {
    try { result = aiPrepMerge(R.plan, d.input, d.output); } catch (e) { /* keep the stored summary */ }
  }
  acShowPanel(aiLocalHtml({ docId: d.id, when: acDate(Date.parse(d.at)), input: d.input, read: { tokens: d.tokens, output: d.output }, result, stamp: d.at.slice(0, 19).replace(/[:T]/g, "-"), download }), "AI doc", "acct-local");
}

/** The small edelweiss sticker that opens an Ask the AI window, set beside the Pimp my GPX sticker: mode "race" (Prep my race) or "run" (Prep my run, the AI coach). */
export function acctAiBadge(mode) {
  return `<button class="ai-badge" type="button" data-ai-ask="${mode}" aria-label="Ask the AI ${mode === "run" ? "coach" : "for a race plan"}">${AC_SPARK}<span><b>Ask the AI</b><small>${mode === "run" ? "coach · my run" : "race plan"}</small></span></button>`;
}
/** Open the Ask the AI window (for the "Ask the AI" link of Your race). */
export function acctOpenAsk() { acAction("ai"); }
/** Open the Ask the AI coach window (the edelweiss button of Prep my run). */
export function acctOpenRunAsk() { acAction("ai-run-ask"); }

/** Open (or redraw) the Account window in the pop-up panel. */
function acProfile(keep = false) {
  if (!keep) ac.dataMsg = ""; // a fresh opening shows no old message
  const box = acPanel.querySelector(".acct-panel-in");
  const top = keep && box ? box.scrollTop : 0;
  // The field or button that has the focus (named by its data-pf or data-acct), to give it back.
  const f = keep && document.activeElement && acPanel.contains(document.activeElement) ? document.activeElement : null;
  const sel = f ? (f.dataset.pf ? `[data-pf="${f.dataset.pf}"]` : f.dataset.acct ? `[data-acct="${f.dataset.acct}"]` : "") : "";
  // My files (owner's rule: in this window, not in the small menu); read first if not cached yet.
  if (!acFiles) { acFilesAll().then(() => acProfile(true)); }
  acShowPanel(profileHtml(acList, acDemo, acDemo ? DEMO_USER : "My account") + acFilesHtml(acFiles || []) + acSavedHtml() + acDataHtml(), "Account", "acct-profile");
  const nb = acPanel.querySelector(".acct-panel-in");
  if (nb) nb.scrollTop = top;
  const again = sel ? acPanel.querySelector(sel) : null;
  if (again) again.focus({ preventScroll: true });
  if (keep) acRender();
}

/** Run the action named `what` (the data-acct attribute of the button clicked): export download all stored run summaries as a JSON file clear delete all runs (after a confirm)... */
async function acAction(what) {
  if (what === "export") {
    // Same download trick as the course files: a Blob, a temporary blob: address, a link clicked from the code.
    const user = cloudOn() && cloudUser();
    const data = { app: "prep-my-race", exported: new Date().toISOString(), account: user ? { email: user.email } : null, profile: profileData(), runs: await acAll(), files: await acFilesAll(), aiDocs: await aiDocsAll(), saved: user ? ac.saved || [] : [] };
    const blob = new Blob([JSON.stringify(data, null, 1)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "my-prep-my-race-data.json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    trackEvent("history-export");
  } else if (what === "clear") {
    const user = cloudOn() && cloudUser();
    // window.confirm shows the browser's OK / Cancel box and returns true on OK.
    if (!window.confirm(`Delete all the runs stored ${user ? "on this device and in your account" : "on this device"}? Your stats, records and achievements start again from zero.${user ? ` ${AC_TOKEN.many[0].toUpperCase() + AC_TOKEN.many.slice(1)} you already have stay yours.` : ""}`)) return;
    if (user) { try { await cloudDeleteRuns(); } catch (e) { ac.msg = e.message === CL_READONLY ? "Runs deleted on this device only: the online account keeps only your profile for now." : "Could not reach your account: runs deleted on this device only."; } }
    acCache = [];
    await acTx("readwrite", (s) => s.clear());
    trackEvent("history-clear");
    acRender();
  } else if (what.startsWith("use:")) {
    // "use:race:<id>": open that kept file in a mode. The file becomes the latest used.
    const [, use, id] = what.split(":");
    const f = (await acFilesAll()).find((x) => x.id === id);
    if (!f || !acUse) return;
    f.used = Date.now();
    await acTx("readwrite", (s) => s.put(f), AC_FILES);
    acFiles = null;
    trackEvent("file-use", use);
    acPanel.hidden = true;
    acUse(trackToGpx(unpackTrack(f.track)), f.name, use);
  } else if (what.startsWith("file-del:")) {
    const id = what.slice(9);
    await acTx("readwrite", (s) => s.delete(id), AC_FILES);
    acFiles = null;
    trackEvent("file-delete");
    await acFilesAll();
    acProfile(true);
  } else if (what.startsWith("files:")) {
    acFileView.kind = what.slice(6);
    acFileView.more = false;
    acProfile(true);
  } else if (what === "files-more") {
    acFileView.more = !acFileView.more;
    acProfile(true);
  } else if (what.startsWith("saved:")) {
    const it = (ac.saved || []).find((x) => x.id === what.slice(6));
    if (!it || !acReopen) return;
    acPanel.hidden = true;
    try { await acReopen(it); } catch (e) { window.alert(`Could not reopen it: ${e.message}`); }
  } else if (what.startsWith("saved-del:")) {
    const id = what.slice(10);
    const it = (ac.saved || []).find((x) => x.id === id);
    if (!it || !window.confirm(`Delete "${it.title}" from your account?`)) return;
    try { await cloudSavedDelete(id); ac.saved = ac.saved.filter((x) => x.id !== id); } catch (e) { window.alert(`Could not delete it: ${e.message}`); }
    acProfile(true);
  } else if (what === "signout") {
    // Send a profile change still waiting, then forget the profile here: it is kept in the account, and the next person signing in on this browser starts from a blank one.
    await acProfileFlush();
    profileReplace({});
    await cloudSignOut();
    document.dispatchEvent(new CustomEvent("trp-refs")); // signed out: plans drop the tuning
    // Object.assign(target, values) sets several fields of `ac` at once.
    Object.assign(ac, { ledger: null, job: null, msg: "", saved: null, recovery: false, dataMsg: "" });
    acRender();
    if (!acPanel.hidden) acProfile(true);
  } else if (what === "delete") {
    if (!window.confirm(`Delete your account for good? Your online profile, saves, ${AC_TOKEN.many} and AI answers are erased from the server. What is on this device (runs, files) stays until you delete it too.`)) return;
    try { await cloudDeleteAccount(); profileReplace({}); Object.assign(ac, { ledger: null, job: null, saved: null, msg: "", dataMsg: "Your account is deleted." }); trackEvent("account-delete"); }
    catch (e) { ac.dataMsg = `Could not delete the account: ${e.message}`; }
    acProfile(true);
  } else if (what === "reset") {
    // Forgot password: the email typed in the sign-in form gets a link to choose a new one.
    const email = (acMenu.querySelector("#acEmail") || {}).value || "";
    if (!email.trim()) { ac.msg = "Type your email first, then Forgot password."; acRender(); return; }
    ac.email = email.trim();
    try { await cloudSendReset(ac.email); ac.msg = `If ${ac.email} has an account, a link to choose a new password is on its way.`; trackEvent("password-reset"); }
    catch (e) { ac.msg = `Could not send the link: ${e.message}`; }
    acRender();
  } else if (what === "signup-mode" || what === "signin-mode") {
    ac.signup = what === "signup-mode";
    ac.email = ((acMenu.querySelector("#acEmail") || {}).value || ac.email || "").trim();
    ac.msg = "";
    acRender();
  } else if (what === "ai") {
    acAsk.checks = null;
    acShowPanel(acAskHtml(), "Ask the AI");
    trackEvent("ai-open");
  } else if (what === "ai-run-ask") {
    acRunAsk.checks = null;
    acShowPanel(acRunHtml(), "Ask the AI coach");
    trackEvent("ai-open", "run");
  } else if (what === "run-go" || what === "run-fake" || what === "run-force") {
    // The Prep my run window: the same checks first; Send anyway only past warnings.
    if (acLocal) acLocal.fake = what === "run-fake";
    const checks = acRunChecks();
    const go = !checks.length || (what === "run-force" && !checks.some((k) => k.level === "stop"));
    if (go) { acRunAsk.checks = null; acStartRun(what === "run-force" ? checks.map((k) => k.code) : []); return; }
    acRunAsk.checks = checks;
    acShowPanel(acRunHtml(), "Ask the AI coach");
    const box = acPanel.querySelector(".acct-checks");
    if (box) box.scrollIntoView({ block: "nearest" });
    trackEvent("ai-checks", "run");
  } else if (what === "run-fix") {
    const first = (acRunAsk.checks || []).find((k) => k.field);
    acRunAsk.checks = null;
    acShowPanel(acRunHtml(), "Ask the AI coach");
    const el = first ? acPanel.querySelector(`[data-field="${first.field}"]`) : null;
    if (el) { el.scrollIntoView({ block: "center" }); if (el.matches("textarea")) el.focus({ preventScroll: true }); }
  } else if (what === "ai-run") {
    // From a Prep my run result: close the window and go to the run, where the session now plays.
    acPanel.hidden = true;
    const sp = document.getElementById("s-prep");
    if (sp) sp.scrollIntoView({ behavior: "smooth" });
  } else if (what.startsWith("mode:")) {
    // what.slice(5) drops "mode:".
    acAsk.mode = what.slice(5);
    if (acAsk.mode === "runs" && !acAsk.ids.size) aiSelect(acList, { from: acAsk.from, to: acAsk.to }).forEach((r) => acAsk.ids.add(r.id));
    acAskShow();
  } else if (what.startsWith("range:")) {
    // what.slice(6) drops "range:"; Number turns "28" into 28.
    const d = Number(what.slice(6));
    acAsk.to = acToday();
    acAsk.from = d ? acAsk.to - d * 86400000 : Math.min(acAsk.to, ...acList.map((r) => r.date));
    acAskShow();
  } else if (what.startsWith("goal:") || what.startsWith("risk:")) {
    // Only the chips change: toggle the "on" class on the one whose data-acct matches. [data-acct^="goal:"] in the selector means "starts with goal:".
    const [k, v] = what.split(":");
    acAsk[k] = v;
    acPanel.querySelectorAll(`[data-acct^="${k}:"]`).forEach((b) => b.classList.toggle("on", b.dataset.acct === what));
  } else if (what.startsWith("reff:")) {
    // The effort of Prep my run (1 to 5): only the chips and the line under them change.
    acRunAsk.effort = Number(what.slice(5));
    acPanel.querySelectorAll('[data-acct^="reff:"]').forEach((b) => b.classList.toggle("on", b.dataset.acct === what));
    const t = acPanel.querySelector("[data-reff-text]");
    if (t) t.textContent = `${AI_RUN_EFFORTS[acRunAsk.effort - 1].text}.`;
  } else if (what.startsWith("goto:")) {
    // Close the window (its content stays in acAsk) and bring the drop zone into view.
    acPanel.hidden = true;
    const el = document.getElementById(what.slice(5));
    if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
  } else if (what === "profile") {
    acProfile();
    trackEvent("profile-open");
  } else if (what.startsWith("pf:")) {
    if (profileAction(what.slice(3))) acProfile(true);
  } else if (what.startsWith("medal:")) {
    acMedalShow(what.slice(6));
  } else if (what === "bests") {
    // The bests live in the Account window: open it on them.
    acctOpenProfile("bests");
  } else if (what === "go" || what === "fake") {
    // Local test only: "fake" asks for the answer made by code instead of the AI.
    if (acLocal) acLocal.fake = what === "fake";
    // The code checks, at click and before any call: all clear starts the analysis at once.
    const checks = acAskChecks();
    if (!checks.length) { acAsk.checks = null; acStartAi(); return; }
    acAsk.checks = checks;
    acAskShow();
    // Bring the box of checks into view (it sits at the bottom of the window).
    const box = acPanel.querySelector(".acct-checks");
    if (box) box.scrollIntoView({ block: "nearest" });
    trackEvent("ai-checks");
  } else if (what === "fix") {
    const first = (acAsk.checks || []).find((k) => k.field);
    acAsk.checks = null;
    acAskShow(first ? first.field : "");
  } else if (what === "force") {
    // Never past a hard stop: the checks are made again, and only warnings can be forced.
    const checks = acAskChecks();
    if (checks.some((k) => k.level === "stop")) { acAsk.checks = checks; acAskShow(); return; }
    acAsk.checks = null;
    trackEvent("ai-forced");
    acStartAi(checks.map((k) => k.code));
  } else if (what.startsWith("doc:")) {
    acDocShow(what.slice(4));
  } else if (what === "docs") {
    acShowPanel(`<p class="acct-kicker">AI docs</p><h3>Every AI answer on this device</h3><section>${ac.docs.map(acDocRow).join("")}</section>`, "AI docs");
  } else if (what.startsWith("doc-use:")) {
    aiDocsGet(what.slice(8)).then((d) => {
      if (!d) return;
      document.dispatchEvent(new CustomEvent("trp-ai-use", { detail: d }));
      acAction(d.mode === "prep_run" ? "ai-run" : "ai-race");
    });
  } else if (what.startsWith("doc-del:")) {
    aiDocsDelete(what.slice(8)).then(() => { acPanel.hidden = true; acRender(); });
  } else if (what === "ai-race") {
    // From an AI result: close the window and go to Your race, where the AI plan now plays.
    acPanel.hidden = true;
    const s4 = document.getElementById("s4");
    if (s4) s4.scrollIntoView({ behavior: "smooth" });
  } else if (what === "close") {
    acPanel.hidden = true;
  }
}

/** The sign-in form was sent: with a password, sign in at once; without one, ask for a sign-in link for the typed email. */
/** Save a new password for the signed-in user (Account window, Sign-in and data). */
async function acNewPassword(pass) {
  if (!pass || pass.length < 8) { ac.dataMsg = "The password needs 8 characters or more."; acProfile(true); return; }
  try { await cloudSetPassword(pass); ac.recovery = false; ac.dataMsg = "Password saved."; trackEvent("password-set"); }
  catch (e) { ac.dataMsg = `Could not save the password: ${e.message}`; }
  acProfile(true);
}
async function acSignIn(form) {
  const email = form.querySelector("#acEmail").value.trim(), pass = form.querySelector("#acPass").value;
  if (!email) return;
  ac.email = email; // kept in the form when it is redrawn
  ac.busy = true;
  acRender();
  if (ac.signup) {
    try { await cloudSignUp(email, pass); ac.signup = false; ac.msg = `Almost there: open the link sent to ${email} to confirm your account.`; trackEvent("signup"); }
    catch (e) { ac.msg = /signups? not allowed/i.test(e.message) ? "Accounts are by invitation for now." : `Could not create the account: ${e.message}`; }
    ac.busy = false;
    acRender();
    return;
  }
  if (pass) {
    try { await cloudSignInPassword(email, pass); ac.msg = ""; trackEvent("signin"); ac.busy = false; acRender(); acSync(); }
    catch (e) { ac.busy = false; ac.msg = e.status === 400 ? "Wrong email or password." : `Could not sign in: ${e.message}`; acRender(); }
    return;
  }
  try { await cloudSendLink(email); ac.msg = `Link sent to ${email}: open it on this device to sign in.`; trackEvent("signin-link"); } catch (e) { ac.msg = /signups? not allowed/i.test(e.message) ? "Online accounts are not open yet: only invited testers can sign in for now." : `Could not send the link: ${e.message}`; }
  ac.busy = false;
  acRender();
}

/** Add the icon and the menu to the page. */
export async function initAccount(opts = {}) {
  if (opts.getRace) acGetRace = opts.getRace;
  if (opts.getRun) acGetRun = opts.getRun;
  // Local test mode: only answers on this computer, under npm run ai-browser (ailocal.js).
  acAiShow();
  aiLocalProbe().then((x) => { acLocal = x; acAiShow(); });
  acEl = document.createElement("div");
  acEl.className = "acct";
  // The round button (a person icon in SVG: a circle head and a curved path for the shoulders), the menu (filled by acRender) and the hidden pop-up panel.
  acEl.innerHTML = `
    <span class="acct-name" aria-hidden="true"></span>
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
  // Open or close the menu. aria-expanded tells screen readers its state.
  const set = (open) => {
    acOpenMenu = set;
    acMenu.classList.toggle("open", open);
    btn.setAttribute("aria-expanded", String(open));
    if (open) { acRender(); trackEvent("account-open"); if (cloudOn() && cloudUser() && !ac.job) acSync(); }
  };
  acOpenMenu = set;
  // stopPropagation(): the click stops here, so the document listener below (which closes the menu on any outside click) does not see it.
  btn.addEventListener("click", (e) => { e.stopPropagation(); set(!acMenu.classList.contains("open")); });
  // The Account window replaces the menu on screen: the menu closes when it opens.
  acEl.addEventListener("click", (e) => { const b = e.target.closest("[data-acct]"); if (!b) return; if (b.dataset.acct === "profile" || b.dataset.acct === "bests" ) set(false); acAction(b.dataset.acct); });
  // Hovering or tabbing onto an achievement icon shows it in the caption too (a tap is a click).
  const medalOver = (e) => { const b = e.target.closest && e.target.closest("[data-acct^='medal:']"); if (b) acMedalShow(b.dataset.acct.slice(6)); };
  acMenu.addEventListener("mouseover", medalOver);
  acMenu.addEventListener("focusin", medalOver);
  // The sign-in form: preventDefault() stops the browser from submitting it as a page load.
  acEl.addEventListener("submit", (e) => {
    const f = e.target.closest("[data-acct-form=signin]");
    if (f) { e.preventDefault(); acSignIn(f); }
    const pw = e.target.closest("[data-acct-form=password]");
    if (pw) { e.preventDefault(); acNewPassword(pw.querySelector("#acNewPass").value); }
  });
  // A click on the dimmed backdrop itself (not on the panel's content) closes the pop-up.
  acPanel.addEventListener("click", (e) => { if (e.target === acPanel) acPanel.hidden = true; });
  // The "input" event fires on every keystroke, date change or tick in the Ask the AI window.
  acPanel.addEventListener("input", (e) => {
    if (!e.target.dataset) return;
    if (e.target.dataset.ask) acAskInput(e.target);
    else if (e.target.dataset.pf && profileInput(e.target, false)) acProfile(true);
  });
  // "change" fires when a field of the Account window is left (or a list choice made): times and numbers are read then, and the window redrawn when the card or the "to go" column changed.
  acPanel.addEventListener("change", (e) => { if (e.target.dataset && e.target.dataset.pf && profileInput(e.target, true)) setTimeout(() => acProfile(true), 0); });
  // The edelweiss stickers of the modes (acctAiBadge) open their Ask the AI window, and the profile links of the page (data-open-profile) the Account window.
  document.addEventListener("click", (e) => {
    const b = e.target.closest && e.target.closest("[data-ai-ask]");
    if (b) acAction(b.dataset.aiAsk === "run" ? "ai-run-ask" : "ai");
    const pl = e.target.closest && e.target.closest("[data-open-profile]");
    if (pl) { e.preventDefault(); acctOpenProfile(pl.dataset.openProfile); }
  });
  // Any click outside the account element closes the menu.
  document.addEventListener("click", (e) => { if (e.target.isConnected && !acEl.contains(e.target)) set(false); });
  // A GPX file given to any drop box (event "trp-gpx" from main.js, preprun.js, review.js) joins My files.
  document.addEventListener("trp-gpx", (e) => acctKeepFile(e.detail.xml, e.detail.label));
  // Escape closes the pop-up first, then the menu (and gives the focus back to the icon).
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!acPanel.hidden) { acPanel.hidden = true; return; }
    if (acMenu.classList.contains("open")) { set(false); btn.focus(); }
  });
  acRender();
  // Back from a sign-in link: keep the session, sync, and show the menu so the user sees it worked.
  const link = await cloudFromUrl();
  if (link === "recovery") { ac.recovery = true; trackEvent("signin", "recovery"); acctOpenProfile("data"); }
  else if (link) { trackEvent("signin", link); set(true); }
}
