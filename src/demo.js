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

/** A planned route: one point every 20 m, elevation, no timestamps. */
export function makeDemoRaceGpx(profile = DEMO_RACE_PROFILE) {
  const total = profile.reduce((s, [l]) => s + l, 0);
  let xml = gpxHeader("Demo Trail 20K");
  for (let d = 0; d <= total; d += 20) {
    const lat = LAT0 + d / M_PER_DEG_LAT;
    xml += `<trkpt lat="${lat.toFixed(6)}" lon="${LON0.toFixed(6)}"><ele>${eleAt(profile, d, 200).toFixed(1)}</ele></trkpt>\n`;
  }
  return xml + GPX_FOOTER;
}

/**
 * A recorded effort: one point per second. Pace follows demoPace(grade), slowing
 * by `fatigue` (for example 0.15 = 15% slower) linearly over the run. Heart rate
 * rises from 150 to 160. Cadence is stored per foot (about 85), like many watches.
 */
export function makeDemoEffortGpx({ fatigue = 0.15, startIso = "2026-10-11T08:00:00Z" } = {}) {
  const profile = [
    [3000, 0], [800, 5], [400, -5], [500, 8], [300, -8], [2500, 0],
    [400, 12], [300, -12], [400, 12], [300, -12], [3000, 0],
    [700, 6], [700, -6], [2000, 0], [500, 14], [400, -14], [1500, 0],
  ];
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
