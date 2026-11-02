// race.js: sections 03 Your plan (renderDday), 04 Your race (renderReplay, the cockpit), 05 Your coach
// (renderPimp), the sticky navigation (renderNav), plan vs actual and the export helpers.
// Split out of main.js (2026-11-02).

import { judgeTarget, parseAidStations } from "../core/plan.js";
import { SCENARIOS } from "../core/model.js";
import { planToMarkdown } from "../core/markdown.js";
import { pimpBadge, watchPanelHtml, mountWatch, downloadCourse, watchPoints } from "./watch.js";
import { starChip, descChip } from "./chips.js";
import { hm, clock, mmss, parseDuration } from "../core/format.js";
import { courseMap } from "./map.js";
import { stopReplay, mountReplay } from "./replay.js";
import { acctAiBadge } from "./account.js";
import { arState, arBarHtml } from "./airace.js";
import { cloudUser } from "./cloud.js";
import { trackEvent, trackOnce } from "./analytics.js";
import { $, state, esc, store } from "./appstate.js";
import { empty, cell, kmRange, spark, jumps, tile, profileView, zoneList, rowsTable, mapStyle, ZONE_NOTE } from "./pieces.js";

let ddayMap = null;

/* ---------- 03 D-day ---------- */
/**
 * Section 03 Plan: the race-day plan from state.plan (core/plan.js buildPlan). Writes into
 * #s3body: the scenario switch and finish time, the targeted-duration verdict, the profile with
 * gels and aid stations, a map, the key zones, the race card (checkpoints, aid stations, gels,
 * heart rate, hikes), the climb-by-climb table, the plan-versus-actual log and export buttons.
 * Times in the plan are seconds from the start; clock(startSec, sec) turns them into a time of
 * day and hm(sec) into a duration. Many values are stored per scenario: x.start[sid], x.dur[sid].
 * Side effects: replaces ddayMap, adds listeners, reads and writes localStorage.
 */
export function renderDday() {
  const out = $("#s3body");
  const plan = state.plan;
  if (ddayMap) { ddayMap.destroy(); ddayMap = null; }
  if (!plan) {
    out.innerHTML = empty(state.race || state.effort ? `<b>Add the ${state.race ? "run" : "race"} GPX</b> to build your race-day plan.` : `<b>Load both files</b> (or press Try the demo) to build your race-day plan.`);
    return;
  }
  // A scenario saved in this browser that the plan does not have falls back to central.
  if (!plan.scenarios[state.scenario]) state.scenario = "central";
  const sid = state.scenario;
  const sc = plan.scenarios[sid];
  const st = plan.startSec;
  const brief = { totalKm: plan.course.totalKm, climbs: plan.climbs, descents: plan.descents };
  const aidMarks = plan.aidStations.map((a) => ({ km: a.km, name: a.name, sec: a.arrive[sid] }));

  // The HTML pieces of the race card, one list item per line. `||` gives a fallback line
  // when a list comes out empty ("" is falsy).
  const seg = SCENARIOS.map((s) => `<button type="button" data-s="${s.id}" aria-pressed="${s.id === sid}">${s.label}<small>${hm(plan.scenarios[s.id].finishSec)}</small></button>`).join("");
  const ckList = sc.checkpoints.map((c) => `<li><span>${esc(c.label)}</span><b>${clock(st, c.sec)} · ${hm(c.sec)}</b></li>`).join("");
  // GEL_WHERE: how to describe where a gel was moved to, by the `where` code plan.js gives it.
  const GEL_WHERE = { top: "top of climb", bottom: "foot of descent", section: "end of a climb section", "before descent": "before the descent", "on the climb": "on the climb, walking" };
  const gelList = sc.gels.map((g) => `<li><span>km ${g.km.toFixed(1)}${g.at ? ` · ${esc(g.at)}` : g.where ? ` · ${GEL_WHERE[g.where]}` : ""}</span><b>${clock(st, g.sec)}</b></li>`).join("") || `<li><span>No gel needed for this length</span><b></b></li>`;
  const hrList = plan.hrGuide ? plan.hrGuide.map((h) => `<li><span>km ${h.fromKm.toFixed(0)} to ${h.toKm.toFixed(0)}</span><b>${esc(h.text)}</b></li>`).join("") : `<li><span>Add your max heart rate in your profile for a heart-rate guide</span><b><button class="to-profile" type="button" data-open-profile="heart">Add it</button></b></li>`;
  // The climbs (and climb sections) to hike: those whose tactic starts with "Hike".
  // The regex /^Hike/ matches "Hike" at the start of the text; /steep part/ anywhere in it.
  const hikes = plan.climbs.flatMap((c) => [c, ...c.sections]).filter((c) => /^Hike/.test(c.tactic));
  const hikeList = hikes.map((c) => `<li><span>#${c.n} · km ${c.startKm.toFixed(1)}</span><b>${/steep part/.test(c.tactic) ? `${Math.round(c.steep)}% pitch` : `${c.avg.toFixed(0)}%`} · ${clock(st, c.start[sid])}</b></li>`).join("") || `<li><span>None at this threshold</span><b></b></li>`;

  // One table row for a climb, section or descent: arrival clock time, time on it (at least
  // 1 min), average pace in min/km (duration in s / length in km) and the tactic.
  const raceRow = (x, sec, chip) => `<div class="row v${x.level} ${sec ? "sec" : ""}">
      <div class="n">${x.n}</div>${cell("Km", kmRange(x))}${spark(plan.course.profile, x.startKm, x.endKm, x.avg)}${cell("Arrive", clock(st, x.start[sid]))}${cell("Time on it", `${Math.max(1, Math.round(x.dur[sid] / 60))} min`)}${cell("Pace", `${mmss(x.dur[sid] / (x.lenM / 1000))}/km`)}${cell("Tactic", esc(x.tactic), "w")}<div class="diff">${chip}</div>
    </div>`;
  const climbRows = plan.climbs.map((c) => raceRow(c, false, starChip(c.level)) + c.sections.map((x) => raceRow(x, true, starChip(x.level))).join("")).join("");
  const descRows = plan.descents.map((d) => raceRow(d, false, descChip(d.level))).join("");
  const PLAN_COLS = ["Arrive", "Time on it", "Pace", { t: "Tactic", w: true }];

  // The plan-versus-actual times are saved per race name and distance, so two races do not mix.
  const logKey = `trp.log.${(state.race && state.race.name) || "race"}.${plan.course.totalKm.toFixed(1)}`;
  const logMode = store.get("trp.logMode") || "race";

  // The targeted duration: parseDuration reads "h:mm" into seconds (null if it cannot), and
  // judgeTarget compares it with the three scenarios. TARGET maps each verdict to
  // [title, tone (colour class), explanation].
  const target = judgeTarget(plan, parseDuration(state.settings.targetTime));
  const TARGET = {
    "out-of-reach": ["Not backed by your runs", "bad", "More than 5% faster than your best-case scenario: nothing in your reference runs shows that speed on this course. Aim for a time inside the scenario range, or add a faster recent run."],
    ambitious: ["Ambitious", "warn", "Faster than your best-case scenario but within the model's margin: it needs a great day, a fast course and no mistakes."],
    realistic: ["Realistic", "good", "Inside the range of your three scenarios: your runs say you can do it."],
    comfortable: ["Comfortable", "good", "Slower than your cautious scenario: you have margin. Keep it as a safe goal, or aim a little higher."],
  };
  // (() => { ... })() is an arrow function called at once (an IIFE): a way to run a few
  // statements where an expression is expected. A typed target that could not be read gets a
  // format hint; no target, nothing.
  const targetHtml = target ? (() => {
    const [title, tone, why] = TARGET[target.verdict];
    const pct = target.vsCentralPct;
    return `<div class="panel target-card t-${tone}" id="d-target">
      <div class="tg-h"><span class="k">Targeted duration</span><b>${hm(target.targetSec)}</b><span class="chip tg-chip">${title}</span></div>
      <p>${why}</p>
      <ul class="kv"><li><span>Versus your balanced scenario (${hm(plan.scenarios.central.finishSec)})</span><b>${Math.abs(pct) < 0.5 ? "the same" : `${Math.abs(pct).toFixed(1)}% ${pct > 0 ? "faster" : "slower"}`}</b></li>
      <li><span>Average pace it needs, stops included</span><b>${mmss(target.paceSec)}/km <small>balanced ${mmss(target.centralPaceSec)}/km</small></b></li>
      <li><span>Scenario range</span><b>${hm(plan.scenarios.best.finishSec)} to ${hm(plan.scenarios.cautious.finishSec)}</b></li></ul>
    </div>`;
  })() : state.settings.targetTime ? `<div class="panel target-card t-warn" id="d-target"><p>Write the targeted duration as hours:minutes, for example 10:15.</p></div>` : "";

  // Write the whole section in one go.
  out.innerHTML = `
  ${jumps([["d-map", "Map"], ["d-key", "★ Key zones"], ["d-card", "Race card"], ["d-climbs", "Climb by climb"], ["d-log", "Plan versus actual"], ["d-export", "Export"], ["s-pimp", "05 Coach"], ["rpCockpit", "▶ Your race", "go"]])}
  <div class="dday-top has-pimp">
    ${tile(`Estimated duration · ${sc.label.toLowerCase()}`, hm(sc.finishSec), `finish at ${clock(st, sc.finishSec)} · start ${clock(st, 0)}`, "big")}
    <div class="panel" style="display:flex;flex-direction:column;gap:12px;justify-content:center">
      <div class="scen-row"><div class="seg" role="group" aria-label="Scenario" id="scen">${seg}</div>${acctAiBadge("race")}</div>
      <p class="note" style="margin:0">${sc.factor >= 1 ? `Race pace is ${((sc.factor - 1) * 100).toFixed(0)}% slower than your run on the same gradients: terrain factor plus the fade for a longer effort.` : `Race pace is ${((1 - sc.factor) * 100).toFixed(0)}% faster than your run on the same gradients: the race is shorter than your runs and your race references allow it.`} Every clock time on this page follows the scenario you pick.</p>
      ${plan.night ? `<p class="note" style="margin:0">Dark from ${clock(0, plan.night.dusk)} to ${clock(0, plan.night.dawn)} at the start line: ${plan.night.darkKm.toFixed(1)} km in the dark, planned ${plan.night.slowPct}% slower.</p>` : `<p class="note" style="margin:0">Add the race date in Your route to plan the stretches run in the dark.</p>`}
      ${plan.scenarios.central.finishSec > 6 * 3600 || plan.scenarios.central.finishSec > 2.5 * plan.effort.durationSec ? (cloudUser() ? `<p class="note" style="margin:0">Long race: ${plan.tuned ? "planned with your tuning." : "fine-tune the calculation in your profile."} <button type="button" class="to-profile" data-open-profile="engine">Tune my engine →</button></p>` : `<p class="note" style="margin:0">Long race: signed-in runners can fine-tune the calculation in their profile (accounts are by invitation for now).</p>`) : ""}
    </div>
    <div class="side-stack">${pimpBadge("#s-pimp")}</div>
  </div>
  ${targetHtml}
  <div class="prof-wrap">${profileView(plan.course.profile, brief, { ...sc, startSec: st, aid: aidMarks }, plan.keyZones).html}
    <div class="legend" style="margin-top:10px"><span class="note" style="margin:0">Red dots: gels. Triangles: aid stations. Shaded bands ★: key zones, where the race is played.</span></div>
  </div>
  ${plan.keyZones.length ? `<div class="kz-bar" id="d-key" role="group" aria-label="Key zones"><span class="kz-h">Key zones</span>${plan.keyZones.map((z, i) => `<button type="button" class="kz-chip m-${z.mode}" data-z="${i}" aria-pressed="${state.kz === i}" title="${esc(z.title)}">★${z.n}<small>${z.modeLabel}</small></button>`).join("")}<span class="kz-hint">Pick a star: its message opens, the profile and the map show where it is.</span></div>
  <div id="kzMsg"></div>` : `<div id="d-key">${zoneList([])}</div>`}
  <div class="sub-h" id="d-map">Map</div>
  <div class="b-map" id="ddayMap"></div>

  <details class="fold" id="d-card"><summary class="sub-h">Race card</summary>
  <div class="grid">
    <div class="panel card"><h3>Checkpoints</h3><ul class="kv">${ckList}</ul></div>
    ${plan.aidStations.length ? `<div class="panel card"><h3>Aid stations</h3><ul class="kv">${plan.aidStations.map((a) => `<li><span>km ${a.km.toFixed(1)} · ${esc(a.name)}</span><b>${clock(st, a.arrive[sid])}${a.stopMin ? ` → ${clock(st, a.arrive[sid] + a.stopMin * 60)}` : ""}</b></li>`).join("")}</ul><p class="note">Arrival → departure. ${plan.aidStations.reduce((t, a) => t + a.stopMin, 0)} min of stops in total, included in the finish time.</p></div>` : ""}
    <div class="panel card"><h3>Gels</h3><ul class="kv">${gelList}</ul><p class="note">Every ${plan.params.gelEveryMin} min after the last one, taken at an aid station when one is close, else moved off climbs and technical descents. When the top is more than ${plan.params.gelMaxDelayMin} min away, it is taken at a change of slope or while walking.</p></div>
    <div class="panel card"><h3>Heart rate</h3><ul class="kv">${hrList}</ul><p class="note">Before each key zone: on pace with heart rate in the guide, commit to it. Above it, hold and eat, and save it for the next one.</p></div>
    <div class="panel card"><h3>Hike these</h3><ul class="kv">${hikeList}</ul><p class="note">Hiking from ${plan.params.hikeGrade}% (${state.settings.hikeGrade ? "set by you" : plan.effort.hikeGrade ? "learned from your cadence" : "default"}). A climb is hiked when its average is within 2 points of that, or just its steep part when a 100 m stretch reaches it.</p></div>
  </div>
  </details>

  <details class="fold" id="d-climbs" ${state.foldClimbs === false ? "" : "open"}><summary class="sub-h">Climb by climb</summary>
  <div class="tabs" role="tablist" aria-label="Segments">
    <button type="button" role="tab" data-t="c" aria-selected="${state.tab === "c"}">Climbs</button>
    <button type="button" role="tab" data-t="d" aria-selected="${state.tab === "d"}">Descents</button>
  </div>
  <div ${state.tab === "c" ? "" : "hidden"}>${rowsTable("t-plan", PLAN_COLS, climbRows)}</div>
  <div ${state.tab === "d" ? "" : "hidden"}>${rowsTable("t-plan", PLAN_COLS, descRows)}</div>
  </details>

  <details class="fold" id="d-log"><summary class="sub-h">Plan versus actual <small>extra</small></summary>
  <div class="panel">
    <div class="actions" style="margin-bottom:8px">
      <label class="f" style="flex-direction:row;align-items:center;gap:8px">Log for
        <select id="logsel" style="width:auto;min-width:200px"><option value="sim" ${logMode === "sim" ? "selected" : ""}>Training simulation</option><option value="race" ${logMode === "race" ? "selected" : ""}>Race result</option></select>
      </label>
      <span class="note" style="margin:0">Saved in this browser only.</span>
    </div>
    <div class="logrow loghead"><span>Checkpoint</span><span>Plan</span><span>Your time</span><span>Gap</span></div>
    <div id="logrows"></div>
    <p class="note">Type the first checkpoint as minutes and seconds if it is under an hour (56:30), the others as hours and minutes (1:55).</p>
  </div>
  </details>

  <div class="sub-h" id="d-export">Take it with you</div>
  <div class="actions">
    <button class="btn primary" id="copyMd" type="button">Copy plan as Markdown</button>
    <button class="btn" id="copyJson" type="button">Copy as JSON</button>
    <button class="btn" id="printDday" type="button">⎙ Export A4 (print or PDF)</button>
    <span class="status" id="exportStat" aria-live="polite"></span>
  </div>`;

  // Wiring: the elements above are new, so their listeners are added after every redraw.
  // A scenario click redraws all the sections whose times depend on it, and saves the choice.
  /* wiring */
  out.querySelectorAll("#scen button").forEach((b) => b.addEventListener("click", () => { state.scenario = b.dataset.s; trackEvent("scenario", state.scenario); store.set("trp.scenario", state.scenario); renderDday(); renderReplay(); renderPimp(); renderNav(); }));
  // Switching the Climbs / Descents tab redraws the section and keeps "Climb by climb" open.
  out.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => { state.tab = b.dataset.t; state.foldClimbs = true; trackEvent("dday-tab", state.tab); renderDday(); }));
  // The "toggle" event fires when a <details> block opens or closes.
  out.querySelectorAll("details.fold").forEach((d) => d.addEventListener("toggle", () => { if (d.open) trackEvent("fold-open", d.id); if (d.id === "d-climbs") state.foldClimbs = d.open; }));
  $("#logsel").addEventListener("change", (ev) => { trackEvent("log-mode", ev.target.value); store.set("trp.logMode", ev.target.value); drawLog(plan, logKey); });
  drawLog(plan, logKey);
  $("#copyMd").addEventListener("click", () => { trackEvent("export", "markdown"); copyText(planToMarkdown(plan, sid)); });
  $("#copyJson").addEventListener("click", () => { trackEvent("export", "json"); copyText(JSON.stringify(slimPlan(plan, sid), null, 2)); });
  $("#printDday").addEventListener("click", () => { const box = $("#s3 .a4x"); box.open = true; box.scrollIntoView({ behavior: "smooth", block: "center" }); });
  // `...mapStyle(...)` spreads paint and marks into the options. Without a route there is no map.
  // The race on a map, coloured like the profile, with your aid stations and key zones.
  if (state.race && state.race.route) ddayMap = courseMap($("#ddayMap"), { route: state.race.route, totalKm: plan.course.totalKm, ...mapStyle(brief, parseAidStations(state.settings.aidStations).filter((a) => a.km <= plan.course.totalKm), plan.keyZones) });
  else $("#ddayMap").remove();
  // Key zone chips: one open at a time (state.kz, the index, or null). Opening one writes its card
  // under the chips, shades its band on the profile (class "on") and lights it on the map with the
  // rest of the route dimmed, without zooming; a second click on the same chip closes it.
  const openZone = (i) => {
    if (i !== null && !plan.keyZones[i]) i = null;
    state.kz = i;
    out.querySelectorAll(".kz-chip").forEach((b) => b.setAttribute("aria-pressed", String(+b.dataset.z === i)));
    const z = i === null ? null : plan.keyZones[i];
    out.querySelectorAll(".prof-wrap rect.zone").forEach((rc) => rc.classList.toggle("on", !!z && +rc.dataset.z === z.n));
    const msg = $("#kzMsg");
    if (msg) msg.innerHTML = z ? `${zoneList([z])}<p class="note kz-note">${ZONE_NOTE}</p>` : "";
    if (ddayMap) { if (z) ddayMap.focus(z.fromKm, z.toKm, { zoom: false }); else ddayMap.focus(null); }
  };
  out.querySelectorAll(".kz-chip").forEach((b) => b.addEventListener("click", () => {
    const i = +b.dataset.z;
    if (state.kz !== i) trackEvent("key-zone", String(plan.keyZones[i].n));
    openZone(state.kz === i ? null : i);
  }));
  if (state.kz !== null && state.kz !== undefined && plan.keyZones[state.kz]) openZone(state.kz);
  // The "Pimp my GPX" sticker drawn by pimpBadge() above links to section 05.
  $("#s3body .pimp-link").addEventListener("click", () => trackEvent("nav", "pimp-badge"));
}

/* ---------- 05 pimp my GPX: the watch messages and the course for the watch ---------- */
/**
 * Section 05 Your coach: the watch messages for this plan (built and edited by ui/watch.js) and the
 * buttons to download the course as a Garmin .fit or as a GPX with waypoints. Writes into
 * #sPimpBody. say(text) shows a short status next to the buttons.
 */
export function renderPimp() {
  const box = $("#sPimpBody");
  const plan = state.plan;
  if (!plan) { box.innerHTML = empty(`<b>Build your plan first</b> (both files, or press Try the demo), then get the race GPX back with your plan on it.`); return; }
  const sid = plan.scenarios[state.scenario] ? state.scenario : "central";
  box.innerHTML = `
  <p class="note" style="margin-top:0">Timed on your <b>${esc(plan.scenarios[sid].label.toLowerCase())}</b> scenario (change it in 03 Your plan).</p>
  <div id="dWatch">${watchPanelHtml(plan, `<button class="btn primary sm" id="dlFit" type="button" title="Import it in Garmin Connect (Courses, Import) or copy it to the watch's GARMIN/NewFiles folder">Garmin .fit</button><button class="btn sm" id="dlGpx" type="button" title="For other brands of watch">.gpx</button><span class="status" id="pimpStat" aria-live="polite"></span>`)}</div>`;
  const say = (t) => { $("#pimpStat").textContent = t; };
  mountWatch($("#dWatch"), { plan, sid, key: watchKey(plan, sid), say });
  $("#dlFit").addEventListener("click", () => exportCourse("fit", plan, sid, say));
  $("#dlGpx").addEventListener("click", () => exportCourse("gpx", plan, sid, say));
}

/* ---------- 04 race day replay ---------- */
/**
 * Section 04 Your race: the plan played back in time (ui/replay.js), in #s4body. Only drawn in
 * Prep my race mode. The key (race name | km) lets replay.js remember things per race.
 */
export function renderReplay() {
  // Only on screen in Prep my race: drawing it in another mode would take the one map and
  // animation away from the cockpit that is showing (Prep my run). setMode draws it on the way back.
  const mode = document.documentElement.dataset.mode;
  if (mode && mode !== "plan") return;
  const box = $("#s4body");
  const calc = state.plan;
  if (!calc) {
    stopReplay();
    $("#s4ai").innerHTML = "";
    box.innerHTML = empty(`<b>Build your plan first</b> (both files, or press Try the demo), then come back to play your race day.`);
    return;
  }
  const sid = calc.scenarios[state.scenario] ? state.scenario : "central";
  // The Calculated / AI switch (airace.js): with AI on and an AI plan that fits this plan, the
  // cockpit plays the AI plan, rebuilt by code from the AI's answer; otherwise the calculated one.
  const key = raceKey();
  const ai = arState(calc, key);
  const on = state.aiOn && ai.state === "ok";
  const plan = on ? ai.result.plan : calc;
  $("#s4ai").innerHTML = arBarHtml(ai, on, calc.scenarios[sid].finishSec, on ? plan.scenarios[sid].finishSec : null);
  document.documentElement.classList.toggle("ai-on", on);
  mountCockpit(box, plan, sid, key);
}
/** The race key ("name|km"): what replay.js and the AI answer are remembered by. */
export const raceKey = () => `${state.race && state.race.name}|${state.plan.course.totalKm.toFixed(2)}`;
/** The race-day cockpit (sections, map, profile, script) for any plan: a race, or a run to come. */
// box: the element to draw into; plan: a plan from buildPlan; sid: scenario id; key: a text that
// identifies the race; noun: "Race" or "Run", used in the cockpit's wording.
// It prepares the compact profile (flat: true) and the map colours, then hands everything to
// replay.js mountReplay, which runs the animation. Also used by Prep my run (see initPrepRun).
export function mountCockpit(box, plan, sid, key, noun = "Race", timeline = "") {
  const sc = plan.scenarios[sid];
  const brief = { totalKm: plan.course.totalKm, climbs: plan.climbs, descents: plan.descents };
  const aidMarks = plan.aidStations.map((a) => ({ km: a.km, name: a.name, sec: a.arrive[sid], time: clock(plan.startSec, a.arrive[sid]) }));
  const prof = profileView(plan.course.profile, brief, { ...sc, startSec: plan.startSec, aid: aidMarks }, plan.keyZones, { flat: true });
  const m = mapStyle(brief, aidMarks, plan.keyZones);
  mountReplay(box, { plan, sid, prof, mapPaint: m.paint, mapMarks: m.marks, key, noun, timeline });
}

/* ---------- sticky navigation ---------- */
// Which section is on screen: an IntersectionObserver reports when each section crosses a thin
// band across the middle of the viewport, without listening to every scroll event.
/**
 * Update the top bar: mark as "ready" the links of sections that have something to show, and
 * show either a Your race button (once there is a plan) or a Try the demo button.
 * Sections s5, s6 and s-prep belong to other modules: they count as ready when an element those
 * modules draw (#rvCockpit, #inKpi, .prep-ready) exists. Also refreshes the A4 export button.
 */
export function renderNav() {
  const plan = state.plan;
  const ready = { s1: Boolean(state.effort), s2: Boolean(state.race), s3: Boolean(plan), s4: Boolean(plan), "s-pimp": Boolean(plan), s5: Boolean($("#rvCockpit")), s6: Boolean($("#inKpi")), "s-prep": Boolean($("#sPrepBody .prep-ready")) };
  document.querySelectorAll(".tn-links a").forEach((a) => a.classList.toggle("ready", ready[a.dataset.sec]));
  const sum = $("#tnSum");
  if (plan) {
    sum.innerHTML = `<a class="btn primary sm" href="#rpCockpit">▶ Your race</a>`;
  } else sum.innerHTML = `<button class="btn ghost sm" type="button" id="tnDemo">Try the demo</button>`;
  const d = $("#tnDemo");
  if (d) d.addEventListener("click", () => $("#demo").click());
  const go = sum.querySelector('a[href="#rpCockpit"]');
  if (go) go.addEventListener("click", () => trackEvent("nav", "race-day-button"));
}

/* ---------- plan vs actual ---------- */
/**
 * The plan-versus-actual log in section 03: one row per checkpoint with the planned time, a box
 * for your real time and the gap (ahead or behind). plan: the plan; logKey: the storage key
 * prefix for this race. Two logs are kept, picked by the select: a training simulation and the
 * race result. Side effects: draws #logrows and saves what you type in localStorage.
 */
function drawLog(plan, logKey) {
  const mode = $("#logsel").value;
  const key = `${logKey}.${mode}`;
  const saved = store.get(key) || {};
  const sid = state.scenario;
  const cps = plan.scenarios[sid].checkpoints;
  // A first checkpoint under an hour (3600 s) is written as mm:ss, all others as h:mm.
  $("#logrows").innerHTML = cps.map((c, i) => {
    const first = i === 0;
    return `<div class="logrow"><span class="lbl">${esc(c.label)}</span><span>${first && c.sec < 3600 ? mmss(c.sec) : hm(c.sec)}</span><input type="text" inputmode="numeric" autocomplete="off" data-i="${i}" placeholder="${first && c.sec < 3600 ? "mm:ss" : "h:mm"}" value="${esc(saved[i] || "")}" aria-label="${esc(c.label)} actual time"><span class="delta" id="gap${i}"></span></div>`;
  }).join("");
  // update(): recompute every gap from what is typed. parseDuration(text, short) reads mm:ss when
  // short is true, else h:mm, and returns seconds or null. Within 5 s counts as on plan.
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
  // Typing updates the gaps at once ("input"); leaving the box ("change") saves all the times.
  $("#logrows").querySelectorAll("input").forEach((inp) => {
    inp.addEventListener("input", update);
    inp.addEventListener("change", () => {
      const o = {};
      $("#logrows").querySelectorAll("input").forEach((x) => { o[x.dataset.i] = x.value.trim(); });
      store.set(key, o);
      trackOnce("log-time-entered");
    });
  });
  update();
}

/* ---------- export ---------- */
/**
 * The plan as plain data for "Copy as JSON", without the heavy parts: the drawing profile, the
 * route and every scenario's timeline. JSON.stringify's second argument (a "replacer") is called
 * for each key: returning undefined drops that key. The text is parsed back to get a clean copy.
 */
function slimPlan(plan, sid) {
  return JSON.parse(JSON.stringify({ ...plan, scenarioShown: sid, course: { ...plan.course, profile: undefined, route: undefined } }, (k, v) => (k === "timeline" ? undefined : v)));
}
/** Show a short message next to the export buttons (if section 03 is drawn). */
function setExportStatus(t) { const el = $("#exportStat"); if (el) el.textContent = t; }
/* ---------- watch messages (ui/watch.js): saved per race, distance and scenario ---------- */
// The storage key for the watch messages you edited: one set per race name, distance and scenario.
const watchKey = (plan, sid) => `trp.watch.${(state.race && state.race.name) || "race"}.${plan.course.totalKm.toFixed(1)}.${sid}`;

/** Save the plan as a watch course: FIT (Garmin) or GPX with waypoints (any brand). */
// kind: "fit" or "gpx"; plan, sid: the plan and scenario; say(text): shows the result.
// The original GPX points (track) are passed along so the course follows the real route.
// downloadCourse (ui/watch.js) builds the file, starts the download and returns the file name.
function exportCourse(kind, plan, sid, say) {
  const name = (state.race && state.race.name) || "Race";
  const track = state.race && state.race.parsed ? state.race.parsed.points : null;
  try {
    const file = downloadCourse(kind, { plan, sid, track, name, points: watchPoints(plan, sid, watchKey(plan, sid)) });
    say(`Saved ${file}.`);
  } catch (e) { say(`Could not make the course: ${e.message}`); }
}

/**
 * Copy text to the clipboard. The modern way is navigator.clipboard.writeText (needs a secure
 * page, https or localhost, and returns a promise). When it is missing or refused, the fallback
 * puts the text in an invisible <textarea>, selects it and runs the older "copy" command.
 */
function copyText(text) {
  const done = () => setExportStatus("Copied.");
  const fallback = () => {
    const ta = document.createElement("textarea");
    ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy") ? done() : setExportStatus("Could not copy here."); } catch (e) { setExportStatus("Could not copy."); }
    ta.remove();
  };
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, fallback);
  else fallback();
}
