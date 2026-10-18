// snapshot.js: what "Save to my account" keeps so a mode can be reopened and still work
// (Boss, 2026-10-18: "like saving the page"): change the target, the settings, the scenario,
// and everything is computed again.
//
// The app needs the points it read to compute again, so a save keeps them, packed small. It does
// not keep the original file: only position, elevation, time and cadence (what parseGpx reads),
// never heart rate (parseGpx never reads it either).
//
// Packing ("delta encoding"): consecutive GPS points are close, so each value is stored as the
// difference from the one before, as a whole number:
//   lat, lon   in millionths of a degree (about 0.1 m)
//   ele        in tenths of a metre
//   time       in seconds (null when the file has no times)
//   cad        in steps per minute (null when the file has none)
// Small whole numbers are short as text and compress very well (the browser then gzips the
// whole snapshot, see ui/main.js).
//
// Main exports: packTrack, unpackTrack, trackToGpx.

// Differences between neighbours: [a, b, c] -> [a, b - a, c - b]; and back with a running sum.
const delta = (a) => a.map((v, i) => (i ? v - a[i - 1] : v));
const undelta = (d) => { let s = 0; return d.map((v) => (s += v)); };

/**
 * Pack a parsed track ({ name, points } from parseGpx) into plain arrays of whole numbers.
 * Returns { name, lat, lon, ele, t (or null), cad (or null) }.
 */
export function packTrack(parsed) {
  const P = parsed.points;
  const hasT = P.every((p) => Number.isFinite(p.time));
  const hasCad = P.some((p) => Number.isFinite(p.cad));
  return {
    name: String(parsed.name || "").slice(0, 120),
    lat: delta(P.map((p) => Math.round(p.lat * 1e6))),
    lon: delta(P.map((p) => Math.round(p.lon * 1e6))),
    ele: delta(P.map((p) => Math.round(p.ele * 10))),
    t: hasT ? delta(P.map((p) => Math.round(p.time / 1000))) : null,
    cad: hasCad ? P.map((p) => (Number.isFinite(p.cad) ? Math.round(p.cad) : -1)) : null,
  };
}

/** The reverse of packTrack: { name, points: [{ lat, lon, ele, time, hr: null, cad }] }. */
export function unpackTrack(k) {
  const lat = undelta(k.lat), lon = undelta(k.lon), ele = undelta(k.ele);
  const t = k.t ? undelta(k.t) : null;
  const points = lat.map((v, i) => ({
    lat: v / 1e6, lon: lon[i] / 1e6, ele: ele[i] / 10,
    time: t ? t[i] * 1000 : null, hr: null,
    cad: k.cad && k.cad[i] >= 0 ? k.cad[i] : null,
  }));
  return { name: k.name || "", points };
}

// Escape text for XML (& < > ").
const snapEsc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/**
 * A minimal GPX text of a track, so a reopened item goes through exactly the same loading code as
 * a dropped file (each mode's loader takes GPX text).
 */
export function trackToGpx(parsed) {
  const pts = parsed.points.map((p) => `<trkpt lat="${p.lat.toFixed(6)}" lon="${p.lon.toFixed(6)}"><ele>${p.ele.toFixed(1)}</ele>${p.time !== null ? `<time>${new Date(p.time).toISOString()}</time>` : ""}${p.cad !== null ? `<extensions><cad>${p.cad}</cad></extensions>` : ""}</trkpt>`).join("");
  return `<?xml version="1.0" encoding="UTF-8"?><gpx version="1.1" creator="Prep my race"><trk><name>${snapEsc(parsed.name || "")}</name><trkseg>${pts}</trkseg></trk></gpx>`;
}
