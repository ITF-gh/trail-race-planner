// acparts.js: the account menu's building blocks that hold no state of their own: run-log and file lists, dates and numbers, the edelweiss and AI pictures, saved items, data and AI-doc rows.

import { mmss, hm } from "../core/format.js";
import { SAVED_KINDS } from "../core/saved.js";
import { cloudOn, cloudUser } from "./cloud.js";

// Escape text for HTML: each of & < > " (the regex's character set) becomes its entity.
export const acEsc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
// The all-time bests a new run can beat, with the short name the page shows ("new 5 km best").
export const AC_BEST_NAMES = [["best1k", "1 km"], ["best5k", "5 km"], ["best10k", "10 km"], ["vam", "climbing speed"], ["longest", "longest run"]];
// Where a file can go (owner's rule: three buttons, one per mode): [button text, what it does].
const AC_USE = {
  race: ["▲ Prep my race", "Open it as the race course in Prep my race"],
  prep: ["◆ Prep my run", "Open it as the route of a session in Prep my run"],
  rewind: ["▶ Rewind my run", "Replay it in Rewind my run"],
};
const AC_USES = { run: ["race", "prep", "rewind"], route: ["race", "prep"] };
// Which kinds the files list shows ("all", "run" or "route") and whether it shows them all.
export const acFileView = { kind: "all", more: false };
export function acFilesHtml(files) {
  const runs = files.filter((f) => f.kind === "run").length;
  const tabs = [["all", `All ${files.length}`], ["run", `Runs ${runs}`], ["route", `Routes ${files.length - runs}`]];
  const list = files.filter((f) => acFileView.kind === "all" || f.kind === acFileView.kind);
  const shown = acFileView.more ? list : list.slice(0, 5);
  const rows = shown.map((f) => `<li class="acct-file">
      <div class="acct-file-top"><span class="acct-tag ${f.kind}">${f.kind === "run" ? "Run" : "Route"}</span><b>${acEsc(f.name)}</b><button type="button" class="acct-file-del" data-acct="file-del:${f.id}" aria-label="Remove ${acEsc(f.name)}" title="Remove from my files">×</button></div>
      <small>${f.date ? `${acDate(f.date)} · ` : ""}${f.km.toFixed(1)} km · ${acNum(f.gain)} m D+</small>
      <div class="acct-use">${AC_USES[f.kind].map((u) => `<button type="button" data-acct="use:${u}:${f.id}" title="${AC_USE[u][1]}">${AC_USE[u][0]}</button>`).join("")}</div>
    </li>`).join("");
  return `<section class="acct-files"><h4 data-pf-sec="files">My files</h4>
    <p class="acct-legend"><span class="acct-tag run">Run</span> GPS + time, pace, cadence <span class="acct-tag route">Route</span> GPS only</p>
    ${files.length ? `<div class="acct-ftabs" role="group" aria-label="Show">${tabs.map(([k, t]) => `<button type="button" data-acct="files:${k}" aria-pressed="${acFileView.kind === k}">${t}</button>`).join("")}</div>
    <ul class="acct-filelist">${rows}</ul>
    ${list.length > 5 ? `<button class="acct-linkbtn" type="button" data-acct="files-more">${acFileView.more ? "Show fewer" : `Show all ${list.length}`}</button>` : ""}
    <p class="acct-note">Kept on this device only, without heart rate. A run can also be used as a route.</p>`
    : `<p class="acct-empty">The GPX files you give the app (race, your runs, a run to rewind) appear here, ready to use again in any mode. Kept on this device only.</p>`}
  </section>`;
}

// Small formatters: a date as "12 Mar" in the reader's language (undefined = the browser's locale), and a whole number with thousands separators ("12,345").
export const acDate = (ms) => new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short" });
export const acNum = (x) => Math.round(x).toLocaleString("en-US");
// The AI token: earned with achievements and events, 1 token = 1 AI analysis.
export const AC_TOKEN = { one: "edelweiss", many: "edelweiss" }; // the same word in the singular and the plural
// "3 edelweiss": a count with the right word (AC_TOKEN keeps the door open for a word whose
// plural differs). Unused while earning edelweiss with achievements is closed.
const acTok = (n) => `${n} ${n === 1 ? AC_TOKEN.one : AC_TOKEN.many}`;
// The token logo: a shiny edelweiss. The AI waiting picture (Boss, 2026-10-23): a trail runner in trail clothes (cap, tech shirt, vest with a flask, shorts, calf socks, trail shoes) jogging slowly, Z2 easy, up a trail that narrows to the horizon; he shrinks with the distance while nature pops up beside the trail (pines, a rock, edelweiss, a bird).
export const AC_WAIT = `<svg class="ai-wait" viewBox="0 0 320 124" role="img" aria-label="A trail runner running away to the horizon while the AI works"><path class="aiw-hills" d="M0 54 L30 36 L60 46 L100 18 L140 44 L180 30 L215 48 L262 20 L300 40 L320 34 L320 54Z"/><line class="aiw-horizon" x1="0" y1="54" x2="320" y2="54"/><path class="aiw-trail" d="M4 124 C120 116 110 80 206 66 C250 57 262 52 262 52 L262 52 C262 52 254 57 216 68 C150 80 200 114 96 124Z"/><path class="aiw-ground" d="M50 118 C160.0 115.0 130.0 80.0 211.0 67.0 C252.0 57.0 262.0 52.0 262.0 52.0"/><g transform="translate(22 112) scale(1.15)"><g class="aiw-i n0"><rect class="trunk" x="-1.5" y="-6" width="3" height="6"/><path class="pine" d="M0 -30 L9 -14 L5 -14 L11 -5 L-11 -5 L-5 -14 L-9 -14Z"/></g></g><g transform="translate(222 118) scale(1)"><g class="aiw-i n1"><ellipse class="petal" cx="0" cy="-14" rx="2.2" ry="5" transform="rotate(0 0 -10)"/><ellipse class="petal" cx="0" cy="-14" rx="2.2" ry="5" transform="rotate(60 0 -10)"/><ellipse class="petal" cx="0" cy="-14" rx="2.2" ry="5" transform="rotate(120 0 -10)"/><ellipse class="petal" cx="0" cy="-14" rx="2.2" ry="5" transform="rotate(180 0 -10)"/><ellipse class="petal" cx="0" cy="-14" rx="2.2" ry="5" transform="rotate(240 0 -10)"/><ellipse class="petal" cx="0" cy="-14" rx="2.2" ry="5" transform="rotate(300 0 -10)"/><circle class="heart" cx="0" cy="-10" r="2.2"/><line x1="0" y1="-6" x2="0" y2="0" stroke="#3fb27f" stroke-width="1.4"/></g></g><g transform="translate(170 88) scale(0.8)"><g class="aiw-i n2"><path class="rock" d="M-10 0 L-6 -9 L1 -12 L8 -7 L11 0Z"/></g></g><g transform="translate(120 74) scale(0.6)"><g class="aiw-i n3"><path class="pine" d="M-6 -22 L1 -9 L-2 -9 L3 -1 L-15 -1 L-10 -9 L-13 -9Z"/><path class="pine" d="M6 -32 L14 -17 L10 -17 L16 0 L-4 0 L2 -17 L-2 -17Z"/></g></g><g transform="translate(200 26) scale(0.8)"><g class="aiw-i n4"><path class="bird" d="M-8 0 q4 -5 8 0 q4 -5 8 0"/></g></g><g transform="translate(232 66) scale(0.5)"><g class="aiw-i n5"><ellipse class="petal" cx="0" cy="-14" rx="2.2" ry="5" transform="rotate(0 0 -10)"/><ellipse class="petal" cx="0" cy="-14" rx="2.2" ry="5" transform="rotate(60 0 -10)"/><ellipse class="petal" cx="0" cy="-14" rx="2.2" ry="5" transform="rotate(120 0 -10)"/><ellipse class="petal" cx="0" cy="-14" rx="2.2" ry="5" transform="rotate(180 0 -10)"/><ellipse class="petal" cx="0" cy="-14" rx="2.2" ry="5" transform="rotate(240 0 -10)"/><ellipse class="petal" cx="0" cy="-14" rx="2.2" ry="5" transform="rotate(300 0 -10)"/><circle class="heart" cx="0" cy="-10" r="2.2"/><line x1="0" y1="-6" x2="0" y2="0" stroke="#3fb27f" stroke-width="1.4"/></g></g><g transform="translate(250 58) scale(0.42)"><g class="aiw-i n6"><rect class="trunk" x="-1.5" y="-6" width="3" height="6"/><path class="pine" d="M0 -30 L9 -14 L5 -14 L11 -5 L-11 -5 L-5 -14 L-9 -14Z"/></g></g><g class="aiw-runner"><animateMotion dur="14s" repeatCount="indefinite" path="M50 118 C160.0 115.0 130.0 80.0 211.0 67.0 C252.0 57.0 262.0 52.0 262.0 52.0" keyPoints="0;1;1" keyTimes="0;0.9;1" calcMode="linear"/><animate attributeName="opacity" values="0;1;1;0;0" keyTimes="0;0.04;0.86;0.92;1" dur="14s" repeatCount="indefinite"/><g><animateTransform attributeName="transform" type="scale" values="0.95;0.18;0.18" keyTimes="0;0.9;1" dur="14s" repeatCount="indefinite"/><g transform="translate(-8 -28)"><g class="aiw-body"><g class="aiw-leg back"><animateTransform attributeName="transform" type="rotate" values="-28;22;-28" keyTimes="0;0.5;1" dur="0.84s" begin="-0.42s" repeatCount="indefinite" calcMode="spline" keySplines="0.45 0 0.55 1;0.45 0 0.55 1"/><line class="sk" x1="0" y1="0" x2="0" y2="13"/><line class="sh" x1="0" y1="-1" x2="0" y2="5.5"/><g transform="translate(0 13)"><g><animateTransform attributeName="transform" type="rotate" values="8;20;78;8" keyTimes="0;0.45;0.72;1" dur="0.84s" begin="-0.42s" repeatCount="indefinite" calcMode="spline" keySplines="0.45 0 0.55 1;0.45 0 0.55 1;0.45 0 0.55 1"/><line class="sk" x1="0" y1="0" x2="0" y2="6"/><line class="so" x1="0" y1="5.5" x2="0" y2="12.5"/><path class="shoe" d="M-2.6 12.2 h5.2 q2.6 0 3 2.2 h-8.6Z"/><path class="sole" d="M-2.8 14.9 h8.8"/></g></g></g><g class="aiw-arm back" transform="translate(5 -18)"><g><animateTransform attributeName="transform" type="rotate" values="26;-30;26" keyTimes="0;0.5;1" dur="0.84s" begin="0s" repeatCount="indefinite" calcMode="spline" keySplines="0.45 0 0.55 1;0.45 0 0.55 1"/><line class="sk" x1="0" y1="0" x2="0" y2="8.5"/><line class="sl" x1="0" y1="-0.5" x2="0" y2="3.6"/><g transform="translate(0 8.5)"><g><animateTransform attributeName="transform" type="rotate" values="-80;-100;-80" keyTimes="0;0.5;1" dur="0.84s" begin="0s" repeatCount="indefinite" calcMode="spline" keySplines="0.45 0 0.55 1;0.45 0 0.55 1"/><line class="sk" x1="0" y1="0" x2="0" y2="7"/></g></g></g></g><path class="shirt" d="M-3.2 -1 L1.6 -21.5 L8.2 -19.6 L4.2 0.6Z"/><path class="vest" d="M-4.6 -6 L-0.8 -21.4 L2.8 -20.6 L0.8 -5Z"/><path class="vest" d="M3.4 -18.6 L6.8 -17.8 L5.6 -10.4 L3 -11Z"/><rect class="flask" x="4.1" y="-17.4" width="2.3" height="5.4" rx="1.1" transform="rotate(14 5.2 -14.7)"/><path class="shorts" d="M-3.6 -1.6 L4.4 0 L5.4 6 L-3.4 6Z"/><circle class="head" cx="8.4" cy="-25" r="4.6"/><path class="cap" d="M3.8 -26.6 a4.7 4.7 0 0 1 9.2 -0.6 l3.8 0.9"/><g class="aiw-leg front"><animateTransform attributeName="transform" type="rotate" values="-28;22;-28" keyTimes="0;0.5;1" dur="0.84s" begin="0s" repeatCount="indefinite" calcMode="spline" keySplines="0.45 0 0.55 1;0.45 0 0.55 1"/><line class="sk" x1="0" y1="0" x2="0" y2="13"/><line class="sh" x1="0" y1="-1" x2="0" y2="5.5"/><g transform="translate(0 13)"><g><animateTransform attributeName="transform" type="rotate" values="8;20;78;8" keyTimes="0;0.45;0.72;1" dur="0.84s" begin="0s" repeatCount="indefinite" calcMode="spline" keySplines="0.45 0 0.55 1;0.45 0 0.55 1;0.45 0 0.55 1"/><line class="sk" x1="0" y1="0" x2="0" y2="6"/><line class="so" x1="0" y1="5.5" x2="0" y2="12.5"/><path class="shoe" d="M-2.6 12.2 h5.2 q2.6 0 3 2.2 h-8.6Z"/><path class="sole" d="M-2.8 14.9 h8.8"/></g></g></g><g class="aiw-arm front" transform="translate(5 -18)"><g><animateTransform attributeName="transform" type="rotate" values="26;-30;26" keyTimes="0;0.5;1" dur="0.84s" begin="-0.42s" repeatCount="indefinite" calcMode="spline" keySplines="0.45 0 0.55 1;0.45 0 0.55 1"/><line class="sk" x1="0" y1="0" x2="0" y2="8.5"/><line class="sl" x1="0" y1="-0.5" x2="0" y2="3.6"/><g transform="translate(0 8.5)"><g><animateTransform attributeName="transform" type="rotate" values="-80;-100;-80" keyTimes="0;0.5;1" dur="0.84s" begin="-0.42s" repeatCount="indefinite" calcMode="spline" keySplines="0.45 0 0.55 1;0.45 0 0.55 1"/><line class="sk" x1="0" y1="0" x2="0" y2="7"/></g></g></g></g></g></g></g></g></svg>`;
export const AC_SPARK = (() => {
  // One petal as an SVG path, pointing straight up from the centre (16, 16) of the 32 x 32 box.
  const petal = (len, w) => `M16 16C${16 - w} ${16 - len * 0.45} ${16 - w * 0.6} ${16 - len * 0.85} 16 ${16 - len}C${16 + w * 0.6} ${16 - len * 0.85} ${16 + w} ${16 - len * 0.45} 16 16Z`;
  // Eight petals, one every 45 degrees, long (13.5) and short (10) in turn (i % 2 is 1 for odd i).
  const ring = [0, 45, 90, 135, 180, 225, 270, 315].map((deg, i) => {
    const d = petal(i % 2 ? 10 : 13.5, i % 2 ? 2.6 : 3.2);
    return `<path d="${d}" transform="rotate(${deg + 22.5} 16 16)" fill="#f4f7fb" stroke="#b9c6d8" stroke-width=".6"/><path d="${d}" transform="rotate(${deg + 22.5} 16 16) translate(16 16) scale(.45) translate(-16 -16)" fill="#ffffff"/>`;
  }).join("");
  // The yellow heart: six small circles [x, y, radius], the destructuring ([x, y, r]) names the three numbers of each.
  const heart = [[16, 16, 2.1], [13.6, 15, 1.4], [18.4, 15, 1.4], [14.4, 18, 1.4], [17.6, 18, 1.4], [16, 13.3, 1.3]].map(([x, y, r]) => `<circle cx="${x}" cy="${y}" r="${r}" fill="#ffc928" stroke="#d99a00" stroke-width=".4"/>`).join("");
  // The glint: a small four-pointed star at the top right.
  const glint = `<path d="M26.5 2.5c.3 2 1.2 2.9 3.2 3.2-2 .3-2.9 1.2-3.2 3.2-.3-2-1.2-2.9-3.2-3.2 2-.3 2.9-1.2 3.2-3.2z" fill="#fff1b8"/>`;
  return `<svg viewBox="0 0 32 32" aria-hidden="true">${ring}${heart}${glint}</svg>`;
})();

// What the account side knows (filled by acSync): the token ledger, the analysis running, a message. ledger [{ delta, reason, created_at }] from the server...
export const ac = { ledger: null, job: null, msg: "", busy: false, docs: [], saved: null, signup: false, recovery: false, dataMsg: "" };
// Token balance = the sum of all ledger lines (+ earned, - spent). Nothing is read yet: 0.
export const acBalance = () => (ac.ledger ? ac.ledger.reduce((s, r) => s + r.delta, 0) : 0);
/** The caption under the achievement icons. */
export function acMedalCap(a) {
  if (!a) return "Tap an icon to see what it is.";
  return a.done
    ? `<b>✓ ${acEsc(a.label)}</b> · ${acEsc(a.hint)}`
    : `<b>${acEsc(a.label)}</b> · ${acEsc(a.hint)} · <span>${Math.floor(a.progress * 100)}% done</span>`;
}
// A date in ms as "2026-10-16", the format an <input type="date"> reads and shows.
export const acDay = (ms) => new Date(ms).toISOString().slice(0, 10);
// Today at midnight UTC, in ms (Date.UTC builds the moment from year, month, day).
export const acToday = () => { const d = new Date(); return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()); };

// A saved item's date, short ("18 Oct 2026").
const acSavedDate = (iso) => new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
// Seconds as "h:mm" (or "mm:ss" under an hour, for best efforts); "–" when missing.
const acDur = (sec) => (Number.isFinite(sec) ? (sec < 3600 ? mmss(sec) : hm(sec)) : "–");

/** The "Saved" part of the Account window: the items kept online, newest first (signed in only). */
export function acSavedHtml() {
  if (!cloudOn() || !cloudUser()) return "";
  const list = ac.saved || [];
  const rows = list.map((it) => {
    const d = (it.data && it.data.summary) || {};
    const facts = it.kind === "run" ? `${d.km} km · +${Math.round(d.gain)} m · ${acDur(d.movingSec)}` : `${d.km} km · +${Math.round(d.gain)} m · ${acDur(d.finish && d.finish.central)}`;
    return `<li><button type="button" class="acct-saved-open" data-acct="saved:${it.id}" title="${it.data && it.data.a4 ? "Reopen it and print the A4" : "Reopen it, ready to change"}"><b>${acEsc(it.title)}</b><small>${SAVED_KINDS[it.kind]} · ${acSavedDate(it.created_at)} · ${facts}</small></button><button type="button" class="acct-saved-del" data-acct="saved-del:${it.id}" aria-label="Delete ${acEsc(it.title)}">×</button></li>`;
  }).join("");
  return `<h4 data-pf-sec="saved">Saved to my account</h4>
    ${list.length ? `<ul class="acct-saved">${rows}</ul>` : `<p class="acct-note">Nothing saved yet. Use "Save to my account" in Your plan, Prep my run or Rewind my run, or "Save A4 to my account" in an Export A4 box.</p>`}
    ${list.length ? `<p class="acct-note">Tap one to reopen it as you left it: change the target or the settings, everything is computed again. An A4 opens its print window too.</p>` : ""}`;
}

/** The last part of the Account window: sign-in and data. */
export function acDataHtml() {
  const user = cloudOn() && cloudUser();
  return `<section class="acct-data"><h4 data-pf-sec="data">Sign-in and data</h4>
    ${user ? `<p class="acct-note">Signed in as <b>${acEsc(user.email)}</b>.</p>
    <form class="acct-signin" data-acct-form="password">
      <label for="acNewPass">${ac.recovery ? "Choose your new password" : "Change password"}</label>
      <div><input id="acNewPass" type="password" required minlength="8" autocomplete="new-password" placeholder="8 characters or more"><button class="btn ghost" type="submit">Save</button></div>
    </form>` : `<p class="acct-note">Not signed in: everything stays on this device.</p>`}
    ${ac.dataMsg ? `<p class="acct-msg" role="status">${acEsc(ac.dataMsg)}</p>` : ""}
    <div class="acct-links"><button type="button" data-acct="export">Export my data</button>${user ? `<button type="button" data-acct="signout">Sign out</button><button type="button" class="acct-danger" data-acct="delete">Delete my account</button>` : ""}</div>
  </section>`;
}

/** One AI doc as a menu row: date, race or run, then the verdict and AI finish (Prep my race) or the session and its exercises (Prep my run), or "empty". */
export function acDocRow(d) {
  const ok = d.result && d.result.status === "ok";
  const run = d.mode === "prep_run";
  const v = !ok ? "empty" : run ? `${acEsc(d.result.dataset.session.type)} · ${d.result.exercises.length} ex.` : `${acEsc(d.result.dataset.target.verdict)} · ${hm(d.result.finishSec)}`;
  return `<button type="button" class="acct-row acct-doc" data-acct="doc:${acEsc(d.id)}"><span>✦ ${acDate(Date.parse(d.at))} ${new Date(d.at).toTimeString().slice(0, 5)} · ${run ? "Run · " : ""}${acEsc(d.raceName)}</span><b>${v}</b></button>`;
}
/** HTML of the AI docs block of the menu: the last few docs, newest first ("" when none). */
export function acDocsHtml(docs) {
  if (!docs.length) return "";
  return `<section><h4>AI docs · ${docs.length}</h4>${docs.slice(0, 4).map(acDocRow).join("")}${docs.length > 4 ? `<button type="button" class="acct-linkbtn" data-acct="docs">All ${docs.length} AI docs</button>` : ""}</section>`;
}
