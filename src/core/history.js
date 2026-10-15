// history.js: the run log behind the account menu. Each run you analyse becomes a small summary
// (about 1 KB: date, distance, climbing, best efforts...), never the GPX itself. From the list
// of summaries this file computes the menu: totals over the last 12 months, all-time bests, the
// last runs, the achievements and the cairns they earn.
//
// Pure functions only: storing the summaries (IndexedDB, in the browser) is the UI's job, so the
// same code can later run on a server to check an achievement before it pays out a cairn.

import { runStats } from "./review.js";
import { bestEffort, runKpis } from "./insights.js";

export const HISTORY_VERSION = 1; // bump when a summary field changes meaning, to know which runs to recompute

/** Summary of one analysed run (the object analyseRun returns), ready to store. */
export function runRecord(run, name = "") {
  const st = runStats(run);
  const k10 = run.totalKm >= 10 ? bestEffort(run, 10000) : null;
  const vam = runKpis(run).find((k) => k.key === "vam");
  return {
    // Same start time and same distance = the same run, so loading a file twice keeps one copy.
    id: `${Math.round(run.startMs / 1000)}-${Math.round(run.totalKm * 100)}`,
    v: HISTORY_VERSION,
    date: run.startMs,
    name: String(name || run.name || "Run").slice(0, 80),
    km: run.totalKm,
    gain: run.gain,
    movingSec: run.movingSec,
    elapsedSec: run.elapsedSec,
    gapPace: run.gapPace || null,
    hrAvg: run.hasHr ? run.hrAvg : null,
    fadePct: Number.isFinite(run.halves.fadePct) ? run.halves.fadePct : null,
    decouplingPct: Number.isFinite(run.halves.decouplingPct) ? run.halves.decouplingPct : null,
    vam: vam ? vam.value : null,
    best1k: st.fastest1k ? st.fastest1k.sec : null,
    best5k: st.fastest5k ? st.fastest5k.sec : null,
    best10k: k10 ? k10.sec : null,
  };
}

const HI_DAY = 86400000;
const hiMonth = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${d.getMonth()}`; };

/**
 * The achievements: each one has a test on the whole log and a progress from 0 to 1, so the
 * menu can show how close you are. `cairns` is what unlocking it earns (1 cairn = 1 AI analysis,
 * later). Kept as data so they are easy to add to or retune.
 */
export const ACHIEVEMENTS = [
  { code: "first", icon: "👣", label: "First steps", hint: "Save your first run", cairns: 1,
    progress: (L) => Math.min(1, L.length) },
  { code: "ten", icon: "🔟", label: "Ten runs", hint: "Ten runs in your log", cairns: 0,
    progress: (L) => L.length / 10 },
  { code: "half", icon: "🥈", label: "Half marathon", hint: "One run of 21.1 km or more", cairns: 0,
    progress: (L) => hiMax(L, (r) => r.km) / 21.0975 },
  { code: "marathon", icon: "🥇", label: "Marathon", hint: "One run of 42.2 km or more", cairns: 1,
    progress: (L) => hiMax(L, (r) => r.km) / 42.195 },
  { code: "ultra", icon: "🧭", label: "First ultra", hint: "One run of 50 km or more", cairns: 2,
    progress: (L) => hiMax(L, (r) => r.km) / 50 },
  { code: "kilo", icon: "⛰", label: "1,000 m day", hint: "1,000 m of climbing in one run", cairns: 0,
    progress: (L) => hiMax(L, (r) => r.gain) / 1000 },
  { code: "everest", icon: "🏔", label: "Everest club", hint: "8,849 m of climbing in one calendar month", cairns: 1,
    progress: (L) => {
      const m = new Map();
      for (const r of L) m.set(hiMonth(r.date), (m.get(hiMonth(r.date)) || 0) + r.gain);
      return Math.max(0, ...m.values()) / 8849;
    } },
  { code: "negative", icon: "🔥", label: "Negative split", hint: "Stronger second half on a run of 20 km or more", cairns: 0,
    progress: (L) => (L.some((r) => r.km >= 20 && r.fadePct !== null && r.fadePct < 0) ? 1 : hiMax(L.filter((r) => r.fadePct !== null && r.fadePct < 0), (r) => r.km) / 20) },
  { code: "iron", icon: "🫀", label: "Iron engine", hint: "Heart drift under 3% on a run of 3 h or more", cairns: 1,
    progress: (L) => hiMax(L.filter((r) => r.decouplingPct !== null && r.decouplingPct < 3), (r) => r.movingSec) / 10800 },
  { code: "thousand", icon: "🏅", label: "1,000 km club", hint: "1,000 km in your log", cairns: 1,
    progress: (L) => L.reduce((s, r) => s + r.km, 0) / 1000 },
];

function hiMax(list, f) { let m = 0; for (const r of list) { const v = f(r); if (Number.isFinite(v) && v > m) m = v; } return m; }

/** The best (smallest or largest) value of a field over the log, with the run it comes from. */
function hiBest(list, key, smaller) {
  let best = null;
  for (const r of list) {
    const v = r[key];
    if (v === null || v === undefined || !Number.isFinite(v)) continue;
    if (!best || (smaller ? v < best.value : v > best.value)) best = { value: v, run: r };
  }
  return best;
}

/** Everything the account menu shows, from the stored summaries. `now` is a date in ms. */
export function historySummary(records, now = Date.now()) {
  const list = [...records].sort((a, b) => b.date - a.date);
  const year = list.filter((r) => r.date >= now - 365 * HI_DAY);
  const achievements = ACHIEVEMENTS.map((a) => {
    const p = Math.max(0, Math.min(1, a.progress(list) || 0));
    return { code: a.code, icon: a.icon, label: a.label, hint: a.hint, cairns: a.cairns, progress: p, done: p >= 1 };
  });
  return {
    count: list.length,
    year: {
      km: year.reduce((s, r) => s + r.km, 0),
      gain: year.reduce((s, r) => s + r.gain, 0),
      movingSec: year.reduce((s, r) => s + r.movingSec, 0),
      runs: year.length,
    },
    bests: {
      best1k: hiBest(list, "best1k", true),
      best5k: hiBest(list, "best5k", true),
      best10k: hiBest(list, "best10k", true),
      vam: hiBest(list, "vam", false),
      longest: hiBest(list, "km", false),
      climb: hiBest(list, "gain", false),
    },
    last: list.slice(0, 3),
    achievements,
    unlocked: achievements.filter((a) => a.done).length,
    cairns: achievements.reduce((s, a) => s + (a.done ? a.cairns : 0), 0),
  };
}
