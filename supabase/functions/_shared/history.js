// history.js: the run log behind the account menu. Each run you analyse becomes a small summary
// (about 1 KB: date, distance, climbing, best efforts...), never the GPX itself. From the list
// of summaries this file computes the menu: totals over the last 12 months, all-time bests, the
// last runs, the achievements and the cairns they earn.
//
// Pure functions only: storing the summaries (IndexedDB in the browser, and the account database
// when signed in) is the UI's job. runRecord (src/core/runrecord.js) builds a summary from a run.

// This file has NO imports on purpose: the server (supabase/functions/_shared/history.js, a copy
// made by the build) runs the very same achievements and checks before it pays out a cairn.
//
// Main exports:
//   HISTORY_VERSION     the summary format version
//   ACHIEVEMENTS        the list of achievements (data, see below)
//   historySummary      everything the account menu shows
//   checkRecord         is a summary believable? (also run by the server)
//   aiDigest            the compact table an AI analysis receives
//
// A summary ("record") is {id, v, date (ms since 1970), name, km, gain (m), movingSec,
// elapsedSec, gapPace (s/km), hrAvg (bpm), fadePct, decouplingPct (%), vam (m/h), best1k,
// best5k, best10k (seconds)}. Optional fields are null when the run had no data for them.

export const HISTORY_VERSION = 1; // bump when a summary field changes meaning, to know which runs to recompute

// One day in milliseconds (24 x 60 x 60 x 1000).
const HI_DAY = 86400000;
// Calendar months in UTC, so the browser and the server always agree on which month a run is in.
// hiMonth(ms) = "2026-9" style key (year, month 0..11), used to group runs by month.
const hiMonth = (ms) => { const d = new Date(ms); return `${d.getUTCFullYear()}-${d.getUTCMonth()}`; };

/**
 * The achievements: each one has a test on the whole log and a progress from 0 to 1, so the
 * menu can show how close you are. `cairns` is what unlocking it earns (1 cairn = 1 AI analysis,
 * later). Kept as data so they are easy to add to or retune.
 *
 * Each achievement: {code (stable id, also used by the server), icon, label, hint (how to earn
 * it), cairns, progress(L)}. progress is a small function given the whole log L (an array of
 * summaries) that returns a number; 1 or more means unlocked (historySummary clamps it to 0..1).
 * Examples: "half" = longest run / 21.0975 km; "everest" adds up the climbing per calendar month
 * in a Map (month key -> metres) and takes the best month / 8849 m (the height of Everest).
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

/**
 * The largest value of f(run) over the list, or 0 when the list is empty or has no number.
 * f is a function that picks a field, for example (r) => r.km.
 */
function hiMax(list, f) { let m = 0; for (const r of list) { const v = f(r); if (Number.isFinite(v) && v > m) m = v; } return m; }

/**
 * The best (smallest or largest) value of a field over the log, with the run it comes from.
 * Inputs: the list, a field name ("best5k"), smaller = true when lower is better (times).
 * Returns {value, run} or null when no run has that field. `r[key]` reads a field by its name.
 */
function hiBest(list, key, smaller) {
  let best = null;
  for (const r of list) {
    const v = r[key];
    if (v === null || v === undefined || !Number.isFinite(v)) continue;
    if (!best || (smaller ? v < best.value : v > best.value)) best = { value: v, run: r };
  }
  return best;
}

/**
 * Everything the account menu shows, from the stored summaries. `now` is a date in ms.
 * Returns {count, year: {km, gain, movingSec, runs} over the last 365 days, bests (each {value,
 * run} or null), last (the 3 newest runs), achievements (each with progress 0..1 and done),
 * unlocked (how many are done), cairns (earned in all)}.
 * `[...records]` copies the array first, so sorting it does not reorder the caller's array.
 */
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

/**
 * Is this summary believable? The server only counts runs that pass, so a hand-made summary
 * cannot unlock an achievement with impossible numbers. Limits sit just beyond world records
 * (1 km in 2:11, 5 km in 12:35, 10 km in 26:11) and human climbing speeds. Returns null when
 * the run is fine, or the reason it is not.
 */
// How it works: num(k, lo, hi, optional) checks one field and returns an error text, or null when
// it is fine. The checks are chained with `||`: the first one that returns a text stops the chain
// and becomes `bad`. Then a few checks that combine fields (average pace, climbing rate).
export function checkRecord(r, now = Date.now()) {
  if (!r || typeof r !== "object") return "not a run";
  const num = (k, lo, hi, optional) => {
    const v = r[k];
    if (v === null || v === undefined) return optional ? null : `${k} missing`;
    if (typeof v !== "number" || !Number.isFinite(v) || v < lo || v > hi) return `${k} out of range`;
    return null;
  };
  // The id must look like "1718000000-1234": 1 to 13 digits, a dash, 1 to 6 digits (see runrecord.js).
  if (typeof r.id !== "string" || !/^\d{1,13}-\d{1,6}$/.test(r.id)) return "bad id";
  if (typeof r.name !== "string" || r.name.length > 80) return "bad name";
  const bad = num("date", Date.UTC(2000, 0, 1), now + HI_DAY) || num("km", 1, 400) || num("gain", 0, 25000)
    || num("movingSec", 60, 7 * 86400) || num("elapsedSec", 60, 8 * 86400)
    || num("gapPace", 120, 3600, true) || num("hrAvg", 30, 230, true) || num("fadePct", -100, 100, true)
    || num("decouplingPct", -100, 100, true) || num("vam", 0, 2500, true)
    || num("best1k", 130, 3600, true) || num("best5k", 750, 18000, true) || num("best10k", 1570, 36000, true);
  if (bad) return bad;
  if (r.movingSec / r.km < 150) return "faster than 2:30 /km on average";
  if (r.gain / (r.movingSec / 3600) > 2500) return "climbs faster than 2,500 m/h on average";
  if (r.elapsedSec < r.movingSec) return "moving time longer than the clock";
  return null;
}

/**
 * What an AI analysis receives: the run summaries as a compact table (one line per run, newest
 * first, at most `max` runs) plus the athlete settings. No names, no GPS points, no email.
 * Shown to the user before they spend a cairn, and built the same way on the server.
 */
export function aiDigest(records, athlete = {}, max = 300) {
  // Keep only believable runs (checkRecord returns null for them), newest first, at most `max`.
  // f(v, d): a number as text with d decimals, or "" when missing. Each run becomes one line of
  // comma-separated values (CSV) under the header line; the date is cut to "YYYY-MM-DD".
  // pick(k, lo, hi): an athlete setting, only when it is a plausible number.
  const list = records.filter((r) => !checkRecord(r)).sort((a, b) => b.date - a.date).slice(0, max);
  const f = (v, d = 0) => (v === null || v === undefined || !Number.isFinite(v) ? "" : v.toFixed(d));
  const head = "date,km,gain_m,moving_min,elapsed_min,gap_pace_s_per_km,hr_avg,fade_pct,decoupling_pct,vam_m_per_h,best_1k_s,best_5k_s,best_10k_s";
  const rows = list.map((r) => [new Date(r.date).toISOString().slice(0, 10), f(r.km, 1), f(r.gain), f(r.movingSec / 60), f(r.elapsedSec / 60),
    f(r.gapPace), f(r.hrAvg), f(r.fadePct, 1), f(r.decouplingPct, 1), f(r.vam), f(r.best1k), f(r.best5k), f(r.best10k)].join(","));
  const pick = (k, lo, hi) => (typeof athlete[k] === "number" && athlete[k] >= lo && athlete[k] <= hi ? athlete[k] : null);
  return {
    athlete: { hrMax: pick("hrMax", 120, 230), hrRest: pick("hrRest", 30, 100), weight: pick("weight", 30, 200) },
    runs: list.length,
    table: [head, ...rows].join("\n"),
  };
}
