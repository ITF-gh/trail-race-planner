import { test } from "node:test";
import assert from "node:assert/strict";
import { parseGpx } from "../src/core/track.js";
import { buildPlan } from "../src/core/plan.js";
import { raceLegs, secAtKm } from "../src/core/script.js";
import { coursePoints, courseFit, courseGpx, fitCrc, pointName, POINT_NAME_MAX, MIN_GAP_M, MIN_GAP_SEC } from "../src/core/garmin.js";
import { makeDemoRaceGpx, makeDemoEffortGpx, DEMO_ULTRA_PROFILE, DEMO_ULTRA_AID, DEMO_LONG_RUN_PROFILE } from "../src/demo.js";

const ultra = parseGpx(makeDemoRaceGpx(DEMO_ULTRA_PROFILE, { startEle: 650, loop: true, center: [45.05, 5.7] }));
const run = parseGpx(makeDemoEffortGpx({ profile: DEMO_LONG_RUN_PROFILE }));
const plan = buildPlan(ultra, run, { aidStations: DEMO_ULTRA_AID, startTime: "06:00" });

test("course points: facts then strategy for every section, two per key zone, short names", () => {
  const pts = coursePoints(plan, "central");
  const legs = raceLegs(plan, "central");
  assert.equal(pts.length, 2 * legs.length + 2 * plan.keyZones.length);
  for (const l of legs) {
    const facts = pts.find((p) => p.name.startsWith(`${l.i} `) && p.name.includes("+"));
    assert.ok(facts, `section ${l.i} has its facts point`);
    assert.match(facts.name, new RegExp(`^${l.i} [\\d.]+k \\+${Math.round(l.up)}-${Math.round(l.down)}$`));
  }
  for (const z of plan.keyZones) assert.equal(pts.filter((p) => p.name.startsWith(`K${z.n} `)).length, 2);
  for (const p of pts) assert.ok(p.name.length <= POINT_NAME_MAX && /^[\x20-\x7e]+$/.test(p.name), p.name);
  for (let i = 1; i < pts.length; i++) {
    assert.ok((pts[i].km - pts[i - 1].km) * 1000 >= MIN_GAP_M - 0.5, `${pts[i].name} at least 200 m after ${pts[i - 1].name}`);
    assert.ok(secAtKm(plan, "central", pts[i].km) - secAtKm(plan, "central", pts[i - 1].km) >= MIN_GAP_SEC - 0.5, `${pts[i].name} at least 1 min after the point before`);
  }
  assert.equal(pointName("Crêtes  très longues à mourir"), "Cretes  tres lo");
});

test("FIT course: header, sizes and both CRCs are valid", () => {
  const fit = courseFit(plan, "central", ultra.points, { name: "Ultra des Crêtes 78K", date: new Date("2026-10-18T04:00:00Z") });
  assert.equal(fit[0], 14);
  assert.equal(String.fromCharCode(...fit.subarray(8, 12)), ".FIT");
  const dataSize = fit[4] | (fit[5] << 8) | (fit[6] << 16) | (fit[7] << 24);
  assert.equal(fit.length, 14 + dataSize + 2);
  assert.equal(fitCrc(fit.subarray(0, 12)), fit[12] | (fit[13] << 8));
  assert.equal(fitCrc(fit), 0, "a FIT file run through its own CRC gives 0");
  // Every course point name is in the file.
  const text = new TextDecoder("latin1").decode(fit);
  for (const p of coursePoints(plan, "central")) assert.ok(text.includes(p.name), p.name);
});

test("GPX course: one waypoint per course point, then the track", () => {
  const gpx = courseGpx(plan, "central", ultra.points, "Ultra & co");
  assert.equal((gpx.match(/<wpt /g) || []).length, coursePoints(plan, "central").length);
  assert.ok(gpx.indexOf("<wpt ") < gpx.indexOf("<trk>"));
  assert.ok(gpx.includes("Ultra &amp; co"));
  assert.ok(parseGpx(gpx).points.length > 100, "the export reads back as a course");
});
