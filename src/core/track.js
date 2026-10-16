// track.js: read a GPX file and turn it into evenly spaced samples.
//
// Why resample? A GPS watch records one point per second (or per 5 m, or
// "smart recording"), so points are unevenly spaced in distance. Terrain
// maths (gradient, climbs) is much simpler when every sample is exactly the
// same distance apart, so we re-sample onto a fixed distance grid (10 m by
// default) and interpolate every channel (elevation, time, cadence...).
//
// Where it sits in the data flow: this is the very first step. plan.js calls
// parseGpx() on the race file and on your effort file(s), then resample() on
// each. terrain.js and effort.js then work only on the resampled arrays, and
// use smooth() from here to clean up noisy elevation.
//
// Main exports:
//   parseGpx(xml)        GPX text  -> {name, points: [{lat, lon, ele, time, hr (always null), cad}]}
//   haversine(a, b)      distance in metres between two GPS points
//   resample(parsed, 10) points    -> parallel arrays, one entry every 10 m
//   smooth(arr, w)       centred moving average (noise filter)
//
// Key ideas:
//   - Regular expressions instead of an XML parser, so the same code runs in
//     the browser and in Node with no library.
//   - The haversine formula for distance on a sphere.
//   - Linear interpolation ("lerp"): a value 30% of the way between two
//     points is a + 0.3 x (b - a).

/**
 * Parse a GPX string into raw points. No dependencies, works in browser and Node.
 *
 * Input: the whole GPX file as text.
 * Returns {name, points}: `name` is the first <name> tag of the file (or ""),
 * `points` is an array of {lat, lon (degrees), ele (m), time (ms since 1970
 * or null), hr (always null: heart rate is never read from a file), cad (steps per minute or null)}.
 * Throws an Error with a readable message when the text is not a usable GPX.
 */
export function parseGpx(xml) {
  // A cheap sanity check: every GPX file contains a <gpx ...> root tag.
  if (typeof xml !== "string" || !xml.includes("<gpx")) {
    throw new Error("This does not look like a GPX file.");
  }
  // The first <name>...</name> in the file, usually the track or route name.
  // ([^<]*) captures every character up to the next "<".
  const nameMatch = /<name>([^<]*)<\/name>/.exec(xml);
  const points = [];
  // One regex matches both kinds of GPX point: <trkpt> (a recorded track) and
  // <rtept> (a planned route). How it reads:
  //   <(trkpt|rtept)\b   the opening tag; group 1 remembers which one
  //   ([^>]*?)           group 2: the attributes (lat="..." lon="...")
  //   (?:\/>|            either a self-closing tag "/>" with no body, or
  //   >([\s\S]*?)<\/\1>) ">", group 3 = the body (any characters, newlines
  //                      included), then the matching closing tag (\1 = group 1)
  // The "g" flag lets matchAll() walk through every point in the file.
  const ptRe = /<(trkpt|rtept)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/g;
  for (const m of xml.matchAll(ptRe)) {
    const attrs = m[2];
    const body = m[3] || "";
    // Read lat="..." and lon="..." from the attributes. `|| []` avoids a crash
    // when the attribute is missing: [][1] is undefined and parseFloat gives NaN.
    const lat = parseFloat((/lat="([^"]+)"/.exec(attrs) || [])[1]);
    const lon = parseFloat((/lon="([^"]+)"/.exec(attrs) || [])[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const ele = num(/<ele>([^<]+)<\/ele>/.exec(body));
    if (ele === null) continue; // a trail plan needs elevation
    // Timestamps are ISO 8601 text ("2024-05-12T07:30:00Z"); Date.parse turns
    // them into milliseconds since 1 January 1970, which are easy to subtract.
    const timeStr = (/<time>([^<]+)<\/time>/.exec(body) || [])[1];
    const time = timeStr ? Date.parse(timeStr) : null;
    // Cadence lives in vendor extensions: <ns3:cad>, <gpxtpx:cad>, <cad>...
    // (?:[\w-]+:)? is an optional namespace prefix such as "gpxtpx:", so one
    // regex accepts every vendor's spelling of the same tag.
    // Heart rate is NEVER read from a file (owner's rule, 2026-10-16): it is health data, and the
    // only heart data the app uses is what the runner types in their profile. `hr` stays null, so
    // every heart-rate chart and number downstream simply sees "no heart rate".
    const hr = null;
    const cad = num(/<(?:[\w-]+:)?cad>([^<]+)<\/(?:[\w-]+:)?cad>/.exec(body));
    points.push({ lat, lon, ele, time: Number.isFinite(time) ? time : null, hr, cad });
  }
  if (points.length < 2) throw new Error("No track points with elevation found in this GPX.");
  return { name: nameMatch ? nameMatch[1].trim() : "", points };
}

/**
 * Turn a regex match into a number. `m` is the result of regex.exec(): null
 * when nothing matched, otherwise m[1] is the captured text.
 * Returns the number, or null when there was no match or the text is not a number.
 */
function num(m) {
  if (!m) return null;
  const v = parseFloat(m[1]);
  return Number.isFinite(v) ? v : null;
}

/**
 * Great-circle distance in metres between two lat/lon points.
 *
 * The haversine formula: treat the Earth as a sphere of radius R = 6371 km and
 * compute the length of the shortest arc between the two points. Inputs are
 * objects with `lat` and `lon` in degrees; trigonometry in JavaScript works in
 * radians, hence the "x PI / 180" conversions. Accurate to well under 1% for
 * the distances between two GPS points.
 */
export function haversine(a, b) {
  // Mean Earth radius in metres.
  const R = 6371000;
  const p1 = (a.lat * Math.PI) / 180;
  const p2 = (b.lat * Math.PI) / 180;
  const dl = ((b.lon - a.lon) * Math.PI) / 180;
  // h is the "haversine" of the angle between the points (** 2 means squared).
  const h = Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  // Turn it back into an angle (asin), then into an arc length on the sphere.
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * Re-sample a parsed track onto a regular distance grid.
 * Returns parallel arrays, one entry per `step` metres:
 *   ele (m), lat and lon (degrees, for the map), time (ms or null), hr (always null: heart rate is never read from a file), cad (spm or null).
 *
 * Input: `parsed` from parseGpx(), and `step` in metres (10 everywhere in the app).
 * The returned object also carries `step`, `n` (number of samples) and
 * `totalM` (track length in metres). "Parallel arrays" means sample k is
 * ele[k], lat[k], time[k]... all at distance k x step from the start.
 * A channel the file does not have (time, hr, cad) is null instead of an array.
 */
export function resample(parsed, step = 10) {
  const pts = parsed.points;
  // 1. Cumulative distance along the track at each kept GPS point (metres).
  //    cum[i] is the distance from the start to keep[i].
  const cum = [0];
  const keep = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const d = haversine(pts[i - 1], pts[i]);
    if (d <= 0) continue; // drop duplicates (the watch was standing still)
    cum.push(cum[cum.length - 1] + d);
    keep.push(pts[i]);
  }
  const total = cum[cum.length - 1];
  // 2. How many samples fit: one at 0 m, then one every `step` metres.
  const n = Math.floor(total / step) + 1;
  // 3. Which channels exist. Time must be on every point (a route with a few
  //    timestamps is useless for pace); heart rate and cadence only on some.
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
  // 4. Walk the grid. For each target distance x, find the GPS segment
  //    [cum[j], cum[j+1]] that contains it and interpolate between its two ends.
  //    j only ever moves forward, so the whole walk is a single pass over the
  //    points (no search from the start for every sample).
  let j = 0;
  for (let k = 0; k < n; k++) {
    const x = k * step;
    while (j < cum.length - 2 && cum[j + 1] < x) j++;
    const span = cum[j + 1] - cum[j];
    // f = how far x is between the two GPS points: 0 at the first, 1 at the second.
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

/**
 * Linear interpolation that tolerates missing values: a + f x (b - a), but
 * when one end is null it returns the other end, and null when both are.
 * Used for heart rate and cadence, which some GPS points do not carry.
 */
function lerpNullable(a, b, f) {
  if (a === null && b === null) return null;
  if (a === null) return b;
  if (b === null) return a;
  return a + f * (b - a);
}

/**
 * Centered moving average with half-window `w` samples.
 *
 * Each output value is the mean of the input values from i - w to i + w
 * (2w + 1 values). Near the ends the window is cut short rather than padded,
 * so the first and last values average fewer samples. On the 10 m grid,
 * w = 3 averages over +/-30 m, which removes most GPS elevation noise.
 * Returns a new array of the same length; the input is not modified.
 */
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
