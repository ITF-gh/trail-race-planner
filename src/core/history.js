// history.js: the run log behind the account menu. Each run you analyse becomes a small summary
// (about 1 KB: date, distance, climbing, best efforts...), never the GPX itself. From the list
// of summaries this file computes the menu: totals over the last 12 months, all-time bests, the
// last runs, the achievements and the cairns they earn.
//
// Pure functions only: storing the summaries (IndexedDB in the browser, and the account database
// when signed in) is the UI's job. runRecord (src/core/runrecord.js) builds a summary from a run.

// This file has NO imports on purpose: the server (supabase/functions/_shared/history.js, a copy
// made by the build) runs the very same achievements and checks before it pays out a cairn.

export const HISTORY_VERSION = 1; // bump when a summary field changes meaning, to know which runs to recompute

const HI_DAY = 86400000;
// Calendar months in UTC, so the browser and the server always agree on which month a run is in.
const hiMonth = (ms) => { const d = new Date(ms); return `${d.getUTCFullYear()}-${d.getUTCMonth()}`; };

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

/**
 * Is this summary believable? The server only counts runs that pass, so a hand-made summary
 * cannot unlock an achievement with impossible numbers. Limits sit just beyond world records
 * (1 km in 2:11, 5 km in 12:35, 10 km in 26:11) and human climbing speeds. Returns null when
 * the run is fine, or the reason it is not.
 */
export function checkRecord(r, now = Date.now()) {
  if (!r || typeof r !== "object") return "not a run";
  const num = (k, lo, hi, optional) => {
    const v = r[k];
    if (v === null || v === undefined) return optional ? null : `${k} missing`;
    if (typeof v !== "number" || !Number.isFinite(v) || v < lo || v > hi) return `${k} out of range`;
    return null;
  };
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

/** The axes of analysis the runner can pick for an AI analysis (the server accepts only these). */
export const AI_FOCUS = [
  { code: "overall", label: "Overall progress", brief: "the overall picture: trends, form and what changed" },
  { code: "endurance", label: "Endurance", brief: "endurance and durability: fade, heart drift, long runs" },
  { code: "climbing", label: "Climbing", brief: "climbing: climbing speed, gradients, hiking against running uphill" },
  { code: "speed", label: "Speed", brief: "speed: fastest 1, 5 and 10 km and pace on flat ground" },
  { code: "heart", label: "Heart rate", brief: "heart rate and aerobic fitness: efficiency, drift, intensity" },
  { code: "race", label: "Race prep", brief: "preparing the next race: what the log says about readiness" },
  { code: "load", label: "Load & recovery", brief: "training load and recovery: volume, rhythm, rest, injury risk" },
];
export const AI_QUESTION_MAX = 300;

/**
 * Clean what the runner asked for (shared by the app and the server, which never trusts the app):
 * { from, to } = a date range in ms, or ids = a list of chosen runs; focus = an AI_FOCUS code;
 * question = their own words, one line, at most AI_QUESTION_MAX characters.
 */
export function aiAsk(raw = {}) {
  const r = raw && typeof raw === "object" ? raw : {};
  const day = (v) => (typeof v === "number" && Number.isFinite(v) && v > 0 && v < 4102444800000 ? v : null);
  const ids = Array.isArray(r.ids) ? [...new Set(r.ids.filter((x) => typeof x === "string" && /^\d{1,13}-\d{1,6}$/.test(x)))].slice(0, 300) : null;
  const focus = AI_FOCUS.some((f) => f.code === r.focus) ? r.focus : "overall";
  // eslint-disable-next-line no-control-regex
  const question = typeof r.question === "string" ? r.question.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, AI_QUESTION_MAX) : "";
  return { from: ids && ids.length ? null : day(r.from), to: ids && ids.length ? null : day(r.to), ids: ids && ids.length ? ids : null, focus, question };
}

/** The runs an ask covers: the chosen ones, or those inside the date range (both ends included). */
export function aiSelect(records, ask) {
  const a = aiAsk(ask);
  if (a.ids) { const want = new Set(a.ids); return records.filter((r) => want.has(r.id)); }
  return records.filter((r) => (a.from === null || r.date >= a.from) && (a.to === null || r.date < a.to + 86400000));
}
