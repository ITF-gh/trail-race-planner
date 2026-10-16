// preprun.js (ui): the "Prep my run" mode. Drop the GPX of a run to come; the planner reads the
// course (climbs, descents, key zones), shows it like race day (section bar, map, profile, script),
// proposes the watch messages, lets you check and edit them, and gives the course back as a
// Garmin .fit or a .gpx with the messages on it.
//
// Time along the course, used to space the messages and show when you reach each one:
//   your target time if you give one (the estimate stretched to land on it), otherwise
//   your reference runs if Plan a race has some loaded (your own pace on every gradient), otherwise
//   a generic estimate from Tobler's hiking function.
//
// Where it sits: main.js puts prepHeroHtml() in the page and calls initPrepRun() once at start-up,
// passing small functions (getRuns, getSettings, cockpit) so this file can read main.js's state
// without importing it. The data flow on each file drop is:
//   GPX text -> parseGpx (core/track.js) -> buildPlan (core/plan.js) or prepRunPlan
//   (core/preprun.js) -> render(): summary, cockpit (replay.js through main.js), watch panel
//   (watch.js), download buttons.
//
// The AI coach: once a GPX is loaded, a small shiny edelweiss sticker (beside Pimp my GPX) opens the Ask the AI coach window
// (account.js). Its answer (core/airun.js) comes back as an AI doc; the Calculated / AI switch
// above the cockpit (airace.js) then plays the session: the exercises as moments of the run
// script, the faster reps in the clock, the AI message box.
//
// Main exports: prepHeroHtml (the mode's header and drop zone), initPrepRun (wires everything and
// returns { rerender, current }).

import { parseGpx } from "../core/track.js";
import { buildPlan } from "../core/plan.js";
import { prepRunPlan } from "../core/preprun.js";
import { hm, parseDuration } from "../core/format.js";
import { makeDemoRaceGpx, DEMO_LONG_RUN_PROFILE } from "../demo.js";
import { watchPanelHtml, mountWatch, watchPoints, downloadCourse, pimpBadge } from "./watch.js";
import { trackEvent } from "./analytics.js";
import { acctOpenRunAsk, acctAiBadge } from "./account.js";
import { arUse, arState, arBarHtml } from "./airace.js";
import { runSpots } from "../core/airun.js";

// Escape text for HTML: each of & < > " (the regex's character set) becomes its entity.
const prEsc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
// Where the times come from, as written under the summary ("Times come from ...").
const SOURCE = { target: "your target time", runs: "your reference runs", estimate: "a generic estimate (add a target time to adjust)" };

/**
 * Hero text and file drop for the mode (shown only in Prep my run).
 * `peak` is the logo's HTML, passed in by main.js. Returns an HTML string. The "prep-only" class
 * lets style.css hide these blocks in the other modes.
 */
export function prepHeroHtml(peak) {
  return `<div class="hero-row prep-only">
      <div>
        <div class="brand">${peak}Prep my race <span class="brand-desc">Trail race &amp; run planner</span></div>
        <h1 style="margin-top:14px">Prep it up,<br><em>get it done.</em></h1>
        <p class="lead">Step out knowing what is coming, and wanting it. Drop the GPX of your next run: the planner reads every climb and descent, writes the messages your watch will show along the way (hike here, brake there, the key moments), lets you check and edit them, and gives the course back ready for your watch. Your file never leaves this page.</p>
      </div>
      <button class="btn primary" type="button" id="prepSample">Try a sample run</button>
    </div>
    <div class="drops prep-only">
      <div class="drop" id="dropPrep">
        <h3><span class="tag">GPX</span>Your run to come</h3>
        <p>The course you will follow, with elevation: from Garmin Connect, Strava, Komoot, a race website...</p>
        <div class="actions"><label class="btn ghost" for="filePrep">Choose GPX</label><input type="file" id="filePrep" accept=".gpx,application/gpx+xml,text/xml"></div>
        <div class="status" id="stPrep" aria-live="polite"></div>
      </div>
    </div>`;
}

/**
 * Wire the mode. getRuns() returns the reference runs loaded in Plan a race (parsed GPX) or [];
 * getSettings() the planner settings (start time, hiking threshold...); onLoaded() runs after each render.
 * cockpit(box, plan, key) draws the race-day cockpit (section bar, map, profile) in `box`; it is
 * main.js's own, so both modes look the same.
 * The `= {}` after the braces lets initPrepRun() be called with no argument at all.
 * Returns { rerender, current }: rerender() redraws with fresh settings, current() tells the
 * print export what is on screen.
 * Side effects: listens to the file input, the drop zone, the sample button and two page events.
 */
export function initPrepRun({ getRuns = () => [], getSettings = () => ({}), onLoaded = () => {}, cockpit = null } = {}) {
  // The mode's state, kept between renders (a closure: every function below sees the same `st`):
  //   parsed     the parsed GPX of the run to come ({ name, points, ... }), null before a drop
  //   name       the name shown (file name, or the GPX's own name)
  //   targetSec  target time typed by the runner, in seconds (0 = none)
  //   startTime  start time typed here ("HH:MM"), null = use the planner's setting
  //   plan       the last plan built, key its localStorage key for the watch messages,
  //   source     where its times came from ("target", "runs" or "estimate", see SOURCE)
  //   aiOn       the AI coach's session is shown (when there is one for this run)
  let aiOn = false;
  try { aiOn = localStorage.getItem("trp.ai.run.on") === "true"; } catch (e) { /* blocked: off */ }
  const st = { parsed: null, name: "", targetSec: 0, startTime: null, plan: null, key: "", source: "" };
  const $p = (s) => document.querySelector(s);
  // The cockpit (section bar, map, profile, run script) is the race-day one from main.js. Only one
  // can play at a time, so it is built when this mode is on screen and emptied when you leave it.
  // The current mode is stored as data-mode on the <html> element.
  const inMode = () => document.documentElement.dataset.mode === "prep";
  // With the AI switch on and a session that fits this run, the cockpit plays the AI plan (rebuilt
  // by code from the coach's answer, airace.js); the html class "ai-run-on" makes its values shine.
  const showCockpit = () => {
    const box = $p("#prepCockpit");
    if (!box || !cockpit || !st.plan) return;
    const ai = arState(st.plan, st.key, "prep_run");
    const on = aiOn && ai.state === "ok";
    document.documentElement.classList.toggle("ai-run-on", on && inMode());
    if (!inMode()) { box.innerHTML = ""; return; }
    const plan = on ? ai.result.plan : st.plan;
    const bar = $p("#prepAi");
    if (bar) bar.innerHTML = arBarHtml(ai, on, st.plan.scenarios.central.finishSec, plan.scenarios.central.finishSec);
    cockpit(box, plan, st.key);
  };
  // The switch and the edelweiss button (event delegation: the mode body is drawn again often).
  $p("#sPrepBody").addEventListener("click", (ev) => {
    const b = ev.target.closest("[data-ar]");
    if (!b) return;
    if (b.dataset.ar === "ask") { acctOpenRunAsk(); return; }
    aiOn = b.dataset.ar === "ai";
    try { localStorage.setItem("trp.ai.run.on", String(aiOn)); } catch (e) { /* kept for this visit */ }
    trackEvent("ai-switch", `run-${b.dataset.ar}`);
    showCockpit();
  });
  // A Prep my run AI doc to play (a new answer, or one picked in the AI docs): switch AI on.
  document.addEventListener("trp-ai-use", (ev) => {
    if (!ev.detail || ev.detail.mode !== "prep_run") return;
    arUse(ev.detail);
    aiOn = true;
    try { localStorage.setItem("trp.ai.run.on", "true"); } catch (e) { /* kept for this visit */ }
    showCockpit();
  });
  // main.js announces a mode switch and a theme switch with these custom events on `document`.
  document.addEventListener("trp-mode", showCockpit);
  document.addEventListener("trp-theme", showCockpit); // redraw so the map takes the new tiles

  /**
   * Read a GPX (its text `xml`), keep it, and draw the mode. `label` is the name to show.
   * On a bad file, parseGpx throws an Error and its message is shown under the drop zone.
   */
  const load = (xml, label) => {
    try {
      const parsed = parseGpx(xml);
      st.parsed = parsed;
      st.name = label || parsed.name || "My run";
      $p("#stPrep").innerHTML = `<span class="ok">✓ ${prEsc(st.name)}</span>`;
      $p("#dropPrep").classList.add("done");
      trackEvent("gpx-upload", "prep");
      render();
      $p("#s-prep").scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (e) {
      $p("#stPrep").innerHTML = `<span class="err">${prEsc(e.message)}</span>`;
      trackEvent("gpx-error", "prep");
    }
  };

  /**
   * Build the plan for the loaded course, choosing the time source in the order given at the top
   * of the file. Returns { plan, source }.
   * With reference runs and no target: the full race planner (buildPlan), with no aid stations.
   * Otherwise: the light prepRunPlan (Tobler's estimate, stretched to the target if there is one).
   */
  const planFor = () => {
    const runs = getRuns();
    const settings = getSettings();
    // a || b || c takes the first value that is not empty (null, undefined or "" count as empty).
    const startTime = st.startTime || settings.startTime || "09:00";
    if (!st.targetSec && runs.length) {
      try {
        // { ...settings, startTime, aidStations: "" } copies the settings and overrides two fields.
        const plan = buildPlan(st.parsed, runs, { ...settings, startTime, aidStations: "" });
        return { plan, source: "runs" };
      } catch (e) { /* a run too short or without time: fall back to the estimate */ }
    }
    const plan = prepRunPlan(st.parsed, { targetSec: st.targetSec, startTime, hikeGrade: settings.hikeGrade });
    return { plan, source: plan.timeSource };
  };

  /**
   * Draw the whole mode body (#sPrepBody) for the loaded course: summary with target and start
   * time, the cockpit, the watch messages and the download buttons; then wire them.
   * Called after a drop, and again whenever the target or start time changes.
   */
  const render = () => {
    if (!st.parsed) return;
    const { plan, source } = planFor();
    // Prep my run shows one scenario only: the central one.
    const sid = "central";
    const finish = plan.scenarios[sid].finishSec;
    // localStorage key of the watch-message edits: one per run name and length, so edits on
    // one course never land on another.
    const key = `trp.watch.prep.${st.name}.${plan.course.totalKm.toFixed(1)}`;
    const body = $p("#sPrepBody");
    // The target time box shows the current estimate as a hint ("3h05" -> "3:05").
    body.innerHTML = `
  <div class="panel prep-sum prep-ready">
    <div class="side-stack">${pimpBadge("#prep-pimp", "Your run on your watch →")}${acctAiBadge("run")}</div>
    <div class="prep-facts"><b>${prEsc(st.name)}</b><span>${plan.course.totalKm.toFixed(1)} km</span><span>+${Math.round(plan.course.gain)} m</span><span>-${Math.round(plan.course.loss)} m</span><span>${plan.climbs.length} climbs</span><span>${(plan.keyZones || []).length} key zones</span><span>about <b>${hm(finish)}</b></span></div>
    <p class="note">Times come from ${SOURCE[source]}.</p>
    <div class="prep-opts">
      <label class="f">Target time (h:mm)<input type="text" id="prepTarget" inputmode="numeric" placeholder="${hm(finish).replace("h", ":")}" value="${st.targetSec ? hm(st.targetSec).replace("h", ":") : ""}"></label>
      <label class="f">Start time<input type="time" id="prepStart" value="${prEsc(st.startTime || getSettings().startTime || "09:00")}"></label>
    </div>
  </div>

  <div class="sub-h">Your run, section by section</div>
  <div id="prepAi"></div>
  <div id="prepCockpit"></div>

  <div class="sub-h" id="prep-pimp">◆ Pimp my GPX · watch messages</div>
  <div id="prepWatch">${watchPanelHtml(plan)}</div>

  <div class="sub-h">Your pimped GPX</div>
  <div class="actions">
    <button class="btn primary" id="prepFit" type="button">Garmin course (.fit)</button>
    <button class="btn" id="prepGpx" type="button">GPX with messages</button>
    <span class="status" id="prepStat" aria-live="polite"></span>
  </div>
  <p class="note">Import the .fit in Garmin Connect (Courses, Import) or copy it to the watch's GARMIN/NewFiles folder, then follow the course: the watch shows each message as you reach it. The GPX works with other brands too.</p>`;
    // say(text): show a short status or error message next to the download buttons.
    const say = (t) => { $p("#prepStat").textContent = t; };
    mountWatch($p("#prepWatch"), { plan, sid, key, say });
    st.plan = plan; st.key = key; st.source = source;
    showCockpit();
    $p("#sPrepBody .pimp-link").addEventListener("click", () => trackEvent("nav", "pimp-badge-prep"));
    // Target time typed as h:mm. parseDuration returns seconds, or null when it cannot read it.
    // An empty box clears the target (0).
    $p("#prepTarget").addEventListener("change", (ev) => {
      const v = ev.target.value.trim();
      const t = v ? parseDuration(v, false) : 0;
      if (t === null) { say("Type the target as h:mm, for example 3:30."); return; }
      st.targetSec = t; trackEvent("prep-target", v ? "set" : "clear"); render();
    });
    $p("#prepStart").addEventListener("change", (ev) => { st.startTime = ev.target.value || null; render(); });
    // Build and download the course file with the (possibly edited) watch messages. suffix ""
    // keeps the scenario name out of the file name. Errors are shown, not thrown.
    const save = (kind) => {
      try { say(`Saved ${downloadCourse(kind, { plan, sid, track: st.parsed.points, name: st.name, points: watchPoints(plan, sid, key), suffix: "" })}.`); }
      catch (e) { say(`Could not make the course: ${e.message}`); }
    };
    $p("#prepFit").addEventListener("click", () => save("fit"));
    $p("#prepGpx").addEventListener("click", () => save("gpx"));
    onLoaded();
  };

  // Two ways to give a file: the "Choose GPX" button (file input) or drag-and-drop on the box.
  // f.text() reads the file as text and returns a Promise; .then() runs once it is read. The
  // name shown is the file name without ".gpx" (regex: ".gpx" at the end, any case, flag i).
  const file = $p("#filePrep");
  file.addEventListener("change", () => {
    const f = file.files && file.files[0];
    if (f) f.text().then((xml) => load(xml, f.name.replace(/\.gpx$/i, "")));
  });
  const drop = $p("#dropPrep");
  // preventDefault() on dragover tells the browser this box accepts a drop (otherwise the
  // browser would open the file itself). The "over" class highlights the box meanwhile.
  drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("over"));
  drop.addEventListener("drop", (e) => {
    e.preventDefault(); drop.classList.remove("over");
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) f.text().then((xml) => load(xml, f.name.replace(/\.gpx$/i, "")));
  });
  // Sample button: a made-up 30 km loop built in demo.js (starting at 650 m, centred near
  // latitude 45.05, longitude 5.7), loaded exactly like a dropped file.
  $p("#prepSample").addEventListener("click", () => {
    trackEvent("prep-sample", "long run");
    load(makeDemoRaceGpx(DEMO_LONG_RUN_PROFILE, { name: "Sample long run 30K", startEle: 650, loop: true, center: [45.05, 5.7] }), "Sample long run 30K (made up)");
  });
  // current(): what is on screen, for the A4 export (ui/print.js); null before a GPX is loaded.
  // spots and key: for the Ask the AI coach window (account.js), which files its answer by key.
  return { rerender: render, current: () => (st.plan ? { plan: st.plan, name: st.name, source: st.source, key: st.key, spots: runSpots(st.plan).filter((x) => x.kind !== "caution").length } : null) };
}
