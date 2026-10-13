// plan.js: put it all together. Race GPX + effort GPX + a few settings => a plan.

import { parseGpx, resample } from "./track.js";
import { analyseCourse, BANDS, bandIndex, steepest100 } from "./terrain.js";
import { analyseEffort } from "./effort.js";
import { predictAll, SCENARIOS, MODEL_DEFAULTS } from "./model.js";
import { parseClock } from "./format.js";

export const PLAN_DEFAULTS = {
  ...MODEL_DEFAULTS,
  startTime: "09:00",
  maxHr: null, // optional; caps the heart-rate guide at 92% of this value
  hikeGrade: null, // null = learn from the effort file, else a number in %
  gelEveryMin: 45,
  checkpointKm: 10,
  splitClimbM: 3000, // climbs this long or longer are split into sections
  sectionMinM: 1500, // shortest section allowed
  splitClimbMinGain: 100, // ...and only if they gain at least this many metres
  halfLifeDays: 28, // with several reference runs, a run this many days older counts half as much
  aidStations: [], // [{km, name, stopMin}] or text, one per line: "8.5 Refuge du Lac 2"
  gelToAidMin: 10, // a gel due within this many minutes of an aid station is taken there
};

/**
 * Read an aid-station list typed by a person, one per line (or separated by ";"):
 *   "8.5 Refuge du Lac 2"   km, name, minutes stopped (optional, default 0)
 *   "12,6 km Col 3 min"     commas, "km" and "min" are fine
 */
export function parseAidStations(text) {
  if (Array.isArray(text)) return [...text].sort((a, b) => a.km - b.km);
  const out = [];
  for (const line of String(text || "").split(/[\n;]+/)) {
    const m = /^\s*(\d+(?:[.,]\d+)?)\s*(?:km)?\s*(.*?)\s*(?:(\d+(?:[.,]\d+)?)\s*(?:min|mn|')?)?\s*$/i.exec(line);
    if (!m) continue;
    const num = (v) => parseFloat(String(v).replace(",", "."));
    out.push({ km: num(m[1]), name: m[2] || `Aid ${out.length + 1}`, stopMin: m[3] ? num(m[3]) : 0 });
  }
  return out.filter((a) => Number.isFinite(a.km)).sort((a, b) => a.km - b.km);
}

export const LEVELS = ["", "Easy", "Moderate", "Hard", "Crux"];
export const DESCENT_LABELS = { 1: "Let it run", 2: "Control", 4: "Brake" };

/** Difficulty score of a climb: gain x steepness factor x fatigue factor. */
export function climbScore(c, totalKm) {
  const steepness = Math.min(2, Math.max(0.5, c.avg / 8));
  const frac = c.startKm / totalKm;
  const fatigue = frac < 0.35 ? 1.0 : frac < 0.69 ? 1.15 : 1.35;
  return c.delta * steepness * fatigue;
}
export function climbLevel(score) {
  return score < 30 ? 1 : score < 60 ? 2 : score < 90 ? 3 : 4;
}
/** 4 = brake, 2 = control, 1 = let it run. */
export function descentLevel(d) {
  if (d.steep <= -20 || d.avg <= -12) return 4;
  if (d.avg <= -6 || d.steep <= -15) return 2;
  return 1;
}

export function climbTactic(c, hikeGrade, biggest) {
  if (c.avg >= hikeGrade - 2) return "Hike";
  // A wall that reaches your hiking gradient over 100 m is hiked, however gentle the rest of the climb.
  if (c.steep >= hikeGrade) return "Hike the steep part";
  if (biggest) return "Biggest climb, steady";
  if (c.delta >= 60 && c.avg < 8) return "Run evenly, do not surge";
  if (c.avg < 6.5) return "Run";
  return "Steady";
}
const DESCENT_TACTIC = { 1: "Let it run, recover", 2: "Quick steps, stay light", 4: "Brake, short steps" };

/**
 * Split a long climb into sections that each hold a fairly even gradient.
 *
 * The number of sections is fixed by the length (as many as fit at sectionMinM
 * each); dynamic programming then picks where to cut. The cost of a section is
 * how much its 10 m gradients scatter around the section's own average (a sum
 * of squared deviations), so cuts land where the slope changes character, for
 * example between a runnable ramp and a steep wall.
 * Returns [[a, b], ...] sample indices, contiguous from the climb's a to b.
 */
export function splitClimb(ele, a, b, step, minM = 1500) {
  const m = b - a; // number of 10 m steps in the climb
  const k = Math.floor((m * step) / minM);
  if (k < 2) return [[a, b]];
  const minN = Math.ceil(minM / step);
  // Prefix sums of gradient and gradient squared: any section's cost in O(1).
  const S = new Float64Array(m + 1);
  const Q = new Float64Array(m + 1);
  for (let i = 0; i < m; i++) {
    const g = ((ele[a + i + 1] - ele[a + i]) / step) * 100;
    S[i + 1] = S[i] + g;
    Q[i + 1] = Q[i] + g * g;
  }
  const cost = (p, q) => Q[q] - Q[p] - ((S[q] - S[p]) ** 2) / (q - p);
  // best[j][q]: lowest cost to cut steps 0..q into j sections; from[j][q]: where the last one starts.
  const best = [new Float64Array(m + 1).fill(Infinity)];
  best[0][0] = 0;
  const from = [null];
  for (let j = 1; j <= k; j++) {
    const bj = new Float64Array(m + 1).fill(Infinity);
    const fj = new Int32Array(m + 1);
    for (let q = j * minN; q <= m - (k - j) * minN; q++) {
      for (let p = (j - 1) * minN; p <= q - minN; p++) {
        if (best[j - 1][p] === Infinity) continue;
        const c = best[j - 1][p] + cost(p, q);
        if (c < bj[q]) { bj[q] = c; fj[q] = p; }
      }
    }
    best.push(bj);
    from.push(fj);
  }
  const cuts = [m];
  for (let j = k, q = m; j > 1; j--) { q = from[j][q]; cuts.unshift(q); }
  cuts.unshift(0);
  const out = [];
  for (let i = 0; i + 1 < cuts.length; i++) out.push([a + cuts[i], a + cuts[i + 1]]);
  return out;
}

/** Index of the sample where cumulative time first reaches `sec`. */
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

/** Match a race climb to the most similar climb in the effort file. */
function closestEffortClimb(c, effortClimbs, rs) {
  let best = null;
  let bestScore = Infinity;
  for (const r of effortClimbs) {
    const s = Math.abs(r.avg - c.avg) / 3 + Math.abs(r.delta - c.delta) / 25 + Math.abs(r.lenM - c.lenM) / 400;
    if (s < bestScore) { bestScore = s; best = r; }
  }
  if (!best) return null;
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
 */
export function briefCourse(course, userParams = {}) {
  const params = { ...PLAN_DEFAULTS, ...userParams };
  const total = course.totalKm;
  const kmAt = (idx) => (idx * course.step) / 1000;
  const rate = (n, a, b) => {
    const lenM = (b - a) * course.step;
    const delta = course.ele[b] - course.ele[a];
    const c = { n, startKm: kmAt(a), endKm: kmAt(b), lenM, delta, gain: delta, avg: (delta / lenM) * 100, steep: steepest100(course.ele, a, b, course.step), a, b };
    // Scored the same way whether it is a whole climb or a section of one.
    c.score = climbScore(c, total);
    c.level = climbLevel(c.score);
    return c;
  };
  const climbs = course.climbs.map((c, i) => {
    const r = { ...rate(i + 1, c.a, c.b), steep: c.steep };
    r.sections = c.lenM >= params.splitClimbM && c.delta >= params.splitClimbMinGain
      ? splitClimb(course.ele, c.a, c.b, course.step, params.sectionMinM).map(([a, b], j) => rate(`${i + 1}.${j + 1}`, a, b))
      : [];
    return r;
  });
  const descents = course.descents.map((d, i) => ({
    n: i + 1, startKm: d.startKm, endKm: d.startKm + d.lenM / 1000, lenM: d.lenM, delta: d.delta, loss: -d.delta,
    avg: d.avg, steep: d.steep, level: descentLevel(d), a: d.a, b: d.b,
  }));
  return { totalKm: total, gain: course.gain, loss: course.loss, climbs, descents };
}

/** Build the plan from two already-parsed GPX tracks. */
export function buildPlan(raceParsed, effortParsed, userParams = {}) {
  const params = { ...PLAN_DEFAULTS, ...userParams };
  const raceRs = resample(raceParsed, 10);
  const course = analyseCourse(raceRs);
  const effort = analyseEffort(effortParsed, { halfLifeDays: params.halfLifeDays });
  const effortCourse = analyseCourse(effort.resampled);
  const preds = predictAll(course, effort, params);
  const rawCentral = preds.central.cum; // moving time only, for the time-per-gradient table

  // Aid stations: the stop is added to every clock time after the station.
  const aid = parseAidStations(params.aidStations)
    .filter((a) => a.km >= 0 && a.km <= course.totalKm)
    .map((a) => ({ ...a, idx: Math.min(course.n - 1, Math.round((a.km * 1000) / course.step)) }));
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
  const hikeGrade = params.hikeGrade ?? effort.hikeGrade ?? 15;
  const total = course.totalKm;
  const kmAt = (idx) => (idx * course.step) / 1000;

  const maxGain = Math.max(...course.climbs.map((c) => c.delta), 0);
  const timing = (a, b) => ({
    start: Object.fromEntries(SCENARIOS.map((s) => [s.id, preds[s.id].cum[a]])),
    dur: Object.fromEntries(SCENARIOS.map((s) => [s.id, preds[s.id].cum[b] - preds[s.id].cum[a]])),
  });
  // The briefing rates the terrain; the plan adds what depends on you: tactic, timing, closest climb in your run.
  const brief = briefCourse(course, params);
  const forRace = (c, biggest) => ({
    ...c,
    tactic: climbTactic(c, hikeGrade, biggest),
    ...timing(c.a, c.b),
    effortMatch: closestEffortClimb(c, effortClimbsOf(effortCourse), effort.resampled),
  });
  const climbs = brief.climbs.map((c) => ({
    ...forRace(c, c.delta === maxGain && c.delta >= 60),
    sections: c.sections.map((x) => forRace(x, false)),
  }));
  const descents = brief.descents.map((d) => ({ ...d, tactic: DESCENT_TACTIC[d.level], ...timing(d.a, d.b) }));

  // Where the gel lands: every N minutes, but never in the middle of a climb or a braking descent.
  const segs = [...climbs.map((c) => ({ ...c, kind: "climb" })), ...descents.filter((d) => d.level === 4).map((d) => ({ ...d, kind: "descent" }))];
  const scenarios = {};
  for (const s of SCENARIOS) {
    const pr = preds[s.id];
    const gels = [];
    for (let t = params.gelEveryMin * 60; t < pr.finishSec - 15 * 60; t += params.gelEveryMin * 60) {
      let idx = indexAtTime(pr.cum, t);
      // An aid station close in time wins: eat there, with a drink at hand.
      const near = aid.find((a) => Math.abs(pr.cum[a.idx] - t) <= params.gelToAidMin * 60);
      if (near) {
        gels.push({ km: kmAt(near.idx), sec: pr.cum[near.idx], moved: true, at: near.name });
        continue;
      }
      const inside = segs.find((g) => idx > g.a && idx < g.b);
      if (inside) idx = inside.b; // take it at the top, or at the bottom of the descent
      if (pr.cum[idx] > pr.finishSec - 15 * 60) break; // moved too close to the finish: not worth it
      gels.push({ km: kmAt(idx), sec: pr.cum[idx], moved: Boolean(inside) });
    }
    const checkpoints = [];
    for (let km = params.checkpointKm; km < total - 1; km += params.checkpointKm) {
      checkpoints.push({ km, sec: pr.cum[Math.min(course.n - 1, Math.round((km * 1000) / course.step))], label: `km ${km}` });
    }
    checkpoints.push({ km: total, sec: pr.finishSec, label: "Finish" });
    scenarios[s.id] = { id: s.id, label: s.label, finishSec: pr.finishSec, factor: pr.factor, durationFactor: pr.durationFactor, gels, checkpoints };
  }

  // Heart-rate guide anchored on the average HR of the effort file.
  let hrGuide = null;
  if (effort.avgHr) {
    const ceiling = params.maxHr ? Math.round(params.maxHr * 0.92) : Infinity;
    const avg = Math.round(effort.avgHr);
    hrGuide = [
      { fromKm: 0, toKm: total * 0.35, text: `${Math.min(avg - 5, ceiling)} or lower` },
      { fromKm: total * 0.35, toKm: total * 0.69, text: `${Math.min(avg - 5, ceiling)} to ${Math.min(avg, ceiling)}` },
      { fromKm: total * 0.69, toKm: total, text: `up to ${Math.min(avg + 4, ceiling)} if legs allow` },
    ];
  }

  // Time on each gradient band for the central scenario.
  const bandUse = BANDS.map((b) => ({ id: b.id, label: b.label, km: 0, sec: 0 }));
  const cc = rawCentral;
  for (let i = 0; i < course.n - 1; i++) {
    const bi = bandIndex(course.grade[i]);
    bandUse[bi].km += course.step / 1000;
    bandUse[bi].sec += cc[i + 1] - cc[i];
  }

  const profile = [];
  for (let i = 0; i < course.n; i += 10) profile.push([kmAt(i), course.ele[i]]);

  return {
    params: { ...params, hikeGrade },
    startSec,
    course: { totalKm: total, gain: course.gain, loss: course.loss, climbCount: climbs.length, descentCount: descents.length, profile },
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
    decision: { fromKm: total * 0.58, toKm: total * 0.64 },
    aidStations: aid.map((a) => ({
      km: a.km, name: a.name, stopMin: a.stopMin,
      arrive: Object.fromEntries(SCENARIOS.map((sc) => [sc.id, preds[sc.id].cum[a.idx]])),
    })),
    scenarios,
    climbs,
    descents,
  };
}

const effortClimbCache = new WeakMap();
function effortClimbsOf(effortCourse) {
  if (!effortClimbCache.has(effortCourse)) effortClimbCache.set(effortCourse, effortCourse.climbs.filter((c) => c.delta >= 10));
  return effortClimbCache.get(effortCourse);
}

/** Convenience: from GPX strings (the effort can be one string or an array of them). */
export function planFromGpx(raceXml, effortXml, params = {}) {
  const efforts = Array.isArray(effortXml) ? effortXml.map(parseGpx) : parseGpx(effortXml);
  return buildPlan(parseGpx(raceXml), efforts, params);
}
