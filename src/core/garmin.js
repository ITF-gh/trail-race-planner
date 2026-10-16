// garmin.js: the race plan as a course for a GPS watch, with the plan's cues along the way.
//
// A watch follows a course (the route) and shows "course points" on it: named spots that
// trigger an alert as you approach them ("HIKE 5.5k +726 · 0.2 km"). We write one each time
// the strategy changes and one at every key zone: few alerts, each worth reading.
//
//   coursePoints(plan, sid)              the points: km, FIT icon type, short name, long text
//   courseFit(plan, sid, track, opts)    a FIT course file (Garmin's binary format), as bytes
//   courseGpx(plan, sid, track, name)    the same as a GPX with waypoints, for any brand
//
// FIT (Flexible and Interoperable Data Transfer) is what Garmin watches store. A file is:
//   a 14-byte header,
//   then messages, each either a DEFINITION (for local type L: global message number and the
//   list of fields with their size and base type) or DATA (L, then the raw field values in
//   exactly that layout), so a reader learns the layout once and then reads values,
//   then a CRC-16 checksum of everything before it.
// A course is: file_id, course, lap, a timer start event, the records (position, altitude,
// distance, time) with the course points among them in distance order, a timer stop event.
// The record times come from the plan, so the watch's Virtual Partner runs at your plan pace.
// Field numbers and the course point icon list come from Garmin's FIT SDK (Profile 21.x).
//
// Where it sits: src/ui/watch.js (the "Watch" panel of Prep my race and Prep my run) calls
// editedPoints to list the messages, then courseFit or courseGpx to build the download. The plan
// comes from plan.js buildPlan (a race) or preprun.js prepRunPlan (a run); sections come from
// script.js raceLegs. This file only builds bytes and text: saving the file is the UI's job.
//
// Binary basics used below: a byte holds 0..255 (0x00..0xff in hexadecimal). A bigger number is
// stored as several bytes, lowest byte first ("little-endian"): 2132 = 0x0854 is written 0x54, 0x08.
// `x & 0xff` keeps the lowest byte, `x >> 8` shifts right by one byte, `|` combines bits.

import { raceLegs, secAtKm, raceStateAt } from "./script.js";
import { haversine } from "./track.js";
import { clock } from "./format.js";

/** Longest name we write: watches show about 15 characters (a 30-character name gave an error). */
export const POINT_NAME_MAX = 15;

/**
 * FIT course point icon types used here (FIT SDK enum `course_point`). Only the classic ones
 * (0-9): Garmin Connect stalls when a point uses a newer type (steep incline, alert, info...).
 */
export const CP = { generic: 0, summit: 1, valley: 2, danger: 5 };

// Strategy words, short enough to leave room for the length and the climb or drop.
// Keys are the tactic phrases written by plan.js climbTactic; values are what the watch shows.
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

/**
 * Watch-safe text: plain ASCII (accents dropped), at most POINT_NAME_MAX characters.
 *
 * 1. normalize("NFD") splits an accented letter into the letter plus a separate accent mark
 *    ("é" becomes "e" + "´").
 * 2. /[\u0300-\u036f]/g matches those accent marks (the Unicode "combining" range): removed.
 * 3. /[^\x20-\x7e]/g matches anything that is not a printable ASCII character (space to ~),
 *    such as emoji or the "·" dot: removed.
 * 4. Trim spaces, cut to `max` characters, trim again (the cut may leave a trailing space).
 */
export function pointName(s, max = POINT_NAME_MAX) {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^\x20-\x7e]/g, "").trim().slice(0, max).trim();
}

/** "1.8k" under 10 km, "12k" above: a length that fits in a short name. 9.95 so 9.96 km shows "10k", not "10.0k". */
function kmShort(km) {
  return km < 9.95 ? `${km.toFixed(1)}k` : `${Math.round(km)}k`;
}

/**
 * The first of these names that fits on the watch (they go from airy to packed).
 * `...tries` (rest parameter) collects all the arguments into an array. Each is cleaned with a
 * generous limit (99) so its real length can be checked; if none fits, the last one is cut.
 */
function fitName(...tries) {
  const ok = tries.map((t) => pointName(t, 99)).find((t) => t.length <= POINT_NAME_MAX);
  return ok || pointName(tries[tries.length - 1]);
}

/**
 * Strategy of a race section in a few characters.
 * Input: a section from raceLegs. A climb tactic not in CLIMB_SHORT falls back to its first word
 * in capitals (split(/[ ,]/) cuts at a space or a comma). Runnable sections are "RUN+EAT".
 */
function legShort(l) {
  if (l.kind === "climb") return CLIMB_SHORT[l.tactic] || l.tactic.split(/[ ,]/)[0].toUpperCase();
  if (l.kind === "descent") return DESCENT_SHORT[l.level] || "CONTROL";
  return "RUN+EAT";
}

/**
 * What to do in a key zone, in a few characters (the long version is z.how).
 * `switch` picks the case matching z.kind (the key-zone kinds of keyzones.js); `default` is
 * for any other kind (the runnable stretches). /power-hike/.test(text) is true when the text
 * contains "power-hike".
 */
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

// Two alerts need time to be read: each point comes at least 200 m and 1 minute (at plan pace)
// after the one before, pushed further along the course if needed.
export const MIN_GAP_M = 200;
export const MIN_GAP_SEC = 60;

// Strategy words counted as easy ground, merged into one plain "RUN" block when gentle.
const EASY = ["RUN", "LET GO", "RUN+EAT"];
const EASY_MAX_M = 60; // an easy section climbing or dropping less than this is plain running

/**
 * The race sections grouped by strategy: neighbouring sections with the same strategy word
 * (three HIKE sections in a row) make one block, with their lengths, D+ and D- added up.
 *
 * Returns [{word, kind, level, startKm, endKm, km, up, down (m), startSec, legs (the sections)}]
 * in course order. Walks the sections once: same word as the previous block, extend it; else
 * start a new block.
 */
export function strategyBlocks(plan, sid) {
  const blocks = [];
  for (const l of raceLegs(plan, sid)) {
    let word = legShort(l);
    // Gentle ground (an easy run, a short let-it-run drop, a runnable stretch) is just "RUN":
    // three of them in a row make one alert, not three.
    if (EASY.includes(word) && l.up < EASY_MAX_M && l.down < EASY_MAX_M) word = "RUN";
    const prev = blocks[blocks.length - 1];
    if (prev && prev.word === word) { prev.endKm = l.endKm; prev.km += l.km; prev.up += l.up; prev.down += l.down; prev.legs.push(l); }
    else blocks.push({ word, kind: l.kind, level: l.level, startKm: l.startKm, endKm: l.endKm, km: l.km, up: l.up, down: l.down, startSec: l.startSec, legs: [l] });
  }
  return blocks;
}

/**
 * Course points for scenario `sid`, in course order: {km, type, name, text}. Few and relevant:
 *   one alert each time the strategy changes: "HIKE 5.5k +726", "BRAKE 4.7k -675", "RUN+EAT 1.4k"
 *   one alert per key zone, marked "!": "!POWER HIKE 2.3k". A key zone that starts where a
 *   strategy block starts takes that block's place (one alert, not two at the same spot).
 * The full sentence (section numbers, tactic, arrival time, why the key zone matters) is the note.
 *
 * Each point: {id, km, type (a CP icon), name (15 characters at most), text (the note)}. The id
 * ("b12.30" for a block at km 12.3, "k2" for key zone 2) stays the same between runs of the
 * planner, so the runner's edits (editedPoints) find their point again.
 */
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
    const elev = b.word === "RUN" ? (up >= 20 || down >= 20 ? `+${up}-${down}` : "") : b.kind === "climb" ? `+${up}` : b.kind === "descent" ? `-${down}` : "";
    const type = b.word === "RUN" ? CP.generic : b.kind === "climb" ? CP.summit : b.kind === "descent" ? (b.level === 4 ? CP.danger : CP.valley) : CP.generic;
    const name = elev ? fitName(`${b.word} ${len} ${elev}`, `${b.word} ${len}${elev}`, `${b.word} ${elev}`) : fitName(`${b.word} ${len}`);
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

/**
 * Points in course order, each pushed along so it comes MIN_GAP_M and MIN_GAP_SEC after the one before.
 * Copies the points first (`{ ...p }`) so the caller's objects are not changed. "A minute later"
 * is found by turning the previous point's km into a clock time (secAtKm), adding 60 s and turning
 * it back into a km (raceStateAt). No point is pushed past the finish.
 */
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

/**
 * The runner's own version of the messages: the planner's points with their edits applied.
 * edits = {names: {id: "new name"}, off: {id: true}, extra: [{id, km, name}]}; an edited name
 * keeps the planner's long text as its note, an added message gets its own name as note.
 *
 * names: new names by point id; off: ids the runner unticked; extra: messages the runner added.
 * `!= null` is true for any value except null and undefined. A name that cleans down to nothing
 * (only emoji, say) is ignored and the planner's name is kept. Added messages are clamped to the
 * course and given the generic icon. Everything is spaced again at the end.
 */
export function editedPoints(plan, sid, edits = {}) {
  const names = edits.names || {}, off = edits.off || {};
  const mine = coursePoints(plan, sid)
    .filter((p) => !off[p.id])
    .map((p) => (names[p.id] != null && pointName(names[p.id]) ? { ...p, name: pointName(names[p.id]), edited: true } : p));
  const total = plan.course.totalKm;
  const extra = (edits.extra || [])
    .filter((x) => Number.isFinite(x.km) && pointName(x.name || ""))
    .map((x) => ({ id: x.id, km: Math.max(0, Math.min(total, x.km)), type: CP.generic, name: pointName(x.name), text: x.name, added: true }));
  return spacePoints(plan, sid, [...mine, ...extra]);
}

/**
 * The route as [{lat, lon, ele, km}] with points at least `minM` metres apart, its distance
 * stretched to the plan's total so plan km and route km agree. `track` is the race GPX's points
 * ({lat, lon, ele}); without it the plan's own 100 m route and profile are used.
 *
 * Why stretch: the plan's km come from the 10 m resampling, the GPX distance from haversine on
 * the raw points; they can differ by a little. Multiplying every distance by f = plan total /
 * track total makes the watch's km match the plan's. Points closer than `minM` metres (15) are
 * skipped to keep the file small; the last point is always kept.
 */
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

/**
 * Position and altitude at `km` on a courseTrack (linear between points).
 * A walk from the start to the first point at or past km, then interpolation between it and the
 * point before. Returns {lat, lon, ele}.
 */
function trackAt(T, km) {
  let i = 1;
  while (i < T.length - 1 && T[i].km < km) i++;
  const a = T[i - 1], b = T[i];
  const f = b.km > a.km ? Math.max(0, Math.min(1, (km - a.km) / (b.km - a.km))) : 0;
  return { lat: a.lat + f * (b.lat - a.lat), lon: a.lon + f * (b.lon - a.lon), ele: a.ele + f * (b.ele - a.ele) };
}

/* ---------- FIT encoding ---------- */

// FIT constants. BASE: the FIT SDK code of each base type, written in a definition (0x84 etc.:
// the high bit 0x80 marks types of more than one byte). SIZE: how many bytes each takes.
// uint32z is an unsigned 32-bit number where 0 means "no value" (used for the serial number).
const FIT_EPOCH_MS = Date.UTC(1989, 11, 31); // FIT times are seconds since 31 Dec 1989 00:00 UTC
const BASE = { enum: 0x00, uint8: 0x02, uint16: 0x84, sint32: 0x85, uint32: 0x86, string: 0x07, uint32z: 0x8c };
const SIZE = { enum: 1, uint8: 1, uint16: 2, sint32: 4, uint32: 4, uint32z: 4 };

// CRC-16 as in the FIT SDK: four bits at a time, with a 16-entry table.
// A CRC (cyclic redundancy check) is a 16-bit fingerprint of the bytes: the watch recomputes it and
// refuses the file if it differs, so a corrupted download is caught.
const CRC_TABLE = [0x0000, 0xcc01, 0xd801, 0x1400, 0xf001, 0x3c00, 0x2800, 0xe401, 0xa001, 0x6c00, 0x7800, 0xb401, 0x5000, 0x9c01, 0x8801, 0x4400];
/**
 * CRC-16 of `bytes` (an array or Uint8Array), continuing from `crc` (0 to start).
 * Each byte is processed as two halves of 4 bits ("nibbles"): low half (& 0xf), then high half
 * (>> 4). `^` is XOR (exclusive or), `>>` a right shift. Returns a number 0..65535.
 * Handy property: the CRC of a whole valid FIT file, checksum included, is 0 (the tests use it).
 */
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

/**
 * Minimal FIT writer: little-endian, one local message type per global message.
 *
 * A closure: `bytes` and `defs` live inside fitWriter and are shared by the three methods it
 * returns (define, write, file), but cannot be reached from outside.
 *   define(local, global, fields)   write a definition message for local type `local`
 *   write(local, values)            write a data message in that layout
 *   file()                          wrap everything with the header and CRC: a Uint8Array
 */
function fitWriter() {
  const bytes = [];
  const defs = {};
  // put(v, type, size): append one value as bytes. A string is UTF-8 encoded (TextEncoder), cut to
  // leave room for a final 0 byte, and padded with zeros to its fixed size. A number is rounded and
  // written lowest byte first. A negative sint32 is turned into its 32-bit "two's complement" form
  // by `| 0` (to a signed 32-bit integer) then `>>> 0` (read the same bits as unsigned).
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
    /**
     * fields: [[name, fieldNum, type, size?]].
     * Definition message: header byte 0x40 | local (0x40 = "this is a definition"), a reserved 0,
     * architecture 0 (little-endian), the global message number on 2 bytes, the field count,
     * then 3 bytes per field: field number, size in bytes, base type. `[, num, type, size]`
     * destructures each field and skips its name (the empty slot before the first comma).
     */
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
    // Header (14 bytes): header size, protocol version (0x20 = 2.0), profile version 2132 (21.32) on
    // 2 bytes, the data size on 4 bytes (filled in below), the text ".FIT" (0x2e 0x46 0x49 0x54), then
    // a CRC of those first 12 bytes. After the data comes the CRC of everything before it.
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

/**
 * A FIT course of the race for scenario `sid`. `track` = the race GPX points ({lat, lon, ele});
 * opts: {name (shown on the watch), points (the messages, default coursePoints), date (start of the course, a Date; only the plan's relative
 * times matter to the watch)}. Returns a Uint8Array, ready to save as a .fit file.
 *
 * Steps: the track (courseTrack), then messages in the order a course needs them:
 *   0 file_id (global 0)  "this file is a course"
 *   1 course (31)         name and sport (running, trail)
 *   2 lap (19)            start and end position, total time, distance, D+ and D-
 *   3 event (21)          timer start; at the end, timer stop
 *   4 record (20)         one per track point: time, position, distance, altitude
 *   5 course_point (32)   the messages, slotted between the records in distance order
 * Units FIT expects: times in seconds since 31 Dec 1989 (t0 is the start), lap times in
 * milliseconds, distances in centimetres (km x 100000), positions in semicircles.
 */
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
  // A course point's name field is 16 bytes: 15 characters plus the closing 0.
  w.define(4, 20, [["timestamp", 253, "uint32"], ["lat", 0, "sint32"], ["lon", 1, "sint32"], ["dist", 5, "uint32"], ["alt", 2, "uint16"]]);
  w.define(5, 32, [["timestamp", 1, "uint32"], ["lat", 2, "sint32"], ["lon", 3, "sint32"], ["dist", 4, "uint32"], ["type", 5, "enum"], ["name", 6, "string", POINT_NAME_MAX + 1], ["index", 254, "uint16"]]);
  // k: the next course point to write. Before each track record, write every course point whose km
  // is already passed (and, at the last record, all the points left), each preceded by a record at
  // the same spot.
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

// xmlEsc: make text safe inside XML by replacing the 4 characters that have a meaning there
// (& < > ") with their "entities". The /g flag replaces every occurrence, not just the first.
const xmlEsc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
// Garmin Connect's own GPX export writes a course point as <name>, <cmt> (the point's note) and
// <type> (the FIT icon name in capitals, e.g. INFO), and reads the same back on import.
const GPX_TYPE = { [CP.generic]: "GENERIC", [CP.summit]: "SUMMIT", [CP.valley]: "VALLEY", [CP.danger]: "DANGER" };

/**
 * The course as GPX 1.1: one waypoint per course point (short name, long text as its note, icon type) and the track.
 * Returns the whole file as one text. Positions are written with 6 decimals (about 10 cm),
 * altitudes with 1. The file is built with template literals (backtick strings with ${...}
 * placeholders) and the lines joined with "\n" (a line break).
 */
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
