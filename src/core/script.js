// script.js: the race told as a story in time, for the race-day replay.
//
// The plan knows WHERE things happen (km of each climb, gel, aid station) and, per scenario,
// WHEN you get there (a timeline: seconds since the start at every 100 m, stops included).
// Two functions turn that into something you can rehearse:
//   raceScript(plan, sid)   the key moments in time order, each with a short cue to say to
//                           yourself (what is coming, how to run it, what to eat)
//   raceStateAt(plan, sid, sec)   where you are at any second of the race: km, altitude,
//                           gradient, pace, the climb you are on, the next gel and aid station
// Both work in Node (tests) and in the browser (the replay plays them back).

import { LEVELS } from "./plan.js";
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
