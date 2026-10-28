// profile.js: the runner's profile behind the Account window: a presentation (name, country
// flag, a few words, badges) and goals and bests on 5 distances.
//
// Pure functions only: storing the profile (localStorage in the browser) and drawing the window
// is src/ui/profile.js's job. The heart rates and the weight are not here: they stay in the
// athlete settings ("trp.athlete"), shared with the deep dive, the plan and the AI analysis.
//
// Main exports:
//   PROFILE_DISTANCES   the 5 distances of the goals table (5K to 100K)
//   PROFILE_COUNTRIES   the countries offered for the flag, PROFILE_TAGS the badges
//   flagEmoji           a country code ("FR") as its flag emoji
//   profileClean        any saved or typed profile, made safe and complete
//   profileBests        the best time on each distance, from the run log
//   PROFILE_LIMITS      the size limits (characters and counts)

import { refsClean, REF_LEVELS } from "./refs.js";

export const PROFILE_DISTANCES = [
  { code: "5k", label: "5K", km: 5 },
  { code: "10k", label: "10K", km: 10 },
  { code: "20k", label: "20K", km: 20 },
  { code: "50k", label: "50K", km: 50 },
  { code: "100k", label: "100K", km: 100 },
];

export const PROFILE_LIMITS = { name: 40, about: 280, tags: 5 };

/**
 * "Tune my engine" (signed-in runners only, Boss's rule 2026-10-28): your own settings for the
 * race-plan engine, saved with the profile. Each entry is [default, lowest, highest]:
 *   level    % on every pace (-15 faster to +15 slower)
 *   fatigue  % of the measured fresh-to-tired gap (100 = as your runs show it)
 *   k        race-length fade exponent (model.js enduranceExp)
 *   gapExp   how fast the tired gap grows with race length (model.js gapExp)
 *   night    % slower in the dark
 *   bands    per gradient band, [fresh %, tired %] on top of your measured pace (-30 to +50)
 * `on` false keeps the settings but plans as if they were not there.
 */
export const TUNE_RANGE = { level: [0, -15, 15], fatigue: [100, 0, 250], k: [0.05, 0, 0.15], gapExp: [0.5, 0, 1], night: [8, 0, 25] };
export const TUNE_BAND = [-30, 50];

/** A clean tuning object from anything (defaults for what is missing or out of range). */
export function tuneClean(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const num = (v, [d, lo, hi]) => (Number.isFinite(v) && v >= lo && v <= hi ? Math.round(v * 1000) / 1000 : d);
  const out = { on: r.on === true };
  for (const [k, range] of Object.entries(TUNE_RANGE)) out[k] = num(r[k], range);
  const band = (v) => num(v, [0, ...TUNE_BAND]);
  out.bands = Array.from({ length: 10 }, (_, i) => {
    const b = Array.isArray(r.bands) && Array.isArray(r.bands[i]) ? r.bands[i] : [];
    return [band(b[0]), band(b[1])];
  });
  return out;
}

/** True when the tuning changes nothing (every setting at its default). */
export const tuneIsDefault = (t) => Object.entries(TUNE_RANGE).every(([k, [d]]) => t[k] === d) && t.bands.every(([f, x]) => f === 0 && x === 0);

// The countries for the flag: [ISO 3166 code, name]. A short list of trail-running countries
// first, the rest alphabetical; easy to extend.
export const PROFILE_COUNTRIES = [
  ["FR", "France"], ["CH", "Switzerland"], ["IT", "Italy"], ["ES", "Spain"], ["BE", "Belgium"],
  ["DE", "Germany"], ["AT", "Austria"], ["GB", "United Kingdom"], ["US", "United States"], ["CA", "Canada"],
  ["AD", "Andorra"], ["AR", "Argentina"], ["AU", "Australia"], ["BR", "Brazil"], ["CL", "Chile"],
  ["CN", "China"], ["CZ", "Czechia"], ["DK", "Denmark"], ["FI", "Finland"], ["GR", "Greece"],
  ["HK", "Hong Kong"], ["IE", "Ireland"], ["IN", "India"], ["JP", "Japan"], ["KE", "Kenya"],
  ["LU", "Luxembourg"], ["MA", "Morocco"], ["MC", "Monaco"], ["MX", "Mexico"], ["NL", "Netherlands"],
  ["NO", "Norway"], ["NP", "Nepal"], ["NZ", "New Zealand"], ["PL", "Poland"], ["PT", "Portugal"],
  ["RE", "Réunion"], ["SE", "Sweden"], ["SI", "Slovenia"], ["SK", "Slovakia"], ["TN", "Tunisia"],
  ["ZA", "South Africa"],
];

// The badges a runner can pin on their profile (at most PROFILE_LIMITS.tags).
export const PROFILE_TAGS = [
  { code: "trail", icon: "🌲", label: "Trail runner" },
  { code: "ultra", icon: "🧭", label: "Ultra runner" },
  { code: "sky", icon: "⛰", label: "Skyrunner" },
  { code: "road", icon: "🛣", label: "Road runner" },
  { code: "climber", icon: "🐐", label: "Mountain goat" },
  { code: "downhill", icon: "🏂", label: "Downhill bomber" },
  { code: "hiker", icon: "🥾", label: "Power hiker" },
  { code: "night", icon: "🌙", label: "Night owl" },
  { code: "early", icon: "🌅", label: "Early bird" },
  { code: "snow", icon: "❄", label: "Snow lover" },
  { code: "mud", icon: "💧", label: "Mud lover" },
  { code: "dog", icon: "🐕", label: "Runs with a dog" },
  { code: "coach", icon: "📣", label: "Coach" },
  { code: "new", icon: "🌱", label: "New to trail" },
];

/**
 * A country code as its flag emoji. A flag emoji is two "regional indicator" letters: 🇫 + 🇷 = 🇫🇷.
 * Each letter A..Z maps to the code point 0x1F1E6 + (its position in the alphabet), and
 * String.fromCodePoint builds the two characters. Returns "" for anything that is not 2 letters.
 */
export function flagEmoji(code) {
  if (typeof code !== "string" || !/^[A-Z]{2}$/.test(code)) return "";
  return String.fromCodePoint(...[...code].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}

/**
 * Any profile (saved, typed, or nothing at all) made safe and complete:
 *   { name, flag ("FR" or ""), about, tags: [codes], goals: { "5k": { goal, best } ... },
 *     refs: { k10, half, easy }, level }
 * Texts are cut to their limits and turned into one line (except `about`, which keeps line
 * breaks), unknown flags and badges are dropped, times are whole seconds between 1 minute and
 * 7 days, or null. Anything else (like the "My data" lines of older versions, removed on
 * 2026-10-17) is dropped, so it leaves the device's copy at the next save.
 */
export function profileClean(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const L = PROFILE_LIMITS;
  // str(v, max, multi): a trimmed text, at most `max` characters; control characters removed,
  // and line breaks too unless `multi`.
  const str = (v, max, multi = false) => (typeof v === "string" ? v : "")
    .replace(multi ? /[\u0000-\u0009\u000b-\u001f\u007f]/g : /[\u0000-\u001f\u007f]+/g, multi ? "" : " ").trim().slice(0, max);
  const sec = (v) => (Number.isFinite(v) && v >= 60 && v <= 7 * 86400 ? Math.round(v) : null);
  const codes = new Set(PROFILE_COUNTRIES.map(([c]) => c));
  const tagCodes = new Set(PROFILE_TAGS.map((t) => t.code));
  const goals = {};
  for (const d of PROFILE_DISTANCES) {
    const g = r.goals && r.goals[d.code] ? r.goals[d.code] : {};
    goals[d.code] = { goal: sec(g.goal), best: sec(g.best) };
  }
  return {
    name: str(r.name, L.name),
    flag: codes.has(r.flag) ? r.flag : "",
    about: str(r.about, L.about, true),
    // [...new Set(list)] drops duplicates; filter keeps known badges only.
    tags: Array.isArray(r.tags) ? [...new Set(r.tags)].filter((t) => tagCodes.has(t)).slice(0, L.tags) : [],
    goals,
    // Your references for the engine (refs.js): 10K, half, easy pace, and the level of the next
    // run in Prep my run (REF_LEVELS, 1 Recovery to 5 Race).
    refs: refsClean(r.refs),
    level: REF_LEVELS.includes(r.level) ? r.level : "easy",
    tune: tuneClean(r.tune),
  };
}

/**
 * The best time on each distance of the goals table, from the run log (summaries of history.js).
 *   5K and 10K: the fastest 5 or 10 km stretch inside any run (best5k, best10k).
 *   20K, 50K, 100K: the fastest whole run (clock time, stops included) whose distance is within
 *   7% below to 10% above that distance, since trail distances are rarely exact.
 * Returns { "5k": { sec, date, km } or null, ... }. A trail time depends on its climbing, so the
 * window shows the run's distance and date beside it.
 */
export function profileBests(records) {
  const out = {};
  for (const d of PROFILE_DISTANCES) {
    let best = null;
    for (const r of records || []) {
      let sec = null;
      if (d.code === "5k") sec = r.best5k;
      else if (d.code === "10k") sec = r.best10k;
      else if (r.km >= d.km * 0.93 && r.km <= d.km * 1.1) sec = r.elapsedSec;
      if (Number.isFinite(sec) && sec > 0 && (!best || sec < best.sec)) best = { sec, date: r.date, km: r.km };
    }
    out[d.code] = best;
  }
  return out;
}
