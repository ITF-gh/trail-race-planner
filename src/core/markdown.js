// markdown.js: render a plan as Markdown (for the CLI, and the "Copy plan" button).

import { mmss, hm, clock } from "./format.js";
import { LEVELS, DESCENT_LABELS } from "./plan.js";

export function planToMarkdown(plan, scenarioId = "central") {
  const sc = plan.scenarios[scenarioId] || plan.scenarios.central;
  const st = plan.startSec;
  const L = [];
  L.push(`# Race plan`);
  L.push("");
  L.push(`Course: ${plan.course.totalKm.toFixed(1)} km, ${Math.round(plan.course.gain)} m D+, ${plan.course.climbCount} climbs, ${plan.course.descentCount} descents. Start ${clock(st, 0)}.`);
  L.push(`Scenarios: ${Object.values(plan.scenarios).map((s) => `${s.label} ${hm(s.finishSec)}`).join(", ")}. Tables below use **${sc.label}**.`);
  L.push("");
  L.push(`## Your effort profile`);
  L.push(`Reference run: ${plan.effort.distKm.toFixed(1)} km in ${hm(plan.effort.durationSec)}, flat pace ${mmss(plan.effort.flatPace)}/km${plan.effort.flatHr ? ` at HR ${Math.round(plan.effort.flatHr)}` : ""}.`);
  if (plan.effort.drift) {
    const d = plan.effort.drift;
    L.push(`Flat drift: ${mmss(d.firstPace)} at HR ${Math.round(d.firstHr)} early, ${mmss(d.secondPace)} at HR ${Math.round(d.secondHr)} late (${d.decouplingPct.toFixed(1)}% less speed per heartbeat).`);
  }
  L.push("");
  L.push(`| Gradient | Fresh | Tired | Source |`);
  L.push(`|---|---|---|---|`);
  for (const b of plan.effort.bands) L.push(`| ${b.label} | ${mmss(b.fresh)} | ${mmss(b.tired)} | ${b.source} |`);
  L.push("");
  L.push(`## Checkpoints`);
  for (const c of sc.checkpoints) L.push(`- ${c.label}: ${clock(st, c.sec)} (${hm(c.sec)})`);
  L.push("");
  L.push(`## Gels (every ${plan.params.gelEveryMin} min, moved off climbs)`);
  for (const g of sc.gels) L.push(`- km ${g.km.toFixed(1)}: ${clock(st, g.sec)}`);
  L.push("");
  if (plan.hrGuide) {
    L.push(`## Heart-rate guide`);
    for (const h of plan.hrGuide) L.push(`- km ${h.fromKm.toFixed(0)} to ${h.toKm.toFixed(0)}: ${h.text}`);
    L.push("");
  }
  L.push(`## Climbs`);
  L.push(`| # | Km | Length | Gain | Avg | Steepest 100 m | Pace | Clock | Tactic | Difficulty |`);
  L.push(`|---|---|---|---|---|---|---|---|---|---|`);
  for (const c of plan.climbs) {
    L.push(`| ${c.n} | ${c.startKm.toFixed(2)} | ${Math.round(c.lenM)} m | ${Math.round(c.gain)} m | ${c.avg.toFixed(1)}% | ${Math.round(c.steep)}% | ${mmss(c.dur[sc.id] / (c.lenM / 1000))} | ${clock(st, c.start[sc.id])} | ${c.tactic} | ${LEVELS[c.level]} |`);
    for (const s of c.sections) {
      L.push(`| ${s.n} | ${s.startKm.toFixed(2)} | ${Math.round(s.lenM)} m | ${Math.round(s.gain)} m | ${s.avg.toFixed(1)}% | ${Math.round(s.steep)}% | ${mmss(s.dur[sc.id] / (s.lenM / 1000))} | ${clock(st, s.start[sc.id])} | ${s.tactic} | section |`);
    }
  }
  L.push("");
  L.push(`## Descents`);
  L.push(`| # | Km | Length | Loss | Avg | Steepest 100 m | Pace | Clock | Tactic | Risk |`);
  L.push(`|---|---|---|---|---|---|---|---|---|---|`);
  for (const d of plan.descents) {
    L.push(`| ${d.n} | ${d.startKm.toFixed(2)} | ${Math.round(d.lenM)} m | ${Math.round(d.loss)} m | ${Math.abs(d.avg).toFixed(1)}% | ${Math.abs(Math.round(d.steep))}% | ${mmss(d.dur[sc.id] / (d.lenM / 1000))} | ${clock(st, d.start[sc.id])} | ${d.tactic} | ${DESCENT_LABELS[d.level]} |`);
  }
  L.push("");
  return L.join("\n");
}
