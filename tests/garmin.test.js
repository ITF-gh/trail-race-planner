import { test } from "node:test";
import assert from "node:assert/strict";
import { parseGpx } from "../src/core/track.js";
import { buildPlan } from "../src/core/plan.js";
import { raceLegs, secAtKm } from "../src/core/script.js";
import { coursePoints, strategyBlocks, editedPoints, courseFit, courseGpx, fitCrc, pointName, POINT_NAME_MAX, MIN_GAP_M, MIN_GAP_SEC } from "../src/core/garmin.js";
import { makeDemoRaceGpx, makeDemoEffortGpx, DEMO_ULTRA_PROFILE, DEMO_ULTRA_AID, DEMO_LONG_RUN_PROFILE } from "../src/demo.js";

const ultra = parseGpx(makeDemoRaceGpx(DEMO_ULTRA_PROFILE, { startEle: 650, loop: true, center: [45.05, 5.7] }));
const run = parseGpx(makeDemoEffortGpx({ profile: DEMO_LONG_RUN_PROFILE }));
const plan = buildPlan(ultra, run, { aidStations: DEMO_ULTRA_AID, startTime: "06:00" });

test("course points: one per strategy change, one per key zone, short names, spaced out", () => {
  const pts = coursePoints(plan, "central");
  const blocks = strategyBlocks(plan, "central");
  const zones = plan.keyZones;
  assert.ok(pts.length < raceLegs(plan, "central").length, "fewer alerts than sections");
  assert.equal(pts.filter((p) => p.name.startsWith("!")).length, zones.length, "one ! alert per key zone");
  for (let i = 1; i < blocks.length; i++) assert.notEqual(blocks[i].word, blocks[i - 1].word, "a block starts only when the strategy changes");
  const hike = pts.find((p) => /^HIKE \d/.test(p.name));
  assert.match(hike.name, /^HIKE [\d.]+k \+\d+$/, "strategy, length, D+");
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

test("watch messages: renamed, switched off and added ones reach the export, spaced out", () => {
  const base = coursePoints(plan, "central");
  const [a, b] = base;
  const mine = editedPoints(plan, "central", { names: { [a.id]: "GO EASY BOSS" }, off: { [b.id]: true }, extra: [{ id: "x1", km: 33, name: "Call home ça va" }] });
  assert.equal(mine.length, base.length, "one off, one added");
  assert.equal(mine.find((p) => p.id === a.id).name, "GO EASY BOSS");
  assert.ok(!mine.some((p) => p.id === b.id));
  assert.equal(mine.find((p) => p.id === "x1").name, "Call home ca va");
  for (let i = 1; i < mine.length; i++) assert.ok((mine[i].km - mine[i - 1].km) * 1000 >= MIN_GAP_M - 0.5);
  const text = new TextDecoder("latin1").decode(courseFit(plan, "central", ultra.points, { points: mine }));
  assert.ok(text.includes("GO EASY BOSS") && text.includes("Call home ca va") && !text.includes(b.name));
  assert.equal((courseGpx(plan, "central", ultra.points, "R", mine).match(/<wpt /g) || []).length, mine.length);
  assert.deepEqual(editedPoints(plan, "central", { names: { [a.id]: "   " } })[0].name, a.name, "an emptied name falls back to the planner's");
});
