// main.js: the browser app. Reads two GPX files locally (nothing is uploaded),
// calls the same core modules as the CLI, and draws the result.

import { parseGpx, resample } from "../core/track.js";
import { analyseCourse } from "../core/terrain.js";
import { analyseEffort } from "../core/effort.js";
import { buildPlan, PLAN_DEFAULTS, LEVELS, DESCENT_LABELS } from "../core/plan.js";
import { TERRAIN, SCENARIOS } from "../core/model.js";
import { planToMarkdown } from "../core/markdown.js";
import { mmss, hm, clock, parseDuration } from "../core/format.js";
import { makeDemoRaceGpx, makeDemoEffortGpx } from "../demo.js";

const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k) || "null"); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage can be blocked */ } },
};

const state = {
  race: null, // {name, xml, parsed, info}
  effort: null, // {name, xml, parsed, info}
  errors: { race: "", effort: "", plan: "" },
  settings: { ...PLAN_DEFAULTS, ...(store.get("trp.settings") || {}) },
  scenario: store.get("trp.scenario") || "central",
  tab: "c",
  plan: null,
};

/* ---------- skeleton ---------- */
$("#app").innerHTML = `
<header class="top">
  <div>
    <div class="eyebrow">Trail Race Planner</div>
    <h1>Your race, gradient by gradient</h1>
    <p class="sub">Give it the course and one of your own recorded runs. It learns how you move on each kind of terrain, then works out the pace, the hikes, the gels and the checkpoints for race day. Files are read in this page and never uploaded.</p>
  </div>
  <button class="btn" id="demo" type="button">Try the demo</button>
</header>

<section>
  <div class="grid two">
    <div class="drop" id="dropRace">
      <h3>1. Race course GPX</h3>
      <p>The official route. Needs elevation. Drop the file here or choose it.</p>
      <div><label class="btn" for="fileRace">Choose file</label><input type="file" id="fileRace" accept=".gpx,application/gpx+xml,text/xml"></div>
      <div class="status" id="stRace" aria-live="polite"></div>
    </div>
    <div class="drop" id="dropEffort">
      <h3>2. Effort reference GPX</h3>
      <p>A recorded run of 1.5 hours or more at a steady effort, on terrain with some climbs. Needs timestamps; heart rate and cadence are a bonus.</p>
      <div><label class="btn" for="fileEffort">Choose file</label><input type="file" id="fileEffort" accept=".gpx,application/gpx+xml,text/xml"></div>
      <div class="status" id="stEffort" aria-live="polite"></div>
    </div>
  </div>
</section>

<section>
  <h2>Race settings</h2>
  <div class="panel">
    <div class="fields">
      <label class="f">Start time<input type="time" id="startTime"></label>
      <label class="f">Terrain on race day
        <select id="terrain">${Object.entries(TERRAIN).map(([k, v]) => `<option value="${k}">${esc(v.label)}</option>`).join("")}</select>
      </label>
      <label class="f">Max heart rate (optional)<input type="number" id="maxHr" min="120" max="230" placeholder="for example 190"></label>
      <label class="f">Gel every (minutes)<input type="number" id="gelEveryMin" min="20" max="90"></label>
    </div>
    <details class="adv">
      <summary>Advanced</summary>
      <div class="fields" style="margin-top:12px">
        <label class="f">Checkpoint every (km)<input type="number" id="checkpointKm" min="2" max="25"></label>
        <label class="f">Hiking threshold (% gradient)<input type="number" id="hikeGrade" min="6" max="30" placeholder="learned from your run"><span class="hint">Leave blank to learn it from your cadence.</span></label>
        <label class="f">Endurance exponent<input type="number" id="enduranceExp" step="0.01" min="0.03" max="0.15"><span class="hint">How fast you fade when the race is longer than your run. 0.07 is typical.</span></label>
        <label class="f">Faster on gentle descents (%)<input type="number" id="descentBoost" step="1" min="0" max="10"><span class="hint">Only if your quads can take it. 0 is safe.</span></label>
      </div>
    </details>
    <div id="planErr"></div>
  </div>
</section>

<div id="results"></div>
`;

/* ---------- settings form ---------- */
const FIELDS = ["startTime", "terrain", "maxHr", "gelEveryMin", "checkpointKm", "hikeGrade", "enduranceExp", "descentBoost"];
function writeSettings() {
  const s = state.settings;
  $("#startTime").value = s.startTime;
  $("#terrain").value = s.terrain;
  $("#maxHr").value = s.maxHr ?? "";
  $("#gelEveryMin").value = s.gelEveryMin;
  $("#checkpointKm").value = s.checkpointKm;
  $("#hikeGrade").value = s.hikeGrade ?? "";
  $("#enduranceExp").value = s.enduranceExp;
  $("#descentBoost").value = Math.round((s.descentBoost || 0) * 100);
}
function readSettings() {
  const n = (id) => { const v = parseFloat($("#" + id).value); return Number.isFinite(v) ? v : null; };
  state.settings = {
    ...state.settings,
    startTime: $("#startTime").value || "09:00",
    terrain: $("#terrain").value,
    maxHr: n("maxHr"),
    gelEveryMin: n("gelEveryMin") || 45,
    checkpointKm: n("checkpointKm") || 10,
    hikeGrade: n("hikeGrade"),
    enduranceExp: n("enduranceExp") ?? 0.07,
    descentBoost: (n("descentBoost") || 0) / 100,
  };
  store.set("trp.settings", state.settings);
}
writeSettings();
FIELDS.forEach((id) => $("#" + id).addEventListener("change", () => { readSettings(); compute(); }));

/* ---------- files ---------- */
function setStatus(which, html, bad) {
  $(which === "race" ? "#stRace" : "#stEffort").innerHTML = html;
  state.errors[which] = bad ? html : "";
}

function loadRace(xml, label) {
  try {
    const parsed = parseGpx(xml);
    const course = analyseCourse(resample(parsed, 10));
    state.race = { name: label || parsed.name || "Race", xml, parsed };
    setStatus("race", `<span class="ok">Loaded.</span> ${esc(state.race.name)}: ${course.totalKm.toFixed(1)} km, ${Math.round(course.gain)} m D+, ${course.climbs.length} climbs.`);
  } catch (e) {
    state.race = null;
    setStatus("race", `<span class="err">${esc(e.message)}</span>`, true);
  }
  compute();
}

function loadEffort(xml, label) {
  try {
    const parsed = parseGpx(xml);
    const info = analyseEffort(parsed);
    state.effort = { name: label || parsed.name || "Effort", xml, parsed };
    const hr = info.avgHr ? `, average HR ${Math.round(info.avgHr)}` : ", no heart-rate data";
    setStatus("effort", `<span class="ok">Loaded.</span> ${esc(state.effort.name)}: ${info.distKm.toFixed(1)} km in ${hm(info.durationSec)}, flat pace ${mmss(info.flatPace)}/km${hr}.`);
  } catch (e) {
    state.effort = null;
    setStatus("effort", `<span class="err">${esc(e.message)}</span>`, true);
  }
  compute();
}

function wireDrop(boxId, inputId, loader) {
  const box = $(boxId);
  const input = $(inputId);
  const handle = async (file) => {
    if (!file) return;
    try { loader(await file.text(), file.name.replace(/\.gpx$/i, "")); } catch (e) { loader("", file.name); }
  };
  input.addEventListener("change", () => handle(input.files[0]));
  box.addEventListener("dragover", (e) => { e.preventDefault(); box.classList.add("over"); });
  box.addEventListener("dragleave", () => box.classList.remove("over"));
  box.addEventListener("drop", (e) => { e.preventDefault(); box.classList.remove("over"); handle(e.dataTransfer.files[0]); });
}
wireDrop("#dropRace", "#fileRace", loadRace);
wireDrop("#dropEffort", "#fileEffort", loadEffort);

$("#demo").addEventListener("click", () => {
  loadRace(makeDemoRaceGpx(), "Demo trail 20K (made up)");
  loadEffort(makeDemoEffortGpx(), "Demo effort (made up)");
});

/* ---------- compute ---------- */
function compute() {
  state.plan = null;
  $("#planErr").innerHTML = "";
  if (state.race && state.effort) {
    try {
      state.plan = buildPlan(state.race.parsed, state.effort.parsed, state.settings);
    } catch (e) {
      $("#planErr").innerHTML = `<div class="err">${esc(e.message)}</div>`;
    }
  }
  render();
}

/* ---------- results ---------- */
function elevAt(profile, km) {
  if (km <= profile[0][0]) return profile[0][1];
  for (let i = 1; i < profile.length; i++) {
    if (profile[i][0] >= km) {
      const a = profile[i - 1], b = profile[i];
      return a[1] + ((km - a[0]) / Math.max(1e-9, b[0] - a[0])) * (b[1] - a[1]);
    }
  }
  return profile[profile.length - 1][1];
}

function profileSvg(plan, sid) {
  const P = plan.course.profile;
  const TOT = plan.course.totalKm;
  const eles = P.map((p) => p[1]);
  const EMIN = Math.min(...eles), EMAX = Math.max(...eles);
  const W = 1000, l = 56, r = 14, top = 34, base = 205;
  const plotH = base - top - 24;
  const x = (km) => l + (km / TOT) * (W - l - r);
  const y = (e) => base - 24 - ((e - EMIN) / Math.max(1, EMAX - EMIN)) * plotH;
  const sc = plan.scenarios[sid];
  let s = "";
  s += `<rect class="zone" x="${x(plan.decision.fromKm)}" y="${top}" width="${x(plan.decision.toKm) - x(plan.decision.fromKm)}" height="${base - top}"/>`;
  let d = `M${x(0)},${base}`;
  P.forEach((p) => { d += ` L${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`; });
  d += ` L${x(TOT)},${base} Z`;
  s += `<path class="area" d="${d}"/>`;
  s += `<path class="ln" d="${P.map((p, i) => `${i ? "L" : "M"}${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join(" ")}"/>`;
  s += `<line class="axis" x1="${l}" x2="${W - r}" y1="${base}" y2="${base}"/>`;
  const tickEvery = TOT > 60 ? 10 : 5;
  for (let k = 0; k <= TOT; k += tickEvery) s += `<line class="axis" x1="${x(k)}" x2="${x(k)}" y1="${base}" y2="${base + 5}"/><text x="${x(k)}" y="${base + 18}" text-anchor="middle">${k}</text>`;
  s += `<text x="${W - r}" y="${base + 32}" text-anchor="end">km</text>`;
  [Math.ceil(EMIN / 10) * 10, Math.floor(EMAX / 10) * 10].forEach((e) => { s += `<text x="${l - 6}" y="${(y(e) + 3).toFixed(1)}" text-anchor="end">${e} m</text>`; });
  const seg = (a, b) => {
    const pts = [];
    const n = Math.max(2, Math.round((b - a) / 0.025));
    for (let i = 0; i <= n; i++) { const k = a + ((b - a) * i) / n; pts.push(`${i ? "L" : "M"}${x(k).toFixed(1)},${y(elevAt(P, k)).toFixed(1)}`); }
    return pts.join("");
  };
  plan.descents.forEach((dd) => { if (dd.level === 4) s += `<path class="dl" d="${seg(dd.startKm, dd.endKm)}"><title>Descent ${dd.n}, km ${dd.startKm.toFixed(2)}: ${Math.round(dd.loss)} m at ${Math.abs(dd.avg).toFixed(1)}%</title></path>`; });
  plan.climbs.forEach((c) => {
    s += `<path class="cl cl${c.level}" d="${seg(c.startKm, c.endKm)}"><title>Climb ${c.n}, km ${c.startKm.toFixed(2)}: ${Math.round(c.gain)} m at ${c.avg.toFixed(1)}%, ${LEVELS[c.level]}</title></path>`;
    c.sections.slice(1).forEach((sc2) => { s += `<line class="cut" x1="${x(sc2.startKm).toFixed(1)}" x2="${x(sc2.startKm).toFixed(1)}" y1="${(y(elevAt(P, sc2.startKm)) - 7).toFixed(1)}" y2="${(y(elevAt(P, sc2.startKm)) + 7).toFixed(1)}"><title>Section ${sc2.n} starts, km ${sc2.startKm.toFixed(2)}</title></line>`; });
    if (c.level >= 3) { const mid = (c.startKm + c.endKm) / 2; s += `<text class="num" x="${x(mid).toFixed(1)}" y="${(y(elevAt(P, mid)) - 9).toFixed(1)}" text-anchor="middle">${c.n}</text>`; }
  });
  sc.checkpoints.filter((c) => c.label !== "Finish").forEach((c) => {
    s += `<line class="ck" x1="${x(c.km)}" x2="${x(c.km)}" y1="${top - 6}" y2="${base}"/><text class="tk" x="${x(c.km)}" y="${top - 12}" text-anchor="middle">${esc(c.label)} · ${clock(plan.startSec, c.sec)}</text>`;
  });
  sc.gels.forEach((g) => {
    s += `<circle class="gel" cx="${x(g.km)}" cy="${base + 50}" r="8"/><text class="gelt" x="${x(g.km)}" y="${base + 53}" text-anchor="middle">G</text><text x="${x(g.km)}" y="${base + 69}" text-anchor="middle">${clock(plan.startSec, g.sec)}</text>`;
  });
  return `<svg viewBox="0 0 1000 285" role="img" aria-label="Elevation profile of the course with climbs coloured by difficulty">${s}</svg>`;
}

function render() {
  const out = $("#results");
  const plan = state.plan;
  if (!plan) {
    out.innerHTML = `<div class="panel"><b>Load both files to see your plan.</b><p class="note" style="margin-top:6px">No files at hand? Press "Try the demo" at the top to see the full result on made-up data.</p></div>`;
    return;
  }
  if (!plan.scenarios[state.scenario]) state.scenario = "central";
  const sid = state.scenario;
  const sc = plan.scenarios[sid];
  const st = plan.startSec;
  const e = plan.effort;

  const seg = SCENARIOS.map((s) => `<button type="button" data-s="${s.id}" aria-pressed="${s.id === sid}">${s.label}<small>${hm(plan.scenarios[s.id].finishSec)}</small></button>`).join("");

  const ckList = sc.checkpoints.map((c) => `<li><span>${esc(c.label)}</span><b>${clock(st, c.sec)} · ${hm(c.sec)}</b></li>`).join("");
  const gelList = sc.gels.map((g) => `<li><span>km ${g.km.toFixed(1)}${g.moved ? " (moved off a climb)" : ""}</span><b>${clock(st, g.sec)}</b></li>`).join("") || `<li><span>No gel needed in this race length</span><b></b></li>`;
  const hrList = plan.hrGuide ? plan.hrGuide.map((h) => `<li><span>km ${h.fromKm.toFixed(0)} to ${h.toKm.toFixed(0)}</span><b>${esc(h.text)}</b></li>`).join("") : `<li><span>No heart-rate data in the effort file</span><b></b></li>`;
  const hikes = plan.climbs.filter((c) => /^Hike/.test(c.tactic));
  const hikeList = hikes.map((c) => `<li><span>#${c.n} · km ${c.startKm.toFixed(1)}</span><b>${c.avg.toFixed(0)}% · ${clock(st, c.start[sid])}</b></li>`).join("") || `<li><span>None at this threshold</span><b></b></li>`;

  const maxScore = Math.max(...plan.climbs.map((c) => c.score), 1);
  const climbRows = plan.climbs.map((c) => {
    const m = c.effortMatch;
    const match = m ? `${m.avg.toFixed(0)}% · ${Math.round(m.delta)} m<small>${mmss(m.paceSecPerKm)}${m.hr ? ` · HR ${Math.round(m.hr)}` : ""} · ${Math.round(m.minutesIn)} min in</small>` : "";
    return `<tr class="r${c.level}"><td class="num">${c.n}</td><td>${c.startKm.toFixed(2)} – ${c.endKm.toFixed(2)}</td><td>${c.lenM >= 1000 ? (c.lenM / 1000).toFixed(2) + " km" : Math.round(c.lenM) + " m"}</td><td class="num">${Math.round(c.gain)} m</td><td class="num">${c.avg.toFixed(1)}%</td><td class="${c.steep >= 18 ? "steep" : ""}">${Math.round(c.steep)}%</td><td>${mmss(c.dur[sid] / (c.lenM / 1000))}</td><td>${clock(st, c.start[sid])}</td><td class="t">${esc(c.tactic)}</td><td><span class="score"><span class="chip l${c.level}">${LEVELS[c.level]}</span><span class="bar"><i style="width:${Math.round(Math.min(1, c.score / maxScore) * 100)}%"></i></span><span style="min-width:2.2em">${Math.round(c.score)}</span></span></td><td>${match}</td></tr>` + c.sections.map((s) => `<tr class="r${c.level} sec"><td class="num">${s.n}</td><td>${s.startKm.toFixed(2)} – ${s.endKm.toFixed(2)}</td><td>${(s.lenM / 1000).toFixed(2)} km</td><td class="num">${Math.round(s.gain)} m</td><td class="num">${s.avg.toFixed(1)}%</td><td class="${s.steep >= 18 ? "steep" : ""}">${Math.round(s.steep)}%</td><td>${mmss(s.dur[sid] / (s.lenM / 1000))}</td><td>${clock(st, s.start[sid])}</td><td class="t">${esc(s.tactic)}</td><td>Section, ${Math.round(s.dur[sid] / 60)} min</td><td></td></tr>`).join("");
  }).join("");
  const descRows = plan.descents.map((d) => `<tr class="r${d.level}"><td class="num">${d.n}</td><td>${d.startKm.toFixed(2)} – ${d.endKm.toFixed(2)}</td><td>${d.lenM >= 1000 ? (d.lenM / 1000).toFixed(2) + " km" : Math.round(d.lenM) + " m"}</td><td class="num">${Math.round(d.loss)} m</td><td class="num">${Math.abs(d.avg).toFixed(1)}%</td><td class="${d.steep <= -20 ? "steep" : ""}">${Math.abs(Math.round(d.steep))}%</td><td>${mmss(d.dur[sid] / (d.lenM / 1000))}</td><td>${clock(st, d.start[sid])}</td><td class="t">${esc(d.tactic)}</td><td><span class="chip l${d.level}">${DESCENT_LABELS[d.level]}</span></td></tr>`).join("");

  const bandRows = e.bands.map((b, i) => {
    const use = plan.bandUse[i];
    const slow = ((b.tired / b.fresh - 1) * 100);
    return `<tr><td class="t">${esc(b.label)}</td><td>${mmss(b.fresh)}</td><td>${mmss(b.tired)}</td><td>+${slow.toFixed(0)}%</td><td>${b.hr ? Math.round(b.hr) : "–"}</td><td>${b.cad ? Math.round(b.cad) : "–"}</td><td>${b.vam && Math.abs(b.vam) > 50 ? Math.round(b.vam) : "–"}</td><td><span class="badge ${b.source === "estimated" ? "est" : ""}">${b.source}</span></td><td>${use.km.toFixed(1)} km</td><td>${hm(use.sec)}</td></tr>`;
  }).join("");

  const drift = e.drift ? `<li><span>Flat, early</span><b>${mmss(e.drift.firstPace)} at HR ${Math.round(e.drift.firstHr)}</b></li><li><span>Flat, late</span><b>${mmss(e.drift.secondPace)} at HR ${Math.round(e.drift.secondHr)}</b></li><li><span>Speed lost per heartbeat</span><b>${e.drift.decouplingPct.toFixed(1)}%</b></li>` : `<li><span>No heart-rate drift data</span><b></b></li>`;

  const logKey = `trp.log.${(state.race && state.race.name) || "race"}.${plan.course.totalKm.toFixed(1)}`;
  const logMode = store.get("trp.logMode") || "race";

  out.innerHTML = `
  <div class="top">
    <h2 style="margin:0">Your plan</h2>
    <div class="seg" role="group" aria-label="Scenario" id="scen">${seg}</div>
  </div>
  <p class="how" style="margin-top:0">${plan.course.totalKm.toFixed(1)} km, ${Math.round(plan.course.gain)} m D+, ${plan.course.climbCount} climbs and ${plan.course.descentCount} descents. Terrain factor and fade for a longer race are included (race pace is ${((sc.factor - 1) * 100).toFixed(0)}% slower than your reference run on matching gradients). Treat the three scenarios as a plausible range, not a promise: a model like this is usually off by 5 to 10%.</p>

  <section>
    <h2>The course</h2>
    <div class="panel">
      <div class="scroll"><div class="prof">${profileSvg(plan, sid)}</div></div>
      <div class="legend" style="margin-top:10px">
        <span class="chip l1">Easy</span><span class="chip l2">Moderate</span><span class="chip l3">Hard</span><span class="chip l4">Crux</span>
        <span class="note" style="margin:0 0 0 6px">Dashed red line: descent to brake on. Circles: gel stops. Short ticks: where a long climb changes section. Shaded band: decision point. Heights are stretched so the climbs are visible.</span>
      </div>
    </div>
  </section>

  <section>
    <h2>Race card</h2>
    <div class="grid">
      <div class="panel card"><h3>Checkpoints</h3><ul class="kv">${ckList}</ul></div>
      <div class="panel card"><h3>Gel stops</h3><ul class="kv">${gelList}</ul><p class="note">Every ${plan.params.gelEveryMin} minutes, moved to the top of a climb when it would land on one.</p></div>
      <div class="panel card"><h3>Heart-rate guide</h3><ul class="kv">${hrList}</ul><p class="note">Anchored on the average heart rate of your reference run. Between km ${plan.decision.fromKm.toFixed(0)} and ${plan.decision.toKm.toFixed(0)}: if you are on pace with HR near the middle of the guide, you can push later. If it is above, hold and eat.</p></div>
      <div class="panel card"><h3>Hike these</h3><ul class="kv">${hikeList}</ul><p class="note">Hiking starts around ${plan.params.hikeGrade}% (${e.hikeGrade ? "learned from your cadence" : "default"}).</p></div>
    </div>
  </section>

  <section>
    <h2>What your reference run says about you</h2>
    <div class="grid">
      <div class="panel card"><h3>The run</h3><ul class="kv"><li><span>Distance and time</span><b>${e.distKm.toFixed(1)} km · ${hm(e.durationSec)}</b></li><li><span>Flat pace</span><b>${mmss(e.flatPace)}/km${e.flatHr ? ` at HR ${Math.round(e.flatHr)}` : ""}</b></li>${e.flatCad ? `<li><span>Flat cadence</span><b>${Math.round(e.flatCad)} spm${e.cadenceWasPerFoot ? " (doubled from per foot)" : ""}</b></li>` : ""}</ul></div>
      <div class="panel card"><h3>Fatigue on the flat</h3><ul class="kv">${drift}</ul><p class="note">Above 5% means your aerobic durability or fuelling is the limit, and a longer race will magnify it.</p></div>
    </div>
    <div class="tablewrap" style="margin-top:14px"><table class="narrow"><thead><tr><th>Gradient</th><th>Fresh</th><th>Tired</th><th>Fade</th><th>HR</th><th>Cadence</th><th>Climb rate (m/h)</th><th>Data</th><th>On course</th><th>Time (race)</th></tr></thead><tbody>${bandRows}</tbody></table></div>
    <p class="note">Fresh and tired are your pace per km in the first and second half of the reference run. Bands marked "estimated" had too little data, so they use typical ratios to your flat pace. Climb rate is vertical metres per hour; for reference, trained amateurs sustain roughly 800 to 1,000 on moderate climbs.</p>
  </section>

  <section>
    <div class="tabs" role="tablist" aria-label="Table view">
      <button type="button" role="tab" data-t="c" aria-selected="${state.tab === "c"}">Climbs</button>
      <button type="button" role="tab" data-t="d" aria-selected="${state.tab === "d"}">Descents</button>
    </div>
    <div id="paneC" ${state.tab === "c" ? "" : "hidden"}>
      <div class="legend"><span class="chip l1">Easy · run</span><span class="chip l2">Moderate · steady</span><span class="chip l3">Hard · manage effort</span><span class="chip l4">Crux · hike the steep part</span></div>
      <p class="how">Score = elevation gain × steepness factor (average gradient ÷ 8%, capped between 0.5 and 2) × fatigue factor (1.00 in the first 35% of the race, 1.15 up to 69%, 1.35 after). Easy is under 30, Moderate 30 to 60, Hard 60 to 90, Crux 90 and above. The last column is the climb in your reference run closest in gradient and size. Climbs of ${(plan.params.splitClimbM / 1000).toFixed(1)} km or more that gain at least ${plan.params.splitClimbMinGain} m are split into sections of at least ${(plan.params.sectionMinM / 1000).toFixed(1)} km (rows 5.1, 5.2...), cut where the gradient changes, each with its own tactic and clock time.</p>
      <div class="tablewrap" style="margin-top:12px"><table><thead><tr><th>#</th><th>Km</th><th>Length</th><th>Gain</th><th>Avg</th><th>Steepest 100 m</th><th>Pace</th><th>Clock</th><th class="t">Tactic</th><th>Difficulty</th><th>Closest climb in your run</th></tr></thead><tbody>${climbRows}</tbody></table></div>
    </div>
    <div id="paneD" ${state.tab === "d" ? "" : "hidden"}>
      <div class="legend"><span class="chip l1">Let it run · recover</span><span class="chip l2">Control · quick steps</span><span class="chip l4">Brake · protect ankle and quads</span></div>
      <p class="how">Brake: steepest 100 m of 20% or more, or an average of 12% or more. Control: an average of 6% or more, or a steepest 100 m of 15% or more. Everything else is a descent where gravity can do the work.</p>
      <div class="tablewrap" style="margin-top:12px"><table style="min-width:820px"><thead><tr><th>#</th><th>Km</th><th>Length</th><th>Loss</th><th>Avg</th><th>Steepest 100 m</th><th>Pace</th><th>Clock</th><th class="t">Tactic</th><th>Risk</th></tr></thead><tbody>${descRows}</tbody></table></div>
    </div>
  </section>

  <section>
    <h2>Plan versus actual</h2>
    <div class="panel">
      <div class="actions" style="margin-bottom:8px">
        <label class="f" style="flex-direction:row;align-items:center;gap:8px">Log for
          <select id="logsel" style="width:auto;min-width:200px"><option value="sim" ${logMode === "sim" ? "selected" : ""}>Training simulation</option><option value="race" ${logMode === "race" ? "selected" : ""}>Race day</option></select>
        </label>
        <span class="note" style="margin:0;align-self:center">Saved in this browser only.</span>
      </div>
      <div class="logrow loghead"><span>Checkpoint</span><span>Plan</span><span>Your time</span><span>Gap</span></div>
      <div id="logrows"></div>
      <p class="note">Type the first checkpoint as minutes and seconds if it is under an hour (56:30), the others as hours and minutes (1:55). The plan follows the scenario selected above.</p>
    </div>
  </section>

  <section>
    <h2>Take it with you</h2>
    <div class="actions">
      <button class="btn primary" id="copyMd" type="button">Copy plan as Markdown</button>
      <button class="btn" id="copyJson" type="button">Copy plan as JSON</button>
      <span class="status" id="exportStat" aria-live="polite"></span>
    </div>
    <p class="note">Markdown pastes into notes, a doc or a chat. Clock times in both use the scenario selected above.</p>
  </section>

  <p class="foot">How it works: your reference run gives a pace for every gradient band, fresh and tired. Each 10 m of the course takes the pace of its band, sliding from fresh to tired along the race, scaled for terrain and for how much longer the race is than your run. Climbs and descents come from the course elevation, smoothed to ignore GPS noise.</p>`;

  /* wiring */
  out.querySelectorAll("#scen button").forEach((b) => b.addEventListener("click", () => { state.scenario = b.dataset.s; store.set("trp.scenario", state.scenario); render(); }));
  out.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => { state.tab = b.dataset.t; render(); }));
  $("#logsel").addEventListener("change", (ev) => { store.set("trp.logMode", ev.target.value); drawLog(plan, logKey); });
  drawLog(plan, logKey);
  $("#copyMd").addEventListener("click", () => copyText(planToMarkdown(plan, sid)));
  $("#copyJson").addEventListener("click", () => copyText(JSON.stringify(slimPlan(plan, sid), null, 2)));
}

/* ---------- plan vs actual ---------- */
function drawLog(plan, logKey) {
  const mode = $("#logsel").value;
  const key = `${logKey}.${mode}`;
  const saved = store.get(key) || {};
  const sid = state.scenario;
  const cps = plan.scenarios[sid].checkpoints;
  $("#logrows").innerHTML = cps.map((c, i) => {
    const first = i === 0;
    return `<div class="logrow"><span class="lbl">${esc(c.label)}</span><span>${first && c.sec < 3600 ? mmss(c.sec) : hm(c.sec)}</span><input type="text" inputmode="numeric" autocomplete="off" data-i="${i}" placeholder="${first && c.sec < 3600 ? "mm:ss" : "h:mm"}" value="${esc(saved[i] || "")}" aria-label="${esc(c.label)} actual time"><span class="delta" id="gap${i}"></span></div>`;
  }).join("");
  const update = () => {
    $("#logrows").querySelectorAll("input").forEach((inp) => {
      const i = Number(inp.dataset.i);
      const out = $("#gap" + i);
      const short = i === 0 && cps[0].sec < 3600;
      const t = parseDuration(inp.value, short);
      if (t === null) { out.textContent = inp.value ? "Check format" : ""; return; }
      const dlt = t - cps[i].sec;
      const a = Math.abs(Math.round(dlt));
      out.textContent = Math.abs(dlt) < 5 ? "On plan" : `${Math.floor(a / 60)}:${String(a % 60).padStart(2, "0")} ${dlt < 0 ? "ahead" : "behind"}`;
    });
  };
  $("#logrows").querySelectorAll("input").forEach((inp) => {
    inp.addEventListener("input", update);
    inp.addEventListener("change", () => {
      const o = {};
      $("#logrows").querySelectorAll("input").forEach((x) => { o[x.dataset.i] = x.value.trim(); });
      store.set(key, o);
    });
  });
  update();
}

/* ---------- export ---------- */
function slimPlan(plan, sid) {
  return JSON.parse(JSON.stringify({ ...plan, scenarioShown: sid, course: { ...plan.course, profile: undefined } }));
}
function setExportStatus(t) { const el = $("#exportStat"); if (el) el.textContent = t; }
function copyText(text) {
  const done = () => setExportStatus("Copied.");
  const fallback = () => {
    const ta = document.createElement("textarea");
    ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy") ? done() : setExportStatus("Could not copy here. Select the text from the table instead."); } catch (e) { setExportStatus("Could not copy."); }
    ta.remove();
  };
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, fallback);
  else fallback();
}
render();
