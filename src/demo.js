// demo.js: synthetic GPX files for the demo button and the tests.
//
// Nothing here comes from a real person: the course is a made-up sequence of
// flat, climbing and descending stretches, and the "effort" file is a run over a
// made-up loop where pace follows a known table. Because we know the table that
// generated the effort file, the tests can check that the analysis recovers it.

const LAT0 = 45.0;
const LON0 = 5.0;
const M_PER_DEG_LAT = 111320;

/** [length in metres, gradient in %] stretches that describe a profile. */
export const DEMO_RACE_PROFILE = [
  [2000, 0], [1200, 4], [800, -3], [600, 9], [500, -8], [1500, 0],
  [900, 7], [700, -10], [1100, 5], [400, 14], [600, -12], [2500, 1],
  [800, 8], [500, 12], [900, -9], [1300, 0], [700, 10], [600, -6],
  [1500, 3], [300, 16], [800, -10], [2000, 0], [1000, 6], [700, -5],
];

/**
 * The demo button's race: a made-up mountain ultra of 78.4 km and about 3,800 m of climbing,
 * from a 650 m valley over four big climbs (the longest gains 650 m over 8.5 km) with steep,
 * technical descents (down to -24%) and a short sharp kicker late in the race. Long climbs
 * change gradient on the way up, so the planner splits them into sections.
 */
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

function gpxHeader(name) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx creator="demo" version="1.1" xmlns="http://www.topografix.com/GPX/1/1" xmlns:ns3="http://www.garmin.com/xmlschemas/TrackPointExtension/v1">\n<trk><name>${name}</name><trkseg>\n`;
}
const GPX_FOOTER = `</trkseg></trk></gpx>\n`;

/**
 * A planned route: one point every 20 m, elevation, no timestamps.
 * `loop` gives it a map shape: instead of a straight line north, the course winds
 * around a closed loop that starts and finishes at `center` (made up, like the profile).
 */
export function makeDemoRaceGpx(profile = DEMO_RACE_PROFILE, { name = "Demo Trail 20K", startEle = 200, loop = false, center = [LAT0, LON0] } = {}) {
  const total = profile.reduce((s, [l]) => s + l, 0);
  const at = loop ? loopPath(total, center) : (d) => [LAT0 + d / M_PER_DEG_LAT, LON0];
  let xml = gpxHeader(name);
  for (let d = 0; d <= total; d += 20) {
    const [lat, lon] = at(d);
    xml += `<trkpt lat="${lat.toFixed(6)}" lon="${lon.toFixed(6)}"><ele>${eleAt(profile, d, startEle).toFixed(1)}</ele></trkpt>\n`;
  }
  return xml + GPX_FOOTER;
}

/**
 * A closed, wiggly loop of length `total` metres: a circle whose radius wobbles with a few
 * sine waves (r = R(1 + 0.2 sin 2t + 0.12 sin 5t + 0.05 sin 11t)), stretched east-west.
 * The radius never gets close to zero, so the loop never crosses itself. Points are placed
 * by arc length (measured on a dense polyline), so 20 m along the profile is 20 m on the map.
 * Returns d (metres) -> [lat, lon], with d = 0 and d = total at `start`.
 */
function loopPath(total, [lat0, lon0]) {
  const N = 4000;
  const xy = [];
  for (let i = 0; i <= N; i++) {
    const t = (i / N) * 2 * Math.PI;
    const r = 1 + 0.2 * Math.sin(2 * t + 0.6) + 0.12 * Math.sin(5 * t + 1.3) + 0.05 * Math.sin(11 * t);
    xy.push([1.35 * r * Math.cos(t), r * Math.sin(t)]);
  }
  const cum = [0];
  for (let i = 1; i <= N; i++) cum.push(cum[i - 1] + Math.hypot(xy[i][0] - xy[i - 1][0], xy[i][1] - xy[i - 1][1]));
  const scale = total / cum[N]; // unit curve -> metres
  const mPerDegLon = M_PER_DEG_LAT * Math.cos((lat0 * Math.PI) / 180);
  let j = 0;
  return (d) => {
    const u = Math.min(d, total) / scale;
    if (u < cum[j]) j = 0;
    while (j < N - 1 && cum[j + 1] < u) j++;
    const f = (u - cum[j]) / (cum[j + 1] - cum[j] || 1);
    const x = (xy[j][0] + f * (xy[j + 1][0] - xy[j][0]) - xy[0][0]) * scale;
    const y = (xy[j][1] + f * (xy[j + 1][1] - xy[j][1]) - xy[0][1]) * scale;
    return [lat0 + y / M_PER_DEG_LAT, lon0 + x / mPerDegLon];
  };
}

/** The 17.7 km rolling loop of the original demo run (the tests use it). */
const DEMO_EFFORT_PROFILE = [
  [3000, 0], [800, 5], [400, -5], [500, 8], [300, -8], [2500, 0],
  [400, 12], [300, -12], [400, 12], [300, -12], [3000, 0],
  [700, 6], [700, -6], [2000, 0], [500, 14], [400, -14], [1500, 0],
];

/**
 * A recorded effort: one point per second. Pace follows demoPace(grade), slowing
 * by `fatigue` (for example 0.15 = 15% slower) linearly over the run. Heart rate
 * rises from 150 to 160. Cadence is stored per foot (about 85), like many watches.
 */
export function makeDemoEffortGpx({ fatigue = 0.15, startIso = "2026-10-11T08:00:00Z", profile = DEMO_EFFORT_PROFILE } = {}) {
  const total = profile.reduce((s, [l]) => s + l, 0);
  const t0 = Date.parse(startIso);
  let d = 0;
  let t = 0;
  let xml = gpxHeader("Demo Effort");
  while (d < total) {
    const lat = LAT0 + d / M_PER_DEG_LAT;
    const g = gradeOf(profile, d);
    const frac = d / total;
    const hr = 150 + 10 * frac;
    const steep = Math.abs(g) > 12;
    const cad = steep ? 62 : 86;
    xml += `<trkpt lat="${lat.toFixed(6)}" lon="${LON0.toFixed(6)}"><ele>${eleAt(profile, d, 300).toFixed(1)}</ele><time>${new Date(t0 + t * 1000).toISOString()}</time><extensions><ns3:TrackPointExtension><ns3:hr>${hr.toFixed(0)}</ns3:hr><ns3:cad>${cad}</ns3:cad></ns3:TrackPointExtension></extensions></trkpt>\n`;
    const pace = demoPace(g) * (1 + fatigue * frac); // s/km
    d += 1000 / pace; // metres covered in one second
    t += 1;
  }
  return xml + GPX_FOOTER;
}

function gradeOf(profile, d) {
  let pos = 0;
  for (const [len, g] of profile) {
    if (d <= pos + len) return g;
    pos += len;
  }
  return 0;
}
