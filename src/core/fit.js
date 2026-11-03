// fit.js: turn a Garmin .FIT file or a .TCX file into GPX text, so every drop box reads them like a GPX (never heart rate).

const FIT_EPOCH = 631065600; // FIT time 0 = 1989-12-31 00:00 UTC, in Unix seconds
const FIT_SEMI = 180 / 2 ** 31; // semicircles -> degrees

/** Is this file a FIT file? (".FIT" at bytes 8-11 of the header) */
export function isFit(bytes) {
  return bytes && bytes.length > 12 && bytes[8] === 0x2e && bytes[9] === 0x46 && bytes[10] === 0x49 && bytes[11] === 0x54;
}

/** Read the points of a FIT activity or course: { name, sport, points: [{ lat, lon, ele, time, cad }] }. */
export function readFit(bytes) {
  if (!isFit(bytes)) throw new Error("This does not look like a FIT file.");
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const head = bytes[0];
  const end = Math.min(bytes.length, head + dv.getUint32(4, true));
  const defs = [];
  const points = [];
  let name = "", sport = null, lastTs = null, pos = head;
  // One field value, or null when it holds the "invalid" marker.
  const value = (at, size, base, le) => {
    const t = base & 0x1f;
    if (t === 7) { // string
      let s = "";
      for (let i = 0; i < size && bytes[at + i]; i++) s += String.fromCharCode(bytes[at + i]);
      return s;
    }
    if (size === 1) { const v = bytes[at]; return (t === 1 ? v === 0x7f : v === 0xff) ? null : (t === 1 && v > 127 ? v - 256 : v); }
    if (size === 2) { const v = t === 3 ? dv.getInt16(at, le) : dv.getUint16(at, le); return (t === 3 ? v === 0x7fff : v === 0xffff) ? null : v; }
    if (size === 4) { const v = t === 5 ? dv.getInt32(at, le) : dv.getUint32(at, le); return (t === 5 ? v === 0x7fffffff : v === 0xffffffff) ? null : v; }
    return null;
  };
  while (pos < end) {
    const h = bytes[pos++];
    if (h & 0x40 && !(h & 0x80)) { // definition message
      const le = bytes[pos + 1] === 0;
      const global = le ? dv.getUint16(pos + 2, true) : dv.getUint16(pos + 2, false);
      const n = bytes[pos + 4];
      pos += 5;
      const fields = [];
      for (let i = 0; i < n; i++, pos += 3) fields.push([bytes[pos], bytes[pos + 1], bytes[pos + 2]]);
      let dev = 0;
      if (h & 0x20) { const nd = bytes[pos++]; for (let i = 0; i < nd; i++, pos += 3) dev += bytes[pos + 1]; }
      defs[h & 0x0f] = { global, le, fields, dev };
      continue;
    }
    // Data message: normal header (local type in bits 0-3) or compressed timestamp (bit 7, local type in bits 5-6).
    const compressed = h & 0x80;
    const d = defs[compressed ? (h >> 5) & 3 : h & 0x0f];
    if (!d) throw new Error("This FIT file is damaged.");
    const f = {};
    for (const [num, size, base] of d.fields) { f[num] = value(pos, size, base, d.le); pos += size; }
    pos += d.dev;
    if (compressed && lastTs !== null) {
      const off = h & 0x1f;
      f[253] = (lastTs & ~0x1f) + off + (off >= (lastTs & 0x1f) ? 0 : 0x20);
    }
    if (f[253] != null && d.global !== 0) lastTs = f[253];
    if (d.global === 18 && f[5] != null && sport === null) sport = f[5]; // session sport (1 = running)
    if (d.global === 31 && f[5]) name = f[5]; // course name
    if (d.global !== 20) continue; // only "record" messages are points
    const lat = f[0], lon = f[1];
    const alt = f[78] != null ? f[78] : f[2];
    if (lat == null || lon == null || alt == null) continue; // no GPS or no elevation: skipped, like in a GPX
    points.push({
      lat: lat * FIT_SEMI, lon: lon * FIT_SEMI, ele: alt / 5 - 500,
      time: f[253] != null ? (f[253] + FIT_EPOCH) * 1000 : null,
      cad: f[4] != null ? f[4] : null,
    });
  }
  return { name, sport, points };
}

/** Read the points of a TCX file (Garmin / Strava export): same shape as readFit. */
export function readTcx(xml) {
  if (typeof xml !== "string" || !xml.includes("<TrainingCenterDatabase")) throw new Error("This does not look like a TCX file.");
  const tag = (body, t) => (new RegExp(`<(?:[\\w-]+:)?${t}>([^<]+)<`).exec(body) || [])[1];
  const points = [];
  for (const m of xml.matchAll(/<Trackpoint>([\s\S]*?)<\/Trackpoint>/g)) {
    const b = m[1];
    const lat = parseFloat(tag(b, "LatitudeDegrees")), lon = parseFloat(tag(b, "LongitudeDegrees")), ele = parseFloat(tag(b, "AltitudeMeters"));
    if (![lat, lon, ele].every(Number.isFinite)) continue;
    const time = Date.parse(tag(b, "Time") || "");
    const cad = parseFloat(tag(b, "RunCadence") || tag(b, "Cadence") || "");
    points.push({ lat, lon, ele, time: Number.isFinite(time) ? time : null, cad: Number.isFinite(cad) ? cad : null });
  }
  const name = (/<(?:Name|Notes)>([^<]*)</.exec(xml) || [])[1] || "";
  return { name, sport: null, points };
}

/** Points -> GPX text (track, elevation, time, cadence). */
export function pointsToGpx(name, points) {
  const x = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const pts = points.map((p) => `<trkpt lat="${p.lat.toFixed(7)}" lon="${p.lon.toFixed(7)}"><ele>${p.ele.toFixed(1)}</ele>${p.time != null ? `<time>${new Date(p.time).toISOString()}</time>` : ""}${p.cad != null ? `<extensions><cad>${p.cad}</cad></extensions>` : ""}</trkpt>`);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="Prep my race" xmlns="http://www.topografix.com/GPX/1/1">\n<trk><name>${x(name || "Imported run")}</name><trkseg>\n${pts.join("\n")}\n</trkseg></trk>\n</gpx>\n`;
}

/** A FIT file (bytes) -> GPX text. */
export function fitToGpx(bytes, fallbackName = "") {
  const r = readFit(bytes);
  if (r.points.length < 2) throw new Error("No GPS points with elevation in this FIT file (indoor or treadmill run?).");
  return pointsToGpx(r.name || fallbackName, r.points);
}

/** A TCX file (text) -> GPX text. */
export function tcxToGpx(xml, fallbackName = "") {
  const r = readTcx(xml);
  if (r.points.length < 2) throw new Error("No GPS points with elevation in this TCX file.");
  return pointsToGpx(fallbackName || r.name, r.points);
}
