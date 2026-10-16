#!/usr/bin/env node
// ai-local.js: try the Prep my race AI call on your own computer, without the online account.
//
//   node scripts/ai-local.js --race race.gpx --runs run1.gpx --runs run2.gpx
//        [--history my-trail-runs.json] [--aid "16.5 Le Moulin 3" ...] [--start 06:00]
//        [--target 7:30] [--goal target|finish|best] [--risk prudent|balanced|bold]
//        [--notes "..."] [--question "..."] [--max-hr 188] [--rest-hr 48] [--weight 66]
//        [--demo] [--dry] [--fake] [--force] [--model gpt-4o-mini] [--effort medium]
//
// What it does, in the same order as the app will:
//   1. build the calculated plan from the GPX files (the same core as the app and cli.js)
//   2. run the code checks of the Ask the AI window (core/aichecks.js); a warning stops here
//      unless --force (the "Send anyway" button)
//   3. build the INPUT object and the ONE request (core/aiprep.js)
//   4. --dry: stop there and write the prompt; --fake: a made-up answer made by code; otherwise
//      call OpenAI with the key from OPENAI_API_KEY or from a file .env.local at the repo root
//   5. read the answer and the tokens, run the referee and rebuild the plan from the AI times
//   6. write everything to ai-runs/<date-time>/ and print a summary
//
// The key never leaves your computer except in the call to OpenAI, and is never written to the
// output files. .env.local and ai-runs/ are ignored by git.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { planFromGpx } from "../src/core/plan.js";
import { parseDuration } from "../src/core/format.js";
import { aiRaceChecks } from "../src/core/aichecks.js";
import { aiPrepInput, aiPrepRequest, aiPrepRead, aiPrepMerge, aiPrepFake } from "../src/core/aiprep.js";
import { makeDemoRaceGpx, makeDemoEffortGpx, DEMO_ULTRA_PROFILE, DEMO_ULTRA_AID, DEMO_LONG_RUN_PROFILE } from "../src/demo.js";
import { demoRecords } from "../src/core/demorecords.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { values: o } = parseArgs({
  options: {
    race: { type: "string" }, runs: { type: "string", multiple: true }, history: { type: "string" },
    aid: { type: "string", multiple: true }, start: { type: "string" },
    target: { type: "string", default: "" }, goal: { type: "string" }, risk: { type: "string", default: "balanced" },
    notes: { type: "string", default: "" }, question: { type: "string", default: "" },
    "max-hr": { type: "string" }, "rest-hr": { type: "string" }, weight: { type: "string" },
    demo: { type: "boolean", default: false }, dry: { type: "boolean", default: false }, fake: { type: "boolean", default: false },
    force: { type: "boolean", default: false }, model: { type: "string" }, effort: { type: "string", default: "medium" },
    help: { type: "boolean", default: false },
  },
});
if (o.help || (!o.demo && (!o.race || !o.runs))) {
  console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1, 11).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
  process.exit(o.help ? 0 : 1);
}

// h:mm:ss for the summary.
const hms = (s) => (s === null || s === undefined ? "-" : `${s < 0 ? "-" : ""}${Math.floor(Math.abs(s) / 3600)}:${String(Math.floor((Math.abs(s) % 3600) / 60)).padStart(2, "0")}:${String(Math.round(Math.abs(s) % 60)).padStart(2, "0")}`);
const num = (v) => (v ? Number(v) : null);

// 1. The calculated plan. --demo uses the app's made-up ultra and runs (and the demo profile's
// stored runs as history) so the whole chain can be tried without any file.
const raceXml = o.demo && !o.race ? makeDemoRaceGpx(DEMO_ULTRA_PROFILE, { name: "Ultra des Crêtes 78K", startEle: 650, loop: true, center: [45.05, 5.7] }) : readFileSync(o.race, "utf8");
const runXml = o.demo && !o.runs
  ? [makeDemoEffortGpx({ profile: DEMO_LONG_RUN_PROFILE, startIso: "2026-10-11T07:00:00Z" }), makeDemoEffortGpx({ profile: DEMO_LONG_RUN_PROFILE, fatigue: 0.3, startIso: "2026-08-30T07:00:00Z" })]
  : o.runs.map((f) => readFileSync(f, "utf8"));
const aidText = o.aid ? o.aid.join("\n") : o.demo ? DEMO_ULTRA_AID : "";
const athlete = { maxHr: num(o["max-hr"]), restHr: num(o["rest-hr"]), weightKg: num(o.weight) };
const plan = planFromGpx(raceXml, runXml, { aidStations: aidText, startTime: o.start || (o.demo ? "06:00" : "09:00"), maxHr: athlete.maxHr, restHr: athlete.restHr });
// The account history: the app's export (menu > Export my runs) is { runs: [...] }; a bare list works too.
let history = [];
if (o.history) { const h = JSON.parse(readFileSync(o.history, "utf8")); history = Array.isArray(h) ? h : h.runs || []; } else if (o.demo) history = demoRecords();
const raceName = o.demo && !o.race ? "Ultra des Crêtes 78K (made up)" : (o.race.split(/[\\/]/).pop() || "Race").replace(/\.gpx$/i, "");

// 2. The code checks, as at a click on "Spend". Locally there is no account: it counts as open.
const targetSec = o.target ? parseDuration(o.target) : null;
const checks = aiRaceChecks({
  race: { km: plan.course.totalKm, gain: plan.course.gain }, gpxRuns: runXml.length, storedRuns: history.length,
  targetText: o.target, targetSec, centralSec: plan.scenarios.central.finishSec, notes: o.notes, question: o.question,
  cloud: { open: true, signedIn: true, balance: 1 },
});
for (const k of checks) console.log(`${k.level === "stop" ? "BLOCKED" : "WARNING"}  ${k.code}: ${k.text}`);
if (checks.some((k) => k.level === "stop")) process.exit(1);
if (checks.length && !o.force && !o.dry) { console.log("Fix the warnings, or add --force to send anyway."); process.exit(1); }

// 3. Input and request.
const input = aiPrepInput(plan, { raceName, athlete, history, user: { targetSec, goal: o.goal, risk: o.risk, notes: o.notes, question: o.question, forced: checks.map((k) => k.code) } });
const request = aiPrepRequest(input, { model: o.model || process.env.OPENAI_MODEL, effort: o.effort });
const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
const out = join(root, "ai-runs", stamp);
mkdirSync(out, { recursive: true });
const save = (name, data) => writeFileSync(join(out, name), typeof data === "string" ? data : JSON.stringify(data, null, 2));
save("input.json", input);
save("prompt.txt", `=== INSTRUCTIONS (fixed) ===\n${request.instructions}\n\n=== INPUT (data) ===\n${request.input}\n`);
save("request.json", request);
console.log(`Plan: ${input.race.legs.length} legs, ${input.race.aid.length} aid stations, calculated finish ${hms(input.calc.finishSec.central)}; ${input.engine.runs.length} GPX run(s), ${input.engine.historyRuns} stored run(s).`);
console.log(`Prompt: about ${Math.round((request.instructions.length + request.input.length) / 4)} tokens (characters / 4).`);
if (o.dry) { console.log(`Dry run: nothing sent. See ${out}/prompt.txt`); process.exit(0); }

// 4. The one call (or the fake answer).
let read;
if (o.fake) {
  read = { output: aiPrepFake(input), tokens: { requestType: "prep_race", model: "fake", input: 0, inputCached: 0, output: 0, reasoning: 0, total: 0 }, error: "" };
} else {
  // The key: the environment first, else the line OPENAI_API_KEY=... of .env.local.
  let key = process.env.OPENAI_API_KEY;
  const envFile = join(root, ".env.local");
  if (!key && existsSync(envFile)) { const m = readFileSync(envFile, "utf8").match(/^\s*OPENAI_API_KEY\s*=\s*"?([^"\s]+)"?/m); if (m) key = m[1]; }
  if (!key) { console.log("No key: put OPENAI_API_KEY=sk-... in .env.local at the repo root (never in a chat or a commit), or use --fake."); process.exit(1); }
  console.log(`Calling ${request.model} (reasoning ${request.reasoning.effort})… this can take a minute or two.`);
  const t0 = Date.now();
  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(10 * 60 * 1000),
  }).then((r) => r.json()).catch((e) => ({ error: { message: e.message } }));
  save("response.json", res);
  read = aiPrepRead(res);
  console.log(`Answer in ${Math.round((Date.now() - t0) / 1000)} s.`);
}

// 5. Referee and rebuild.
const result = read.output ? aiPrepMerge(plan, input, read.output) : { status: "null", reason: read.error, legs: [], aid: [], fixes: [], texts: null };
save("output.json", read.output);
save("result.json", { status: result.status, reason: result.reason, tokens: read.tokens, finishSec: result.finishSec, aiFinishSec: result.aiFinishSec, fixes: result.fixes, legs: result.legs, aid: result.aid, texts: result.texts });

// 6. A readable report.
const T = result.texts || {};
const list = (a) => (a && a.length ? a.map((p) => `- **${p.what}**: ${p.effect} _(proof: ${p.proof})_`).join("\n") : "-");
const report = [
  `# Prep my race AI test, ${stamp}`,
  "",
  `Race: ${input.race.name}, ${input.race.totalKm} km, +${input.race.gainM} m · target ${hms(input.user.targetSec)} · goal ${input.user.goal} · risk ${input.user.risk}`,
  `Status: **${result.status}**${result.reason ? ` (${result.reason})` : ""}`,
  "",
  "## Tokens",
  "| Input | Cached | Output | Reasoning | Total | Model |", "|---|---|---|---|---|---|",
  `| ${read.tokens.input} | ${read.tokens.inputCached} | ${read.tokens.output} | ${read.tokens.reasoning} | ${read.tokens.total} | ${read.tokens.model} |`,
  ...(result.status === "ok" ? [
    "",
    "## Finish",
    `Calculated ${hms(input.calc.finishSec.central)} · AI, summed by code ${hms(result.finishSec)} · AI's own estimate ${hms(result.aiFinishSec)} · verdict ${result.dataset.target.verdict}`,
    "",
    `## ${T.headline || ""}`, "", T.synthesis || "", "",
    ...(T.answer ? ["**Answer:** " + T.answer, ""] : []),
    "### Strengths", list(T.strengths), "", "### Weaknesses", list(T.weaknesses), "",
    "## Legs (moving time; ✿ = differs by more than 3%)",
    "| Leg | Kind | km | Calculated | AI | Diff | Mode | Effort | Why |", "|---|---|---|---|---|---|---|---|---|",
    ...result.legs.map((l) => `| ${l.id}${l.mark ? " ✿" : ""} | ${l.kind}${l.n ? " " + l.n : ""} | ${l.startKm}–${l.endKm} | ${hms(l.calcSec)} | ${hms(l.aiSec)} | ${l.pct > 0 ? "+" : ""}${l.pct}% | ${l.mode || ""} | ${l.effort || ""} | ${(l.why || "").replace(/\|/g, "/")} |`),
    "", "## Aid stations",
    "| Aid | km | Name | Typed stop | AI stop | AI arrival |", "|---|---|---|---|---|---|",
    ...result.aid.map((s) => `| ${s.id} | ${s.km} | ${s.name} | ${s.stopMin} min | ${s.aiStopMin} min | ${hms(s.arriveSec)} |`),
    "", `## Fuel: ${result.dataset.fuel.carbsPerHour} g carbs per hour`,
    ...result.dataset.fuel.items.map((f) => `- ${f.legId} (${f.at}): ${f.item}, ${f.carbsG} g`),
    "", "## Watch texts", ...(T.watchTexts || []).map((w) => `- ${w.legId}: ${w.text}`),
    "", "## Next steps", T.nextSteps || "",
  ] : []),
  "", "## Referee fixes", ...(result.fixes.length ? result.fixes.map((f) => `- ${f}`) : ["- none"]),
].join("\n");
save("report.md", report);
console.log(`Status: ${result.status}${result.reason ? ` (${result.reason})` : ""}. Tokens: ${read.tokens.total} total (${read.tokens.input} in, ${read.tokens.inputCached} cached, ${read.tokens.output} out, ${read.tokens.reasoning} reasoning).`);
if (result.status === "ok") console.log(`Finish: calculated ${hms(input.calc.finishSec.central)}, AI ${hms(result.finishSec)}. ${result.legs.filter((l) => l.mark).length} of ${result.legs.length} legs changed by more than 3%. Referee fixes: ${result.fixes.length}.`);
console.log(`Report: ${join(out, "report.md")}`);
