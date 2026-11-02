// garmin.js: the race plan as a course for a GPS watch, with the plan's cues along the way.

import { raceLegs, secAtKm, raceStateAt } from "./script.js";
import { haversine } from "./track.js";
import { clock } from "./format.js";

/** Longest name we write: watches show about 15 characters (a 30-character name gave an error). */
export const POINT_NAME_MAX = 15;

/** FIT course point icon types used here (FIT SDK enum `course_point`). */
export const CP = { generic: 0, summit: 1, valley: 2, danger: 5 };

// Strategy words, short enough to leave room for the length and the climb or drop.
const CLIMB_SHORT = {
  "Hike": "HIKE",
  "Hike the steep part": "RUN/HIKE",
  "Biggest climb, steady": "STEADY",
  "Run evenly, do not surge": "EVEN",
  "Run": "RUN",
  "Steady": "STEADY",
};
// Descent levels: 1 Let it run, 2 Control, 4 Brake (DESCENT_LABELS in plan.js).
const DESCENT_SHORT = { 1: "LET GO", 2: "QUICK", 4: "BRAKE" };

/** Watch-safe text: plain ASCII (accents dropped), at most POINT_NAME_MAX characters. 1. normalize("NFD") splits an accented letter into the letter plus a separate accent mark... */
export function pointName(s, max = POINT_NAME_MAX) {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^\x20-\x7e]/g, "").trim().slice(0, max).trim();
}

/** "1.8k" under 10 km, "12k" above: a length that fits in a short name. 9.95 so 9.96 km shows "10k", not "10.0k". */
function kmShort(km) {
  return km < 9.95 ? `${km.toFixed(1)}k` : `${Math.round(km)}k`;
}

/** The first of these names that fits on the watch (they go from airy to packed). */
function fitName(...tries) {
  const ok = tries.map((t) => pointName(t, 99)).find((t) => t.length <= POINT_NAME_MAX);
  return ok || pointName(tries[tries.length - 1]);
}

/** Strategy of a race section in a few characters. */
function legShort(l, hikeGrade = 15) {
  if (l.kind === "climb") {
    // Very steep (5 points above your hiking gradient): hands on thighs.
    if (l.avg >= hikeGrade + 5) return "POWER HIKE";
    return CLIMB_SHORT[l.tactic] || l.tactic.split(/[ ,]/)[0].toUpperCase();
  }
  if (l.kind === "descent") {
    // A long steep descent (700 m or more down): it costs the legs for everything after.
    if (l.level >= 2 && l.down >= SAVE_QUADS_M) return "SAVE QUADS";
    return DESCENT_SHORT[l.level] || "CONTROL";
  }
  // Runnable ground with bumps (60 m or more up or down): run the flat, hike the short rises.
  if (l.up >= EASY_MAX_M || l.down >= EASY_MAX_M) return "ROLL";
  // A gentle rise (30 m or more, 2% or more): hold the effort, let the pace drop.
  if (l.up >= HOLD_M && l.avg >= 2) return "HOLD";
  return "RUN";
}

/** What to do in a key zone, in a few characters (the long version is z.how). */
function keyShort(z) {
  switch (z.kind) {
    case "climb": return /power-hike/.test(z.how) ? "POWER HIKE" : "RUN/HIKE";
    case "start": return "GO SLOW";
    case "approach": return "EAT+EASE";
    case "wall": return "HIKE";
    case "restart": return "RUN AGAIN";
    case "descent": return z.mode === "attack" ? "LET GO" : "SAVE QUADS";
    default: return "RUN TALL";
  }
}

// Two alerts need time to be read: each point comes at least 200 m and 1 minute (at plan pace) after the one before, pushed further along the course if needed.
export const MIN_GAP_M = 200;
export const MIN_GAP_SEC = 60;

// Strategy words counted as easy ground, merged into one plain "RUN" block when gentle.
const EASY = ["RUN", "LET GO", "ROLL"];
const EASY_MAX_M = 60; // an easy section climbing or dropping less than this is plain running
const SAVE_QUADS_M = 700; // m down that turns QUICK or BRAKE into SAVE QUADS
const HOLD_M = 30; // m up that makes a runnable section HOLD
const CRUISE_KM = 3; // a RUN block this long becomes CRUISE
const BIG_HIKE_M = 300; // a hike this big: RECOVER after it, EASE UP before it (short RUN blocks)

/** The race sections grouped by strategy: neighbouring sections with the same strategy word (three HIKE sections in a row) make one block, with their lengths, D+ and D- added up. */
export function strategyBlocks(plan, sid) {
  const blocks = [];
  const hg = (plan.params && plan.params.hikeGrade) ?? (plan.effort && plan.effort.hikeGrade) ?? 15;
  for (const l of raceLegs(plan, sid)) {
    let word = legShort(l, hg);
    // Gentle ground (an easy run, a short let-it-run drop, a runnable stretch) is just "RUN": three of them in a row make one alert, not three.
    if (EASY.includes(word) && l.up < EASY_MAX_M && l.down < EASY_MAX_M) word = "RUN";
    const prev = blocks[blocks.length - 1];
    if (prev && prev.word === word) { prev.endKm = l.endKm; prev.km += l.km; prev.up += l.up; prev.down += l.down; prev.legs.push(l); }
    else blocks.push({ word, kind: l.kind, level: l.level, startKm: l.startKm, endKm: l.endKm, km: l.km, up: l.up, down: l.down, startSec: l.startSec, legs: [l] });
  }
  // What is around a RUN block changes what to do in it: an aid station just behind, a big hike just behind or just ahead, or a long stretch.
  const aids = plan.aidStations || [];
  // Metres up in the hike blocks next to block i, going back (dir -1) or forward (dir 1) until something else.
  const hikeUp = (i, dir) => { let up = 0; for (let k = i + dir; blocks[k] && /HIKE/.test(blocks[k].word); k += dir) up += blocks[k].up; return up; };
  blocks.forEach((b, i) => {
    if (b.word !== "RUN") return;
    const short = b.km < CRUISE_KM;
    if (aids.some((a) => a.km >= b.startKm - 0.3 && a.km <= b.startKm + 0.5)) b.word = "SETTLE";
    else if (short && hikeUp(i, -1) >= BIG_HIKE_M) b.word = "RECOVER";
    else if (short && hikeUp(i, 1) >= BIG_HIKE_M) b.word = "EASE UP";
    else if (!short) b.word = "CRUISE";
  });
  return blocks;
}

/** Course points for scenario `sid`, in course order: {km, type, name, text}. */
export function coursePoints(plan, sid) {
  const st = plan.startSec;
  const zones = plan.keyZones || [];
  const pts = [];
  strategyBlocks(plan, sid).forEach((b) => {
    if (zones.some((z) => Math.abs(z.fromKm - b.startKm) < MIN_GAP_M / 1000)) return; // the key zone speaks here
    // The elevation part of the name: "+726" for a climb, "-675" for a descent, "+40-35" for a RUN
    // block with some up and down (20 m or more), nothing otherwise. The icon follows the same idea.
    // Three spellings are offered to fitName, from "HIKE 5.5k +726" down to "HIKE +726".
    const up = Math.round(b.up), down = Math.round(b.down);
    const len = kmShort(b.km);
    const runnable = ["RUN", "CRUISE", "RECOVER", "SETTLE", "EASE UP", "HOLD", "ROLL"].includes(b.word);
    const elev = runnable ? (up >= 20 || down >= 20 ? `+${up}-${down}` : "") : b.kind === "climb" ? `+${up}` : b.kind === "descent" ? `-${down}` : "";
    const type = runnable ? CP.generic : b.kind === "climb" ? CP.summit : b.kind === "descent" ? (b.level === 4 ? CP.danger : CP.valley) : CP.generic;
    const name = elev ? (runnable ? fitName(`${b.word} ${len} ${elev}`, `${b.word} ${len}${elev}`, `${b.word} ${len}`) : fitName(`${b.word} ${len} ${elev}`, `${b.word} ${len}${elev}`, `${b.word} ${elev}`, `${b.word} ${len}`)) : fitName(`${b.word} ${len}`);
    const secs = b.legs.length > 1 ? `Sections ${b.legs[0].i}-${b.legs[b.legs.length - 1].i}` : `Section ${b.legs[0].i}`;
    pts.push({ id: `b${b.startKm.toFixed(2)}`, km: b.startKm, type, name, text: `${secs}: ${b.word === "RUN" && b.legs.length > 1 ? "Gentle ground, just run" : b.legs[0].tactic}. ${b.km.toFixed(1)} km, +${up} m / -${down} m, arrive ${clock(st, b.startSec)}.` });
  });
  // One alert per key zone, with the danger icon and a "!" in front of its name.
  zones.forEach((z) => {
    const len = kmShort(z.toKm - z.fromKm);
    pts.push({ id: `k${z.n}`, km: z.fromKm, type: CP.danger, name: fitName(`!${keyShort(z)} ${len}`, `!${keyShort(z)}${len}`, `!${keyShort(z)}`), text: `Key zone ${z.n} · ${z.modeLabel} · ${z.title}. ${z.how}` });
  });
  return spacePoints(plan, sid, pts);
}

/** Points in course order, each pushed along so it comes MIN_GAP_M and MIN_GAP_SEC after the one before. */
export function spacePoints(plan, sid, points) {
  const pts = points.map((p) => ({ ...p })).sort((a, b) => a.km - b.km);
  const total = plan.course.totalKm;
  for (let i = 1; i < pts.length; i++) {
    const prev = pts[i - 1].km;
    const oneMin = raceStateAt(plan, sid, secAtKm(plan, sid, prev) + MIN_GAP_SEC).km; // where you are a minute later
    pts[i].km = Math.max(pts[i].km, prev + MIN_GAP_M / 1000, oneMin);
  }
  return pts.map((p) => ({ ...p, km: Math.min(p.km, total) }));
}

/** The runner's own version of the messages: the planner's points with their edits applied. edits = {names: {id: "new name"}, off: {id: true}, kms: {id: km}, extra: [{id, km, name}]}... */
export function editedPoints(plan, sid, edits = {}) {
  const names = edits.names || {}, off = edits.off || {}, kms = edits.kms || {};
  const total = plan.course.totalKm;
  const mine = coursePoints(plan, sid)
    .filter((p) => !off[p.id])
    .map((p) => (names[p.id] != null && pointName(names[p.id]) ? { ...p, name: pointName(names[p.id]), edited: true } : p))
    .map((p) => (Number.isFinite(kms[p.id]) ? { ...p, km: Math.max(0, Math.min(total, kms[p.id])), moved: true } : p));
  const extra = (edits.extra || [])
    .filter((x) => Number.isFinite(x.km) && pointName(x.name || ""))
    .map((x) => ({ id: x.id, km: Math.max(0, Math.min(total, x.km)), type: CP.generic, name: pointName(x.name), text: x.name, added: true }));
  return spacePoints(plan, sid, [...mine, ...extra]);
}

/** The route as [{lat, lon, ele, km}] with points at least `minM` metres apart, its distance stretched to the plan's total so plan km and route km agree. */
export function courseTrack(plan, track, minM = 15) {
  let pts = track && track.length > 1 ? track : (plan.course.route || []).map(([lat, lon], i) => ({ lat, lon, ele: plan.course.profile[i][1] }));
  if (pts.length < 2) throw new Error("This course has no positions to follow.");
  const out = [{ ...pts[0], m: 0 }];
  let m = 0;
  for (let i = 1; i < pts.length; i++) {
    m += haversine(pts[i - 1], pts[i]);
    if (m - out[out.length - 1].m >= minM || i === pts.length - 1) out.push({ lat: pts[i].lat, lon: pts[i].lon, ele: pts[i].ele, m });
  }
  const f = m > 0 ? (plan.course.totalKm * 1000) / m : 1;
  return out.map((p) => ({ lat: p.lat, lon: p.lon, ele: p.ele, km: (p.m * f) / 1000 }));
}

/** Position and altitude at `km` on a courseTrack (linear between points). */
function trackAt(T, km) {
  let i = 1;
  while (i < T.length - 1 && T[i].km < km) i++;
  const a = T[i - 1], b = T[i];
  const f = b.km > a.km ? Math.max(0, Math.min(1, (km - a.km) / (b.km - a.km))) : 0;
  return { lat: a.lat + f * (b.lat - a.lat), lon: a.lon + f * (b.lon - a.lon), ele: a.ele + f * (b.ele - a.ele) };
}

/* ---------- FIT encoding ---------- */

// FIT constants.
const FIT_EPOCH_MS = Date.UTC(1989, 11, 31); // FIT times are seconds since 31 Dec 1989 00:00 UTC
const BASE = { enum: 0x00, uint8: 0x02, uint16: 0x84, sint32: 0x85, uint32: 0x86, string: 0x07, uint32z: 0x8c };
const SIZE = { enum: 1, uint8: 1, uint16: 2, sint32: 4, uint32: 4, uint32z: 4 };

// CRC-16 as in the FIT SDK: four bits at a time, with a 16-entry table.
const CRC_TABLE = [0x0000, 0xcc01, 0xd801, 0x1400, 0xf001, 0x3c00, 0x2800, 0xe401, 0xa001, 0x6c00, 0x7800, 0xb401, 0x5000, 0x9c01, 0x8801, 0x4400];
/** CRC-16 of `bytes` (an array or Uint8Array), continuing from `crc` (0 to start). */
export function fitCrc(bytes, crc = 0) {
  for (const byte of bytes) {
    let tmp = CRC_TABLE[crc & 0xf];
    crc = ((crc >> 4) & 0x0fff) ^ tmp ^ CRC_TABLE[byte & 0xf];
    tmp = CRC_TABLE[crc & 0xf];
    crc = ((crc >> 4) & 0x0fff) ^ tmp ^ CRC_TABLE[(byte >> 4) & 0xf];
  }
  return crc;
}

/** Degrees to FIT "semicircles": 2^31 semicircles = 180 degrees, stored as a signed 32-bit int. */
const semi = (deg) => Math.round((deg * 2 ** 31) / 180);

/** Minimal FIT writer: little-endian, one local message type per global message. */
function fitWriter() {
  const bytes = [];
  const defs = {};
  // put(v, type, size): append one value as bytes.
  const put = (v, type, size) => {
    if (type === "string") {
      const s = new TextEncoder().encode(v || "").slice(0, size - 1);
      for (let i = 0; i < size; i++) bytes.push(i < s.length ? s[i] : 0);
      return;
    }
    const n = SIZE[type];
    let x = type === "sint32" ? (Math.round(v) | 0) >>> 0 : Math.max(0, Math.round(v));
    for (let i = 0; i < n; i++) { bytes.push(x & 0xff); x = Math.floor(x / 256); }
  };
  return {
    /** fields: [[name, fieldNum, type, size?]]. */
    define(local, global, fields) {
      defs[local] = fields;
      bytes.push(0x40 | local, 0, 0, global & 0xff, global >> 8, fields.length);
      for (const [, num, type, size] of fields) bytes.push(num, size || SIZE[type], BASE[type]);
    },
    // Data message: header byte = the local type, then each field's value in the defined order.
    write(local, values) {
      bytes.push(local);
      for (const [name, , type, size] of defs[local]) put(values[name], type, size || SIZE[type]);
    },
    // Header (14 bytes): header size, protocol version (0x20 = 2.0), profile version 2132 (21.32) on 2 bytes, the data size on 4 bytes (filled in below), the text ".FIT" (0x2e 0x46 0x49 0x54)...
    file() {
      const head = [14, 0x20, 2132 & 0xff, 2132 >> 8, 0, 0, 0, 0, 0x2e, 0x46, 0x49, 0x54]; // 14 bytes, protocol 2.0, profile 21.32, ".FIT"
      const n = bytes.length;
      head[4] = n & 0xff; head[5] = (n >> 8) & 0xff; head[6] = (n >> 16) & 0xff; head[7] = (n >>> 24) & 0xff;
      const hc = fitCrc(head);
      head.push(hc & 0xff, hc >> 8);
      const all = new Uint8Array(head.length + n + 2);
      all.set(head, 0);
      all.set(bytes, head.length);
      const c = fitCrc(all.subarray(0, head.length + n));
      all[head.length + n] = c & 0xff;
      all[head.length + n + 1] = c >> 8;
      return all;
    },
  };
}

/** A FIT course of the race for scenario `sid`. */
export function courseFit(plan, sid, track, opts = {}) {
  const T = courseTrack(plan, track);
  const pts = opts.points || coursePoints(plan, sid);
  const sc = plan.scenarios[sid];
  const start = opts.date || new Date();
  // t0: the start in FIT time. tAt(km): FIT time at km, from the plan's timeline for this scenario.
  const t0 = Math.floor((start.getTime() - FIT_EPOCH_MS) / 1000);
  const tAt = (km) => t0 + Math.round(secAtKm(plan, sid, Math.min(km, plan.course.totalKm)));
  // FIT stores altitude as an unsigned number: (metres + 500) x 5, so -500 m is 0 and the step is 20 cm.
  const alt = (e) => (Math.max(-500, e) + 500) * 5; // altitude: scale 5, offset 500 m
  const first = T[0], last = T[T.length - 1];
  const w = fitWriter();

  // file_id: type 6 = course; manufacturer 255 = "development" (not a real brand); created = t0.
  w.define(0, 0, [["type", 0, "enum"], ["manufacturer", 1, "uint16"], ["product", 2, "uint16"], ["serial", 3, "uint32z"], ["created", 4, "uint32"]]);
  w.write(0, { type: 6, manufacturer: 255, product: 0, serial: 1, created: t0 }); // 6 = course, 255 = development

  w.define(1, 31, [["name", 5, "string", 32], ["sport", 4, "enum"], ["subSport", 7, "enum"]]);
  w.write(1, { name: pointName(opts.name || "Race", 31) || "Race", sport: 1, subSport: 3 }); // running, trail

  // lap: one lap for the whole course. event 9 = lap, eventType 1 = stop.
  w.define(2, 19, [["timestamp", 253, "uint32"], ["startTime", 2, "uint32"], ["sLat", 3, "sint32"], ["sLon", 4, "sint32"], ["eLat", 5, "sint32"], ["eLon", 6, "sint32"],
    ["elapsed", 7, "uint32"], ["timer", 8, "uint32"], ["dist", 9, "uint32"], ["ascent", 21, "uint16"], ["descent", 22, "uint16"], ["event", 0, "enum"], ["eventType", 1, "enum"]]);
  w.write(2, { timestamp: t0 + sc.finishSec, startTime: t0, sLat: semi(first.lat), sLon: semi(first.lon), eLat: semi(last.lat), eLon: semi(last.lon),
    elapsed: sc.finishSec * 1000, timer: sc.finishSec * 1000, dist: plan.course.totalKm * 100000, ascent: plan.course.gain, descent: plan.course.loss, event: 9, eventType: 1 });

  w.define(3, 21, [["timestamp", 253, "uint32"], ["event", 0, "enum"], ["eventType", 1, "enum"]]);
  w.write(3, { timestamp: t0, event: 0, eventType: 0 }); // timer start

  // Define record (local 4) and course_point (local 5) once, then write many of each.
  w.define(4, 20, [["timestamp", 253, "uint32"], ["lat", 0, "sint32"], ["lon", 1, "sint32"], ["dist", 5, "uint32"], ["alt", 2, "uint16"]]);
  w.define(5, 32, [["timestamp", 1, "uint32"], ["lat", 2, "sint32"], ["lon", 3, "sint32"], ["dist", 4, "uint32"], ["type", 5, "enum"], ["name", 6, "string", POINT_NAME_MAX + 1], ["index", 254, "uint16"]]);
  // k: the next course point to write.
  let k = 0;
  T.forEach((p, i) => {
    // Course points sit between the records, in distance order, so the file reads start to finish.
    while (k < pts.length && (pts[k].km <= p.km || i === T.length - 1)) {
      const q = pts[k], at = trackAt(T, q.km);
      // A record at the exact same spot and time, so each point sits on the course line itself.
      w.write(4, { timestamp: tAt(q.km), lat: semi(at.lat), lon: semi(at.lon), dist: q.km * 100000, alt: alt(at.ele) });
      w.write(5, { timestamp: tAt(q.km), lat: semi(at.lat), lon: semi(at.lon), dist: q.km * 100000, type: q.type, name: q.name, index: k });
      k++;
    }
    w.write(4, { timestamp: tAt(p.km), lat: semi(p.lat), lon: semi(p.lon), dist: p.km * 100000, alt: alt(p.ele) });
  });

  w.write(3, { timestamp: t0 + sc.finishSec, event: 0, eventType: 4 }); // timer stop all
  return w.file();
}

/* ---------- GPX ---------- */

// xmlEsc: make text safe inside XML by replacing the 4 characters that have a meaning there (& < > ") with their "entities".
const xmlEsc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
// Garmin Connect's own GPX export writes a course point as <name>, <cmt> (the point's note) and <type> (the FIT icon name in capitals, e.g.
const GPX_TYPE = { [CP.generic]: "GENERIC", [CP.summit]: "SUMMIT", [CP.valley]: "VALLEY", [CP.danger]: "DANGER" };

/** The course as GPX 1.1: one waypoint per course point (short name, long text as its note, icon type) and the track. */
export function courseGpx(plan, sid, track, name = "Race", points = null) {
  const T = courseTrack(plan, track);
  const wpts = (points || coursePoints(plan, sid)).map((q) => {
    const at = trackAt(T, q.km);
    return `  <wpt lat="${at.lat.toFixed(6)}" lon="${at.lon.toFixed(6)}"><ele>${at.ele.toFixed(1)}</ele><name>${xmlEsc(q.name)}</name><cmt>${xmlEsc(q.text)}</cmt><type>${GPX_TYPE[q.type] || "GENERIC"}</type></wpt>`;
  });
  const trkpts = T.map((p) => `      <trkpt lat="${p.lat.toFixed(6)}" lon="${p.lon.toFixed(6)}"><ele>${p.ele.toFixed(1)}</ele></trkpt>`);
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Trail race planner" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><name>${xmlEsc(name)}</name></metadata>
${wpts.join("\n")}
  <trk><name>${xmlEsc(name)}</name><trkseg>
${trkpts.join("\n")}
  </trkseg></trk>
</gpx>
`;
}
