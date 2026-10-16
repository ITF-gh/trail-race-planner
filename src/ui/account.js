// account.js: the account icon at the top right of the hero and its see-through menu.
//
// The run log lives in this browser, in IndexedDB (a small database every browser has, much
// roomier than localStorage). Each run you open in Rewind my run, or add as one of your runs in
// Prep my race, is summarised (src/core/runrecord.js) and stored; sample and demo runs are not.
// The menu is re-drawn from the stored summaries (src/core/history.js).
//
// Signed in (cloud.js, when the online account is set up), the same summaries are also kept in
// the account, so they follow you to every device, and the account holds your cairns: earned
// with achievements (checked by the server), spent on an AI analysis of all your runs.
//
// Where it sits: main.js calls initAccount() once at start-up, and calls
// acctSaveRun() / acctSaveGpx() when a run is opened. Everything else here is private.
//
// Main pieces, top to bottom:
//   acOpen, acTx, acAll     the IndexedDB helpers (open, one transaction, read all)
//   acctSaveRun/Gpx         store one run summary (and send it to the account when signed in)
//   acCairnsHtml, acMenuHtml   build the menu's HTML from historySummary()
//   acRender                redraw the menu
//   acClaim, acSync         talk to the account (cairns, two-way sync of runs)
//   acShowPanel, acResultHtml, acStartAi   the AI analysis (consent, start, polling, result)
//   acAction, acSignIn      what each menu button does
//   initAccount             build the icon and menu, wire the clicks and the keyboard
//
// IndexedDB's API is old-style: requests report back through onsuccess / onerror callbacks. The
// helpers below wrap those in Promises so the rest can use async / await, and they never reject:
// a failure resolves with null, and the app keeps working from its in-memory copy.

import { parseGpx } from "../core/track.js";
import { analyseRun } from "../core/review.js";
import { historySummary } from "../core/history.js";
import { runRecord } from "../core/runrecord.js";
import { demoRecords, DEMO_USER } from "../core/demorecords.js";
import { mmss, hms } from "../core/format.js";
import { trackEvent } from "./analytics.js";
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
/** All stored run summaries, read from the database once and then served from acCache. */
async function acAll() {
  if (!acCache) acCache = (await acTx("readonly", (s) => s.getAll())) || [];
  return acCache;
}

/**
 * Store the summary of an analysed run (same run twice = one copy).
 * `run` is the analysis from core/review.js, `name` the name to show. Steps: 1. summarise it
 * (runRecord; a run that cannot be summarised is skipped), 2. replace any copy with the same id
 * in the cache and the database, 3. redraw the menu, 4. when signed in, send it to the account
 * and claim any cairn it earned (offline: it goes with the next sync).
 */
export async function acctSaveRun(run, name) {
  let rec;
  try { rec = runRecord(run, name); } catch (e) { return; }
  const list = await acAll();
  const isNew = !list.some((r) => r.id === rec.id);
  acCache = list.filter((r) => r.id !== rec.id).concat(rec);
  // put() adds the record, or replaces the one with the same id.
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
// The cairn icon: four stacked stones drawn as SVG ellipses (centre cx, cy; radii rx, ry).
const AC_CAIRN = `<svg viewBox="0 0 32 32" aria-hidden="true"><ellipse cx="16" cy="27" rx="12" ry="4" fill="#9fb0c9"/><ellipse cx="16" cy="20" rx="9" ry="3.6" fill="#c3cfe0"/><ellipse cx="16" cy="13.5" rx="6.5" ry="3" fill="#ffc928"/><ellipse cx="16" cy="7.5" rx="4" ry="2.4" fill="#ff3048"/></svg>`;

// What the account side knows (filled by acSync): the cairn ledger, the analysis running, a message.
//   ledger  [{ delta, reason, created_at }] from the server, null before the first read
//   jobs    past AI analyses, newest first
//   job     id of the analysis running now, null when none
//   msg     a message to show in the Cairns section ("" = none)
//   busy    true while a sign-in link is being sent (greys out the button)
const ac = { ledger: null, jobs: [], job: null, msg: "", busy: false };
// Cairn balance = the sum of all ledger lines (+ earned, - spent).
const acBalance = () => (ac.ledger ? ac.ledger.reduce((s, r) => s + r.delta, 0) : 0);

/**
 * HTML of the Cairns section of the menu, in one of three states:
 * account not open yet (count only, button disabled), signed out (sign-in form), signed in
 * (balance and the AI analysis button). `S` is the summary from historySummary().
 * An analysis needs 1 cairn, at least 3 runs and no analysis already running.
 */
function acCairnsHtml(S) {
  if (!cloudOn()) {
    return `<section><h4>Cairns</h4>
      <div class="acct-cairns"><b>${AC_CAIRN}${S.cairns}</b><button class="btn ghost" type="button" disabled>AI analysis · soon</button></div>
      <p class="acct-note">Earned with achievements. 1 cairn will buy 1 AI analysis of all your runs.</p>
    </section>`;
  }
  if (!cloudUser()) {
    return `<section><h4>Cairns</h4>
      <div class="acct-cairns"><b>${AC_CAIRN}${S.cairns}</b><span class="acct-note">to collect</span></div>
      <form class="acct-signin" data-acct-form="signin">
        <label for="acEmail">Sign in to collect them and spend them on an AI analysis</label>
        <div><input id="acEmail" type="email" required autocomplete="email" placeholder="you@example.com"><button class="btn ghost" type="submit"${ac.busy ? " disabled" : ""}>Send link</button></div>
      </form>
      <p class="acct-note">${ac.msg ? acEsc(ac.msg) : "No password: we email you a one-time link. Your runs then follow you on every device."}</p>
    </section>`;
  }
  const bal = acBalance();
  const can = bal >= 1 && S.count >= 3 && !ac.job;
  const label = ac.job ? "Analysing…" : `AI analysis · 1 cairn`;
  // The note under the button explains, in order of priority: a message, an analysis running,
  // too few runs, no cairn, or what an analysis gives. The data-acct attributes name the action
  // a click runs (see acAction).
  return `<section><h4>Cairns</h4>
      <div class="acct-cairns"><b>${AC_CAIRN}${ac.ledger ? bal : "…"}</b><button class="btn ${can ? "primary" : "ghost"}" type="button" data-acct="ai"${can ? "" : " disabled"}>${label}</button></div>
      <p class="acct-note">${ac.msg ? acEsc(ac.msg) : ac.job ? "Claude is reading all your runs. It takes about a minute; you can close this menu." : S.count < 3 ? "An analysis needs at least 3 runs in your log." : bal < 1 ? "Earn cairns with achievements and events." : "1 cairn = 1 AI analysis of all your runs: new KPIs, trends, what to work on."}</p>
      ${ac.jobs.length ? `<button class="acct-linkbtn" type="button" data-acct="last">See my last analysis (${acDate(Date.parse(ac.jobs[0].created_at))})</button>` : ""}
    </section>`;
}

/**
 * HTML of the whole menu from `S`, the summary of the stored runs (historySummary in
 * core/history.js): count, bests, last runs, 12-month totals, achievements, cairns.
 * `demo` = true shows the made-up profile (no runs of your own yet).
 * Sections: who (name and where the runs are), then either an empty-log note, or the 12-month
 * totals, all-time bests, last runs and achievements; then cairns and the action links.
 */
function acMenuHtml(S, demo = false) {
  const user = cloudOn() && cloudUser();
  const where = demo ? `Demo profile · ${S.count} sample runs. Open one of your runs to start your own log.` : user ? `${acEsc(user.email)} · ${S.count} run${S.count === 1 ? "" : "s"} synced` : `${S.count || "No"} run${S.count === 1 ? "" : "s"} stored on this device`;
  const who = `<section class="acct-who"><div><b>${demo ? DEMO_USER : "My account"}</b><small>${where}</small></div></section>`;
  const links = `<section class="acct-links">${S.count && !demo ? `<button type="button" data-acct="export">Export my data</button><button type="button" data-acct="clear">Delete my runs</button>` : ""}${user ? `<button type="button" data-acct="signout">Sign out</button><button type="button" data-acct="delete">Delete my account</button>` : ""}</section>`;
  if (!S.count) {
    return `${who}
    <section><p class="acct-empty">Open one of your runs in <b>Rewind my run</b>, or add it to <b>Your runs</b> in Prep my race: its numbers are kept here${user ? "" : ", on this device only"}, and your stats, records and achievements build up run after run.</p></section>
    ${cloudOn() ? acCairnsHtml(S) : ""}${links}`;
  }
  const B = S.bests, lastId = S.last[0].id;
  // A "PR" badge on a best set by the latest run (not shown when there is only one run).
  const pr = (b) => (b && b.run.id === lastId && S.count > 1 ? `<i class="acct-pr">PR</i>` : "");
  // One line of the bests table; f formats the value (b = { value, run }, or missing).
  const row = (label, b, f) => (b ? `<div class="acct-row"><span>${label}</span><b>${f(b.value, b.run)}${pr(b)}</b></div>` : "");
  // Big climbing totals in thousands: 12345 m -> "12.3k".
  const gainK = S.year.gain >= 10000 ? `${(S.year.gain / 1000).toFixed(1)}k` : acNum(S.year.gain);
  // Six achievements: those reached first, then the closest to being reached. The sort compares
  // `done` (true counts as 1, false as 0), then `progress` (0 to 1) when `done` is equal. [...x]
  // copies the array first, so the summary's own list is not reordered.
  const medals = [...S.achievements].sort((a, b) => b.done - a.done || b.progress - a.progress).slice(0, 6);
  return `${who}
    <section><h4>Last 12 months</h4>
      <div class="acct-kpis"><div><b>${acNum(S.year.km)}</b><small>km</small></div><div><b>${gainK}</b><small>m D+</small></div><div><b>${acNum(S.year.movingSec / 3600)} h</b><small>moving</small></div></div>
    </section>
    <section><h4>All-time bests</h4>
      ${row("Fastest 1 km", B.best1k, (v) => mmss(v))}
      ${row("Fastest 5 km", B.best5k, (v) => mmss(v))}
      ${row("Fastest 10 km", B.best10k, (v) => (v < 3600 ? mmss(v) : hms(v)))}
      ${row("Best climbing speed", B.vam, (v) => `${acNum(v)} m/h`)}
      ${row("Longest run", B.longest, (v, r) => `${v.toFixed(1)} km · ${acNum(r.gain)} m`)}
    </section>
    <section><h4>Last runs</h4>
      ${S.last.map((r) => `<div class="acct-row"><span>${acDate(r.date)} · ${acEsc(r.name)}</span><b>${r.km.toFixed(1)} km · ${acNum(r.gain)} m</b></div>`).join("")}
    </section>
    <section><h4>Achievements · ${S.unlocked} / ${S.achievements.length}</h4>
      <div class="acct-medals">${medals.map((a) => `<span class="${a.done ? "" : "lock"}" title="${acEsc(a.hint)}${a.cairns ? ` · +${a.cairns} cairn${a.cairns > 1 ? "s" : ""}` : ""}">${a.icon} ${acEsc(a.label)}${a.done ? "" : ` ${Math.floor(a.progress * 100)}%`}</span>`).join("")}</div>
    </section>
    ${acCairnsHtml(S)}
    ${links}`;
}

// The page elements, set by initAccount: the wrapper, the drop-down menu, the AI panel.
let acEl = null, acMenu = null, acPanel = null;

/** Redraw the menu from the stored runs (or from the demo runs when there are none). */
async function acRender() {
  if (!acMenu) return;
  const mine = await acAll();
  // No run of your own yet (and not signed in): show the demo profile User1 and its made-up runs,
  // so the menu is never empty. Your first saved run replaces it.
  const demo = !mine.length && !(cloudOn() && cloudUser());
  acMenu.innerHTML = acMenuHtml(historySummary(demo ? demoRecords() : mine), demo);
}

/**
 * Ask the server for the cairns of the achievements reached, then read the ledger.
 * The server checks the achievements itself (the browser cannot be trusted to grant cairns);
 * a failed claim is ignored and the ledger is read anyway.
 */
async function acClaim() {
  await cloudClaim().catch(() => null);
  ac.ledger = await cloudLedger();
}

/**
 * Signed in: send the runs the account does not have, fetch the ones this device lacks, then cairns.
 * Runs are matched by id (a Set gives a fast "do we have this id?" test). Runs are only added,
 * never removed, so the result on both sides is the union of the two lists.
 * Any failure leaves the local runs untouched and shows a short message.
 */
async function acSync() {
  if (!cloudOn() || !cloudUser()) return;
  try {
    const [local, remote] = [await acAll(), await cloudRuns()];
    // 1. Upload: local runs whose id the account does not have.
    const have = new Set(remote.map((r) => r.id));
    await cloudPutRuns(local.filter((r) => !have.has(r.id)));
    // 2. Download: account runs this device does not have, stored in the cache and the database.
    const mine = new Set(local.map((r) => r.id));
    const fresh = remote.filter((r) => r && r.id && !mine.has(r.id));
    if (fresh.length) {
      acCache = local.concat(fresh);
      await acTx("readwrite", (s) => { fresh.forEach((r) => s.put(r)); return null; });
    }
    // 3. Cairns and past analyses.
    await acClaim();
    ac.jobs = await cloudJobs();
    ac.msg = "";
  } catch (e) {
    ac.msg = e.message === "Session expired, please sign in again" ? e.message : "Could not reach your account. Your runs are safe on this device.";
  }
  acRender();
}

/**
 * The see-through panel for the AI analysis: the consent before, the answer after.
 * `html` is the panel's content; a close button is added, and gets the keyboard focus so the
 * Escape and Enter keys work at once.
 */
function acShowPanel(html) {
  acPanel.innerHTML = `<div class="acct-panel-in" role="dialog" aria-modal="true" aria-label="AI analysis"><button class="acct-x" type="button" data-acct="close" aria-label="Close">×</button>${html}</div>`;
  acPanel.hidden = false;
  const x = acPanel.querySelector(".acct-x");
  if (x) x.focus();
}
/**
 * HTML of an AI analysis result `r` (from the server): headline, summary, new KPIs (each with
 * name, value, unit, meaning and how it is computed), strengths, things to work on and a plan
 * for the next weeks. `when` is its creation date (ISO text). Every text is escaped: it comes
 * from the AI, not from this code.
 */
function acResultHtml(r, when) {
  const list = (a) => (a && a.length ? `<ul>${a.map((x) => `<li>${acEsc(x)}</li>`).join("")}</ul>` : "");
  return `<p class="acct-kicker">AI analysis${when ? ` · ${acDate(Date.parse(when))}` : ""}</p>
    <h3>${acEsc(r.headline || "")}</h3>
    <p>${acEsc(r.summary || "")}</p>
    ${r.kpis && r.kpis.length ? `<h4>New KPIs</h4><div class="acct-ai-kpis">${r.kpis.map((k) => `<div><span>${acEsc(k.name)}</span><b>${acEsc(k.value)} <small>${acEsc(k.unit)}</small></b><p>${acEsc(k.meaning)}</p><p class="how">${acEsc(k.how)}</p></div>`).join("")}</div>` : ""}
    <div class="acct-ai-cols"><div><h4>Strengths</h4>${list(r.strengths)}</div><div><h4>To work on</h4>${list(r.focus)}</div></div>
    ${r.next_weeks ? `<h4>Next weeks</h4><p>${acEsc(r.next_weeks)}</p>` : ""}`;
}
/**
 * The athlete settings saved by ui/insights.js under "trp.athlete" in localStorage: max and resting
 * heart rate and weight, each null when not set. Sent with an AI analysis request.
 */
function acAthlete() {
  try { const a = JSON.parse(localStorage.getItem("trp.athlete") || "{}") || {}; return { hrMax: a.hrMax || null, hrRest: a.hrRest || null, weight: a.weight || null }; } catch (e) { return {}; }
}

/**
 * Start an AI analysis (after the consent panel) and wait for its result.
 * The server answers at once with a job id and works in the background; this function then
 * "polls": it asks for the job's status every 4 s until it is done or failed, or 6 minutes have
 * passed (90 tries x 4 s). Done: the result opens in the panel. Failed: the server gives the
 * cairn back, and the ledger is read again to show it.
 */
async function acStartAi() {
  acPanel.hidden = true;
  ac.msg = "";
  try {
    const r = await cloudAnalyse(acAthlete());
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
      ac.msg = "The analysis failed; your cairn was given back.";
      ac.ledger = await cloudLedger().catch(() => ac.ledger);
    }
  }
  if (ac.job) { ac.job = null; ac.msg = "Still running: open this menu again in a minute to see it."; }
  acRender();
}

/**
 * Run the action named `what` (the data-acct attribute of the button clicked):
 *   export   download all stored run summaries as a JSON file
 *   clear    delete all runs (after a confirm), here and in the account
 *   signout  sign out and forget the account data in memory
 *   delete   delete the online account (after a confirm)
 *   ai       open the consent panel for an AI analysis; go = confirm it; last = show the last
 *            result; close = hide the panel
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
    // window.confirm shows the browser's OK / Cancel box and returns true on OK.
    if (!window.confirm(`Delete all the runs stored ${user ? "on this device and in your account" : "on this device"}? Your stats, records and achievements start again from zero.${user ? " Cairns you already have stay yours." : ""}`)) return;
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
    if (!window.confirm("Delete your account? Your runs, cairns and AI analyses are erased from the server for good. The runs on this device stay until you delete them too.")) return;
    try { await cloudDeleteAccount(); Object.assign(ac, { ledger: null, jobs: [], job: null, msg: "Account deleted." }); trackEvent("account-delete"); } catch (e) { ac.msg = e.message; }
    acRender();
  } else if (what === "ai") {
    // The consent panel says exactly what is sent (up to 300 most recent runs) before any cairn
    // is spent; "Spend 1 cairn" (data-acct="go") starts it.
    const S = historySummary(await acAll());
    const a = acAthlete();
    acShowPanel(`<p class="acct-kicker">AI analysis · 1 cairn</p>
      <h3>Claude reads your whole log</h3>
      <p>What is sent: the numbers of your ${Math.min(S.count, 300)} most recent runs (date, distance, climbing, moving and total time, grade-adjusted pace, average heart rate, fade, heart drift, climbing speed, fastest 1, 5 and 10 km)${a.hrMax || a.weight ? " and your athlete settings" : ""}. <b>Not sent:</b> run names, GPS tracks, your email.</p>
      <p>It takes about a minute. If it fails, your cairn comes back.</p>
      <div class="acct-actions"><button class="btn primary" type="button" data-acct="go">Spend 1 cairn</button><button class="btn ghost" type="button" data-acct="close">Cancel</button></div>`);
  } else if (what === "go") {
    acStartAi();
  } else if (what === "last" && ac.jobs[0]) {
    acShowPanel(acResultHtml(ac.jobs[0].result, ac.jobs[0].created_at));
  } else if (what === "close") {
    acPanel.hidden = true;
  }
}

/**
 * The sign-in form was sent: ask for a sign-in link for the typed email, with the button greyed
 * out meanwhile (ac.busy), and show the outcome in the Cairns section.
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
 * Side effects: adds the account element to <body>, listens to clicks, form submits and the
 * Escape key, and, when the page was opened from a sign-in link, finishes the sign-in.
 *
 * Event delegation: instead of one listener per menu button (the menu is redrawn often, which
 * would drop them), ONE listener on the wrapper catches every click and looks up the nearest
 * element with a data-acct attribute (e.target.closest). Redrawing the menu needs no re-wiring.
 */
export async function initAccount() {
  acEl = document.createElement("div");
  acEl.className = "acct";
  // The round button (a person icon in SVG: a circle head and a curved path for the shoulders),
  // the menu (filled by acRender) and the hidden AI panel.
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
  acEl.addEventListener("click", (e) => { const b = e.target.closest("[data-acct]"); if (b) acAction(b.dataset.acct); });
  // The sign-in form: preventDefault() stops the browser from submitting it as a page load.
  acEl.addEventListener("submit", (e) => { const f = e.target.closest("[data-acct-form=signin]"); if (f) { e.preventDefault(); acSignIn(f); } });
  // A click on the dimmed backdrop itself (not on the panel's content) closes the AI panel.
  acPanel.addEventListener("click", (e) => { if (e.target === acPanel) acPanel.hidden = true; });
  document.addEventListener("click", (e) => { if (!acEl.contains(e.target)) set(false); });
  // Escape closes the AI panel first, then the menu (and gives the focus back to the icon).
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!acPanel.hidden) { acPanel.hidden = true; return; }
    if (acMenu.classList.contains("open")) { set(false); btn.focus(); }
  });
  acRender();
  // Back from a sign-in link: keep the session, sync, and show the menu so the user sees it worked.
  if (await cloudFromUrl()) { trackEvent("signin"); set(true); }
}
