// keyzones.js: where the race is played. A key zone is a short stretch where how you run
// it changes your race: to gain time (ATTACK), to set up what comes next (PREPARE), or to
// protect your effort for later (MANAGE). Zones are portions of the course, not whole climbs:
// a whole climb is only kept when its sections are all key, by merging them.
//
// Each candidate gets "minutes in play": the time two runners of your level, one who runs
// that stretch well and one who does not, typically end up apart because of it.
//
//   in play (min) = time on it (min) x spread(when) x weight(kind)
//
//   time on it   from your prediction, or from Tobler's hiking function on the course alone
//   spread       how much runners differ at that point: 3% at the start, growing with the
//                square of the distance covered to 18% at the finish (fatigue divergence)
//
// Candidates and weights:
//   ATTACK   climb section (or a short climb)                 1.0, x1.3 on the last big climb
//            late runnable stretch, 2.5 km or more              2.0 (running vs walking)
//            steepest 2 km of a long descent, second half      0.5 + 0.4 x progress
//   PREPARE  the 0.8 to 2.5 km of easy ground before a big climb (250 m or more): eat, drink,
//            let heart rate drop. Worth 40% of what that climb puts in play.
//   MANAGE   the start: the first 8% of the race (up to the first big climb, unless it starts
//            within 2 km). Going
//            out too fast is paid for at the end: worth 0.6% of the finish time.
//            a wall: the steepest 400 m of a climb at 18% or more. Over-pushing there costs
//            the rest of the climb: worth 40% of the climb.
//            the restart: the first 1.5 km of runnable ground after 400 m or more of
//            descent, where heavy legs want to walk                         2.0
//            steepest 2 km of a long descent, first half: protect the quads 0.5 + 0.4 x progress
//
// The best are kept without overlapping, one per 13 km of race (1 to 7), none under a sixth
// of the best. Neighbouring sections of the same climb that are both kept merge into one zone.

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

/** Runnable stretches: where the 300 m gradient stays within [lo, hi] %, as [startKm, endKm]. */
function stretches(profile, ok) {
  const out = [];
  let start = null;
  for (let i = 0; i < profile.length; i++) {
    const good = i < profile.length - 1 && ok(gradeAt(profile, i));
    if (good && start === null) start = i;
    if (!good && start !== null) { out.push([profile[start][0], profile[i][0]]); start = null; }
  }
  return out;
}
/** Gradient (%) around profile point i, over about 300 m. */
function gradeAt(profile, i) {
  const a = profile[Math.max(0, i - 1)], b = profile[Math.min(profile.length - 1, i + 2)];
  return b[0] > a[0] ? ((b[1] - a[1]) / ((b[0] - a[0]) * 1000)) * 100 : 0;
}
/** Steepest window of `lenKm` inside [a, b] (sign +1 up, -1 down): [fromKm, toKm, avg %]. */
function steepest(profile, a, b, lenKm, sign) {
  const pts = profile.filter((p) => p[0] >= a - 1e-9 && p[0] <= b + 1e-9);
  let best = null;
  for (let i = 0; i < pts.length; i++) {
    let j = i;
    while (j < pts.length - 1 && pts[j][0] - pts[i][0] < lenKm - 1e-9) j++;
    if (pts[j][0] - pts[i][0] < lenKm * 0.9) break;
    const g = ((pts[j][1] - pts[i][1]) / ((pts[j][0] - pts[i][0]) * 1000)) * 100 * sign;
    if (!best || g > best[2]) best = [pts[i][0], pts[j][0], g];
  }
  return best;
}

/**
 * Key zones of a course. `brief` = {totalKm, climbs (with sections), descents}, `profile` =
 * [[km, ele]] every 100 m, `aid` = [{km, name}], `timeAt(km)` = seconds since the start.
 * Returns zones in course order: {n, mode, kind, fromKm, toKm, title, why, how, stakeMin, durMin}.
 */
export function keyZones(brief, profile, aid, timeAt) {
  const T = brief.totalKm;
  const cands = [];
  const dur = (a, b) => (timeAt(b) - timeAt(a)) / 60;
  const fracOf = (a, b) => (a + b) / 2 / T;
  const add = (mode, kind, fromKm, toKm, stakeMin, extra = {}) => {
    if (toKm - fromKm < 0.2) return;
    cands.push({ mode, kind, fromKm, toKm, durMin: dur(fromKm, toKm), frac: fracOf(fromKm, toKm), stakeMin, ...extra });
  };
  const inPlay = (a, b, w) => dur(a, b) * spreadAt(fracOf(a, b)) * w;

  const big = brief.climbs.filter((c) => c.gain >= 80);
  const maxGain = Math.max(0, ...big.map((c) => c.gain));
  const lastBig = [...big].reverse().find((c) => c.gain >= 0.4 * maxGain && c.startKm > T * 0.4);
  const easy = stretches(profile, (g) => g > -8 && g < 6); // runnable or gently down

  // MANAGE: the start, until the first big climb at most.
  // (a climb straight from the start line is part of the start: do not race up it)
  const foot = big.length ? big[0].startKm : T;
  const startEnd = foot >= 2 ? Math.min(foot, T * 0.08) : T * 0.08;
  add("manage", "start", 0, startEnd, 0.006 * dur(0, T));

  big.forEach((c) => {
    const w = c === lastBig ? 1.3 : 1;
    const climbStake = inPlay(c.startKm, c.endKm, w);
    // ATTACK: each section of a long climb on its own; a short climb as a whole.
    const parts = c.sections && c.sections.length ? c.sections : [c];
    parts.forEach((x) => { if (x.gain >= 50) add("attack", "climb", x.startKm, x.endKm, inPlay(x.startKm, x.endKm, w), { climb: c, part: x, last: c === lastBig }); });
    // PREPARE: easy ground just before the foot of a big climb.
    if (c.gain >= 250) {
      const before = easy.find(([a, b]) => b >= c.startKm - 0.15 && a < c.startKm);
      if (before) {
        const from = Math.max(before[0], c.startKm - 2.5);
        if (c.startKm - from >= 0.8) add("prepare", "approach", from, c.startKm, 0.4 * climbStake, { climb: c, last: c === lastBig });
      }
    }
    // MANAGE: the wall, where over-pushing ruins the rest of the climb.
    const wall = steepest(profile, c.startKm, c.endKm, 0.4, 1);
    if (wall && wall[2] >= 18 && c.lenM >= 1500) add("manage", "wall", wall[0], wall[1], 0.4 * climbStake, { climb: c, grade: wall[2] });
  });

  brief.descents.filter((d) => d.loss >= 250).forEach((d) => {
    const f = fracOf(d.startKm, d.endKm);
    const w = 0.5 + 0.4 * f;
    const part = d.endKm - d.startKm > 2.5 ? steepest(profile, d.startKm, d.endKm, 2, -1) : [d.startKm, d.endKm, Math.abs(d.avg)];
    if (part) add(f > 0.5 ? "attack" : "manage", "descent", part[0], part[1], inPlay(part[0], part[1], w), { desc: d, grade: part[2], whole: part[0] === d.startKm && part[1] === d.endKm });
    // MANAGE: restarting to run after a long descent.
    if (d.loss >= 400) {
      const after = stretches(profile, (g) => Math.abs(g) < 6).find(([a, b]) => a <= d.endKm + 0.15 && b > d.endKm + 1);
      if (after) add("manage", "restart", d.endKm, Math.min(after[1], d.endKm + 1.5), inPlay(d.endKm, Math.min(after[1], d.endKm + 1.5), 2), { desc: d });
    }
  });

  // ATTACK: long runnable stretches after the first third, where runners who can still run pull away.
  stretches(profile, (g) => Math.abs(g) < 5).filter(([a, b]) => b - a >= 2.5 && a >= T / 3).forEach(([a, b]) => add("attack", "run", a, b, inPlay(a, b, 2)));

  const want = Math.max(1, Math.min(7, Math.round(T / 13)));
  cands.sort((a, b) => b.stakeMin - a.stakeMin);
  const best = cands.length ? cands[0].stakeMin : 0;
  const picked = [];
  for (const c of cands) {
    if (picked.length >= want || c.stakeMin < best / 6) break;
    if (picked.some((p) => c.fromKm < p.toKm - 0.05 && c.toKm > p.fromKm + 0.05)) continue; // touching is fine, overlapping is not
    picked.push(c);
  }
  picked.sort((a, b) => a.fromKm - b.fromKm);
  // Neighbouring sections of the same climb that are both key: one zone.
  const merged = [];
  for (const z of picked) {
    const prev = merged[merged.length - 1];
    if (prev && prev.kind === "climb" && z.kind === "climb" && prev.climb === z.climb && Math.abs(prev.toKm - z.fromKm) < 0.05) {
      prev.toKm = z.toKm; prev.stakeMin += z.stakeMin; prev.durMin += z.durMin; prev.parts = [...(prev.parts || [prev.part]), z.part];
    } else merged.push({ ...z });
  }
  return merged.map((z, i) => describe(z, i + 1, aid, profile));
}

const MODE = { attack: "Attack", prepare: "Prepare", manage: "Manage" };

function describe(z, n, aid, profile) {
  const stake = Math.max(1, Math.round(z.stakeMin));
  const dur = Math.max(1, Math.round(z.durMin));
  const when = LATE(z.frac);
  const lenKm = (z.toKm - z.fromKm).toFixed(1);
  const gain = Math.max(0, profile ? zoneEle(profile, z.toKm) - zoneEle(profile, z.fromKm) : 0);
  let title, why, how;
  if (z.kind === "climb") {
    const c = z.climb;
    const parts = z.parts || [z.part];
    const whole = parts.length === ((c.sections || []).length || 1);
    const avg = (gain / ((z.toKm - z.fromKm) * 1000)) * 100;
    const label = whole ? `Climb ${c.n}` : parts.length > 1 ? `Climb ${c.n}, sections ${parts[0].n}–${parts[parts.length - 1].n}` : `Climb ${c.n}, section ${parts[0].n}`;
    title = `${z.last ? "Last big climb · " : ""}${label} · ${Math.round(gain)} m`;
    why = `${when}, ${Math.round(gain)} m at ${avg.toFixed(0)}% over ${lenKm} km${whole ? "" : ` of the ${Math.round(c.gain)} m climb`}: about ${dur} min where ${stake} min are in play.${z.last ? " The last big climb: races are often decided here." : ""}`;
    how = avg >= 14
      ? "Strong power-hike: hands on knees, short steps, steady breathing. Push the effort here, not on the easier ground before."
      : "Run it with a short stride, or alternate 1 min run and 1 min hike. Steady effort from the bottom; let others surge.";
  } else if (z.kind === "start") {
    title = `The start · first ${lenKm} km`;
    why = `Fresh legs, adrenaline and the crowd make the first ${lenKm} km feel easy. Every minute gained here by going out too fast is paid back with interest at the end: ${stake} min in play.`;
    how = "Start slower than feels right: you should be able to talk. Let the crowd go, settle your breathing, drink early.";
  } else if (z.kind === "approach") {
    const c = z.climb;
    title = `Before climb ${c.n} · ${lenKm} km to prepare`;
    why = `${when}, the ${lenKm} km of easy ground before ${Math.round(c.gain)} m of climbing${z.last ? " (the last big one)" : ""}. How you arrive decides how you climb: ${stake} min in play.`;
    how = "Ease off a little, eat and drink now, let your heart rate drop. Walk any short bump. Arrive at the foot fresh, ready to push.";
  } else if (z.kind === "wall") {
    title = `Wall on climb ${z.climb.n} · 400 m at ${z.grade.toFixed(0)}%`;
    why = `${when}, the steepest part of climb ${z.climb.n}. Fighting it burns more than it gains and can cost the rest of the climb: ${stake} min in play.`;
    how = "Hike from the first step, hands on knees, short steps, long breaths out. Keep your heart rate in the guide: you will go faster after it.";
  } else if (z.kind === "restart") {
    title = `Restart after descent ${z.desc.n} · ${lenKm} km`;
    why = `${when}, the first ${lenKm} km of runnable ground after ${Math.round(z.desc.loss)} m of descent. The legs feel heavy and want to walk; runners who start running again here pull away: ${stake} min in play.`;
    how = "Shorten the stride and raise the cadence. Run the first kilometre, even slowly: the legs come back after a few minutes.";
  } else if (z.kind === "descent") {
    const d = z.desc;
    title = `Descent ${d.n}${z.whole ? "" : ", steep part"} · ${lenKm} km at ${z.grade.toFixed(0)}%`;
    why = z.mode === "attack"
      ? `${when}, the steepest ${lenKm} km of a ${Math.round(d.loss)} m descent, on tired legs: ${stake} min in play for those whose quads still hold.`
      : `${when}, the steepest ${lenKm} km of a ${Math.round(d.loss)} m descent. Racing it now costs your quads for the rest of the day: ${stake} min in play later.`;
    how = z.mode === "attack"
      ? "Quick light feet, relax the upper body, use the whole trail. Do not brake on what you can run."
      : "Protect your quads: short quick steps, brake early and smoothly, no big impacts. You need these legs later.";
  } else {
    title = `Runnable · ${lenKm} km`;
    why = `${when}, ${lenKm} km of runnable ground: about ${dur} min where ${stake} min separate runners who can still run from those who walk.`;
    how = "This is where saved energy pays. Run tall, short quick steps, keep the cadence up, no walking breaks.";
  }
  const near = aid.find((a) => a.km >= z.fromKm - 1 && a.km <= z.toKm);
  if (near) how += ` ${near.name} (km ${near.km.toFixed(1)}) is here: in and out fast.`;
  return { n, mode: z.mode, modeLabel: MODE[z.mode], kind: z.kind, fromKm: z.fromKm, toKm: z.toKm, title, why, how, stakeMin: stake, durMin: dur };
}

function zoneEle(profile, km) {
  let i = 1;
  while (i < profile.length - 1 && profile[i][0] < km) i++;
  const a = profile[i - 1], b = profile[i];
  return b[0] > a[0] ? a[1] + ((km - a[0]) / (b[0] - a[0])) * (b[1] - a[1]) : a[1];
}
