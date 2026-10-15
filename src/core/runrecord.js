// runrecord.js: turn an analysed run into the small summary the run log keeps (see history.js).

import { runStats } from "./review.js";
import { bestEffort, runKpis } from "./insights.js";
import { HISTORY_VERSION } from "./history.js";

/** Summary of one analysed run (the object analyseRun returns), ready to store. */
export function runRecord(run, name = "") {
  const st = runStats(run);
  const k10 = run.totalKm >= 10 ? bestEffort(run, 10000) : null;
  const vam = runKpis(run).find((k) => k.key === "vam");
  return {
    // Same start time and same distance = the same run, so loading a file twice keeps one copy.
    id: `${Math.round(run.startMs / 1000)}-${Math.round(run.totalKm * 100)}`,
    v: HISTORY_VERSION,
    date: run.startMs,
    name: String(name || run.name || "Run").slice(0, 80),
    km: run.totalKm,
    gain: run.gain,
    movingSec: run.movingSec,
    elapsedSec: run.elapsedSec,
    gapPace: run.gapPace || null,
    hrAvg: run.hasHr ? run.hrAvg : null,
    fadePct: Number.isFinite(run.halves.fadePct) ? run.halves.fadePct : null,
    decouplingPct: Number.isFinite(run.halves.decouplingPct) ? run.halves.decouplingPct : null,
    vam: vam ? vam.value : null,
    best1k: st.fastest1k ? st.fastest1k.sec : null,
    best5k: st.fastest5k ? st.fastest5k.sec : null,
    best10k: k10 ? k10.sec : null,
  };
}
