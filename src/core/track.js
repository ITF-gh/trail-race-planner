// track.js: read a GPX file and turn it into evenly spaced samples.
//
// Why resample? A GPS watch records one point per second (or per 5 m, or
// "smart recording"), so points are unevenly spaced in distance. Terrain
// maths (gradient, climbs) is much simpler when every sample is exactly the
// same distance apart, so we re-sample onto a fixed distance grid (10 m by
// default) and interpolate every channel (elevation, time, heart rate...).

/** Parse a GPX string into raw points. No dependencies, works in browser and Node. */
export function parseGpx(xml) {
  if (typeof xml !== "string" || !xml.includes("<gpx")) {
    throw new Error("This does not look like a GPX file.");
  }
  const nameMatch = /<name>([^<]*)<\/name>/.exec(xml);
  const points = [];
  const ptRe = /<(trkpt|rtept)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/g;
  for (const m of xml.matchAll(ptRe)) {
    const attrs = m[2];
    const body = m[3] || "";
    const lat = parseFloat((/lat="([^"]+)"/.exec(attrs) || [])[1]);
    const lon = parseFloat((/lon="([^"]+)"/.exec(attrs) || [])[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const ele = num(/<ele>([^<]+)<\/ele>/.exec(body));
    if (ele === null) continue; // a trail plan needs elevation
    const timeStr = (/<time>([^<]+)<\/time>/.exec(body) || [])[1];
    const time = timeStr ? Date.parse(timeStr) : null;
    // Heart rate and cadence live in vendor extensions: <ns3:hr>, <gpxtpx:hr>, <hr>...
    const hr = num(/<(?:[\w-]+:)?hr>([^<]+)<\/(?:[\w-]+:)?hr>/.exec(body));
    const cad = num(/<(?:[\w-]+:)?cad>([^<]+)<\/(?:[\w-]+:)?cad>/.exec(body));
    points.push({ lat, lon, ele, time: Number.isFinite(time) ? time : null, hr, cad });
  }
  if (points.length < 2) throw new Error("No track points with elevation found in this GPX.");
  return { name: nameMatch ? nameMatch[1].trim() : "", points };
}

function num(m) {
  if (!m) return null;
  const v = parseFloat(m[1]);
  return Number.isFinite(v) ? v : null;
}

/** Great-circle distance in metres between two lat/lon points. */
export function haversine(a, b) {
  const R = 6371000;
  const p1 = (a.lat * Math.PI) / 180;
  const p2 = (b.lat * Math.PI) / 180;
  const dl = ((b.lon - a.lon) * Math.PI) / 180;
  const h = Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * Re-sample a parsed track onto a regular distance grid.
 * Returns parallel arrays, one entry per `step` metres:
 *   ele (m), lat and lon (degrees, for the map), time (ms or null), hr (bpm or null), cad (spm or null).
 */
export function resample(parsed, step = 10) {
  const pts = parsed.points;
  const cum = [0];
  const keep = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const d = haversine(pts[i - 1], pts[i]);
    if (d <= 0) continue; // drop duplicates (the watch was standing still)
    cum.push(cum[cum.length - 1] + d);
    keep.push(pts[i]);
  }
  const total = cum[cum.length - 1];
  const n = Math.floor(total / step) + 1;
  const hasTime = keep.every((p) => p.time !== null);
  const hasHr = keep.some((p) => p.hr !== null);
  const hasCad = keep.some((p) => p.cad !== null);
  const out = {
    step,
    n,
    totalM: total,
    ele: new Array(n),
    lat: new Array(n),
    lon: new Array(n),
    time: hasTime ? new Array(n) : null,
    hr: hasHr ? new Array(n) : null,
    cad: hasCad ? new Array(n) : null,
  };
  let j = 0;
  for (let k = 0; k < n; k++) {
    const x = k * step;
    while (j < cum.length - 2 && cum[j + 1] < x) j++;
    const span = cum[j + 1] - cum[j];
    const f = span > 0 ? (x - cum[j]) / span : 0;
    const a = keep[j];
    const b = keep[j + 1];
    out.ele[k] = a.ele + f * (b.ele - a.ele);
    out.lat[k] = a.lat + f * (b.lat - a.lat);
    out.lon[k] = a.lon + f * (b.lon - a.lon);
    if (hasTime) out.time[k] = a.time + f * (b.time - a.time);
    if (hasHr) out.hr[k] = lerpNullable(a.hr, b.hr, f);
    if (hasCad) out.cad[k] = lerpNullable(a.cad, b.cad, f);
  }
  return out;
}

function lerpNullable(a, b, f) {
  if (a === null && b === null) return null;
  if (a === null) return b;
  if (b === null) return a;
  return a + f * (b - a);
}

/** Centered moving average with half-window `w` samples. */
export function smooth(arr, w) {
  const out = new Array(arr.length);
  for (let i = 0; i < arr.length; i++) {
    const a = Math.max(0, i - w);
    const b = Math.min(arr.length - 1, i + w);
    let s = 0;
    for (let k = a; k <= b; k++) s += arr[k];
    out[i] = s / (b - a + 1);
  }
  return out;
}
