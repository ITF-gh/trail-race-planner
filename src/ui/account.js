// account.js: the account icon at the top right of the hero and its see-through menu.
//
// The run log lives in this browser, in IndexedDB (a small database every browser has, much
// roomier than localStorage). Each run you open in Rewind my run, or add as one of your runs in
// Prep my race, is summarised (src/core/runrecord.js) and stored; sample and demo runs are not.
// The menu is re-drawn from the stored summaries (src/core/history.js).
//
// Signed in (cloud.js, when the online account is set up), the same summaries are also kept in
// the account, so they follow you to every device, and the account holds your AI tokens (edelweiss):
// earned with achievements (checked by the server), spent on an AI analysis of the runs you choose.
//
// Where it sits: main.js calls initAccount() once at start-up, and calls
// acctSaveRun() / acctSaveGpx() when a run is opened. Everything else here is private.
//
// Main pieces, top to bottom:
//   acOpen, acTx, acAll        the IndexedDB helpers (open, one transaction, read all)
//   acctSaveRun/Gpx            store one run summary (and send it to the account when signed in)
//   AC_TOKEN, AC_SPARK         the token's name and its edelweiss logo (an SVG built in code)
//   acTokensHtml, acMenuHtml   build the menu's HTML from historySummary()
//   acBestsHtml                the All-time bests pop-up
//   acAsk... functions         the "Ask the AI" window: which runs, which axis, which question
//   acRender                   redraw the menu
//   acClaim, acSync            talk to the account (tokens, two-way sync of runs)
//   acShowPanel, acResultHtml, acStartAi   the pop-up panel, the AI answer, start and polling
//   acAction, acSignIn         what each menu button does
//   initAccount                build the icon and menu, wire the clicks and the keyboard
//
// IndexedDB's API is old-style: requests report back through onsuccess / onerror callbacks. The
// helpers below wrap those in Promises so the rest can use async / await, and they never reject:
// a failure resolves with null, and the app keeps working from its in-memory copy.
//
// The HTML of the menu and pop-ups is built as template strings (text between backticks, with
// ${...} holes filled by values) and put in the page with innerHTML. Every text that comes from a
// user or from the AI goes through acEsc first, so it can never be read as HTML.

import { parseGpx } from "../core/track.js";
import { analyseRun } from "../core/review.js";
import { historySummary, aiSelect, recordClean, AI_QUESTION_MAX } from "../core/history.js";
import { aiRaceChecks, AI_GOALS, AI_RISKS, AI_NOTES_MAX } from "../core/aichecks.js";
import { runRecord } from "../core/runrecord.js";
import { demoRecords, DEMO_USER } from "../core/demorecords.js";
import { mmss, hms, hm, parseDuration } from "../core/format.js";
import { trackEvent } from "./analytics.js";
import { profileHtml, profileInput, profileAction, profileAthlete, profileWho } from "./profile.js";
import { aiLocalProbe, aiLocalRun, aiLocalHtml } from "./ailocal.js";
import { aiDocsAll, aiDocsPut, aiDocsGet, aiDocsDelete } from "./aidocs.js";
import { cloudOn, cloudUser, cloudFromUrl, cloudSendLink, cloudSignOut, cloudRuns, cloudPutRuns, cloudDeleteRuns, cloudLedger, cloudClaim, cloudAnalyse, cloudJob, cloudJobs, cloudDeleteAccount } from "./cloud.js";

// Database name and its one "object store" (IndexedDB's word for a table) of run summaries.
const AC_DB = "trp-history", AC_STORE = "runs";
let acCache = null; // the records, once read; also the fallback when IndexedDB is blocked
// Escape text for HTML: each of & < > " (the regex's character set) becomes its entity.
const acEsc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/**
 * Open (and on first use create) the database. Resolves to null when the browser blocks it.
 * indexedDB.open(name, 1) asks for version 1; the very first time, the browser fires
 * onupgradeneeded, where the store is created with `id` as its key (one record per run id).
 */
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
/**
 * Run one request in a transaction; resolves with its result (or null on failure).
 * `mode` is "readonly" or "readwrite"; `make(store)` makes the request (getAll, put, clear...)
 * and returns it (or null when it made several). The result is read once the whole transaction
 * is complete (oncomplete), so the data is surely written. The database is closed each time.
 */
async function acTx(mode, make) {
  const db = await acOpen();
  if (!db) return null;
  return new Promise((ok) => {
    try {
      const tx = db.transaction(AC_STORE, mode);
      const req = make(tx.objectStore(AC_STORE));
      tx.oncomplete = () => { db.close(); ok(req ? req.result : true); };
      // a = b = fn sets both handlers to the same function.
      tx.onerror = tx.onabort = () => { db.close(); ok(null); };
    } catch (e) { db.close(); ok(null); }
  });
}
/**
 * All stored run summaries, read from the database once and then served from acCache.
 * Summaries saved before the "no heart rate from files" rule may still hold heart data: they are
 * cleaned (recordClean) and written back once, so none stays on the device.
 */
async function acAll() {
  if (!acCache) {
    const raw = (await acTx("readonly", (s) => s.getAll())) || [];
    acCache = raw.map(recordClean);
    const old = raw.filter((r) => r && ("hrAvg" in r || "decouplingPct" in r));
    if (old.length) await acTx("readwrite", (s) => { old.forEach((r) => s.put(recordClean(r))); return null; });
  }
  return acCache;
}

/**
 * Store the summary of an analysed run (same run twice = one copy).
 * `run` is the analysis from core/review.js, `name` the name to show. Steps: 1. summarise it
 * (runRecord; a run that cannot be summarised is skipped), 2. replace any copy with the same id
 * in the cache and the database, 3. redraw the menu, 4. when signed in, send it to the account
 * and claim any token it earned (offline: it goes with the next sync).
 */
export async function acctSaveRun(run, name) {
  let rec;
  try { rec = runRecord(run, name); } catch (e) { return; }
  const list = await acAll();
  const isNew = !list.some((r) => r.id === rec.id);
  // put() adds the record, or replaces the one with the same id.
  acCache = list.filter((r) => r.id !== rec.id).concat(rec);
  await acTx("readwrite", (s) => s.put(rec));
  // The event label is the number of runs stored (a count, nothing personal).
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

// Small formatters: a date as "12 Mar" in the reader's language (undefined = the browser's
// locale), and a whole number with thousands separators ("12,345").
const acDate = (ms) => new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short" });
const acNum = (x) => Math.round(x).toLocaleString("en-US");
// The AI token: earned with achievements and events, 1 token = 1 AI analysis. Its name lives here
// only (the database and the server still call it a "cairn" internally, which nobody sees).
const AC_TOKEN = { one: "edelweiss", many: "edelweiss" }; // the same word in the singular and the plural
// "3 edelweiss": a count with the right word (AC_TOKEN keeps the door open for a word whose
// plural differs).
const acTok = (n) => `${n} ${n === 1 ? AC_TOKEN.one : AC_TOKEN.many}`;
// The token logo: a shiny edelweiss. Eight woolly star petals (long and short in turn), a yellow
// heart of small florets, and a glint. Built once as an SVG string; no gradients, so the many
// copies on the page need no shared ids.
const AC_SPARK = (() => {
  // One petal as an SVG path, pointing straight up from the centre (16, 16) of the 32 x 32 box.
  // M x y moves the pen to the centre; each C draws a cubic Bezier curve (two control points,
  // then the end point): one curve up the left side to the tip at (16, 16 - len), one back down
  // the right side; Z closes the shape. `len` is the petal length, `w` its half width.
  const petal = (len, w) => `M16 16C${16 - w} ${16 - len * 0.45} ${16 - w * 0.6} ${16 - len * 0.85} 16 ${16 - len}C${16 + w * 0.6} ${16 - len * 0.85} ${16 + w} ${16 - len * 0.45} 16 16Z`;
  // Eight petals, one every 45 degrees, long (13.5) and short (10) in turn (i % 2 is 1 for odd i).
  // Each petal is drawn twice: a pale grey one with an outline, then a white one shrunk to 45%
  // around the centre (translate, scale, translate back) for the woolly highlight. The extra 22.5
  // degrees turns the flower so no petal points straight up.
  const ring = [0, 45, 90, 135, 180, 225, 270, 315].map((deg, i) => {
    const d = petal(i % 2 ? 10 : 13.5, i % 2 ? 2.6 : 3.2);
    return `<path d="${d}" transform="rotate(${deg + 22.5} 16 16)" fill="#f4f7fb" stroke="#b9c6d8" stroke-width=".6"/><path d="${d}" transform="rotate(${deg + 22.5} 16 16) translate(16 16) scale(.45) translate(-16 -16)" fill="#ffffff"/>`;
  }).join("");
  // The yellow heart: six small circles [x, y, radius], the destructuring ([x, y, r]) names the
  // three numbers of each.
  const heart = [[16, 16, 2.1], [13.6, 15, 1.4], [18.4, 15, 1.4], [14.4, 18, 1.4], [17.6, 18, 1.4], [16, 13.3, 1.3]].map(([x, y, r]) => `<circle cx="${x}" cy="${y}" r="${r}" fill="#ffc928" stroke="#d99a00" stroke-width=".4"/>`).join("");
  // The glint: a small four-pointed star at the top right.
  const glint = `<path d="M26.5 2.5c.3 2 1.2 2.9 3.2 3.2-2 .3-2.9 1.2-3.2 3.2-.3-2-1.2-2.9-3.2-3.2 2-.3 2.9-1.2 3.2-3.2z" fill="#fff1b8"/>`;
  return `<svg viewBox="0 0 32 32" aria-hidden="true">${ring}${heart}${glint}</svg>`;
})();

// What the account side knows (filled by acSync): the token ledger, the analysis running, a message.
//   ledger  [{ delta, reason, created_at }] from the server, null before the first read
//   jobs    past AI analyses, newest first
//   job     id of the analysis running now, null when none
//   msg     a message to show in the tokens section ("" = none)
//   busy    true while a sign-in link is being sent (greys out the button)
const ac = { ledger: null, jobs: [], job: null, msg: "", busy: false, docs: [] };
// Token balance = the sum of all ledger lines (+ earned, - spent). Nothing is read yet: 0.
const acBalance = () => (ac.ledger ? ac.ledger.reduce((s, r) => s + r.delta, 0) : 0);
// acList: the run summaries the menu and the AI window work on; acDemo: true when they are the
// demo profile's made-up runs.
let acList = [], acDemo = false; // the runs the menu shows (yours, or User1's)

/**
 * HTML of the tokens section of the menu ("AI edelweiss"). `S` is the summary from
 * historySummary(). The count shown is the server's balance when signed in ("…" until the
 * ledger is read), otherwise S.cairns: what the achievements in this browser would earn.
 * The note under it is, in order of priority: a message (signed in), "The AI is reading your
 * race and runs" while an analysis runs, or what tokens are for. Signed out with the account open: a
 * sign-in form. Signed in: a link to the last analysis, when there is one.
 * The "Ask the AI" button is only disabled while an analysis runs; the Ask the AI window then
 * says what (if anything) blocks it.
 */
function acTokensHtml(S) {
  const signedIn = cloudOn() && cloudUser();
  const n = signedIn ? (ac.ledger ? acBalance() : "…") : S.cairns;
  let note = `Earned with achievements and events. 1 ${AC_TOKEN.one} buys 1 AI-tailored race plan.`;
  if (signedIn && ac.msg) note = acEsc(ac.msg);
  else if (signedIn && ac.job) note = "The AI is reading your race and runs. It takes about a minute; you can close this menu.";
  // The sign-in form, only when the account exists but nobody is signed in. data-acct-form names
  // it for the submit listener in initAccount.
  const signin = cloudOn() && !signedIn ? `<form class="acct-signin" data-acct-form="signin">
        <label for="acEmail">Sign in to collect them</label>
        <div><input id="acEmail" type="email" required autocomplete="email" placeholder="you@example.com"><button class="btn ghost" type="submit"${ac.busy ? " disabled" : ""}>Send link</button></div>
      </form>` : "";
  // data-acct="..." on a button names the action a click runs (see acAction).
  return `<section><h4>AI ${AC_TOKEN.many}</h4>
      <div class="acct-cairns"><b>${AC_SPARK}${n}</b><button class="btn primary" type="button" data-acct="ai"${ac.job ? " disabled" : ""}>${ac.job ? "Analysing…" : `${AC_SPARK}Ask the AI`}</button></div>
      <p class="acct-note">${note}</p>${signin}
      ${signedIn && ac.jobs.length ? `<button class="acct-linkbtn" type="button" data-acct="last">See my last analysis (${acDate(Date.parse(ac.jobs[0].created_at))})</button>` : ""}
    </section>`;
}

/**
 * HTML of the whole menu from `S`, the summary of the stored runs (historySummary in
 * core/history.js): count, bests, last runs, 12-month totals, achievements, tokens.
 * `demo` = true shows the made-up profile (no runs of your own yet).
 * Sections: who (name and where the runs are), then either an empty-log note, or the 12-month
 * totals, last runs and all the achievements as small icons; then tokens and the action links.
 */
function acMenuHtml(S, demo = false) {
  const user = cloudOn() && cloudUser();
  // The line under the name: demo profile, signed-in email, or runs on this device only.
  const where = demo ? `Demo profile · ${S.count} sample runs` : user ? `${acEsc(user.email)} · ${S.count} run${S.count === 1 ? "" : "s"} synced` : `${S.count || "No"} run${S.count === 1 ? "" : "s"} on this device`;
  // The name and flag typed in the Account window, else User1 (demo) or "My account". The
  // "Account" button opens that window (profile.js).
  const me = profileWho();
  const who = `<section class="acct-who"><div><b>${me.flag ? `${me.flag} ` : ""}${acEsc(me.name || (demo ? DEMO_USER : "My account"))}</b><small>${where}</small></div><button class="btn ghost acct-prof" type="button" data-acct="profile">Account</button></section>`;
  // The links at the bottom: bests (when there are runs), export and delete (own runs only),
  // sign out and delete account (signed in only).
  const links = `<section class="acct-links">${S.count ? `<button type="button" data-acct="bests">All-time bests</button>` : ""}${S.count && !demo ? `<button type="button" data-acct="export">Export</button><button type="button" data-acct="clear">Delete runs</button>` : ""}${user ? `<button type="button" data-acct="signout">Sign out</button><button type="button" data-acct="delete">Delete account</button>` : ""}</section>`;
  if (!S.count) {
    return `${who}
    <section><p class="acct-empty">Open one of your runs in <b>Rewind my run</b>, or add it to <b>Your runs</b> in Prep my race: its numbers are kept here${user ? "" : ", on this device only"}, and your stats, records and achievements build up run after run.</p></section>
    ${acDocsHtml(ac.docs)}${acTokensHtml(S)}${links}`;
  }
  // Big climbing totals in thousands: 12345 m -> "12.3k".
  const gainK = S.year.gain >= 10000 ? `${(S.year.gain / 1000).toFixed(1)}k` : acNum(S.year.gain);
  // Achievements reached first, then the closest to being reached. The sort compares `done`
  // (true counts as 1, false as 0), then `progress` (0 to 1) when `done` is equal. [...x] copies
  // the array first, so the summary's own list is not reordered. Each medal is an icon; its name,
  // hint, progress (locked ones) and the tokens it earns are in the tooltip (title attribute).
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
    ${acDocsHtml(ac.docs)}
    ${acTokensHtml(S)}
    ${links}`;
}

/**
 * All-time bests, in the pop-up (they used to make the menu too long).
 * `S.bests` holds { best1k, best5k, best10k, vam, longest }, each { value, run } or missing:
 * times in seconds, climbing speed in m/h, longest in km. Each line shows the date of the run.
 */
function acBestsHtml(S) {
  const B = S.bests;
  // One line of the table, or "" when that best is missing; f formats the value.
  const row = (label, b, f) => (b ? `<div class="acct-row"><span>${label}</span><b>${f(b.value, b.run)} <small>${acDate(b.run.date)}</small></b></div>` : "");
  return `<p class="acct-kicker">${acEsc(profileWho().name || (acDemo ? DEMO_USER : "My account"))}</p><h3>All-time bests</h3>
    <div class="acct-bests">
      ${row("Fastest 1 km", B.best1k, (v) => mmss(v))}
      ${row("Fastest 5 km", B.best5k, (v) => mmss(v))}
      ${row("Fastest 10 km", B.best10k, (v) => (v < 3600 ? mmss(v) : hms(v)))}
      ${row("Best climbing speed", B.vam, (v) => `${acNum(v)} m/h`)}
      ${row("Longest run", B.longest, (v, r) => `${v.toFixed(1)} km · ${acNum(r.gain)} m`)}
    </div>`;
}

// The AI window, Prep my race version: the runner sees the target race (from the race GPX), picks
// their old runs (the GPX files of "Your runs" plus a choice of the runs stored in the account)
// and gives their own input (goal, target time, risk, free information, question).
// Its state, kept between openings of the window (nothing typed is lost, whatever is clicked):
//   mode      "dates" (a date range) or "runs" (stored runs ticked one by one)
//   from, to  the range, as ms at midnight UTC of the first and last day (both days included);
//             null until the window first opens, then the last 90 days
//   ids       a Set of the ticked run ids (a Set holds each value once, quick to test)
//   goal      a code from AI_GOALS (aichecks.js): "finish", "target" or "best"
//   risk      a code from AI_RISKS: "prudent", "balanced" or "bold"
//   target    the target time as typed ("7:30"); null until the window first opens, then the
//             plan's own target time
//   notes     free information about the runner or the race, "" when none
//   question  the runner's own question, "" when none
//   checks    the failed checks shown after a click on "Spend", or null when none are shown
const acAsk = { mode: "dates", from: null, to: null, ids: new Set(), goal: "target", risk: "balanced", target: null, notes: "", question: "", checks: null };
// A date in ms as "2026-10-16", the format an <input type="date"> reads and shows.
const acDay = (ms) => new Date(ms).toISOString().slice(0, 10);
// Today at midnight UTC, in ms (Date.UTC builds the moment from year, month, day).
const acToday = () => { const d = new Date(); return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()); };
// What the page knows about the race being prepared, given by main.js to initAccount (getRace):
// { race: { name, km, gain, legs, aid } or null, gpxRuns, targetText, centralSec }.
let acGetRace = () => ({ race: null, gpxRuns: 0, targetText: "", centralSec: null, plan: null });
// The local test mode (ailocal.js): { key, model, fake } when the page comes from npm run
// ai-browser on this computer, else null. `fake` = the last click asked for the fake answer.
let acLocal = null;
/**
 * What is sent to the server as the `ask`: the stored runs (ticked ids or the date range), the
 * goal, target time, risk, free information and question, and `forced`: the codes of the
 * warnings the runner chose to send anyway. `focus: "race"` keeps the server of today working
 * (it reads only the runs, the focus and the question). The server cleans it all again.
 */
function acAskPayload(forced = []) {
  const runs = acAsk.mode === "runs" ? { ids: [...acAsk.ids] } : { from: acAsk.from, to: acAsk.to };
  return { ...runs, mode: "prep_race", focus: "race", goal: acAsk.goal, risk: acAsk.risk, targetSec: parseDuration(acAsk.target), notes: acAsk.notes, question: acAsk.question, forced };
}
/** The stored runs the window currently selects (aiSelect: the same rule as on the server). */
const acAskRuns = () => aiSelect(acList, acAskPayload());
/**
 * The code checks of a click on "Spend" (aiRaceChecks in core/aichecks.js), from what the window
 * and the page hold now. Returns the failed checks, hard stops first ([] = all clear).
 */
function acAskChecks() {
  const R = acGetRace();
  const signedIn = Boolean(cloudOn() && cloudUser());
  return aiRaceChecks({
    race: R.race, gpxRuns: R.gpxRuns, storedRuns: acAskRuns().length,
    targetText: (acAsk.target || "").trim(), targetSec: parseDuration((acAsk.target || "").trim()), centralSec: R.centralSec,
    notes: acAsk.notes, question: acAsk.question,
    // Local test: no account is needed, so the account checks pass.
    cloud: acLocal ? { open: true, signedIn: true, balance: 1 } : { open: cloudOn(), signedIn, balance: acBalance(), demo: acDemo },
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
/**
 * HTML of the Ask the AI window for Prep my race, five steps:
 *   1. Target race: what the race GPX gives (name, km, climbing, sections, aid stations), or a
 *      link to load it.
 *   2. Your old runs: how many GPX files are in "Your runs", then the stored runs to use (a date
 *      range or runs ticked one by one).
 *   3. Your goal: goal chips, target time, risk chips.
 *   4. Free information and 5. Your question: optional texts.
 * Then what is sent and what is not, and either the "Spend 1 edelweiss" and Cancel buttons, or,
 * after a click on Spend that failed a check, the box of checks with Fix and retry, Send anyway
 * (only when no check is a hard stop) and Cancel.
 * Every element a check can point at carries data-field, so "Fix and retry" can scroll to it.
 */
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
/**
 * Refresh the count of stored runs without redrawing the window (keeps the cursor where it is).
 * Used while the runner types or ticks: redrawing the whole window would reset the text field.
 */
function acAskRefresh() {
  // querySelector finds the first element matching a CSS selector; null when there is none.
  const c = acPanel.querySelector(".acct-ask-count");
  if (c) c.innerHTML = acAskSummary();
}
/**
 * A field of the Ask the AI window changed (`el` is the input). Its data-ask attribute says which:
 * target, notes, question (texts), from / to (a date field) or run (a checkbox). Updates acAsk,
 * then the count.
 */
function acAskInput(el) {
  const k = el.dataset.ask;
  if (k === "question" || k === "notes" || k === "target") acAsk[k] = el.value;
  // The OpenAI key of the file test copy: kept in memory only, outside acAsk.
  else if (k === "key" && acLocal) acLocal.apiKey = el.value.trim();
  // Date.parse("2026-10-16") gives midnight UTC of that day in ms; NaN (an empty field) is ignored.
  else if (k === "from" || k === "to") { const v = Date.parse(el.value); if (Number.isFinite(v)) acAsk[k] = v; }
  else if (k === "run") { if (el.checked) acAsk.ids.add(el.value); else acAsk.ids.delete(el.value); }
  acAskRefresh();
}
/**
 * Redraw the Ask the AI window, keeping its scroll position. `field` (optional) is a data-field
 * name: the window then scrolls to that element and puts the focus in it when it is a field.
 */
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
async function acRender() {
  if (!acMenu) return;
  const mine = await acAll();
  // No run of your own yet (and not signed in): show the demo profile User1 and its made-up runs,
  // so the menu is never empty. Your first saved run replaces it.
  acDemo = !mine.length && !(cloudOn() && cloudUser());
  acList = acDemo ? demoRecords() : mine;
  ac.docs = await aiDocsAll();
  acMenu.innerHTML = acMenuHtml(historySummary(acList), acDemo);
}

/**
 * Ask the server for the tokens of the achievements reached, then read the ledger.
 * The server checks the achievements itself (the browser cannot be trusted to grant tokens);
 * a failed claim is ignored and the ledger is read anyway.
 */
async function acClaim() {
  await cloudClaim().catch(() => null);
  ac.ledger = await cloudLedger();
}

/**
 * Signed in: send the runs the account does not have, fetch the ones this device lacks, then tokens.
 * Runs are matched by id (a Set gives a fast "do we have this id?" test). Runs are only added,
 * never removed, so the result on both sides is the union of the two lists.
 * Any failure leaves the local runs untouched and shows a short message.
 */
async function acSync() {
  if (!cloudOn() || !cloudUser()) return;
  try {
    // 1. Upload: local runs whose id the account does not have.
    const [local, remote] = [await acAll(), await cloudRuns()];
    const have = new Set(remote.map((r) => r.id));
    await cloudPutRuns(local.filter((r) => !have.has(r.id)));
    // 2. Download: account runs this device does not have, stored in the cache and the database.
    const mine = new Set(local.map((r) => r.id));
    const fresh = remote.filter((r) => r && r.id && !mine.has(r.id));
    if (fresh.length) {
      acCache = local.concat(fresh);
      await acTx("readwrite", (s) => { fresh.forEach((r) => s.put(r)); return null; });
    }
    // 3. Tokens and past analyses.
    await acClaim();
    ac.jobs = await cloudJobs();
    ac.msg = "";
  } catch (e) {
    ac.msg = e.message === "Session expired, please sign in again" ? e.message : "Could not reach your account. Your runs are safe on this device.";
  }
  acRender();
}

/**
 * The see-through pop-up panel: the Ask the AI window, the AI answer or the all-time bests.
 * `html` is the content, `label` the name screen readers announce. A close button is added and
 * gets the keyboard focus, so the Escape and Enter keys work at once.
 */
function acShowPanel(html, label = "AI analysis", cls = "") {
  acPanel.innerHTML = `<div class="acct-panel-in${cls ? ` ${cls}` : ""}" role="dialog" aria-modal="true" aria-label="${label}"><button class="acct-x" type="button" data-acct="close" aria-label="Close">×</button>${html}</div>`;
  acPanel.hidden = false;
  const x = acPanel.querySelector(".acct-x");
  if (x) x.focus();
}
/**
 * HTML of an AI analysis result `r` (from the server): headline, the answer to the runner's
 * question (when asked), summary, new KPIs (each with name, value, unit, meaning and how it is
 * computed), strengths, things to work on and a plan for the next weeks. `when` is its creation
 * date (ISO text). Every text is escaped: it comes from the AI, not from this code.
 */
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

/**
 * Start an AI analysis (the "Spend 1 edelweiss" button) and wait for its result.
 * Sends the athlete settings and the window's ask (acAskPayload, with `forced`: the codes of the
 * warnings the runner chose to send anyway). The server answers at once
 * with a job id and works in the background; this function then "polls": it asks for the job's
 * status every 4 s until it is done or failed, or 6 minutes have passed (90 tries x 4 s).
 * Done: the result opens in the panel. Failed: the server gives the token back, and the ledger
 * is read again to show it.
 */
async function acStartAi(forced = []) {
  if (acLocal) return acStartLocal(forced);
  acPanel.hidden = true;
  ac.msg = "";
  try {
    const r = await cloudAnalyse(profileAthlete(), acAskPayload(forced));
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
    // A pause: a Promise that resolves after 4000 ms, awaited.
    await new Promise((ok) => setTimeout(ok, 4000));
    const j = await cloudJob(ac.job).catch(() => null);
    // No answer (network) or still running: try again next round.
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

/**
 * The local test (ailocal.js): the same ask, sent to the local server instead of the account.
 * The panel says it is working, then shows the result: the referee's verdict, the rebuilt finish,
 * every leg compared, the texts and the tokens.
 */
async function acStartLocal(forced) {
  const R = acGetRace();
  const fake = acLocal.fake;
  acShowPanel(`<p class="acct-kicker">Local AI test</p><h3>${fake ? "Making the fake answer…" : `Asking ${acEsc(acLocal.model)}…`}</h3><p>${fake ? "" : "This can take a minute or two. Keep this tab open."}</p>`, "Local AI test");
  const a = profileAthlete();
  const r = await aiLocalRun({
    plan: R.plan, raceName: R.race ? R.race.name : "Race", fake, direct: acLocal.direct, apiKey: acLocal.apiKey,
    user: { targetSec: parseDuration((acAsk.target || "").trim()), goal: acAsk.goal, risk: acAsk.risk, notes: acAsk.notes, question: acAsk.question, forced },
    athlete: { maxHr: a.hrMax, restHr: a.hrRest, weightKg: a.weight },
    history: acAskRuns(),
  });
  // Every answer that came back is kept as an AI doc (aidocs.js); a usable one also goes to
  // Your race (main.js plays it and turns the AI switch on).
  if (!r.error) {
    const m = r.result;
    const doc = {
      id: `ai-${Date.now()}`, at: new Date().toISOString(), mode: "prep_race", race: R.key, raceName: R.race ? R.race.name : "Race",
      input: r.input, output: r.read.output, tokens: r.read.tokens,
      // The referee's summary, without the rebuilt plan (rebuilt from the output when played).
      result: { status: m.status, reason: m.reason, finishSec: m.finishSec, aiFinishSec: m.aiFinishSec, fixes: m.fixes, legs: m.legs, aid: m.aid, texts: m.texts, dataset: m.dataset || null },
    };
    await aiDocsPut(doc);
    if (m.status === "ok") document.dispatchEvent(new CustomEvent("trp-ai-use", { detail: doc }));
  }
  acShowPanel(aiLocalHtml(r), "Local AI test", "acct-local");
}

/** One AI doc as a menu row: date, race, then the verdict and AI finish (or "empty"). */
function acDocRow(d) {
  const ok = d.result && d.result.status === "ok";
  const v = ok ? `${acEsc(d.result.dataset.target.verdict)} · ${hm(d.result.finishSec)}` : "empty";
  return `<button type="button" class="acct-row acct-doc" data-acct="doc:${acEsc(d.id)}"><span>✦ ${acDate(Date.parse(d.at))} ${new Date(d.at).toTimeString().slice(0, 5)} · ${acEsc(d.raceName)}</span><b>${v}</b></button>`;
}
/** HTML of the AI docs block of the menu: the last few docs, newest first ("" when none). */
function acDocsHtml(docs) {
  if (!docs.length) return "";
  return `<section><h4>AI docs · ${docs.length}</h4>${docs.slice(0, 4).map(acDocRow).join("")}${docs.length > 4 ? `<button type="button" class="acct-linkbtn" data-acct="docs">All ${docs.length} AI docs</button>` : ""}</section>`;
}
/** Open one AI doc in the panel: the same view as a fresh answer, with its own buttons. */
async function acDocShow(id) {
  const d = await aiDocsGet(id);
  if (!d) return;
  const download = URL.createObjectURL(new Blob([JSON.stringify(d, null, 2)], { type: "application/json" }));
  acShowPanel(aiLocalHtml({ docId: d.id, when: acDate(Date.parse(d.at)), input: d.input, read: { tokens: d.tokens, output: d.output }, result: d.result, stamp: d.at.slice(0, 19).replace(/[:T]/g, "-"), download }), "AI doc", "acct-local");
}

/** Open the Ask the AI window (for the "Ask the AI" link of Your race). */
export function acctOpenAsk() { acAction("ai"); }

/**
 * Open (or redraw) the Account window in the pop-up panel. `keep` = true keeps the scroll
 * position, so a redraw after a change does not jump back to the top. The menu is redrawn too,
 * since its first line shows the profile's name and flag.
 */
function acProfile(keep = false) {
  const box = acPanel.querySelector(".acct-panel-in");
  const top = keep && box ? box.scrollTop : 0;
  // The field or button that has the focus (named by its data-pf or data-acct), to give it back.
  const f = keep && document.activeElement && acPanel.contains(document.activeElement) ? document.activeElement : null;
  const sel = f ? (f.dataset.pf ? `[data-pf="${f.dataset.pf}"]` : f.dataset.acct ? `[data-acct="${f.dataset.acct}"]` : "") : "";
  acShowPanel(profileHtml(acList, acDemo, acDemo ? DEMO_USER : "My account"), "Account", "acct-profile");
  const nb = acPanel.querySelector(".acct-panel-in");
  if (nb) nb.scrollTop = top;
  const again = sel ? acPanel.querySelector(sel) : null;
  if (again) again.focus({ preventScroll: true });
  if (keep) acRender();
}

/**
 * Run the action named `what` (the data-acct attribute of the button clicked):
 *   export      download all stored run summaries as a JSON file
 *   clear       delete all runs (after a confirm), here and in the account
 *   signout     sign out and forget the account data in memory
 *   delete      delete the online account (after a confirm)
 *   ai          open the Ask the AI window (Prep my race)
 *   mode:X      in that window, switch to "dates" or "runs"
 *   range:N     set the range to the last N days (0 = everything)
 *   goal:X      choose the goal; risk:X the risk (only the chips change)
 *   goto:ID     close the window and scroll to the page element ID (a drop zone for a GPX)
 *   go          run the code checks (aichecks.js): all clear starts the analysis, otherwise the
 *               window shows the checks; fix = hide them and go to the first field to fix;
 *               force = start anyway with the warnings (never with a hard stop)
 *   bests       open the all-time bests pop-up
 *   profile     open the Account window (profile.js); pf:X are its own buttons
 *   last        show the last result; close = hide the pop-up
 * "mode:" and "range:" redraw the window; "goal:" and "risk:" only move the highlight. What is
 * typed is kept either way: it lives in acAsk, not in the page.
 */
async function acAction(what) {
  if (what === "export") {
    // Same download trick as the course files: a Blob, a temporary blob: address, a link clicked
    // from the code. JSON.stringify(x, null, 1) indents the JSON by one space, readable by eye.
    const blob = new Blob([JSON.stringify({ app: "trail-race-planner", exported: new Date().toISOString(), runs: await acAll() }, null, 1)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "my-trail-runs.json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    trackEvent("history-export");
  } else if (what === "clear") {
    const user = cloudOn() && cloudUser();
    // window.confirm shows the browser's OK / Cancel box and returns true on OK. The last part
    // (signed in only) says that the tokens already earned are kept.
    if (!window.confirm(`Delete all the runs stored ${user ? "on this device and in your account" : "on this device"}? Your stats, records and achievements start again from zero.${user ? ` ${AC_TOKEN.many[0].toUpperCase() + AC_TOKEN.many.slice(1)} you already have stay yours.` : ""}`)) return;
    if (user) { try { await cloudDeleteRuns(); } catch (e) { ac.msg = "Could not reach your account: runs deleted on this device only."; } }
    acCache = [];
    await acTx("readwrite", (s) => s.clear());
    trackEvent("history-clear");
    acRender();
  } else if (what === "signout") {
    await cloudSignOut();
    // Object.assign(target, values) sets several fields of `ac` at once.
    Object.assign(ac, { ledger: null, jobs: [], job: null, msg: "" });
    acRender();
  } else if (what === "delete") {
    if (!window.confirm(`Delete your account? Your runs, ${AC_TOKEN.many} and AI analyses are erased from the server for good. The runs on this device stay until you delete them too.`)) return;
    try { await cloudDeleteAccount(); Object.assign(ac, { ledger: null, jobs: [], job: null, msg: "Account deleted." }); trackEvent("account-delete"); } catch (e) { ac.msg = e.message; }
    acRender();
  } else if (what === "ai") {
    acAsk.checks = null;
    acShowPanel(acAskHtml(), "Ask the AI");
    trackEvent("ai-open");
  } else if (what.startsWith("mode:")) {
    // what.slice(5) drops "mode:". Switching to "runs" with nothing ticked yet ticks the runs of
    // the current date range, so the list starts from the same selection.
    acAsk.mode = what.slice(5);
    if (acAsk.mode === "runs" && !acAsk.ids.size) aiSelect(acList, { from: acAsk.from, to: acAsk.to }).forEach((r) => acAsk.ids.add(r.id));
    acAskShow();
  } else if (what.startsWith("range:")) {
    // what.slice(6) drops "range:"; Number turns "28" into 28. "Everything" (0) starts at the
    // oldest run (or today when there is none).
    const d = Number(what.slice(6));
    acAsk.to = acToday();
    acAsk.from = d ? acAsk.to - d * 86400000 : Math.min(acAsk.to, ...acList.map((r) => r.date));
    acAskShow();
  } else if (what.startsWith("goal:") || what.startsWith("risk:")) {
    // Only the chips change: toggle the "on" class on the one whose data-acct matches.
    // [data-acct^="goal:"] in the selector means "starts with goal:".
    const [k, v] = what.split(":");
    acAsk[k] = v;
    acPanel.querySelectorAll(`[data-acct^="${k}:"]`).forEach((b) => b.classList.toggle("on", b.dataset.acct === what));
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
  } else if (what === "bests") {
    acShowPanel(acBestsHtml(historySummary(acList)), "All-time bests");
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
  } else if (what === "last" && ac.jobs[0]) {
    acShowPanel(acResultHtml(ac.jobs[0].result, ac.jobs[0].created_at));
  } else if (what.startsWith("doc:")) {
    acDocShow(what.slice(4));
  } else if (what === "docs") {
    acShowPanel(`<p class="acct-kicker">AI docs</p><h3>Every AI answer on this device</h3><section>${ac.docs.map(acDocRow).join("")}</section>`, "AI docs");
  } else if (what.startsWith("doc-use:")) {
    aiDocsGet(what.slice(8)).then((d) => {
      if (!d) return;
      document.dispatchEvent(new CustomEvent("trp-ai-use", { detail: d }));
      acAction("ai-race");
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

/**
 * The sign-in form was sent: ask for a sign-in link for the typed email, with the button greyed
 * out meanwhile (ac.busy), and show the outcome in the tokens section.
 */
async function acSignIn(form) {
  const email = form.querySelector("input").value.trim();
  if (!email) return;
  ac.busy = true;
  acRender();
  try { await cloudSendLink(email); ac.msg = `Link sent to ${email}: open it on this device to sign in.`; trackEvent("signin-link"); } catch (e) { ac.msg = `Could not send the link: ${e.message}`; }
  ac.busy = false;
  acRender();
}

/**
 * Add the icon and the menu to the page.
 * Side effects: adds the account element to <body>, listens to clicks, form submits, typing in
 * the Ask the AI window and the Escape key, and, when the page was opened from a sign-in link,
 * finishes the sign-in.
 *
 * Event delegation: instead of one listener per menu button (the menu is redrawn often, which
 * would drop them), ONE listener on the wrapper catches every click and looks up the nearest
 * element with a data-acct attribute (e.target.closest). Redrawing the menu needs no re-wiring.
 * `opts.getRace` (from main.js) tells the Ask the AI window about the race being prepared:
 * a function returning { race: { name, km, gain, legs, aid } or null, gpxRuns, targetText, centralSec }.
 */
export async function initAccount(opts = {}) {
  if (opts.getRace) acGetRace = opts.getRace;
  // Local test mode: only answers on this computer, under npm run ai-browser (ailocal.js).
  aiLocalProbe().then((x) => { acLocal = x; });
  acEl = document.createElement("div");
  acEl.className = "acct";
  // The round button (a person icon in SVG: a circle head and a curved path for the shoulders),
  // the menu (filled by acRender) and the hidden pop-up panel.
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
  // Open or close the menu. aria-expanded tells screen readers its state. Opening redraws it
  // and, when signed in (and no analysis is running), syncs with the account.
  const set = (open) => {
    acMenu.classList.toggle("open", open);
    btn.setAttribute("aria-expanded", String(open));
    if (open) { acRender(); trackEvent("account-open"); if (cloudOn() && cloudUser() && !ac.job) acSync(); }
  };
  // stopPropagation(): the click stops here, so the document listener below (which closes the
  // menu on any outside click) does not see it.
  btn.addEventListener("click", (e) => { e.stopPropagation(); set(!acMenu.classList.contains("open")); });
  // The Account window replaces the menu on screen: the menu closes when it opens.
  acEl.addEventListener("click", (e) => { const b = e.target.closest("[data-acct]"); if (!b) return; if (b.dataset.acct === "profile") set(false); acAction(b.dataset.acct); });
  // The sign-in form: preventDefault() stops the browser from submitting it as a page load.
  acEl.addEventListener("submit", (e) => { const f = e.target.closest("[data-acct-form=signin]"); if (f) { e.preventDefault(); acSignIn(f); } });
  // A click on the dimmed backdrop itself (not on the panel's content) closes the pop-up.
  acPanel.addEventListener("click", (e) => { if (e.target === acPanel) acPanel.hidden = true; });
  // The "input" event fires on every keystroke, date change or tick in the Ask the AI window.
  acPanel.addEventListener("input", (e) => {
    if (!e.target.dataset) return;
    if (e.target.dataset.ask) acAskInput(e.target);
    else if (e.target.dataset.pf && profileInput(e.target, false)) acProfile(true);
  });
  // "change" fires when a field of the Account window is left (or a list choice made): times and
  // numbers are read then, and the window redrawn when the card or the "to go" column changed.
  // The redraw waits a moment (setTimeout 0): a Tab press fires "change" before the focus moves
  // to the next field, and redrawing at once would lose where the focus is going.
  acPanel.addEventListener("change", (e) => { if (e.target.dataset && e.target.dataset.pf && profileInput(e.target, true)) setTimeout(() => acProfile(true), 0); });
  // Any click outside the account element closes the menu.
  document.addEventListener("click", (e) => { if (!acEl.contains(e.target)) set(false); });
  // Escape closes the pop-up first, then the menu (and gives the focus back to the icon).
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!acPanel.hidden) { acPanel.hidden = true; return; }
    if (acMenu.classList.contains("open")) { set(false); btn.focus(); }
  });
  acRender();
  // Back from a sign-in link: keep the session, sync, and show the menu so the user sees it worked.
  if (await cloudFromUrl()) { trackEvent("signin"); set(true); }
}
