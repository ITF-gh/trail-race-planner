// appstate.js: what every part of the Prep my race page shares: the page state, the localStorage
// wrapper and two tiny helpers ($ to find an element, esc to make text safe in HTML).
// Split out of main.js (2026-11-02) so each section file can import them.

import { PLAN_DEFAULTS } from "../core/plan.js";

/**
 * $(selector, root): a short name for root.querySelector(selector), which returns the first
 * element matching a CSS selector ("#id", ".class", "div > a"...) or null if none matches.
 * `r = document` is a default parameter: search the whole page unless a root is given.
 */
export const $ = (s, r = document) => r.querySelector(s);
/**
 * esc(text): makes text safe to put inside HTML. It replaces the four characters that HTML
 * treats as markup (& < > ") by their entity codes (&amp; &lt; &gt; &quot;).
 * The regex /[&<>"]/g matches any one of those four characters; the `g` flag means every
 * occurrence, not just the first. Used on anything that came from a file or the user (race
 * names, aid station names), so a name like "<b>" shows as text instead of becoming markup.
 */
export const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/**
 * store: a thin wrapper around localStorage (text-only storage kept by the browser for this
 * site). Values are turned into text with JSON.stringify on the way in and back with JSON.parse
 * on the way out, so objects and numbers survive. Both calls are wrapped in try/catch because
 * storage can be blocked (private browsing, strict settings): then get() returns null and set()
 * silently does nothing, and the app still works, it just forgets on reload.
 */
export const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k) || "null"); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage can be blocked */ } },
};

/**
 * state: everything the page currently knows, in one object. The render* functions read it;
 * the event handlers change it and then call compute() or a render function.
 *   race      the loaded race GPX: name, parsed points, course analysis, a light profile
 *             [[km, altitude m], ...] and route [[lat, lon], ...] for drawing.
 *   effort    your reference runs and what analyseEffort learned from them (`info`).
 *   settings  the settings form. `{ ...A, ...B }` (spread) copies A's fields, then B's on top:
 *             the defaults from plan.js, overridden by what was saved in this browser.
 *   scenario  which of the three scenarios is shown: "best", "central" or "cautious".
 *   plan      the result of buildPlan, or null until both files are loaded.
 * (state.foldClimbs is also set later, by renderDday, to remember if "Climb by climb" is open.)
 */
export const state = {
  race: null, // {name, parsed, course, profile}
  effort: null, // {runs: [{name, parsed}], info}
  ownRuns: false, // true once one of your own GPX is in Your runs (not only the demo): the status then points to the profile
  settings: { ...PLAN_DEFAULTS, ...(store.get("trp.settings") || {}) },
  scenario: store.get("trp.scenario") || "central",
  tab: "c", // D-day list: climbs or descents
  kz: 0, // Your plan: the open key zone chip (index in plan.keyZones), or null; key zone 1 opens by default
  btab: "c", // briefing list: climbs or descents
  ptab: "c", // Prep my run climbs and descents: which tab is open
  bwin: null, // briefing profile zoom window [fromKm, toKm], null = whole course
  plan: null,
  aiOn: store.get("trp.ai.on") === true, // Your race shows the AI plan (when there is one)
};
// v2.27 lowered the default endurance exponent from 0.07 to 0.05 (the tired gap now also grows with
// race length). A value saved by an earlier version that still holds the old default follows it.
if (state.settings.enduranceExp === 0.07) state.settings.enduranceExp = PLAN_DEFAULTS.enduranceExp;
