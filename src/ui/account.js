// account.js: the account icon at the top right of the hero and its see-through menu.
//
// "Device first": the run log lives in this browser only, in IndexedDB (a small database every
// browser has, much roomier than localStorage). Nothing is sent anywhere. Each run you open in
// Check my run, or add as one of your runs in Prep my race, is summarised (src/core/history.js)
// and stored; sample and demo runs are not. The menu is re-drawn from the stored summaries.

import { parseGpx } from "../core/track.js";
import { analyseRun } from "../core/review.js";
import { runRecord, historySummary } from "../core/history.js";
import { mmss, hms } from "../core/format.js";
import { trackEvent } from "./analytics.js";

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
}
/** Same, from a GPX file (used for the runs added in Prep my race). Files that are not runs are skipped. */
export function acctSaveGpx(xml, name) {
  try { acctSaveRun(analyseRun(parseGpx(xml)), name); } catch (e) { /* a route without times, or too short: not a run */ }
}

const acDate = (ms) => new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short" });
const acNum = (x) => Math.round(x).toLocaleString("en-US");

function acMenuHtml(S) {
  if (!S.count) {
    return `<section class="acct-who"><div><b>My account</b><small>No runs stored yet</small></div></section>
    <section><p class="acct-empty">Open one of your runs in <b>Check my run</b>, or add it to <b>Your runs</b> in Prep my race: its numbers are kept here, on this device only, and your stats, records and achievements build up run after run.</p></section>`;
  }
  const B = S.bests, lastId = S.last[0].id;
  const pr = (b) => (b && b.run.id === lastId && S.count > 1 ? `<i class="acct-pr">PR</i>` : "");
  const row = (label, b, f) => (b ? `<div class="acct-row"><span>${label}</span><b>${f(b.value, b.run)}${pr(b)}</b></div>` : "");
  const gainK = S.year.gain >= 10000 ? `${(S.year.gain / 1000).toFixed(1)}k` : acNum(S.year.gain);
  const medals = [...S.achievements].sort((a, b) => b.done - a.done || b.progress - a.progress).slice(0, 6);
  return `
    <section class="acct-who"><div><b>My account</b><small>${S.count} run${S.count > 1 ? "s" : ""} stored on this device</small></div></section>
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
    <section><h4>Cairns</h4>
      <div class="acct-cairns"><b>${AC_CAIRN}${S.cairns}</b><button class="btn ghost" type="button" disabled>AI analysis · soon</button></div>
      <p class="acct-note">Earned with achievements. 1 cairn will buy 1 AI analysis of all your runs.</p>
    </section>
    <section class="acct-links"><button type="button" data-acct="export">Export my data</button><button type="button" data-acct="clear">Delete my runs</button></section>`;
}

const AC_CAIRN = `<svg viewBox="0 0 32 32" aria-hidden="true"><ellipse cx="16" cy="27" rx="12" ry="4" fill="#9fb0c9"/><ellipse cx="16" cy="20" rx="9" ry="3.6" fill="#c3cfe0"/><ellipse cx="16" cy="13.5" rx="6.5" ry="3" fill="#ffc928"/><ellipse cx="16" cy="7.5" rx="4" ry="2.4" fill="#ff3048"/></svg>`;
let acMenu = null;

async function acRender() {
  if (!acMenu) return;
  acMenu.innerHTML = acMenuHtml(historySummary(await acAll()));
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
    if (!window.confirm("Delete all the runs stored on this device? Your stats, records and achievements start again from zero.")) return;
    acCache = [];
    await acTx("readwrite", (s) => s.clear());
    trackEvent("history-clear");
    acRender();
  }
}

/** Add the icon and the menu to the page. */
export function initAccount() {
  const el = document.createElement("div");
  el.className = "acct";
  el.innerHTML = `
    <button class="acct-btn" type="button" aria-haspopup="true" aria-expanded="false" aria-label="My account">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="8.5" r="3.8"/><path d="M4.5 20c1.2-3.6 4-5.4 7.5-5.4s6.3 1.8 7.5 5.4"/></svg>
    </button>
    <div class="acct-menu" role="dialog" aria-label="My account"></div>`;
  // On the body, not inside the hero: the hero hides whatever overflows it, which would cut the menu.
  document.body.appendChild(el);
  const btn = el.querySelector(".acct-btn");
  acMenu = el.querySelector(".acct-menu");
  const set = (open) => {
    acMenu.classList.toggle("open", open);
    btn.setAttribute("aria-expanded", String(open));
    if (open) { acRender(); trackEvent("account-open"); }
  };
  btn.addEventListener("click", (e) => { e.stopPropagation(); set(!acMenu.classList.contains("open")); });
  acMenu.addEventListener("click", (e) => { const b = e.target.closest("[data-acct]"); if (b) acAction(b.dataset.acct); });
  document.addEventListener("click", (e) => { if (!el.contains(e.target)) set(false); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && acMenu.classList.contains("open")) { set(false); btn.focus(); } });
  acRender();
}
