// plan.js: put it all together. Race GPX + effort GPX + a few settings => a plan.
//
// This is the conductor of the core. buildPlan() calls, in order:
//   track.js     resample the race GPX onto a 10 m grid
//   terrain.js   gradients, climbs, descents of the race (and of your run)
//   effort.js    your pace table, fresh and tired, per gradient band
//   model.js     cumulative time at every 10 m, for three scenarios
//   keyzones.js  where the race is played
// and then adds what a runner reads on race day: a tactic and a clock time for
// each climb and descent, aid-station stops, gel timing, checkpoints, a
// heart-rate guide, and the time spent in each gradient band. The UI, the CLI
// and markdown.js all read the object buildPlan() returns.
//
// Other exports: PLAN_DEFAULTS (every setting and its default), the scoring
// helpers for climbs and descents, splitClimb() (dynamic programming),
// briefCourse() (the course analysed without a runner), planFromGpx() (a
// shortcut from GPX text) and judgeTarget() (is a target time realistic?).

import { parseGpx, resample } from "./track.js";
import { analyseCourse, BANDS, bandIndex, steepest100 } from "./terrain.js";
import { analyseEffort } from "./effort.js";
import { predictAll, SCENARIOS, MODEL_DEFAULTS } from "./model.js";
import { parseClock } from "./format.js";
import { keyZones, clockFromTimeline } from "./keyzones.js";

/**
 * Every plan setting and its default. A caller passes only what it wants to
 * change; buildPlan merges it over these with object spread.
 * `...MODEL_DEFAULTS` copies terrain, enduranceExp and descentBoost from model.js.
 */
export const PLAN_DEFAULTS = {
  ...MODEL_DEFAULTS,
  // Start time of day, "HH:MM".
  startTime: "09:00",
  maxHr: null, // from the runner's profile (never from a file); sets the heart-rate guide
  restHr: null, // from the profile too; with it, the guide uses the heart-rate reserve
  hikeGrade: null, // null = learn from the effort file, else a number in %
  // Minutes between gels.
  gelEveryMin: 45,
  // A checkpoint (clock time) every this many km.
  checkpointKm: 10,
  splitClimbM: 3000, // climbs this long or longer are split into sections
  sectionMinShare: 0.15, // shortest section allowed, as a share of its climb's length
  splitClimbMinGain: 100, // ...and only if they gain at least this many metres
  climbShare: 0.1, // a rise counts as a climb when it gains this share of the race's total D+...
  climbFloorM: 100, // ...or at least this many metres; smaller rises are "bumps" (advice kept, not counted)
  halfLifeDays: 28, // with several reference runs, a run this many days older counts half as much
  aidStations: [], // [{km, name, stopMin}] or text, one per line: "8.5 Refuge du Lac 2"
  gelToAidMin: 10, // a gel due within this many minutes of an aid station is taken there
  gelMaxDelayMin: 20, // a gel waits for the top of a climb at most this long, else it is eaten on the way up
};

/**
 * Read an aid-station list typed by a person, one per line (or separated by ";"):
 *   "8.5 Refuge du Lac 2"   km, name, minutes stopped (optional, default 0)
 *   "12,6 km Col 3 min"     commas, "km" and "min" are fine
 *
 * Returns [{km, name, stopMin}] sorted by km. An array is accepted as is (only sorted).
 * A line with no name gets "Aid 1", "Aid 2"...; lines that do not start with a number are skipped.
 */
export function parseAidStations(text) {
  // Already structured (from the UI or a test): copy with [...text] so the
  // caller's array is not reordered, and sort by km.
  if (Array.isArray(text)) return [...text].sort((a, b) => a.km - b.km);
  const out = [];
  // Split on newlines or ";" (one or more in a row, so blank lines vanish).
  for (const line of String(text || "").split(/[\n;]+/)) {
    // The regex, piece by piece (\s* = optional spaces):
    //   ^\s*(\d+(?:[.,]\d+)?)        group 1: the km, "8.5" or "8,5"
    //   \s*(?:km)?                    an optional "km"
    //   \s*(.*?)                      group 2: the name, as short as possible
    //   \s*(?:(\d+(?:[.,]\d+)?)       group 3 (optional): a number at the end...
    //   \s*(?:min|mn|')?)?\s*$        ...optionally followed by "min", "mn" or "'"
    // The final "i" makes it case-insensitive ("KM", "Min").
    const m = /^\s*(\d+(?:[.,]\d+)?)\s*(?:km)?\s*(.*?)\s*(?:(\d+(?:[.,]\d+)?)\s*(?:min|mn|')?)?\s*$/i.exec(line);
    if (!m) continue;
    // French-style decimals: "12,6" becomes "12.6" before parseFloat.
    const num = (v) => parseFloat(String(v).replace(",", "."));
    out.push({ km: num(m[1]), name: m[2] || `Aid ${out.length + 1}`, stopMin: m[3] ? num(m[3]) : 0 });
  }
  return out.filter((a) => Number.isFinite(a.km)).sort((a, b) => a.km - b.km);
}

// Climb difficulty words, indexed by level 1 to 4 (index 0 is unused).
export const LEVELS = ["", "Easy", "Moderate", "Hard", "Crux"];
// The same levels as 1 to 4 stars, for the chips, legends and map titles (green, yellow, orange, red).
export const STARS = ["", "★", "★★", "★★★", "★★★★"];
// Descent risk words, keyed by descentLevel() (there is no level 3).
export const DESCENT_LABELS = { 1: "Let it run", 2: "Control", 4: "Brake" };

/**
 * Difficulty score of a climb: gain x steepness factor x fatigue factor.
 *
 * `c` needs avg (%), startKm and delta (m of gain); `totalKm` is the race length.
 *   steepness  average gradient / 8%, kept between 0.5 and 2
 *   fatigue    1.00 in the first 35% of the race, 1.15 up to 69%, 1.35 after
 * Example: 200 m at 8% in the second half: 200 x 1 x 1.15 = 230.
 * The score is a guide for where to save energy, not a physical quantity.
 */
export function climbScore(c, totalKm) {
  const steepness = Math.min(2, Math.max(0.5, c.avg / 8));
  const frac = c.startKm / totalKm;
  const fatigue = frac < 0.35 ? 1.0 : frac < 0.69 ? 1.15 : 1.35;
  return c.delta * steepness * fatigue;
}
/** Score to level: under 30 Easy (1), under 60 Moderate (2), under 90 Hard (3), else Crux (4). */
export function climbLevel(score) {
  return score < 30 ? 1 : score < 60 ? 2 : score < 90 ? 3 : 4;
}
/**
 * 4 = brake, 2 = control, 1 = let it run.
 * `d` is a descent with negative avg and steep (%): Brake when the steepest
 * 100 m reaches -20% or the average -12%; Control from -6% average or -15% steepest.
 */
export function descentLevel(d) {
  if (d.steep <= -20 || d.avg <= -12) return 4;
  if (d.avg <= -6 || d.steep <= -15) return 2;
  return 1;
}

/**
 * The tactic for one climb (or one section), as a short phrase.
 * Inputs: `c` with avg, steep (%) and delta (m); `hikeGrade` your hiking
 * threshold (%); `biggest` true for the climb with the most gain.
 * Rules are checked in order and the first that matches wins.
 */
export function climbTactic(c, hikeGrade, biggest) {
  // Average within 2 points of your hiking gradient: hike all of it.
  if (c.avg >= hikeGrade - 2) return "Hike";
  // A wall that reaches your hiking gradient over 100 m is hiked, however gentle the rest of the climb.
  if (c.steep >= hikeGrade) return "Hike the steep part";
  if (biggest) return "Biggest climb, steady";
  if (c.delta >= 60 && c.avg < 8) return "Run evenly, do not surge";
  if (c.avg < 6.5) return "Run";
  return "Steady";
}
// Descent tactic phrase, keyed by descentLevel().
const DESCENT_TACTIC = { 1: "Let it run, recover", 2: "Quick steps, stay light", 4: "Brake, short steps" };

/**
 * Split a long climb into sections that each hold a fairly even gradient.
 *
 * The cost of a section is how much its 10 m gradients scatter around the
 * section's own average (a sum of squared deviations), so cuts land where the
 * slope changes character, for example between a runnable ramp and a steep wall.
 * Dynamic programming finds the best cuts for 1, 2, 3... sections; we then keep
 * adding a section only while it pays: it must remove at least `minGainShare`
 * of the one-piece cost AND every pair of neighbouring sections must differ by
 * at least `minDiff` points of average gradient (the weight on gradient change:
 * two sections at 7% and 8% are one section). Each section is at least
 * `minShare` of the climb's length; a climb shorter than `minM` is not split.
 * Returns [[a, b], ...] sample indices, contiguous from the climb's a to b.
 *
 * Inputs: `ele` smoothed elevations (m), `a` and `b` the climb's first and last
 * sample, `step` metres per sample, options {minM, minShare, minDiff, minGainShare}.
 * Dynamic programming in one sentence: the best way to cut the first q steps
 * into j sections is the best way to cut the first p steps into j - 1
 * sections, plus one last section from p to q, for the best p. We fill a
 * table of those answers for j = 1, 2, ..., kMax, then walk back through it.
 */
export function splitClimb(ele, a, b, step, opts = {}) {
  const { minM = 3000, minShare = 0.15, minDiff = 2, minGainShare = 0.1 } = opts;
  const m = b - a; // number of 10 m steps in the climb
  if (m * step < minM) return [[a, b]];
  const minN = Math.max(1, Math.ceil(m * minShare));
  const kMax = Math.floor(m / minN);
  if (kMax < 2) return [[a, b]];
  // Prefix sums of gradient and gradient squared: any section's cost in O(1).
  const S = new Float64Array(m + 1);
  const Q = new Float64Array(m + 1);
  for (let i = 0; i < m; i++) {
    const g = ((ele[a + i + 1] - ele[a + i]) / step) * 100;
    S[i + 1] = S[i] + g;
    Q[i + 1] = Q[i] + g * g;
  }
  // Cost of a section from step p to step q: sum of squared deviations of its
  // gradients from their mean, which equals sum(g^2) - (sum(g))^2 / count.
  const cost = (p, q) => Q[q] - Q[p] - ((S[q] - S[p]) ** 2) / (q - p);
  const mean = (p, q) => (S[q] - S[p]) / (q - p);
  // best[j][q]: lowest cost to cut steps 0..q into j sections; from[j][q]: where the last one starts.
  const best = [new Float64Array(m + 1).fill(Infinity)];
  best[0][0] = 0;
  const from = [null];
  for (let j = 1; j <= kMax; j++) {
    const bj = new Float64Array(m + 1).fill(Infinity);
    const fj = new Int32Array(m + 1);
    for (let q = j * minN; q <= m; q++) {
      // Try every start p of the last section, keeping it at least minN long.
      for (let p = (j - 1) * minN; p <= q - minN; p++) {
        if (best[j - 1][p] === Infinity) continue;
        const c = best[j - 1][p] + cost(p, q);
        if (c < bj[q]) { bj[q] = c; fj[q] = p; }
      }
    }
    best.push(bj);
    from.push(fj);
  }
  // Walk back from the end through `from` to recover where each of k sections starts.
  const cutsFor = (k) => {
    const cuts = [m];
    for (let j = k, q = m; j > 1; j--) { q = from[j][q]; cuts.unshift(q); }
    cuts.unshift(0);
    return cuts;
  };
  const one = best[1][m];
  let cuts = [0, m];
  for (let k = 2; k <= kMax; k++) {
    if (best[k][m] === Infinity || best[k - 1][m] - best[k][m] < minGainShare * one) break;
    const c = cutsFor(k);
    let distinct = true;
    for (let i = 1; i + 1 < c.length; i++) if (Math.abs(mean(c[i - 1], c[i]) - mean(c[i], c[i + 1])) < minDiff) distinct = false;
    if (!distinct) break;
    cuts = c;
  }
  // Turn cut positions (steps from the climb's start) back into course sample indices.
  const out = [];
  for (let i = 0; i + 1 < cuts.length; i++) out.push([a + cuts[i], a + cuts[i + 1]]);
  return out;
}

/**
 * Every 10th sample (one per 100 m on the 10 m grid) plus the last one: the resolution of
 * the profile, the map route and the race-day replay timeline.
 */
export function coarseIndices(n, every = 10) {
  const idx = [];
  for (let i = 0; i < n; i += every) idx.push(i);
  if (idx[idx.length - 1] !== n - 1) idx.push(n - 1);
  return idx;
}

/**
 * Index of the sample where cumulative time first reaches `sec`.
 * Binary search: `cum` only grows, so we halve the search range each time
 * (about 12 steps for the 2500 samples of a 25 km course, instead of a scan).
 * `(lo + hi) >> 1` is a fast integer division by 2 (a bit shift).
 */
function indexAtTime(cum, sec) {
  let lo = 0;
  let hi = cum.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] < sec) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Match a race climb to the most similar climb in the effort file.
 *
 * Similarity is a weighted sum of differences: 3 points of gradient, 25 m of
 * gain and 400 m of length each count as 1; the lowest total wins.
 * `rs` is the resampled effort run (for its times and heart rate).
 * Returns what you did on that climb {avg, delta, lenM, paceSecPerKm, hr,
 * minutesIn (minutes from the start of the run)}, or null with no climbs.
 */
function closestEffortClimb(c, effortClimbs, rs) {
  let best = null;
  let bestScore = Infinity;
  for (const r of effortClimbs) {
    const s = Math.abs(r.avg - c.avg) / 3 + Math.abs(r.delta - c.delta) / 25 + Math.abs(r.lenM - c.lenM) / 400;
    if (s < bestScore) { bestScore = s; best = r; }
  }
  if (!best) return null;
  // Average heart rate over the matched climb (samples with a value only).
  let hrSum = 0;
  let hrN = 0;
  if (rs.hr) for (let i = best.a; i <= best.b; i++) if (rs.hr[i]) { hrSum += rs.hr[i]; hrN++; }
  const secs = (rs.time[best.b] - rs.time[best.a]) / 1000;
  return {
    avg: best.avg,
    delta: best.delta,
    lenM: best.lenM,
    paceSecPerKm: secs / (best.lenM / 1000),
    hr: hrN ? hrSum / hrN : null,
    minutesIn: (rs.time[best.a] - rs.time[0]) / 60000,
  };
}

/**
 * Race briefing: everything the course alone tells us, before knowing who runs it.
 * Climbs (long ones split into sections) with their difficulty score, and descents
 * with their risk level. Each item keeps `delta` (signed metres) and sample indices a, b.
 *
 * Input: `course` from analyseCourse(), `userParams` overrides of PLAN_DEFAULTS
 * (only the climb-splitting settings are used here).
 * Returns {totalKm, gain, loss, climbs, descents, minClimb}. A climb is {n, label, bump,
 * startKm, endKm, lenM, delta, gain, avg, steep, score, level, a, b, sections}; a
 * section has the same fields with n like "2.1". A descent is {n, startKm,
 * endKm, lenM, delta, loss, avg, steep, level, a, b}.
 */
export function briefCourse(course, userParams = {}) {
  const params = { ...PLAN_DEFAULTS, ...userParams };
  const total = course.totalKm;
  const kmAt = (idx) => (idx * course.step) / 1000;
  // Measure and score the stretch from sample a to sample b, numbered n.
  const rate = (n, a, b) => {
    const lenM = (b - a) * course.step;
    const delta = course.ele[b] - course.ele[a];
    const c = { n, startKm: kmAt(a), endKm: kmAt(b), lenM, delta, gain: delta, avg: (delta / lenM) * 100, steep: steepest100(course.ele, a, b, course.step), a, b };
    // Scored the same way whether it is a whole climb or a section of one.
    c.score = climbScore(c, total);
    c.level = climbLevel(c.score);
    return c;
  };
  // Whole climbs keep the steepest-100 m value analyseCourse already measured.
  // A climb long enough that also gains enough gets sections from splitClimb.
  // Climb or bump: a rise is a climb when it gains at least climbShare of the total D+, or
  // climbFloorM metres whatever the race (so on a hilly race every 100 m rise counts).
  // Bumps keep their tactic and race-script cue but are not counted or numbered as climbs:
  // they are numbered on their own ("b1", "b2"...) so a bump never shares a number with a climb.
  const minClimb = Math.min(params.climbShare * course.gain, params.climbFloorM);
  let nc = 0;
  let nb = 0;
  const climbs = course.climbs.map((c) => {
    const bump = c.delta < minClimb;
    const n = bump ? `b${++nb}` : ++nc;
    const r = { ...rate(n, c.a, c.b), steep: c.steep, bump, label: bump ? `Bump ${nb}` : `Climb ${nc}` };
    // A climb that splitClimb keeps in one piece has no sections (it is its own only section).
    const parts = !bump && c.delta >= params.splitClimbMinGain
      ? splitClimb(course.ele, c.a, c.b, course.step, { minM: params.splitClimbM, minShare: params.sectionMinShare })
      : [];
    r.sections = parts.length > 1 ? parts.map(([a, b], j) => rate(`${n}.${j + 1}`, a, b)) : [];
    return r;
  });
  const descents = course.descents.map((d, i) => ({
    n: i + 1, startKm: d.startKm, endKm: d.startKm + d.lenM / 1000, lenM: d.lenM, delta: d.delta, loss: -d.delta,
    avg: d.avg, steep: d.steep, level: descentLevel(d), a: d.a, b: d.b,
  }));
  return { totalKm: total, gain: course.gain, loss: course.loss, climbs, descents, minClimb };
}

/**
 * Build the plan from two already-parsed GPX tracks.
 *
 * Inputs: `raceParsed` and `effortParsed` from parseGpx() (the effort can be
 * an array of runs), `userParams` overrides of PLAN_DEFAULTS.
 * Returns the plan:
 *   params        the settings used (with the hiking gradient actually used)
 *   startSec      start time, seconds since midnight
 *   course        {totalKm, gain, loss, climbCount, descentCount,
 *                  profile [[km, ele]] every 100 m, route [[lat, lon]] or null}
 *   effort        the effort profile (see effort.js), without the raw samples
 *   bandUse       km and seconds spent in each gradient band (central, moving time)
 *   hrGuide       three heart-rate phases, or null without a max heart rate in the profile
 *   keyZones      see keyzones.js
 *   aidStations   [{km, name, stopMin, arrive: {best, central, cautious} (s)}]
 *   scenarios     {best, central, cautious}: {id, label, finishSec, factor,
 *                  durationFactor, gels, checkpoints, timeline}
 *   climbs        briefing climbs plus tactic, start / dur per scenario, effortMatch
 *   descents      briefing descents plus tactic and start / dur per scenario
 */
export function buildPlan(raceParsed, effortParsed, userParams = {}) {
  const params = { ...PLAN_DEFAULTS, ...userParams };
  // 1. Analyse the race, your run(s), and predict the three scenarios.
  const raceRs = resample(raceParsed, 10);
  const course = analyseCourse(raceRs);
  const effort = analyseEffort(effortParsed, { halfLifeDays: params.halfLifeDays });
  const effortCourse = analyseCourse(effort.resampled);
  const preds = predictAll(course, effort, params);
  const rawCentral = preds.central.cum; // moving time only, for the time-per-gradient table

  // 2. Aid stations: the stop is added to every clock time after the station.
  // Each station gets `idx`, the 10 m sample nearest to its km.
  const aid = parseAidStations(params.aidStations)
    .filter((a) => a.km >= 0 && a.km <= course.totalKm)
    .map((a) => ({ ...a, idx: Math.min(course.n - 1, Math.round((a.km * 1000) / course.step)) }));
  // For each scenario, rebuild `cum` with a running total of stop time
  // (`extra`) that grows as each station is passed. `k` points to the next station.
  if (aid.length) {
    for (const sc of SCENARIOS) {
      const p = preds[sc.id];
      const cum = new Float64Array(p.cum.length);
      let extra = 0;
      let k = 0;
      for (let i = 0; i < cum.length; i++) {
        cum[i] = p.cum[i] + extra;
        while (k < aid.length && aid[k].idx === i) { extra += aid[k].stopMin * 60; k++; }
      }
      preds[sc.id] = { ...p, cum, finishSec: cum[cum.length - 1] };
    }
  }
  const startSec = parseClock(params.startTime);
  // 3. The hiking gradient: your setting, else learned from cadence, else 15%.
  // `??` picks the right side only when the left is null or undefined (unlike
  // `||`, it keeps a real 0).
  const hikeGrade = params.hikeGrade ?? effort.hikeGrade ?? 15;
  const total = course.totalKm;
  const kmAt = (idx) => (idx * course.step) / 1000;

  // Gain of the biggest climb (0 when there are none), to flag "Biggest climb".
  const maxGain = Math.max(...course.climbs.map((c) => c.delta), 0);
  // Clock offset at sample a and duration from a to b, for each scenario:
  // {start: {best, central, cautious}, dur: {...}}. Object.fromEntries builds an
  // object from [key, value] pairs.
  const timing = (a, b) => ({
    start: Object.fromEntries(SCENARIOS.map((s) => [s.id, preds[s.id].cum[a]])),
    dur: Object.fromEntries(SCENARIOS.map((s) => [s.id, preds[s.id].cum[b] - preds[s.id].cum[a]])),
  });
  // The briefing rates the terrain; the plan adds what depends on you: tactic, timing, closest climb in your run.
  const brief = briefCourse(course, params);
  // 4. A briefing climb (or section) plus what depends on you.
  const forRace = (c, biggest) => ({
    ...c,
    tactic: climbTactic(c, hikeGrade, biggest),
    ...timing(c.a, c.b),
    effortMatch: closestEffortClimb(c, effortClimbsOf(effortCourse), effort.resampled),
  });
  // "Biggest climb" only applies when it gains at least 60 m.
  const climbs = brief.climbs.map((c) => ({
    ...forRace(c, c.delta === maxGain && c.delta >= 60),
    sections: c.sections.map((x) => forRace(x, false)),
  }));
  const descents = brief.descents.map((d) => ({ ...d, tactic: DESCENT_TACTIC[d.level], ...timing(d.a, d.b) }));

  // 5. Where the gel lands: every N minutes, but never in the middle of a climb or a braking descent.
  // `segs` = the stretches a gel should avoid: every climb, and the "Brake" descents.
  const segs = [...climbs.map((c) => ({ ...c, kind: "climb" })), ...descents.filter((d) => d.level === 4).map((d) => ({ ...d, kind: "descent" }))];
  const coarse = coarseIndices(course.n);
  const scenarios = {};
  for (const s of SCENARIOS) {
    const pr = preds[s.id];
    // Gels: {km, sec (since the start), moved (true when not at the due time), at (aid name) or where}.
    const gels = [];
    // the clock restarts at each gel actually taken, so a gel moved earlier or later shifts the next ones
    const every = params.gelEveryMin * 60;
    // t = the time the next gel is due. No gel in the last 15 minutes of the race.
    for (let t = every; t < pr.finishSec - 15 * 60; t = Math.max(t, gels.length ? gels[gels.length - 1].sec : 0) + every) {
      let idx = indexAtTime(pr.cum, t);
      // An aid station close in time wins: eat there, with a drink at hand.
      const near = aid.find((a) => Math.abs(pr.cum[a.idx] - t) <= params.gelToAidMin * 60);
      const last = gels.length ? gels[gels.length - 1].sec : -Infinity;
      if (near) {
        if (pr.cum[near.idx] > last) gels.push({ km: kmAt(near.idx), sec: pr.cum[near.idx], moved: true, at: near.name });
        continue;
      }
      // Take it at the top, or at the bottom of the descent; on a climb too long to wait for the
      // top (more than gelMaxDelayMin away), at the end of the current section, else right there.
      // A gel moved earlier or later than another one is never taken twice at the same spot.
      // `soon(j)`: sample j is reached within gelMaxDelayMin of the due time.
      // `[idx, where] = [x, y]` is destructuring: it sets both variables at once.
      const inside = segs.find((g) => idx > g.a && idx < g.b);
      let where = null; // why it moved: "top", "bottom", "section", "before descent", or "on the climb"
      if (inside) {
        const soon = (j) => pr.cum[j] - t <= params.gelMaxDelayMin * 60;
        const sec = (inside.sections || []).find((x) => idx > x.a && idx < x.b);
        if (soon(inside.b)) [idx, where] = [inside.b, inside.kind === "climb" ? "top" : "bottom"];
        else if (inside.kind === "descent") [idx, where] = [inside.a, "before descent"]; // a long technical descent: eat just before dropping in
        else if (sec && soon(sec.b)) [idx, where] = [sec.b, "section"];
        else where = "on the climb";
      }
      if (pr.cum[idx] > pr.finishSec - 15 * 60) break; // moved too close to the finish: not worth it
      if (pr.cum[idx] <= last) continue; // already eating there
      gels.push({ km: kmAt(idx), sec: pr.cum[idx], moved: idx !== indexAtTime(pr.cum, t), where });
    }
    // 6. Checkpoints every checkpointKm (none in the last km), then the finish.
    const checkpoints = [];
    for (let km = params.checkpointKm; km < total - 1; km += params.checkpointKm) {
      checkpoints.push({ km, sec: pr.cum[Math.min(course.n - 1, Math.round((km * 1000) / course.step))], label: `km ${km}` });
    }
    checkpoints.push({ km: total, sec: pr.finishSec, label: "Finish" });
    // Clock (seconds since the start, stops included) every 100 m: what the race-day replay plays back.
    const timeline = coarse.map((i) => Math.round(pr.cum[i]));
    scenarios[s.id] = { id: s.id, label: s.label, finishSec: pr.finishSec, factor: pr.factor, durationFactor: pr.durationFactor, gels, checkpoints, timeline };
  }

  // 7. Heart-rate guide, from the runner's PROFILE only (heart rate is never read from a GPX
  // file). Three phases with the same 35% / 69% boundaries as the climb fatigue factor, each a
  // ceiling that rises as the race goes on. With a resting heart rate too, the ceilings are taken
  // on the heart-rate reserve (Karvonen: rest + share x (max - rest)), which fits each runner
  // better; with the max alone, they are a share of the max.
  //   phase   reserve share   share of max
  //   early   65%             75%
  //   middle  72%             80%
  //   late    80%             86%   ("if legs allow")
  let hrGuide = null;
  if (params.maxHr) {
    const max = params.maxHr, rest = params.restHr;
    const at = (hrr, pmax) => Math.round(rest ? rest + hrr * (max - rest) : pmax * max);
    const [e, m, l] = [at(0.65, 0.75), at(0.72, 0.8), at(0.8, 0.86)];
    hrGuide = [
      // bpm: the value to expect in that phase (just under the ceiling), for the race-day forecast
      { fromKm: 0, toKm: total * 0.35, text: `${e} or lower`, bpm: e - 3 },
      { fromKm: total * 0.35, toKm: total * 0.69, text: `${e} to ${m}`, bpm: Math.round((e + m) / 2) },
      { fromKm: total * 0.69, toKm: total, text: `up to ${l} if legs allow`, bpm: Math.round((m + l) / 2) },
    ];
  }

  // 8. Time on each gradient band for the central scenario.
  // Uses rawCentral (moving time, before aid stops) so stops are not counted as running.
  const bandUse = BANDS.map((b) => ({ id: b.id, label: b.label, km: 0, sec: 0 }));
  const cc = rawCentral;
  for (let i = 0; i < course.n - 1; i++) {
    const bi = bandIndex(course.grade[i]);
    bandUse[bi].km += course.step / 1000;
    bandUse[bi].sec += cc[i + 1] - cc[i];
  }

  // 9. Elevation profile every 100 m: [[km, elevation in m], ...].
  const profile = coarse.map((i) => [kmAt(i), course.ele[i]]);
  // [lat, lon] at the same points as the profile, for the map. Null when the GPX has no positions.
  // toFixed(6) keeps 6 decimals (about 0.1 m); the leading + turns the text back into a number.
  const route = raceRs.lat ? coarse.map((i) => [+raceRs.lat[i].toFixed(6), +raceRs.lon[i].toFixed(6)]) : null;

  return {
    params: { ...params, hikeGrade },
    startSec,
    course: { totalKm: total, gain: course.gain, loss: course.loss, climbCount: climbs.filter((c) => !c.bump).length, descentCount: descents.length, profile, route },
    effort: {
      durationSec: effort.durationSec,
      distKm: effort.distKm,
      flatPace: effort.flatPace,
      flatHr: effort.flatHr,
      flatCad: effort.flatCad,
      avgHr: effort.avgHr,
      maxHrSeen: effort.maxHrSeen,
      cadenceWasPerFoot: effort.cadenceWasPerFoot,
      hikeGrade: effort.hikeGrade,
      drift: effort.drift,
      bands: effort.bands,
      runs: effort.runs,
    },
    bandUse,
    hrGuide,
    // Where the race is played, from your predicted (central) time on each stretch.
    keyZones: keyZones({ totalKm: total, climbs, descents }, profile, aid, clockFromTimeline(profile, scenarios.central.timeline)),
    aidStations: aid.map((a) => ({
      km: a.km, name: a.name, stopMin: a.stopMin,
      arrive: Object.fromEntries(SCENARIOS.map((sc) => [sc.id, preds[sc.id].cum[a.idx]])),
    })),
    scenarios,
    climbs,
    descents,
  };
}

// Climbs of the effort run with 10 m of gain or more, computed once per
// analysed run. A WeakMap is a cache keyed by the object itself; when the
// object is no longer used, its entry is freed automatically.
const effortClimbCache = new WeakMap();
/** The climbs of an analysed effort run that can be matched to race climbs (cached). */
function effortClimbsOf(effortCourse) {
  if (!effortClimbCache.has(effortCourse)) effortClimbCache.set(effortCourse, effortCourse.climbs.filter((c) => c.delta >= 10));
  return effortClimbCache.get(effortCourse);
}

/** Convenience: from GPX strings (the effort can be one string or an array of them). */
export function planFromGpx(raceXml, effortXml, params = {}) {
  const efforts = Array.isArray(effortXml) ? effortXml.map(parseGpx) : parseGpx(effortXml);
  return buildPlan(parseGpx(raceXml), efforts, params);
}

/**
 * Check a finish time the runner is aiming for against the three scenarios of the plan.
 * The scenarios already span the likely range (best -3.5%, cautious +3.5% around central); a model
 * like this one is also usually within 5 to 10%, so a target a little faster than the best case
 * is still possible on a great day, but one more than 5% faster than it is not backed by the runs.
 * Returns null without a target, else {targetSec, verdict, ok, vsCentralPct, paceSec, centralPaceSec}:
 *   verdict "out-of-reach" | "ambitious" | "realistic" | "comfortable"; ok = false only out of reach;
 *   vsCentralPct > 0 means the target needs that much faster than the central scenario;
 *   paceSec is the average pace (s/km, stops included) the target needs.
 */
export function judgeTarget(plan, targetSec) {
  if (!plan || !Number.isFinite(targetSec) || targetSec <= 0) return null;
  const { best, central, cautious } = plan.scenarios;
  const km = plan.course.totalKm;
  // A chain of ternaries, read top to bottom: the first true condition wins.
  //   more than 5% faster than best   out of reach
  //   faster than best                ambitious
  //   up to the cautious time         realistic
  //   slower than cautious            comfortable
  const verdict = targetSec < best.finishSec * 0.95 ? "out-of-reach"
    : targetSec < best.finishSec ? "ambitious"
    : targetSec <= cautious.finishSec ? "realistic"
    : "comfortable";
  return {
    targetSec,
    verdict,
    ok: verdict !== "out-of-reach",
    vsCentralPct: (central.finishSec / targetSec - 1) * 100,
    paceSec: targetSec / km,
    centralPaceSec: central.finishSec / km,
  };
}
