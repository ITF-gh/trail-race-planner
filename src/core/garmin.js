// garmin.js: the race plan as a course for a GPS watch, with the plan's cues along the way.
//
// A watch follows a course (the route) and shows "course points" on it: named spots that
// trigger an alert as you approach them ("12 HIKE steep · 0.2 km"). We write two at the start
// of every race section (its facts, then its strategy) and two at every key zone.
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

import { raceLegs, secAtKm } from "./script.js";
import { haversine } from "./track.js";
import { clock } from "./format.js";

/** Longest name we write: watches show about 15 characters. */
export const POINT_NAME_MAX = 15;

/**
 * FIT course point icon types used here (FIT SDK enum `course_point`). Only the classic ones
 * (0-9): Garmin Connect stalls when a point uses a newer type (steep incline, alert, info...).
 */
export const CP = { generic: 0, summit: 1, valley: 2, danger: 5 };

const CLIMB_SHORT = {
  "Hike": "HIKE",
  "Hike the steep part": "HIKE steep",
  "Biggest climb, steady": "BIG: steady",
  "Run evenly, do not surge": "RUN even",
  "Run": "RUN",
  "Steady": "STEADY",
};
const DESCENT_SHORT = { 1: "LET IT RUN", 2: "QUICK STEPS", 4: "BRAKE" };
const MODE_SHORT = { attack: "ATTACK", prepare: "PREPARE", manage: "MANAGE" };

/** Watch-safe text: plain ASCII (accents dropped), at most POINT_NAME_MAX characters. */
export function pointName(s, max = POINT_NAME_MAX) {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^\x20-\x7e]/g, "").trim().slice(0, max).trim();
}

/** "1.8k" under 10 km, "12k" above: a length that fits in a short name. */
function kmShort(km) {
  return km < 9.95 ? `${km.toFixed(1)}k` : `${Math.round(km)}k`;
}

/** Strategy of a race section in a few characters. */
function legShort(l) {
  if (l.kind === "climb") return CLIMB_SHORT[l.tactic] || l.tactic.split(/[ ,]/)[0].toUpperCase();
  if (l.kind === "descent") return DESCENT_SHORT[l.level] || "CONTROL";
  return "RUN+FUEL";
}

/** What to do in a key zone, in a few characters (the long version is z.how). */
function keyShort(z) {
  switch (z.kind) {
    case "climb": return /power-hike/.test(z.how) ? "POWER HIKE" : "RUN/HIKE";
    case "start": return "START SLOW";
    case "approach": return "EAT+EASE OFF";
    case "wall": return "HIKE IT";
    case "restart": return "RUN AGAIN";
    case "descent": return z.mode === "attack" ? "LET IT GO" : "SAVE QUADS";
    default: return "RUN TALL";
  }
}

const SPACING_KM = 0.025; // points closer than 25 m are pushed apart so each one gets its alert

/**
 * Course points for scenario `sid`, in course order: {km, type, name, text}.
 * Per section: "12 1.8k +320-40" (number, length, D+, D-) then "12 HIKE steep" (strategy).
 * Per key zone: "K1 2.4k ATTACK" (length, mode) then "K1 POWER HIKE" (what to do).
 */
export function coursePoints(plan, sid) {
  const legs = raceLegs(plan, sid);
  const st = plan.startSec;
  const pts = [];
  legs.forEach((l) => {
    const up = Math.round(l.up), down = Math.round(l.down);
    const facts = `${l.i} ${kmShort(l.km)} +${up}-${down}`;
    const type = l.kind === "climb" ? CP.summit : l.kind === "descent" ? (l.level === 4 ? CP.danger : CP.valley) : CP.generic;
    const head = `Section ${l.i}/${legs.length} · ${l.title}${l.kind === "flat" ? "" : ` · ${l.label}`}`;
    pts.push({ km: l.startKm, order: 0, type, name: pointName(facts.length <= POINT_NAME_MAX ? facts : `${l.i} +${up}-${down}`), text: `${head}: ${l.km.toFixed(1)} km, +${up} m / -${down} m, arrive ${clock(st, l.startSec)}.` });
    pts.push({ km: l.startKm, order: 1, type: CP.generic, name: pointName(`${l.i} ${legShort(l)}`), text: `${head}: ${l.tactic}.` });
  });
  (plan.keyZones || []).forEach((z) => {
    const len = z.toKm - z.fromKm;
    pts.push({ km: z.fromKm, order: 2, type: CP.danger, name: pointName(`K${z.n} ${kmShort(len)} ${MODE_SHORT[z.mode] || ""}`), text: `Key zone ${z.n} · ${z.modeLabel} · ${z.title}: ${len.toFixed(1)} km. ${z.why}` });
    pts.push({ km: z.fromKm, order: 3, type: CP.danger, name: pointName(`K${z.n} ${keyShort(z)}`), text: `Key zone ${z.n}: ${z.how}` });
  });
  pts.sort((a, b) => a.km - b.km || a.order - b.order);
  const total = plan.course.totalKm;
  for (let i = 1; i < pts.length; i++) pts[i].km = Math.max(pts[i].km, pts[i - 1].km + SPACING_KM);
  return pts.map(({ order, ...p }) => ({ ...p, km: Math.min(p.km, total) }));
}

/**
 * The route as [{lat, lon, ele, km}] with points at least `minM` metres apart, its distance
 * stretched to the plan's total so plan km and route km agree. `track` is the race GPX's points
 * ({lat, lon, ele}); without it the plan's own 100 m route and profile are used.
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

/** Position and altitude at `km` on a courseTrack (linear between points). */
function trackAt(T, km) {
  let i = 1;
  while (i < T.length - 1 && T[i].km < km) i++;
  const a = T[i - 1], b = T[i];
  const f = b.km > a.km ? Math.max(0, Math.min(1, (km - a.km) / (b.km - a.km))) : 0;
  return { lat: a.lat + f * (b.lat - a.lat), lon: a.lon + f * (b.lon - a.lon), ele: a.ele + f * (b.ele - a.ele) };
}

/* ---------- FIT encoding ---------- */

const FIT_EPOCH_MS = Date.UTC(1989, 11, 31); // FIT times are seconds since 31 Dec 1989 00:00 UTC
const BASE = { enum: 0x00, uint8: 0x02, uint16: 0x84, sint32: 0x85, uint32: 0x86, string: 0x07, uint32z: 0x8c };
const SIZE = { enum: 1, uint8: 1, uint16: 2, sint32: 4, uint32: 4, uint32z: 4 };

// CRC-16 as in the FIT SDK: four bits at a time, with a 16-entry table.
const CRC_TABLE = [0x0000, 0xcc01, 0xd801, 0x1400, 0xf001, 0x3c00, 0x2800, 0xe401, 0xa001, 0x6c00, 0x7800, 0xb401, 0x5000, 0x9c01, 0x8801, 0x4400];
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
    write(local, values) {
      bytes.push(local);
      for (const [name, , type, size] of defs[local]) put(values[name], type, size || SIZE[type]);
    },
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
 * opts: {name (shown on the watch), date (start of the course, a Date; only the plan's relative
 * times matter to the watch)}. Returns a Uint8Array, ready to save as a .fit file.
 */
export function courseFit(plan, sid, track, opts = {}) {
  const T = courseTrack(plan, track);
  const pts = coursePoints(plan, sid);
  const sc = plan.scenarios[sid];
  const start = opts.date || new Date();
  const t0 = Math.floor((start.getTime() - FIT_EPOCH_MS) / 1000);
  const tAt = (km) => t0 + Math.round(secAtKm(plan, sid, Math.min(km, plan.course.totalKm)));
  const alt = (e) => (Math.max(-500, e) + 500) * 5; // altitude: scale 5, offset 500 m
  const first = T[0], last = T[T.length - 1];
  const w = fitWriter();

  w.define(0, 0, [["type", 0, "enum"], ["manufacturer", 1, "uint16"], ["product", 2, "uint16"], ["serial", 3, "uint32z"], ["created", 4, "uint32"]]);
  w.write(0, { type: 6, manufacturer: 255, product: 0, serial: 1, created: t0 }); // 6 = course, 255 = development

  w.define(1, 31, [["name", 5, "string", 32], ["sport", 4, "enum"], ["subSport", 7, "enum"]]);
  w.write(1, { name: pointName(opts.name || "Race", 31) || "Race", sport: 1, subSport: 3 }); // running, trail

  w.define(2, 19, [["timestamp", 253, "uint32"], ["startTime", 2, "uint32"], ["sLat", 3, "sint32"], ["sLon", 4, "sint32"], ["eLat", 5, "sint32"], ["eLon", 6, "sint32"],
    ["elapsed", 7, "uint32"], ["timer", 8, "uint32"], ["dist", 9, "uint32"], ["ascent", 21, "uint16"], ["descent", 22, "uint16"], ["event", 0, "enum"], ["eventType", 1, "enum"]]);
  w.write(2, { timestamp: t0 + sc.finishSec, startTime: t0, sLat: semi(first.lat), sLon: semi(first.lon), eLat: semi(last.lat), eLon: semi(last.lon),
    elapsed: sc.finishSec * 1000, timer: sc.finishSec * 1000, dist: plan.course.totalKm * 100000, ascent: plan.course.gain, descent: plan.course.loss, event: 9, eventType: 1 });

  w.define(3, 21, [["timestamp", 253, "uint32"], ["event", 0, "enum"], ["eventType", 1, "enum"]]);
  w.write(3, { timestamp: t0, event: 0, eventType: 0 }); // timer start

  w.define(4, 20, [["timestamp", 253, "uint32"], ["lat", 0, "sint32"], ["lon", 1, "sint32"], ["dist", 5, "uint32"], ["alt", 2, "uint16"]]);
  w.define(5, 32, [["timestamp", 1, "uint32"], ["lat", 2, "sint32"], ["lon", 3, "sint32"], ["dist", 4, "uint32"], ["type", 5, "enum"], ["name", 6, "string", POINT_NAME_MAX + 1], ["index", 254, "uint16"]]);
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

const xmlEsc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const GPX_SYM = { [CP.summit]: "Summit", [CP.danger]: "Danger Area", [CP.valley]: "Flag, Blue", [CP.generic]: "Information" };

/** The course as GPX 1.1: one waypoint per course point (short name, long text) and the track. */
export function courseGpx(plan, sid, track, name = "Race") {
  const T = courseTrack(plan, track);
  const wpts = coursePoints(plan, sid).map((q) => {
    const at = trackAt(T, q.km);
    return `  <wpt lat="${at.lat.toFixed(6)}" lon="${at.lon.toFixed(6)}"><ele>${at.ele.toFixed(1)}</ele><name>${xmlEsc(q.name)}</name><desc>${xmlEsc(q.text)}</desc><sym>${GPX_SYM[q.type] || "Waypoint"}</sym></wpt>`;
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
