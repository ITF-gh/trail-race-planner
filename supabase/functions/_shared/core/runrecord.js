// runrecord.js: turn an analysed run into the small summary the run log keeps (see history.js).
//
// Where it sits: after Rewind my run analyses a file (review.js analyseRun), src/ui/account.js
// calls runRecord and stores the result (IndexedDB, and the account database when signed in).
// history.js then builds the account menu from all the stored summaries. Only these few numbers
// are kept, never the GPS points.

import { runStats } from "./review.js";
import { bestEffort, runKpis } from "./insights.js";
import { HISTORY_VERSION } from "./history.js";

/**
 * Summary of one analysed run (the object analyseRun returns), ready to store.
 * Inputs: the run, and an optional name (else the GPX name, else "Run"; cut to 80 characters,
 * the limit checkRecord accepts). Returns the record described in history.js. Best efforts come
 * from runStats (1 km, 5 km) and bestEffort (10 km, only on runs of 10 km or more); the climbing
 * speed is the "vam" key number of runKpis. Number.isFinite turns a NaN or missing fade into
 * null. No heart rate: it is never read from a file (see track.js).
 */
export function runRecord(run, name = "") {
  const st = runStats(run);
  const k10 = run.totalKm >= 10 ? bestEffort(run, 10000) : null;
  const vam = runKpis(run).find((k) => k.key === "vam");
  return {
    // Same start time and same distance = the same run, so loading a file twice keeps one copy.
    // Format: start in whole seconds since 1970, a dash, distance in units of 10 m (km x 100).
    id: `${Math.round(run.startMs / 1000)}-${Math.round(run.totalKm * 100)}`,
    v: HISTORY_VERSION,
    date: run.startMs,
    name: String(name || run.name || "Run").slice(0, 80),
    km: run.totalKm,
    gain: run.gain,
    movingSec: run.movingSec,
    elapsedSec: run.elapsedSec,
    gapPace: run.gapPace || null,
    fadePct: Number.isFinite(run.halves.fadePct) ? run.halves.fadePct : null,
    vam: vam ? vam.value : null,
    best1k: st.fastest1k ? st.fastest1k.sec : null,
    best5k: st.fastest5k ? st.fastest5k.sec : null,
    best10k: k10 ? k10.sec : null,
  };
}
