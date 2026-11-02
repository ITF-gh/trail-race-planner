// demo.js: synthetic GPX files for the demo button and the tests.

// Starting point of the straight-line demo tracks: latitude 45 degrees N, longitude 5 degrees E (somewhere in the French Alps foothills; the place itself does not matter).
const LAT0 = 45.0;
const LON0 = 5.0;
// Metres per degree of latitude: the Earth's circumference (about 40,075 km) divided by 360.
const M_PER_DEG_LAT = 111320;

/** [length in metres, gradient in %] stretches that describe a profile. */
export const DEMO_RACE_PROFILE = [
  [2000, 0], [1200, 4], [800, -3], [600, 9], [500, -8], [1500, 0],
  [900, 7], [700, -10], [1100, 5], [400, 14], [600, -12], [2500, 1],
  [800, 8], [500, 12], [900, -9], [1300, 0], [700, 10], [600, -6],
  [1500, 3], [300, 16], [800, -10], [2000, 0], [1000, 6], [700, -5],
];

/** The demo button's race: a made-up mountain ultra of 78.4 km and about 3,800 m of climbing, from a 650 m valley over four big climbs (the longest gains 650 m over 8.5 km) with steep, technical descents... */
export const DEMO_ULTRA_PROFILE = [
  [1500, 0], [1500, 6], [2000, 13], [1200, 16], [1500, 8], [800, 20], [1500, 2], [800, -4], [1000, 3],
  [1200, -14], [1500, -22], [2000, -9], [1500, 0],
  [2500, 5], [3000, 9], [1500, 4], [1000, 13], [1500, 15], [2000, 0], [600, -6], [900, 7],
  [3000, -14], [1500, -9], [1500, 0],
  [1500, 12], [1000, 25], [1200, 18], [1500, 12], [700, 22], [1500, -3], [1000, 6], [800, -2],
  [2000, -18], [2500, -11], [1500, -24], [1500, 0],
  [1500, 3], [2000, 8], [1500, 14], [1500, 10], [800, 17], [1500, -10], [2000, -15], [1500, -5],
  [1000, 18], [1000, -16], [1200, 8], [900, -6], [1500, 2], [2500, -12], [2000, -13], [1500, -11], [800, 0],
];

/** Aid stations of the demo ultra, as typed in the settings: km, name, minutes stopped. */
export const DEMO_ULTRA_AID = [
  "16.5 Le Moulin 3",
  "29.5 Refuge des Aiguilles 4",
  "37 Combe-Basse (bag drop) 10",
  "46 Col de la Brèche 2",
  "53.7 Les Granges 6",
  "64.5 Chalet du Pré 4",
  "71.6 La Crête 2",
].join("\n");

/** A 30 km mountain long run with 1,230 m of climbing, the demo's reference runs for the ultra. */
export const DEMO_LONG_RUN_PROFILE = [
  [2000, 0], [1500, 6], [1500, 11], [800, 16], [700, -8], [1200, -14], [2500, 0], [2000, 9], [1000, 14],
  [600, 20], [1500, -12], [1000, -18], [2000, 0], [1500, 5], [1200, 13], [1000, -10], [1200, -6],
  [2500, 0], [800, 22], [800, -20], [3000, -10.5],
];

/** Pace (s/km) by gradient for the generated effort file, fresh. */
export function demoPace(grade) {
  if (grade < -20) return 400;
  if (grade < -12) return 330;
  if (grade < -6) return 290;
  if (grade < -2) return 275;
  if (grade < 2) return 265;
  if (grade < 6) return 300;
  if (grade < 10) return 350;
  if (grade < 15) return 430;
  if (grade < 22) return 560;
  return 780;
}

/** Elevation (metres) at distance `d` (metres) along a profile that starts at elevation `e0`. */
function eleAt(profile, d, e0) {
  let pos = 0;
  let e = e0;
  for (const [len, g] of profile) {
    if (d <= pos + len) return e + ((d - pos) * g) / 100;
    e += (len * g) / 100;
    pos += len;
  }
  return e;
}

/** The opening lines of a GPX file: the XML declaration, the <gpx> root with its namespaces, and the start of one track (<trk>) and one track segment (<trkseg>). */
function gpxHeader(name) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx creator="demo" version="1.1" xmlns="http://www.topografix.com/GPX/1/1" xmlns:ns3="http://www.garmin.com/xmlschemas/TrackPointExtension/v1">\n<trk><name>${name}</name><trkseg>\n`;
}
// Closes the tags opened by gpxHeader.
const GPX_FOOTER = `</trkseg></trk></gpx>\n`;

/** A planned route: one point every 20 m, elevation, no timestamps. */
export function makeDemoRaceGpx(profile = DEMO_RACE_PROFILE, { name = "Demo Trail 20K", startEle = 200, loop = false, center = [LAT0, LON0] } = {}) {
  // Total length in metres: reduce adds up the first element (the length) of every stretch.
  const total = profile.reduce((s, [l]) => s + l, 0);
  // `at` is a function d (metres) -> [lat, lon].
  const at = loop ? loopPath(total, center) : (d) => [LAT0 + d / M_PER_DEG_LAT, LON0];
  let xml = gpxHeader(name);
  // One <trkpt> (track point) every 20 m. toFixed(6) keeps 6 decimals of a degree (about 0.1 m), toFixed(1) keeps elevation to the decimetre.
  for (let d = 0; d <= total; d += 20) {
    const [lat, lon] = at(d);
    xml += `<trkpt lat="${lat.toFixed(6)}" lon="${lon.toFixed(6)}"><ele>${eleAt(profile, d, startEle).toFixed(1)}</ele></trkpt>\n`;
  }
  return xml + GPX_FOOTER;
}

/** A closed, wiggly loop of length `total` metres: a circle whose radius wobbles with a few sine waves (r = R(1 + 0.2 sin 2t + 0.12 sin 5t + 0.05 sin 11t)), stretched east-west. */
function loopPath(total, [lat0, lon0]) {
  // 1.
  const N = 4000;
  const xy = [];
  for (let i = 0; i <= N; i++) {
    const t = (i / N) * 2 * Math.PI;
    const r = 1 + 0.2 * Math.sin(2 * t + 0.6) + 0.12 * Math.sin(5 * t + 1.3) + 0.05 * Math.sin(11 * t);
    xy.push([1.35 * r * Math.cos(t), r * Math.sin(t)]);
  }
  // 2.
  const cum = [0];
  for (let i = 1; i <= N; i++) cum.push(cum[i - 1] + Math.hypot(xy[i][0] - xy[i - 1][0], xy[i][1] - xy[i - 1][1]));
  // 3. Scale the unit curve so its full length equals `total` metres.
  const scale = total / cum[N]; // unit curve -> metres
  // A degree of longitude shrinks towards the poles: it is cos(latitude) times a degree of latitude.
  const mPerDegLon = M_PER_DEG_LAT * Math.cos((lat0 * Math.PI) / 180);
  let j = 0;
  return (d) => {
    // u: the requested distance expressed in unit-curve length (clamped to the end of the loop).
    const u = Math.min(d, total) / scale;
    // If asked for a point behind the remembered segment, start searching again from 0.
    if (u < cum[j]) j = 0;
    // Move forward to the segment [j, j + 1] that contains u.
    while (j < N - 1 && cum[j + 1] < u) j++;
    // f: how far along that segment u lies (0 to 1).
    const f = (u - cum[j]) / (cum[j + 1] - cum[j] || 1);
    // 4.
    const x = (xy[j][0] + f * (xy[j + 1][0] - xy[j][0]) - xy[0][0]) * scale;
    const y = (xy[j][1] + f * (xy[j + 1][1] - xy[j][1]) - xy[0][1]) * scale;
    // 5. Metres to degrees around the start point.
    return [lat0 + y / M_PER_DEG_LAT, lon0 + x / mPerDegLon];
  };
}

/** The 17.7 km rolling loop of the original demo run (the tests use it). */
const DEMO_EFFORT_PROFILE = [
  [3000, 0], [800, 5], [400, -5], [500, 8], [300, -8], [2500, 0],
  [400, 12], [300, -12], [400, 12], [300, -12], [3000, 0],
  [700, 6], [700, -6], [2000, 0], [500, 14], [400, -14], [1500, 0],
];

/** A recorded effort: one point per second. */
export function makeDemoEffortGpx({ fatigue = 0.15, startIso = "2026-10-11T08:00:00Z", profile = DEMO_EFFORT_PROFILE } = {}) {
  const total = profile.reduce((s, [l]) => s + l, 0);
  // Date.parse turns the ISO text into milliseconds since 1 January 1970 (UTC).
  const t0 = Date.parse(startIso);
  // d: distance covered so far (metres), t: elapsed time (seconds).
  let d = 0;
  let t = 0;
  let xml = gpxHeader("Demo Effort");
  while (d < total) {
    const lat = LAT0 + d / M_PER_DEG_LAT;
    const g = gradeOf(profile, d);
    // frac: how far through the run we are, 0 at the start to 1 at the finish.
    const frac = d / total;
    const hr = 150 + 10 * frac;
    // Above 12% (up or down) the simulated runner hikes: cadence drops from 86 to 62 per foot (172 to 124 steps per minute), which is how the analysis tells running from hiking.
    const steep = Math.abs(g) > 12;
    const cad = steep ? 62 : 86;
    // One track point with position, elevation, time (ISO text) and, in the Garmin extension, heart rate (bpm) and cadence.
    xml += `<trkpt lat="${lat.toFixed(6)}" lon="${LON0.toFixed(6)}"><ele>${eleAt(profile, d, 300).toFixed(1)}</ele><time>${new Date(t0 + t * 1000).toISOString()}</time><extensions><ns3:TrackPointExtension><ns3:hr>${hr.toFixed(0)}</ns3:hr><ns3:cad>${cad}</ns3:cad></ns3:TrackPointExtension></extensions></trkpt>\n`;
    // Linear fatigue: at the finish (frac = 1) the pace is (1 + fatigue) times the fresh pace.
    const pace = demoPace(g) * (1 + fatigue * frac); // s/km
    // A pace of P seconds per km means 1000 / P metres per second.
    d += 1000 / pace; // metres covered in one second
    t += 1;
  }
  return xml + GPX_FOOTER;
}

/** Gradient (%) of the stretch that contains distance `d` (metres) of a profile; 0 past the end. */
function gradeOf(profile, d) {
  let pos = 0;
  for (const [len, g] of profile) {
    if (d <= pos + len) return g;
    pos += len;
  }
  return 0;
}

/** The sample run of the "Check my run" mode: a made-up 28 km trail run with three climbs. */
export const DEMO_REVIEW_PROFILE = [
  [1500, 0], [1000, 3], [1500, 9], [1200, 13], [800, 6],
  [1000, -8], [1500, -14], [1000, -5],
  [2000, 1],
  [1200, 7], [1000, 11], [600, 4],
  [1500, -10], [1500, -6],
  [2500, 0],
  [1500, 10], [1000, 15], [600, 8],
  [2000, -12], [1500, -4], [1500, 0],
];

/** A recorded trail run with a story to find, for the review mode and its tests: a strong first climb, a 90 s stop at the top of it, a 4 min stop at a fountain (km 11), a fade from about 60% of the run... */
export function makeDemoRunGpx({ startIso = "2026-10-15T06:30:00Z", profile = DEMO_REVIEW_PROFILE } = {}) {
  const total = profile.reduce((s, [l]) => s + l, 0);
  // The loop starts at 45.86 N, 6.2 E (near Annecy).
  const at = loopPath(total, [45.86, 6.2]);
  const t0 = Date.parse(startIso);
  // The two stops: at distance d (metres), stand still for sec seconds.
  const stops = [{ d: 6000, sec: 90 }, { d: 11000, sec: 240 }];
  let d = 0;
  let t = 0;
  // Heart rate (bpm) is a running state here: each second it moves part of the way towards a target.
  let hr = 120;
  let xml = gpxHeader("Morning trail run");
  // A small helper (arrow function) that builds one <trkpt> line.
  const point = (lat, lon, ele, h, cad) => `<trkpt lat="${lat.toFixed(6)}" lon="${lon.toFixed(6)}"><ele>${ele.toFixed(1)}</ele><time>${new Date(t0 + t * 1000).toISOString()}</time><extensions><ns3:TrackPointExtension><ns3:hr>${Math.round(h)}</ns3:hr><ns3:cad>${cad}</ns3:cad></ns3:TrackPointExtension></extensions></trkpt>\n`;
  while (d < total) {
    const [lat, lon] = at(d);
    const g = gradeOf(profile, d);
    const frac = d / total;
    // The first stop not yet used whose distance we have reached (undefined if none).
    const stop = stops.find((s) => !s.done && d >= s.d);
    if (stop) {
      // Standing still: the watch keeps recording, the position wobbles by a metre or two.
      stop.done = true;
      for (let k = 0; k < stop.sec; k++) {
        // Heart rate recovers: each second it closes 2% of the gap to 105 bpm (an exponential decay).
        hr += (105 - hr) * 0.02;
        // 0.000008 degrees is under 1 m: a small GPS wobble around the stop. Cadence 0 = not moving.
        xml += point(lat + Math.sin(k / 25) * 0.000008, lon + Math.cos(k / 31) * 0.000008, eleAt(profile, d, 450), hr, 0);
        t += 1;
      }
    }
    // The story, as multipliers on the pace from the demoPace table: walking 600 m walked on the flat from km 19 (pace 620 s/km = 10:20 /km) fade 0 before 60% of the run...
    const walking = d >= 19000 && d < 19600;
    const fade = frac > 0.6 ? 0.22 * (frac - 0.6) / 0.4 : 0;
    const climb = d >= 1500 && d < 6000 ? 0.9 : d >= 19800 && d < 22900 ? 1.12 : 1;
    // On top of that, a gentle 3% slow-down over the whole run (0.03 * frac).
    const pace = walking ? 620 : demoPace(g) * (1 + 0.03 * frac + fade) * climb; // s/km
    const hike = walking || g > 12;
    // Heart rate chases a target set by the effort (grade-adjusted speed), plus a slow drift. eff: speed relative to the flat pace of 265 s/km, made bigger uphill (6.5% per gradient point) and smaller downhill (2% per point)...
    const eff = Math.min(1.5, (265 / pace) * (g > 0 ? 1 + g * 0.065 : 1 + g * 0.02));
    // Target: 118 bpm at zero effort, +40 bpm per unit of effort, +14 bpm of drift by the finish.
    const target = 118 + 40 * eff + 14 * frac;
    // Close 5% of the gap each second, so heart rate lags behind changes of effort like a real one.
    hr += (target - hr) * 0.05;
    // Cadence per foot: about 58 to 60 when hiking, 86 to 87 when running.
    xml += point(lat, lon, eleAt(profile, d, 450), hr, hike ? 58 + (t % 3) : 86 + (t % 2));
    d += 1000 / pace;
    t += 1;
  }
  return xml + GPX_FOOTER;
}
