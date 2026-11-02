// appstate.js: what every part of the Prep my race page shares: the page state, the localStorage wrapper and two tiny helpers ($ to find an element, esc to make text safe in HTML).

import { PLAN_DEFAULTS } from "../core/plan.js";

/** $(selector, root): a short name for root.querySelector(selector), which returns the first element matching a CSS selector ("#id", ".class", "div > a"...) or null if none matches. */
export const $ = (s, r = document) => r.querySelector(s);
/** esc(text): makes text safe to put inside HTML. */
export const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/** store: a thin wrapper around localStorage (text-only storage kept by the browser for this site). */
export const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k) || "null"); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage can be blocked */ } },
};

/** state: everything the page currently knows, in one object. */
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
// v2.27 lowered the default endurance exponent from 0.07 to 0.05 (the tired gap now also grows with race length).
if (state.settings.enduranceExp === 0.07) state.settings.enduranceExp = PLAN_DEFAULTS.enduranceExp;
