// profile.js: the Account window, a see-through pop-up of its own, opened from the account menu
// ("My profile"). It holds the runner's presentation (name, flag, a few words, badges), their
// goals and bests from 5K to 100K, their heart rates and weight, and lines of their own data.
//
// Storage: everything stays in this browser (localStorage), the profile under "trp.profile", the
// heart rates and weight under "trp.athlete" (the athlete settings also used by the deep dive,
// the plan and the AI analysis). Nothing here is sent anywhere.
//
// Heart data: the max and resting heart rates typed here are the ONLY heart data the app uses
// (owner's rule, 2026-10-16). Heart rate recorded in a GPX file is never read (core/track.js).
// When they change, a "trp-profile" event tells main.js to redraw the plan's heart-rate guide.
//
// Where it sits: account.js draws the window with profileHtml() in its pop-up panel and passes
// it the inputs (profileInput) and the buttons whose data-acct starts with "pf:" (profileAction).
//
// Main exports:
//   profileHeart   { maxHr, restHr } for the plan (null when not set)
//   profileAthlete { hrMax, hrRest, weight } for the AI analysis (null when not set)
//   profileWho     { name, flag } for the menu's first line
//   profileRefs, profileSetRefs   your references (10K, half, easy pace) and the run level
//   profileHtml    the Account window
//   profileInput, profileAction   what typing and clicking in it do

import { PROFILE_DISTANCES, PROFILE_COUNTRIES, PROFILE_TAGS, PROFILE_LIMITS, flagEmoji, profileClean, profileBests } from "../core/profile.js";
import { mmss, hms, parseDuration } from "../core/format.js";

const PF_KEY = "trp.profile", PF_ATHLETE = "trp.athlete";
// Escape text for HTML (& < > " become entities), so a typed name can never be read as HTML.
const pfEsc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
// Read and write JSON in localStorage; a blocked or broken storage gives {} and is ignored.
const pfRead = (k) => { try { return JSON.parse(localStorage.getItem(k) || "{}") || {}; } catch (e) { return {}; } };
const pfWrite = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private window: kept in memory only */ } };
// A time as "18:30" under an hour, else "1:24:05".
const pfTime = (sec) => (sec < 3600 ? mmss(sec) : hms(sec));
const pfDate = (ms) => new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

// The profile in memory, read once (cleaned, so it is always complete).
let pf = null;
const pfGet = () => (pf || (pf = profileClean(pfRead(PF_KEY))));
// Saved cleaned (limits applied, empty lines of own data dropped); the copy in memory keeps the
// lines just added and still empty, so they stay on screen while being filled in.
const pfSave = () => pfWrite(PF_KEY, profileClean(pf));

/** The heart rates for the plan: { maxHr, restHr }, each null when not set in the profile. */
export function profileHeart() {
  const a = pfRead(PF_ATHLETE);
  return { maxHr: a.hrMax || null, restHr: a.hrRest || null };
}
/** The athlete settings for the AI analysis: { hrMax, hrRest, weight }, each null when not set. */
export function profileAthlete() {
  const a = pfRead(PF_ATHLETE);
  return { hrMax: a.hrMax || null, hrRest: a.hrRest || null, weight: a.weight || null };
}
/** Your references and the level of the next run: { refs: { k10, half, easy }, level }. */
export function profileRefs() {
  const p = pfGet();
  return { refs: { ...p.refs }, level: p.level };
}
/**
 * Save references and / or the level ({ refs: { k10: 2700 }, level: "race" }; fields left out
 * stay as they are), then announce it with a "trp-refs" event so every mode plans again.
 */
export function profileSetRefs({ refs, level } = {}) {
  const p = pfGet();
  if (refs) p.refs = { ...p.refs, ...refs };
  if (level) p.level = level;
  pf = profileClean(p);
  pfSave();
  document.dispatchEvent(new CustomEvent("trp-refs"));
}
/** Name and flag emoji for the menu ("" when not set). */
export function profileWho() {
  const p = pfGet();
  return { name: p.name, flag: flagEmoji(p.flag) };
}

/**
 * The Account window. `records` are the run summaries the menu shows (for the bests), `demo`
 * true when they are the demo profile's made-up runs, `fallbackName` the name to show when none
 * is typed ("User1" or "My account"). Five parts:
 *   1. the card: flag (or the first letter of the name), name, badges and the few words
 *   2. Presentation: name, country, about, badges to pick (at most 5)
 *   3. Goals and bests: one row per distance: goal, best (typed, or else from the runs), to go
 *   4. Heart and body: max and resting heart rate, weight (the only heart data the app uses)
 *   5. My data: lines of label and value, added and removed freely
 * Every input carries data-pf="..." naming what it changes (see profileInput).
 */
export function profileHtml(records, demo, fallbackName) {
  const p = pfGet();
  const a = pfRead(PF_ATHLETE);
  const logBest = profileBests(records);
  const name = p.name || fallbackName;
  const flag = flagEmoji(p.flag);
  const L = PROFILE_LIMITS;
  const tagsOn = PROFILE_TAGS.filter((t) => p.tags.includes(t.code));
  // One row of the goals table. `short` = 5K and 10K, where "18:30" means minutes and seconds;
  // longer distances read "6:30" as hours and minutes (parseDuration in format.js).
  const goalRow = (d) => {
    const g = p.goals[d.code], lb = logBest[d.code];
    const best = g.best || (lb ? lb.sec : null);
    // Gap to the goal: reached, or the time still to find.
    const gap = g.goal && best ? (best <= g.goal ? `<span class="pf-ok">✓ reached</span>` : `${pfTime(best - g.goal)} to go`) : "";
    const ph = d.km <= 10 ? "mm:ss" : "h:mm";
    const from = !g.best && lb ? `<small>from your runs${d.km > 10 ? `, ${lb.km.toFixed(1)} km` : ""}, ${pfDate(lb.date)}${demo ? " (demo)" : ""}</small>` : "";
    return `<tr><th>${d.label}</th>
      <td><input data-pf="goal:${d.code}" inputmode="numeric" autocomplete="off" placeholder="${ph}" value="${g.goal ? pfTime(g.goal) : ""}"></td>
      <td><input data-pf="best:${d.code}" inputmode="numeric" autocomplete="off" placeholder="${lb ? pfTime(lb.sec) : ph}" value="${g.best ? pfTime(g.best) : ""}">${from}</td>
      <td class="pf-gap">${gap}</td></tr>`;
  };
  const extraRow = (x, i) => `<div class="pf-extra"><input data-pf="xl:${i}" maxlength="${L.label}" placeholder="VO2max" value="${pfEsc(x.label)}"><input data-pf="xv:${i}" maxlength="${L.value}" placeholder="54" value="${pfEsc(x.value)}"><button type="button" class="acct-x pf-del" data-acct="pf:del:${i}" aria-label="Remove this line">×</button></div>`;
  return `<p class="acct-kicker">Account</p>
    <div class="pf-card">
      <span class="pf-avatar" aria-hidden="true">${flag || pfEsc((name[0] || "?").toUpperCase())}</span>
      <div><h3>${pfEsc(name)}</h3>
        ${tagsOn.length ? `<p class="pf-tags">${tagsOn.map((t) => `<span>${t.icon} ${t.label}</span>`).join("")}</p>` : ""}
        ${p.about ? `<p class="pf-about">${pfEsc(p.about)}</p>` : ""}</div>
    </div>
    <h4>Presentation</h4>
    <div class="pf-grid">
      <label>Name<input data-pf="name" maxlength="${L.name}" placeholder="${pfEsc(fallbackName)}" value="${pfEsc(p.name)}"></label>
      <label>Country<select data-pf="flag"><option value="">No flag</option>${PROFILE_COUNTRIES.map(([c, n]) => `<option value="${c}"${p.flag === c ? " selected" : ""}>${flagEmoji(c)} ${n}</option>`).join("")}</select></label>
      <label class="wide">A few words<textarea data-pf="about" maxlength="${L.about}" rows="2" placeholder="Trail runner from the Alps, chasing my first 100K.">${pfEsc(p.about)}</textarea></label>
    </div>
    <p class="acct-note">Badges, ${L.tags} at most:</p>
    <div class="acct-chips small">${PROFILE_TAGS.map((t) => `<button type="button" class="acct-chip${p.tags.includes(t.code) ? " on" : ""}" data-acct="pf:tag:${t.code}">${t.icon} ${t.label}</button>`).join("")}</div>
    <h4>Goals and bests</h4>
    <table class="pf-goals"><thead><tr><th></th><th>Goal</th><th>Best</th><th>To go</th></tr></thead><tbody>${PROFILE_DISTANCES.map(goalRow).join("")}</tbody></table>
    <p class="acct-note">Type a best to replace the one found in your runs. 5K and 10K read as mm:ss, longer ones as h:mm (or h:mm:ss everywhere).</p>
    <h4>Heart and body</h4>
    <div class="pf-grid three">
      <label>Max heart rate<span class="pf-u"><input type="number" data-pf="hrMax" min="120" max="230" step="1" placeholder="190" value="${a.hrMax || ""}"> bpm</span></label>
      <label>Resting heart rate<span class="pf-u"><input type="number" data-pf="hrRest" min="30" max="100" step="1" placeholder="55" value="${a.hrRest || ""}"> bpm</span></label>
      <label>Weight<span class="pf-u"><input type="number" data-pf="weight" min="30" max="200" step="0.5" placeholder="70" value="${a.weight || ""}"> kg</span></label>
    </div>
    <p class="acct-note">These are the only heart data the app uses: heart rate recorded in a GPX file is never read. They set the plan's heart-rate guide and stay on this device.</p>
    <h4>My data</h4>
    <div class="pf-extras">${p.extra.map(extraRow).join("")}</div>
    ${p.extra.length < L.extra ? `<button type="button" class="acct-linkbtn" data-acct="pf:add">+ Add a line</button>` : ""}
    <div class="acct-actions"><button class="btn ghost" type="button" data-acct="close">Done</button><button class="acct-linkbtn" type="button" data-acct="pf:reset">Reset profile</button></div>`;
}

/**
 * An input of the window changed. `el` is the input, `final` true on its "change" event (the
 * field was left or Enter pressed), false on each keystroke. Texts are saved as they are typed;
 * times and numbers once the field is left, so "1:2" is not read halfway through "1:25".
 * Returns true when the window should be redrawn (the card or the "to go" column changed).
 */
export function profileInput(el, final) {
  const p = pfGet();
  const k = el.dataset.pf;
  const [what, code] = k.split(":");
  if (what === "name" || what === "about") { p[what] = el.value; pfSave(); return final; }
  if (what === "flag") { p.flag = el.value; pfSave(); return true; }
  if (what === "xl" || what === "xv") {
    const x = p.extra[Number(code)];
    if (x) { x[what === "xl" ? "label" : "value"] = el.value; pfSave(); }
    return false;
  }
  if (!final) return false;
  if (what === "goal" || what === "best") {
    const d = PROFILE_DISTANCES.find((x) => x.code === code);
    const v = parseDuration(el.value, d.km <= 10);
    p.goals[code][what] = Number.isFinite(v) && v >= 60 && v <= 7 * 86400 ? v : null;
    pfSave();
    return true;
  }
  if (what === "hrMax" || what === "hrRest" || what === "weight") {
    const a = pfRead(PF_ATHLETE);
    const v = parseFloat(el.value);
    // Limits as in the form; an empty or impossible value removes the setting.
    const [lo, hi] = { hrMax: [120, 230], hrRest: [30, 100], weight: [30, 200] }[what];
    if (Number.isFinite(v) && v >= lo && v <= hi) a[what] = v; else delete a[what];
    pfWrite(PF_ATHLETE, a);
    document.dispatchEvent(new CustomEvent("trp-profile"));
    return false;
  }
  return false;
}

/**
 * A button of the window, its data-acct without the "pf:" prefix:
 *   tag:CODE  toggle a badge (at most PROFILE_LIMITS.tags)
 *   add       add an empty line of own data; del:I removes line I
 *   reset     forget the presentation, goals and own data (after a confirm; heart rates stay)
 * Returns true when the window should be redrawn.
 */
export function profileAction(what) {
  const p = pfGet();
  if (what.startsWith("tag:")) {
    const t = what.slice(4);
    if (p.tags.includes(t)) p.tags = p.tags.filter((x) => x !== t);
    else if (p.tags.length < PROFILE_LIMITS.tags) p.tags = p.tags.concat(t);
  } else if (what === "add") {
    if (p.extra.length < PROFILE_LIMITS.extra) p.extra.push({ label: "", value: "" });
  } else if (what.startsWith("del:")) {
    p.extra = p.extra.filter((x, i) => i !== Number(what.slice(4)));
  } else if (what === "reset") {
    if (!window.confirm("Reset your profile? Name, flag, badges, goals, bests and your own data are erased. Heart rates and weight stay.")) return false;
    pf = profileClean({});
    pfSave();
    return true;
  } else return false;
  pfSave();
  return true;
}
