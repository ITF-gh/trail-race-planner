// keyzones.js: where the race is played. Key zones are the stretches where a runner who
// paced well can make a difference, and where one who did not loses the most.
//
// The idea is "minutes at stake". On any stretch, two runners of the same level drift apart
// by a share of the time they spend there: the longer the stretch, and the later in the race,
// the bigger the gap. So for each candidate stretch:
//
//   stake (min) = time on it (min) x spread(when) x weight(kind)
//
//   time on it   from the prediction (your plan), or from Tobler's hiking function on the
//                course alone (the briefing, before we know who runs it)
//   spread       how much runners differ at that point: 3% at the start, growing with the
//                square of the distance covered to 18% at the finish (fatigue divergence:
//                fresh legs all look alike, tired legs do not)
//   weight       climbs 1.0 (effort turns straight into time), runnable stretches 0.9 (late
//                on, runners who saved their legs keep running while others walk), descents
//                0.5 early to 0.9 late (quads decide), x1.4 for the last big climb
//
// Candidates are climbs (80 m or more), descents (250 m or more) and runnable stretches
// (2.5 km or more under 5% either way, after a third of the race). The best ones are kept,
// not overlapping, one per 20 km of race (between 1 and 5), and never less than a fifth of
// the best one's stake. A race of 20 km has one key zone; a 78 km ultra has four.

const LATE = (f) => (f < 0.35 ? "Early in the race" : f < 0.69 ? "Mid-race" : "Late in the race");
export const spreadAt = (frac) => 0.03 + 0.15 * frac * frac;

/** timeAt(km) from times known at the profile points (seconds since the start at each point). */
export function clockFromTimeline(profile, times) {
  return (km) => {
    let lo = 1;
    let hi = profile.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (profile[mid][0] < km) lo = mid + 1; else hi = mid; } // binary search
    const a = profile[lo - 1][0], b = profile[lo][0];
    const f = b > a ? Math.max(0, Math.min(1, (km - a) / (b - a))) : 0;
    return times[lo - 1] + f * (times[lo] - times[lo - 1]);
  };
}

/**
 * Seconds to cover the profile, km by km, from Tobler's hiking function (1993):
 * speed = 6 exp(-3.5 |slope + 0.05|) km/h, fastest at a 5% descent. Scaled x1.4 for a runner.
 * Returns timeAt(km), used when no personal prediction exists yet.
 */
export function toblerClock(profile) {
  const cum = [0];
  for (let i = 1; i < profile.length; i++) {
    const dKm = profile[i][0] - profile[i - 1][0];
    const slope = dKm > 0 ? (profile[i][1] - profile[i - 1][1]) / (dKm * 1000) : 0;
    const kmh = 1.4 * 6 * Math.exp(-3.5 * Math.abs(slope + 0.05));
    cum.push(cum[i - 1] + (dKm / kmh) * 3600);
  }
  return clockFromTimeline(profile, cum);
}

/** Runnable stretches: 2.5 km or more where the 300 m gradient stays under 5% either way. */
function runnableStretches(profile, totalKm) {
  const out = [];
  let start = null;
  const grade = (i) => {
    const a = profile[Math.max(0, i - 1)], b = profile[Math.min(profile.length - 1, i + 2)];
    return b[0] > a[0] ? ((b[1] - a[1]) / ((b[0] - a[0]) * 1000)) * 100 : 0;
  };
  for (let i = 0; i < profile.length; i++) {
    const ok = i < profile.length - 1 && Math.abs(grade(i)) < 5;
    if (ok && start === null) start = i;
    if (!ok && start !== null) {
      const a = profile[start][0], b = profile[i][0];
      if (b - a >= 2.5 && a >= totalKm / 3) out.push({ startKm: a, endKm: b });
      start = null;
    }
  }
  return out;
}

/**
 * Key zones of a course. `brief` = {totalKm, climbs, descents} (as briefCourse or buildPlan give
 * them), `profile` = [[km, ele]], `aid` = [{km, name}], `timeAt(km)` = seconds since the start.
 * Returns zones in course order: {n, kind, fromKm, toKm, title, why, how, stakeMin, durMin}.
 */
export function keyZones(brief, profile, aid, timeAt) {
  const T = brief.totalKm;
  const cands = [];
  const add = (kind, fromKm, toKm, w, extra) => {
    const durMin = (timeAt(toKm) - timeAt(fromKm)) / 60;
    const frac = (fromKm + toKm) / 2 / T;
    cands.push({ kind, fromKm, toKm, durMin, frac, stakeMin: durMin * spreadAt(frac) * w, ...extra });
  };
  const big = brief.climbs.filter((c) => c.gain >= 80);
  const maxGain = Math.max(0, ...big.map((c) => c.gain));
  // The last big climb: the last one with at least 40% of the biggest climb's gain.
  const lastBig = [...big].reverse().find((c) => c.gain >= 0.4 * maxGain && c.startKm > T * 0.4);
  big.forEach((c) => add("climb", c.startKm, c.endKm, c === lastBig ? 1.4 : 1, { item: c, last: c === lastBig }));
  brief.descents.filter((d) => d.loss >= 250).forEach((d) => {
    const frac = (d.startKm + d.endKm) / 2 / T;
    add("descent", d.startKm, d.endKm, 0.5 + 0.4 * frac, { item: d });
  });
  runnableStretches(profile, T).forEach((r) => add("run", r.startKm, r.endKm, 0.9, {}));

  const want = Math.max(1, Math.min(5, Math.round(T / 20)));
  cands.sort((a, b) => b.stakeMin - a.stakeMin);
  const best = cands.length ? cands[0].stakeMin : 0;
  const picked = [];
  for (const c of cands) {
    if (picked.length >= want || c.stakeMin < best / 5) break;
    if (picked.some((p) => c.fromKm < p.toKm + 1 && c.toKm > p.fromKm - 1)) continue; // overlaps or touches one already kept
    picked.push(c);
  }
  return picked.sort((a, b) => a.fromKm - b.fromKm).map((z, i) => describe(z, i + 1, aid));
}

function describe(z, n, aid) {
  const stake = Math.max(1, Math.round(z.stakeMin));
  const dur = Math.max(1, Math.round(z.durMin));
  const when = LATE(z.frac);
  const lenKm = (z.toKm - z.fromKm).toFixed(1);
  let title, why, how;
  if (z.kind === "climb") {
    const c = z.item;
    title = z.last ? `Last big climb · ${Math.round(c.gain)} m` : `Climb ${c.n} · ${Math.round(c.gain)} m`;
    why = `${when}, ${Math.round(c.gain)} m up at ${c.avg.toFixed(0)}% over ${lenKm} km: about ${dur} min of climbing, where ${stake} min can be won or lost.${z.last ? " The last big climb: races are often decided here." : ""}`;
    how = "Arrive fuelled with heart rate in range. Commit from the bottom, hike the steep pitches hard, run the flatter ones.";
  } else if (z.kind === "descent") {
    const d = z.item;
    title = `Descent ${d.n} · ${Math.round(d.loss)} m`;
    why = `${when}, ${Math.round(d.loss)} m down at ${Math.abs(d.avg).toFixed(0)}%: about ${dur} min where ${stake} min hang on your quads${z.frac > 0.5 ? ", already tired" : ""}.`;
    how = "Eat before dropping in. Quick light feet, relax the upper body, use the whole trail. Do not brake on what you can run.";
  } else {
    title = `Runnable · ${lenKm} km`;
    why = `${when}, ${lenKm} km of runnable ground: about ${dur} min where ${stake} min separate runners who can still run from those who walk.`;
    how = "This is where saved energy pays. Run tall, short quick steps, keep the cadence up, no walking breaks.";
  }
  const near = aid.find((a) => a.km >= z.fromKm - 1.5 && a.km <= z.toKm);
  if (near) how += ` ${near.name} (km ${near.km.toFixed(1)}) is right there: in and out fast.`;
  return { n, kind: z.kind, fromKm: z.fromKm, toKm: z.toKm, title, why, how, stakeMin: stake, durMin: dur };
}
