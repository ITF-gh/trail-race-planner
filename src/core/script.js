// script.js: the race told as a story in time, for the race-day replay.
//
// The plan knows WHERE things happen (km of each climb, gel, aid station) and, per scenario,
// WHEN you get there (a timeline: seconds since the start at every 100 m, stops included).
// Two functions turn that into something you can rehearse:
//   raceScript(plan, sid)   the key moments in time order, each with a short cue to say to
//                           yourself (what is coming, how to run it, what to eat)
//   raceStateAt(plan, sid, sec)   where you are at any second of the race: km, altitude,
//                           gradient, pace, the climb you are on, the next gel and aid station
//   raceLegs(plan, sid)     the whole course cut into numbered sections, end to end: every
//                           climb (or climb section) and descent of the briefing, with the
//                           runnable stretches between them, each with its own targets
//   raceTotals(plan, sid)   the targets for the whole race: finish, pace, gels, heart rate
// Both work in Node (tests) and in the browser (the replay plays them back).

import { LEVELS, DESCENT_LABELS } from "./plan.js";
import { clock, hm } from "./format.js";

/** First index i with arr[i] > v (arr sorted ascending): a binary search. */
function upperBound(arr, v) {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] <= v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Seconds since the start when the runner reaches `km`, in scenario `sid`. */
export function secAtKm(plan, sid, km) {
  const P = plan.course.profile;
  const tl = plan.scenarios[sid].timeline;
  const kms = P.map((p) => p[0]);
  const i = Math.max(0, Math.min(P.length - 2, upperBound(kms, km) - 1));
  const f = Math.max(0, Math.min(1, (km - P[i][0]) / (P[i + 1][0] - P[i][0] || 1)));
  return tl[i] + f * (tl[i + 1] - tl[i]);
}

const CLIMB_CUE = {
  1: "Easy one: stay relaxed and keep the breathing calm.",
  2: "Keep it smooth: a rhythm you could hold for twice as long.",
  3: "A hard one. Settle in early, short steps, do not chase anyone.",
  4: "A crux climb. Shorten the stride, hands on knees on the steep pitches, long breaths out. It ends.",
};
const r0 = (x) => Math.round(x);

/** Key moments of the race for scenario `sid`, in time order. */
export function raceScript(plan, sid) {
  const sc = plan.scenarios[sid];
  const st = plan.startSec;
  const total = plan.course.totalKm;
  const at = (sec) => clock(st, sec);
  const ev = [];
  const add = (e) => ev.push({ level: 0, ...e });
  const hr = plan.hrGuide;

  add({ kind: "start", sec: 0, km: 0, title: "Start", cue: `Start easy: the first hour should feel too slow.${hr ? ` Heart rate ${hr[0].text}.` : ""} ${plan.climbs.length} climbs and ${r0(plan.course.gain)} m of climbing ahead.` });

  plan.climbs.forEach((c) => {
    if (c.gain < 40 && c.level < 2) return; // bumps are not worth a cue
    const min = Math.max(1, r0(c.dur[sid] / 60));
    const secs = c.sections.length ? ` In ${c.sections.length} sections: ${c.sections.map((x) => `${x.n} ${x.tactic.toLowerCase()}`).join(", ")}.` : "";
    add({
      kind: "climb", sec: c.start[sid], km: c.startKm, level: c.level,
      title: `Climb ${c.n} · ${LEVELS[c.level]}`,
      cue: `${r0(c.gain)} m up over ${(c.lenM / 1000).toFixed(1)} km at ${c.avg.toFixed(0)}% (steepest 100 m: ${r0(c.steep)}%). ${c.tactic}. About ${min} min, top at ${at(c.start[sid] + c.dur[sid])}.${secs} ${CLIMB_CUE[c.level]}`,
    });
    if (c.level >= 3) {
      add({ kind: "top", sec: c.start[sid] + c.dur[sid], km: c.endKm, level: c.level, title: `Top of climb ${c.n}`, cue: "Shake out your arms, reset your breathing, let the legs turn over for a minute before you push the descent." });
    }
  });

  plan.descents.forEach((d) => {
    if (d.level === 4) {
      add({ kind: "descent", sec: d.start[sid], km: d.startKm, level: 4, title: `Descent ${d.n} · Brake`, cue: `${r0(d.loss)} m down at ${Math.abs(d.avg).toFixed(0)}% (steepest 100 m: ${Math.abs(r0(d.steep))}%). Brake, short quick steps, eyes three metres ahead. Your quads are needed later.` });
    } else if (d.level === 2 && d.loss >= 150) {
      add({ kind: "descent", sec: d.start[sid], km: d.startKm, level: 2, title: `Descent ${d.n} · Control`, cue: `${r0(d.loss)} m down at ${Math.abs(d.avg).toFixed(0)}%. Quick light steps, stay in control, no heroics.` });
    }
  });

  sc.gels.forEach((g, i) => {
    add({ kind: "gel", sec: g.sec, km: g.km, title: `Gel ${i + 1} of ${sc.gels.length}`, cue: `${g.at ? `At ${g.at}. ` : ""}Eat it now with a few sips of water, even if you do not feel hungry. Fuel taken now is energy in 30 min.` });
  });

  plan.aidStations.forEach((a) => {
    const arrive = a.arrive[sid];
    add({ kind: "aid", sec: arrive, km: a.km, title: a.name, cue: a.stopMin ? `${a.stopMin} min stop: refill bottles, eat something real, out by ${at(arrive + a.stopMin * 60)}. Walk out eating.` : "Pass through: grab a drink and go." });
  });

  if (hr) {
    add({ kind: "phase", sec: secAtKm(plan, sid, hr[1].fromKm), km: hr[1].fromKm, title: "Middle of the race", cue: `Heart rate ${hr[1].text}. Keep eating on time: this is where the fade starts if you skip fuel.` });
    add({ kind: "phase", sec: secAtKm(plan, sid, hr[2].fromKm), km: hr[2].fromKm, title: "Final third", cue: `Heart rate ${hr[2].text}. From here, effort you saved is time you gain.` });
  }
  add({ kind: "phase", sec: secAtKm(plan, sid, total / 2), km: total / 2, title: "Halfway", cue: `Halfway at ${at(secAtKm(plan, sid, total / 2))}, ${hm(secAtKm(plan, sid, total / 2))} on course. Check in: fuel, feet, chafing. The second half is the race.` });
  // Key zones come last so that, at the same spot as a climb, the key-zone cue is the one shown.
  (plan.keyZones || []).forEach((z) => {
    add({ kind: "key", sec: secAtKm(plan, sid, z.fromKm), km: z.fromKm, level: 4, title: `Key zone ${z.n} · ${z.modeLabel} · ${z.title}`, cue: `${z.why} ${z.how}` });
  });
  add({ kind: "finish", sec: sc.finishSec, km: total, title: "Finish", cue: `Finish at ${at(sc.finishSec)}, ${hm(sc.finishSec)} on course. Picture the arch, the clock, the people. You earned it climb by climb.` });

  return ev.sort((a, b) => a.sec - b.sec || a.km - b.km);
}

/** Where the runner is at `sec` seconds after the start, in scenario `sid`. */
export function raceStateAt(plan, sid, sec) {
  const P = plan.course.profile;
  const sc = plan.scenarios[sid];
  const tl = sc.timeline;
  const t = Math.max(0, Math.min(sc.finishSec, sec));
  const i = Math.max(0, Math.min(P.length - 2, upperBound(tl, t) - 1));
  const span = tl[i + 1] - tl[i];
  const f = span > 0 ? Math.max(0, Math.min(1, (t - tl[i]) / span)) : 0;
  let km = P[i][0] + f * (P[i + 1][0] - P[i][0]);
  let ele = P[i][1] + f * (P[i + 1][1] - P[i][1]);
  const dKm = P[i + 1][0] - P[i][0] || 0.1;
  const grade = ((P[i + 1][1] - P[i][1]) / (dKm * 1000)) * 100;
  let pace = span / dKm; // seconds per km over this 100 m
  // At an aid station the clock runs while you stand still.
  const aid = plan.aidStations.find((a) => t >= a.arrive[sid] && t < a.arrive[sid] + a.stopMin * 60);
  if (aid) { km = aid.km; pace = null; ele = P[Math.min(P.length - 1, Math.round((aid.km / plan.course.totalKm) * (P.length - 1)))][1]; }
  const inside = (x) => km >= x.startKm && km < x.endKm;
  const climb = plan.climbs.find(inside) || null;
  const section = climb ? climb.sections.find(inside) || null : null;
  const descent = plan.descents.find(inside) || null;
  const nextGel = sc.gels.find((g) => g.sec > t) || null;
  const nextAid = plan.aidStations.find((a) => a.arrive[sid] > t) || null;
  const nextClimb = plan.climbs.find((c) => c.startKm > km && (c.gain >= 40 || c.level >= 2)) || null;
  const zones = plan.keyZones || [];
  const keyZone = zones.find((z) => km >= z.fromKm && km < z.toKm) || null;
  const nextKey = zones.find((z) => z.fromKm > km) || null;
  const frac = km / plan.course.totalKm;
  const phase = plan.hrGuide ? plan.hrGuide.find((h) => km >= h.fromKm && km <= h.toKm) || null : null;
  return { sec: t, km, ele, grade, pace, frac, aid, climb, section, descent, nextGel, nextAid, nextClimb, keyZone, nextKey, phase };
}

/** Altitude at `km` on the profile (linear between the 100 m points). */
function eleAtKm(P, km) {
  const kms = P.map((p) => p[0]);
  const i = Math.max(0, Math.min(P.length - 2, upperBound(kms, km) - 1));
  const f = Math.max(0, Math.min(1, (km - P[i][0]) / (P[i + 1][0] - P[i][0] || 1)));
  return P[i][1] + f * (P[i + 1][1] - P[i][1]);
}

/** Metres up and down on the profile between two km. */
export function gainLoss(P, a, b) {
  let up = 0, down = 0, prev = eleAtKm(P, a);
  for (const [k, e] of P) {
    if (k <= a || k >= b) continue;
    const d = e - prev;
    if (d > 0) up += d; else down -= d;
    prev = e;
  }
  const d = eleAtKm(P, b) - prev;
  if (d > 0) up += d; else down -= d;
  return { up, down };
}

const RUNNABLE_MIN_KM = 0.3; // a gap shorter than this between two climbs is part of the one before

/**
 * The course cut into sections, start to finish with no gap: the climbs (split ones section by
 * section) and descents of the briefing, and "runnable" stretches where nothing climbs or drops
 * for long. Each section: {i (1..n), kind, n (its number in the briefing), level, title, label,
 * startKm, endKm, km, up, down, avg, startSec, endSec, durSec, stopSec, pace (moving, s/km),
 * tactic, gels, aids, keyZone, hr}. In course order, so section i+1 starts where i ends.
 */
export function raceLegs(plan, sid) {
  const P = plan.course.profile;
  const total = plan.course.totalKm;
  const sc = plan.scenarios[sid];
  const parts = [];
  plan.climbs.forEach((c) => (c.sections.length ? c.sections : [c]).forEach((x) => parts.push({
    kind: "climb", n: x.n, level: x.level, startKm: x.startKm, endKm: x.endKm,
    title: `${c.sections.length ? "Climb section" : "Climb"} ${x.n}`, label: LEVELS[x.level], tactic: x.tactic,
  })));
  plan.descents.forEach((d) => parts.push({
    kind: "descent", n: d.n, level: d.level, startKm: d.startKm, endKm: d.endKm,
    title: `Descent ${d.n}`, label: DESCENT_LABELS[d.level], tactic: d.tactic,
  }));
  parts.sort((a, b) => a.startKm - b.startKm);
  const runnable = (a, b) => ({ kind: "flat", n: null, level: 0, startKm: a, endKm: b, title: "Runnable", label: "Runnable", tactic: "Run tall and relaxed, drink, eat on time" });
  const legs = [];
  let at = 0;
  for (const p of parts) {
    const from = Math.max(at, p.startKm);
    if (from >= p.endKm) continue; // fully inside the previous one (should not happen)
    if (from - at >= RUNNABLE_MIN_KM) legs.push(runnable(at, from));
    else if (legs.length) legs[legs.length - 1].endKm = from; // a short gap joins the section before
    legs.push({ ...p, startKm: legs.length ? from : 0 });
    at = p.endKm;
  }
  if (total - at >= RUNNABLE_MIN_KM || !legs.length) legs.push(runnable(at, total));
  else legs[legs.length - 1].endKm = total;

  const zones = plan.keyZones || [];
  return legs.map((l, k) => {
    const startSec = secAtKm(plan, sid, l.startKm);
    const endSec = k === legs.length - 1 ? sc.finishSec : secAtKm(plan, sid, l.endKm);
    const km = l.endKm - l.startKm;
    const inLeg = (x) => x >= l.startKm && (x < l.endKm || (k === legs.length - 1 && x <= l.endKm));
    const aids = plan.aidStations.filter((a) => inLeg(a.km));
    const stopSec = aids.reduce((t, a) => t + a.stopMin * 60, 0);
    const { up, down } = gainLoss(P, l.startKm, l.endKm);
    const mid = (l.startKm + l.endKm) / 2;
    return {
      ...l, i: k + 1, km, up, down,
      avg: ((eleAtKm(P, l.endKm) - eleAtKm(P, l.startKm)) / Math.max(1, km * 1000)) * 100,
      startSec, endSec, durSec: endSec - startSec, stopSec,
      pace: km > 0 ? Math.max(0, endSec - startSec - stopSec) / km : null,
      gels: sc.gels.filter((g) => inLeg(g.km)),
      aids,
      keyZone: zones.find((z) => z.fromKm < l.endKm && z.toKm > l.startKm) || null,
      hr: plan.hrGuide ? plan.hrGuide.find((h) => mid >= h.fromKm && mid <= h.toKm) || null : null,
    };
  });
}

/** Index (0-based) of the leg that contains `km`. */
export function legAtKm(legs, km) {
  let i = 0;
  while (i < legs.length - 1 && km >= legs[i].endKm) i++;
  return i;
}

/**
 * Targets for the whole race in scenario `sid`: {finishSec, durationSec, km, gain, loss,
 * paceSec (finish time / km, stops included), movingPaceSec (stops left out), stopSec,
 * gels, gelEveryMin, aids, hrAvg, hrMin, hrMax}. hrAvg is null when the runs had no heart rate:
 * otherwise the time-weighted mean of the value expected in each phase of the heart-rate guide.
 */
export function raceTotals(plan, sid) {
  const sc = plan.scenarios[sid];
  const km = plan.course.totalKm;
  const stopSec = plan.aidStations.reduce((t, a) => t + a.stopMin * 60, 0);
  let hrAvg = null, hrMin = null, hrMax = null;
  const hr = plan.hrGuide;
  if (hr && hr.every((h) => Number.isFinite(h.bpm))) {
    let sum = 0, w = 0;
    for (const h of hr) {
      const dt = secAtKm(plan, sid, Math.min(km, h.toKm)) - secAtKm(plan, sid, h.fromKm);
      sum += h.bpm * dt;
      w += dt;
    }
    hrAvg = w > 0 ? Math.round(sum / w) : null;
    hrMin = Math.min(...hr.map((h) => h.bpm));
    hrMax = Math.max(...hr.map((h) => h.bpm));
  }
  return {
    finishSec: sc.finishSec, durationSec: sc.finishSec, km, gain: plan.course.gain, loss: plan.course.loss,
    paceSec: sc.finishSec / km, movingPaceSec: (sc.finishSec - stopSec) / km, stopSec,
    gels: sc.gels.length, gelEveryMin: plan.params.gelEveryMin, aids: plan.aidStations.length,
    hrAvg, hrMin, hrMax,
  };
}
