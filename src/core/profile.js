// profile.js: the runner's profile behind the Account window: a presentation (name, country
// flag, a few words, badges), goals and bests on 5 distances, and lines of their own data.
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

export const PROFILE_DISTANCES = [
  { code: "5k", label: "5K", km: 5 },
  { code: "10k", label: "10K", km: 10 },
  { code: "20k", label: "20K", km: 20 },
  { code: "50k", label: "50K", km: 50 },
  { code: "100k", label: "100K", km: 100 },
];

export const PROFILE_LIMITS = { name: 40, about: 280, tags: 5, extra: 12, label: 30, value: 60 };

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
 *     extra: [{ label, value }] }
 * Texts are cut to their limits and turned into one line (except `about`, which keeps line
 * breaks), unknown flags and badges are dropped, times are whole seconds between 1 minute and
 * 7 days, or null. Lines of own data with neither label nor value are dropped.
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
    extra: Array.isArray(r.extra)
      ? r.extra.map((x) => ({ label: str(x && x.label, L.label), value: str(x && x.value, L.value) })).filter((x) => x.label || x.value).slice(0, L.extra)
      : [],
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
