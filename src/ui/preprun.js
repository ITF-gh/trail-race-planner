// preprun.js (ui): the "Prep my run" mode. Drop the GPX of a run to come; the planner reads the
// course (climbs, descents, key zones), shows it like race day (section bar, map, profile, script),
// proposes the watch messages, lets you check and edit them, and gives the course back as a
// Garmin .fit or a .gpx with the messages on it.
//
// Time along the course, used to space the messages and show when you reach each one:
//   your target time if you give one (the estimate stretched to land on it), otherwise
//   your reference runs if Plan a race has some loaded (your own pace on every gradient), otherwise
//   a generic estimate from Tobler's hiking function.

import { parseGpx } from "../core/track.js";
import { buildPlan } from "../core/plan.js";
import { prepRunPlan } from "../core/preprun.js";
import { hm, parseDuration } from "../core/format.js";
import { makeDemoRaceGpx, DEMO_LONG_RUN_PROFILE } from "../demo.js";
import { watchPanelHtml, mountWatch, watchPoints, downloadCourse, pimpBadge } from "./watch.js";
import { trackEvent } from "./analytics.js";

const prEsc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const SOURCE = { target: "your target time", runs: "your reference runs", estimate: "a generic estimate (add a target time to adjust)" };

/** Hero text and file drop for the mode (shown only in Prep my run). */
export function prepHeroHtml(peak) {
  return `<div class="hero-row prep-only">
      <div>
        <div class="brand">${peak}Trail Race Planner · Prep my run</div>
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
 */
export function initPrepRun({ getRuns = () => [], getSettings = () => ({}), onLoaded = () => {}, cockpit = null } = {}) {
  const st = { parsed: null, name: "", targetSec: 0, startTime: null, plan: null, key: "", source: "" };
  const $p = (s) => document.querySelector(s);
  // The cockpit (section bar, map, profile, run script) is the race-day one from main.js. Only one
  // can play at a time, so it is built when this mode is on screen and emptied when you leave it.
  const inMode = () => document.documentElement.dataset.mode === "prep";
  const showCockpit = () => {
    const box = $p("#prepCockpit");
    if (!box || !cockpit || !st.plan) return;
    if (inMode()) cockpit(box, st.plan, st.key); else box.innerHTML = "";
  };
  document.addEventListener("trp-mode", showCockpit);
  document.addEventListener("trp-theme", showCockpit); // redraw so the map takes the new tiles

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

  const planFor = () => {
    const runs = getRuns();
    const settings = getSettings();
    const startTime = st.startTime || settings.startTime || "09:00";
    if (!st.targetSec && runs.length) {
      try {
        const plan = buildPlan(st.parsed, runs, { ...settings, startTime, aidStations: "" });
        return { plan, source: "runs" };
      } catch (e) { /* a run too short or without time: fall back to the estimate */ }
    }
    const plan = prepRunPlan(st.parsed, { targetSec: st.targetSec, startTime, hikeGrade: settings.hikeGrade });
    return { plan, source: plan.timeSource };
  };

  const render = () => {
    if (!st.parsed) return;
    const { plan, source } = planFor();
    const sid = "central";
    const finish = plan.scenarios[sid].finishSec;
    const key = `trp.watch.prep.${st.name}.${plan.course.totalKm.toFixed(1)}`;
    const body = $p("#sPrepBody");
    body.innerHTML = `
  <div class="panel prep-sum prep-ready">
    ${pimpBadge("#prep-pimp", "Your run on your watch →")}
    <div class="prep-facts"><b>${prEsc(st.name)}</b><span>${plan.course.totalKm.toFixed(1)} km</span><span>+${Math.round(plan.course.gain)} m</span><span>-${Math.round(plan.course.loss)} m</span><span>${plan.climbs.length} climbs</span><span>${(plan.keyZones || []).length} key zones</span><span>about <b>${hm(finish)}</b></span></div>
    <p class="note">Times come from ${SOURCE[source]}.</p>
    <div class="prep-opts">
      <label class="f">Target time (h:mm)<input type="text" id="prepTarget" inputmode="numeric" placeholder="${hm(finish).replace("h", ":")}" value="${st.targetSec ? hm(st.targetSec).replace("h", ":") : ""}"></label>
      <label class="f">Start time<input type="time" id="prepStart" value="${prEsc(st.startTime || getSettings().startTime || "09:00")}"></label>
    </div>
  </div>

  <div class="sub-h">Your run, section by section</div>
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
    const say = (t) => { $p("#prepStat").textContent = t; };
    mountWatch($p("#prepWatch"), { plan, sid, key, say });
    st.plan = plan; st.key = key; st.source = source;
    showCockpit();
    $p("#sPrepBody .pimp-link").addEventListener("click", () => trackEvent("nav", "pimp-badge-prep"));
    $p("#prepTarget").addEventListener("change", (ev) => {
      const v = ev.target.value.trim();
      const t = v ? parseDuration(v, false) : 0;
      if (t === null) { say("Type the target as h:mm, for example 3:30."); return; }
      st.targetSec = t; trackEvent("prep-target", v ? "set" : "clear"); render();
    });
    $p("#prepStart").addEventListener("change", (ev) => { st.startTime = ev.target.value || null; render(); });
    const save = (kind) => {
      try { say(`Saved ${downloadCourse(kind, { plan, sid, track: st.parsed.points, name: st.name, points: watchPoints(plan, sid, key), suffix: "" })}.`); }
      catch (e) { say(`Could not make the course: ${e.message}`); }
    };
    $p("#prepFit").addEventListener("click", () => save("fit"));
    $p("#prepGpx").addEventListener("click", () => save("gpx"));
    onLoaded();
  };

  const file = $p("#filePrep");
  file.addEventListener("change", () => {
    const f = file.files && file.files[0];
    if (f) f.text().then((xml) => load(xml, f.name.replace(/\.gpx$/i, "")));
  });
  const drop = $p("#dropPrep");
  drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("over"));
  drop.addEventListener("drop", (e) => {
    e.preventDefault(); drop.classList.remove("over");
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) f.text().then((xml) => load(xml, f.name.replace(/\.gpx$/i, "")));
  });
  $p("#prepSample").addEventListener("click", () => {
    trackEvent("prep-sample", "long run");
    load(makeDemoRaceGpx(DEMO_LONG_RUN_PROFILE, { name: "Sample long run 30K", startEle: 650, loop: true, center: [45.05, 5.7] }), "Sample long run 30K (made up)");
  });
  // current(): what is on screen, for the A4 export (ui/print.js); null before a GPX is loaded.
  return { rerender: render, current: () => (st.plan ? { plan: st.plan, name: st.name, source: st.source } : null) };
}
