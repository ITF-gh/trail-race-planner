import { test } from "node:test";
import assert from "node:assert/strict";
import { parseGpx } from "../src/core/track.js";
import { buildPlan } from "../src/core/plan.js";
import { courseFit } from "../src/core/garmin.js";
import { readFit, fitToGpx, tcxToGpx, isFit } from "../src/core/fit.js";
import { makeDemoRaceGpx, makeDemoEffortGpx, DEMO_ULTRA_PROFILE, DEMO_ULTRA_AID, DEMO_LONG_RUN_PROFILE } from "../src/demo.js";

test("FIT course from the app reads back as the same track", () => {
  const ultra = parseGpx(makeDemoRaceGpx(DEMO_ULTRA_PROFILE, { startEle: 650, loop: true, center: [45.05, 5.7] }));
  const plan = buildPlan(ultra, parseGpx(makeDemoEffortGpx({ profile: DEMO_LONG_RUN_PROFILE })), { aidStations: DEMO_ULTRA_AID, startTime: "06:00" });
  const fit = courseFit(plan, "central", ultra.points, { name: "Ultra 78K", date: new Date("2026-10-18T04:00:00Z") });
  assert.ok(isFit(fit));
  const back = parseGpx(fitToGpx(fit));
  assert.equal(back.name, "Ultra 78K");
  assert.ok(back.points.length > 100);
  const a = back.points[0], b = ultra.points[0];
  assert.ok(Math.abs(a.lat - b.lat) < 1e-5 && Math.abs(a.lon - b.lon) < 1e-5);
  assert.ok(Math.abs(a.ele - b.ele) < 0.5);
  assert.equal(back.points.every((p) => p.hr === null), true);
});

// A tiny watch activity: big-endian definition, developer field, heart rate, compressed timestamps.
function activityFit() {
  const out = [];
  const u32 = (v, le = true) => { const b = [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255]; return le ? b : b.reverse(); };
  const u16 = (v, le = true) => (le ? [v & 255, v >> 8] : [v >> 8, v & 255]);
  // record (20), big-endian: timestamp, lat, lon, enhanced_altitude, heart_rate, cadence + 1 developer byte
  out.push(0x60, 0, 1, ...u16(20, false), 6, 253, 4, 0x86, 0, 4, 0x85, 1, 4, 0x85, 78, 4, 0x86, 3, 1, 2, 4, 1, 2, 1, 0, 1, 0);
  const semi = (d) => Math.round(d / (180 / 2 ** 31));
  const t0 = 1100000000;
  out.push(0x00, ...u32(t0, false), ...u32(semi(45.1), false), ...u32(semi(5.7), false), ...u32((1000 + 500) * 5, false), 150, 82, 9);
  // Local 1 without timestamp, used with a compressed-timestamp header (t0 + 3 s).
  out.push(0x41, 0, 0, ...u16(20), 4, 0, 4, 0x85, 1, 4, 0x85, 2, 2, 0x84, 4, 1, 2);
  out.push(0x80 | (1 << 5) | ((t0 + 3) & 0x1f), ...u32(semi(45.101)), ...u32(semi(5.701)), ...u16((1010 + 500) * 5), 84);
  out.push(0x01, ...u32(0x7fffffff), ...u32(0x7fffffff), ...u16(0xffff), 0xff); // no GPS: skipped
  const head = [12, 0x20, 0, 0, ...u32(out.length), 0x2e, 0x46, 0x49, 0x54];
  return new Uint8Array([...head, ...out, 0, 0]);
}

test("FIT activity: compressed timestamps, big-endian, developer fields, no heart rate kept", () => {
  const r = readFit(activityFit());
  assert.equal(r.points.length, 2);
  assert.equal(r.points[0].time, (1100000000 + 631065600) * 1000);
  assert.equal(r.points[1].time - r.points[0].time, 3000);
  assert.ok(Math.abs(r.points[1].ele - 1010) < 0.01);
  assert.equal(r.points[0].cad, 82);
  const gpx = fitToGpx(activityFit(), "Morning run");
  assert.ok(!/hr>|150/.test(gpx));
  const p = parseGpx(gpx);
  assert.equal(p.name, "Morning run");
  assert.equal(p.points[1].cad, 84);
});

test("TCX and errors", () => {
  const tcx = `<TrainingCenterDatabase><Activities><Activity><Lap><Track>
    <Trackpoint><Time>2026-10-11T08:00:00Z</Time><Position><LatitudeDegrees>48.87</LatitudeDegrees><LongitudeDegrees>2.18</LongitudeDegrees></Position><AltitudeMeters>40</AltitudeMeters><HeartRateBpm><Value>140</Value></HeartRateBpm><Extensions><ns3:TPX><ns3:RunCadence>86</ns3:RunCadence></ns3:TPX></Extensions></Trackpoint>
    <Trackpoint><Time>2026-10-11T08:00:05Z</Time><Position><LatitudeDegrees>48.871</LatitudeDegrees><LongitudeDegrees>2.181</LongitudeDegrees></Position><AltitudeMeters>42</AltitudeMeters></Trackpoint>
  </Track></Lap></Activity></Activities></TrainingCenterDatabase>`;
  const p = parseGpx(tcxToGpx(tcx, "Rueil"));
  assert.equal(p.points.length, 2);
  assert.equal(p.points[0].cad, 86);
  assert.equal(p.points[1].time - p.points[0].time, 5000);
  assert.throws(() => readFit(new Uint8Array(20)), /FIT/);
  assert.throws(() => parseGpx("<!--err No GPS points-->"), /No GPS points/);
});
