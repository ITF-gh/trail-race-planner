#!/usr/bin/env node
// cli.js: the same calculation core as the browser app, from a terminal.
//
//   node cli.js --race course.gpx --effort run.gpx [--start 09:00] [--terrain mixed]
//               [--scenario central] [--max-hr 190] [--json]
//
// Because the core modules are pure functions (text in, numbers out), the CLI
// and the browser app share every line of calculation. Only the thin layer that
// reads files and prints results differs.

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { planFromGpx } from "./src/core/plan.js";
import { planToMarkdown } from "./src/core/markdown.js";

const { values } = parseArgs({
  options: {
    race: { type: "string" },
    effort: { type: "string", multiple: true },
    aid: { type: "string", multiple: true },
    "half-life": { type: "string", default: "28" },
    start: { type: "string", default: "09:00" },
    terrain: { type: "string", default: "mixed" },
    scenario: { type: "string", default: "central" },
    "max-hr": { type: "string" },
    "hike-grade": { type: "string" },
    "gel-every": { type: "string", default: "45" },
    "descent-boost": { type: "string", default: "0" },
    json: { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
});

if (values.help || !values.race || !values.effort?.length) {
  console.log(`Usage: node cli.js --race course.gpx --effort run.gpx [--effort older-run.gpx ...] [options]

Options:
  --start 09:00         race start time
  --terrain mixed       smooth | mixed | technical
  --scenario central    best | central | cautious (which clock times to print)
  --max-hr 190          optional, caps the heart-rate guide at 92% of this
  --hike-grade 15       override the hiking threshold (%), default learned from your effort file
  --gel-every 45        minutes between gels
  --descent-boost 0.03  fraction faster on mild descents (0 to 0.1)
  --aid "8.5 Refuge 2"  aid station: km, name, minutes stopped (repeat for each)
  --half-life 28        with several --effort runs, days until an older run counts half
  --json                print the full plan as JSON`);
  process.exit(values.help ? 0 : 1);
}

const plan = planFromGpx(readFileSync(values.race, "utf8"), values.effort.map((f) => readFileSync(f, "utf8")), {
  aidStations: (values.aid || []).join("\n"),
  halfLifeDays: Number(values["half-life"]),
  startTime: values.start,
  terrain: values.terrain,
  maxHr: values["max-hr"] ? Number(values["max-hr"]) : null,
  hikeGrade: values["hike-grade"] ? Number(values["hike-grade"]) : null,
  gelEveryMin: Number(values["gel-every"]),
  descentBoost: Number(values["descent-boost"]),
});

if (values.json) {
  const slim = JSON.parse(JSON.stringify(plan, (k, v) => (k === "profile" ? undefined : v)));
  console.log(JSON.stringify(slim, null, 2));
} else {
  console.log(planToMarkdown(plan, values.scenario));
}
