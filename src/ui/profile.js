// profile.js: the Account window, a see-through pop-up of its own, opened from the account menu
// ("My profile"). It holds the runner's presentation (name, flag, a few words, badges), their
// goals and bests from 5K to 100K, and their heart rates and weight.
//
// Storage: in this browser (localStorage), the profile under "trp.profile", the heart rates and
// weight under "trp.athlete" (the athlete settings also used by the deep dive, the plan and the
// AI analysis). When signed in to the online account, account.js also saves the profile there
// (profileData); heart rates and weight never leave the browser.
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
//   profileData, profileReplace   the profile to save online, and loading the online one
//   profileTune, profileSetBands  "Tune my engine" for the plan (signed in), the measured table to show
//   profileHtml    the Account window
//   profileInput, profileAction   what typing and clicking in it do

import { PROFILE_DISTANCES, PROFILE_COUNTRIES, PROFILE_TAGS, PROFILE_LIMITS, flagEmoji, profileClean, profileBests, TUNE_RANGE, TUNE_BAND, tuneClean, tuneIsDefault } from "../core/profile.js";
import { cloudUser } from "./cloud.js";
import { BANDS } from "../core/terrain.js";
import { mmss, hms, parseDuration } from "../core/format.js";
import { historySummary } from "../core/history.js";

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
// Saved cleaned (limits applied); the "trp-profile-save" event lets account.js send it to the
// online account when one is signed in.
const pfSave = () => { pfWrite(PF_KEY, profileClean(pf)); document.dispatchEvent(new CustomEvent("trp-profile-save")); };

/** The profile as saved (cleaned): what the online account stores. Heart rates and weight are not in it. */
export const profileData = () => profileClean(pfGet());
/** Replace this browser's profile with another one (the online account's, or {} to forget it). */
export function profileReplace(data) {
  pf = profileClean(data);
  pfWrite(PF_KEY, pf);
}

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
/**
 * "Tune my engine" for the plan, or null: only for a signed-in runner who switched it on (Boss's
 * rule, 2026-10-28: manual pace by gradient is a deeper feature for registered users).
 */
export function profileTune() {
  const t = pfGet().tune;
  return cloudUser() && t.on ? t : null;
}
// The measured pace table of the runs loaded in Prep my race (effort.js bands), to show next to
// the tuning; main.js gives it after each analysis. null until runs are loaded.
let pfBands = null;
/** Remember the measured pace table for the tuning part of the window. */
export function profileSetBands(bands) { pfBands = bands || null; }

/** Name and flag emoji for the menu ("" when not set). */
export function profileWho() {
  const p = pfGet();
  return { name: p.name, flag: flagEmoji(p.flag) };
}

/**
 * The "Tune my engine" part of the Account window (signed in only). Sliders for the engine's
 * settings and a table of the 10 gradient bands, each with a fresh and a tired % on top of your
 * measured pace (shown when runs are loaded in Prep my race).
 */
function tuneHtml() {
  const t = pfGet().tune;
  const R = TUNE_RANGE;
  const row = (k, label, step, unit, help) => `<label class="tn-row">${label} <output>${t[k]}${unit}</output>
    <input type="range" data-pf="tune:${k}" min="${R[k][1]}" max="${R[k][2]}" step="${step}" value="${t[k]}"><small>${help} Default ${R[k][0]}${unit}.</small></label>`;
  const mm = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;
  const band = (b, i) => {
    const [fp, tp] = t.bands[i];
    const m = pfBands && pfBands[i];
    const cell = (j, v, base) => `<td><input type="number" data-pf="tune:b${i}:${j}" min="${TUNE_BAND[0]}" max="${TUNE_BAND[1]}" step="1" value="${v}">%${m ? `<small>${mm(base * (1 + v / 100))}</small>` : ""}</td>`;
    return `<tr><th>${pfEsc(b)}</th>${cell(0, fp, m ? m.fresh : 0)}${cell(1, tp, m ? m.tired : 0)}</tr>`;
  };
  return `<h4 data-pf-sec="engine">Tune my engine</h4>
    <p class="acct-note">Your own corrections to the race plan, on top of what your runs measure. Useful on very long races. Saved with your profile.</p>
    <div class="acct-actions" style="margin:0"><button type="button" class="acct-chip${t.on ? " on" : ""}" data-acct="pf:tune-on">${t.on ? "On: every plan uses my tuning" : "Off: plans use my runs as measured"}</button>${tuneIsDefault(t) ? "" : `<button class="acct-linkbtn" type="button" data-acct="pf:tune-reset">Reset tuning</button>`}</div>
    <div class="tn-grid${t.on ? "" : " off"}">
      ${row("level", "Level", 1, "%", "Every pace, minus = faster.")}
      ${row("fatigue", "Fatigue gap", 5, "%", "How much slower tired is than fresh, 100% = as your runs show.")}
      ${row("k", "Race-length fade", 0.005, "", "Slows long races more as it grows.")}
      ${row("gapExp", "Tired gap growth", 0.05, "", "How fast the tired gap grows on races longer than your runs.")}
      ${row("night", "Night", 1, "%", "Slower in the dark (with a race date).")}
    </div>
    <table class="pf-goals tn-bands${t.on ? "" : " off"}"><thead><tr><th>Gradient</th><th>Fresh</th><th>Tired</th></tr></thead><tbody>${BANDS.map((b, i) => band(b.label, i)).join("")}</tbody></table>
    <p class="acct-note">${pfBands ? "Paces in min/km from the runs loaded in Prep my race, before your level and references." : "Load your runs in Prep my race to see the paces next to each %."}</p>`;
}

/**
 * The Account window. `records` are the run summaries the menu shows (for the bests), `demo`
 * true when they are the demo profile's made-up runs, `fallbackName` the name to show when none
 * is typed ("User1" or "My account"). Four parts:
 *   1. the card: flag (or the first letter of the name), name, badges and the few words
 *   2. Presentation: name, country, about, badges to pick (at most 5)
 *   3. Goals and bests: one row per distance: goal, best (typed, or else from the runs), to go
 *   4. Heart and body: max and resting heart rate, weight (the only heart data the app uses)
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
  // The other all-time bests found in the runs (the menu's "Bests" link opens the window here):
  // fastest 1 km, best climbing speed and longest run, each with its date. The 5K and 10K bests
  // are already in the table above (the same values).
  const B = historySummary(records || []).bests;
  const bestRow = (label, b, f) => (b ? `<div class="acct-row"><span>${label}</span><b>${f(b.value, b.run)} <small>${new Date(b.run.date).toLocaleDateString(undefined, { day: "numeric", month: "short" })}${demo ? " (demo)" : ""}</small></b></div>` : "");
  const more = bestRow("Fastest 1 km", B.best1k, (v) => mmss(v))
    + bestRow("Best climbing speed", B.vam, (v) => `${Math.round(v).toLocaleString("en-US")} m/h`)
    + bestRow("Longest run", B.longest, (v, r) => `${v.toFixed(1)} km · ${Math.round(r.gain).toLocaleString("en-US")} m`);
  const moreBests = more ? `<div class="acct-bests pf-more" data-pf-sec="bests">${more}</div>` : "";
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
    ${moreBests}
    <h4 data-pf-sec="heart">Heart and body</h4>
    <div class="pf-grid three">
      <label>Max heart rate<span class="pf-u"><input type="number" data-pf="hrMax" min="120" max="230" step="1" placeholder="190" value="${a.hrMax || ""}"> bpm</span></label>
      <label>Resting heart rate<span class="pf-u"><input type="number" data-pf="hrRest" min="30" max="100" step="1" placeholder="55" value="${a.hrRest || ""}"> bpm</span></label>
      <label>Weight<span class="pf-u"><input type="number" data-pf="weight" min="30" max="200" step="0.5" placeholder="70" value="${a.weight || ""}"> kg</span></label>
    </div>
    <p class="acct-note">These are the only heart data the app uses: heart rate recorded in a GPX file is never read. They set the plan's heart-rate guide and stay on this device.</p>
    ${cloudUser() ? tuneHtml() : ""}
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
  if (what === "tune") {
    // Sliders save as they move (the output shows the value); band boxes once the field is left.
    const sub = k.split(":").slice(1);
    const v = parseFloat(el.value);
    if (sub[0].startsWith("b")) { if (!final) return false; p.tune.bands[+sub[0].slice(1)][+sub[1]] = v; }
    else { p.tune[sub[0]] = v; const o = el.parentElement.querySelector("output"); if (o) o.textContent = el.value + (sub[0] === "level" || sub[0] === "fatigue" || sub[0] === "night" ? "%" : ""); }
    p.tune = tuneClean(p.tune);
    pf = p;
    pfSave();
    if (final || sub[0].startsWith("b")) document.dispatchEvent(new CustomEvent("trp-refs"));
    return final;
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
 *   reset     forget the presentation and goals (after a confirm; heart rates stay)
 * Returns true when the window should be redrawn.
 */
export function profileAction(what) {
  const p = pfGet();
  if (what === "tune-on" || what === "tune-reset") {
    p.tune = what === "tune-on" ? { ...p.tune, on: !p.tune.on } : tuneClean({ on: p.tune.on });
    pfSave();
    document.dispatchEvent(new CustomEvent("trp-refs"));
    return true;
  }
  if (what.startsWith("tag:")) {
    const t = what.slice(4);
    if (p.tags.includes(t)) p.tags = p.tags.filter((x) => x !== t);
    else if (p.tags.length < PROFILE_LIMITS.tags) p.tags = p.tags.concat(t);
  } else if (what === "reset") {
    if (!window.confirm("Reset your profile? Name, flag, badges, goals and bests are erased. Heart rates and weight stay.")) return false;
    pf = profileClean({});
    pfSave();
    return true;
  } else return false;
  pfSave();
  return true;
}
