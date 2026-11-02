// route.js: sections 01 Your engine (renderEngine) and 02 Your route (renderBriefing) of Prep my race.

import { briefCourse, PLAN_DEFAULTS, parseAidStations } from "../core/plan.js";
import { starChip } from "./chips.js";
import { mmss } from "../core/format.js";
import { keyZones, toblerClock } from "../core/keyzones.js";
import { courseMap } from "./map.js";
import { trackEvent } from "./analytics.js";
import { $, state, esc } from "./appstate.js";
import { empty, tile, jumps, segListHtml, wireSegTabs, mapStyle, profileView, elevAt } from "./pieces.js";

/* ---------- 01 your engine ---------- */
/** Section 01 Engine: what your own runs say about you. */
export function renderEngine() {
  const box = $("#s1body");
  if (!state.effort) { box.innerHTML = empty(`<b>Drop one of your runs above</b> (or press Try the demo) to see your pace on every gradient.`); return; }
  const e = state.effort.info;
  const bands = e.bands;
  // The band with the best climb rate (VAM, vertical metres per hour), counting only bands with a real climb rate (over 50 m/h) that were measured rather than estimated. sort() puts the highest first, [0] takes it...
  const steep = bands.filter((b) => b.vam && b.vam > 50 && b.source !== "estimated").sort((a, b) => b.vam - a.vam)[0];
  // The key figures are about how you move, not about the run itself (its length and duration say nothing without context): flat pace, cadence, a gentle and a steep climb, best climb rate. band(id)...
  const band = (id) => bands.find((b) => b.id === id);
  const fadeTxt = (b) => `tired ${mmss(b.tired)} · +${((b.tired / b.fresh - 1) * 100).toFixed(0)}%`;
  const gentle = band("u1"), steepB = band("u4");
  const tiles = [
    tile("Flat pace", `${mmss(e.flatPace)}<small>/km</small>`, e.runs.length > 1 ? `${e.runs.length} runs, weighted` : "on the flat"),
    tile("Cadence", e.flatCad ? `${Math.round(e.flatCad)}<small>spm</small>` : "–", e.cadenceWasPerFoot ? "doubled from per-foot" : "on the flat"),
    tile("Pace +2 to +6%", `${mmss(gentle.fresh)}<small>/km</small>`, fadeTxt(gentle)),
    tile("Pace +15 to +22%", `${mmss(steepB.fresh)}<small>/km</small>`, fadeTxt(steepB)),
    tile("Best climb rate", steep ? `${Math.round(steep.vam)}<small>m/h</small>` : "–", steep ? steep.label : "not enough climbing"),
  ].join("");
  // Bars are drawn as a share of the slowest pace on the page, so the longest bar fills the row.
  const maxPace = Math.max(...bands.map((b) => b.tired));
  const rows = bands.map((b) => {
    const fade = (b.tired / b.fresh - 1) * 100;
    return `<div class="pace ${b.source === "estimated" ? "est" : ""}">
      <div class="lab">${esc(b.label)}<small>${b.source}${b.hr ? ` · HR ${Math.round(b.hr)}` : ""}</small></div>
      <div class="bars"><i class="fr" style="width:${((b.fresh / maxPace) * 100).toFixed(1)}%"></i><i class="ti" style="width:${((b.tired / maxPace) * 100).toFixed(1)}%"></i></div>
      <div class="num"><b class="pf">${mmss(b.fresh)}</b><span class="pt">${mmss(b.tired)}</span><span class="pfade${fade >= 15 ? " hi" : ""}">+${fade.toFixed(0)}%</span></div>
    </div>`;
  }).join("");
  // Your runs and their weights show under the drop box at the top (setRuns), not here.
  box.innerHTML = `
    <div class="tiles">${tiles}</div>
    <div class="sub-h">Pace by gradient</div>
    <div class="panel compact">
      <div class="keyline"><span><i style="background:var(--accent)"></i>Fresh (first half of your run)</span><span><i style="background:color-mix(in srgb,var(--fg) 35%,transparent)"></i>Tired (second half)</span><span>Longer bar = slower. On the right: fresh pace, tired pace, how much you fade. Pace in min/km.</span></div>
      <div class="paces">${rows}</div>
      <p class="note">"Estimated" bands had under a minute of data in your run, so they use typical ratios to your flat pace.</p>
    </div>`;
}
// The two Leaflet maps currently shown.
let briefMap = null;

/** Section 02 Course: the race on its own, before knowing who runs it. */
export function renderBriefing() {
  const box = $("#s2body");
  if (briefMap) { briefMap.destroy(); briefMap = null; }
  if (!state.race) { box.innerHTML = empty(`<b>Drop the race GPX above</b> to get the course briefing.`); return; }
  // briefCourse (core/plan.js) lists the climbs and descents with their difficulty level.
  const brief = briefCourse(state.race.course, state.settings);
  const P = state.race.profile;
  const top = Math.max(...P.map((p) => p[1]));
  const tiles = [
    tile("Distance", `${brief.totalKm.toFixed(1)}<small>km</small>`),
    tile("Elevation gain", `${Math.round(brief.gain)}<small>m D+</small>`, `${Math.round(brief.loss)} m D−`),
    tile("Climbs", `${brief.climbs.filter((c) => !c.bump).length}`, `${brief.descents.length} descents`),
    tile("High point", `${Math.round(top)}<small>m</small>`),
    tile("Start time", esc(state.settings.startTime || PLAN_DEFAULTS.startTime), "set it below"),
  ].join("");
  const aid = parseAidStations(state.settings.aidStations).filter((a) => a.km <= brief.totalKm);
  // With a plan, the zones use your predicted times; before that, a typical runner's (Tobler's hiking function).
  const zones = state.plan ? state.plan.keyZones : keyZones(brief, P, aid, toblerClock(P));
  // A zoom window saved from a longer course no longer fits: forget it.
  if (state.bwin && state.bwin[1] > brief.totalKm) state.bwin = null;
  // Write the section. `hidden` on a tab's div hides it; the tab buttons below switch them.
  box.innerHTML = `
    ${jumps([["b-map", "Map and profile"], ["b-list", `Climbs and descents`]])}
    <div class="tiles">${tiles}</div>
    <div class="sub-h" id="b-map">Map and profile</div>
    <div class="b-map" id="briefMap"></div>
    <div class="prof-wrap b-prof" id="briefProf"><div class="prof-tools"><span class="note" style="margin:0">Drag across the profile to zoom: the map follows. Each climb shows whole, its badge gives its average gradient; hover or tap it for the figures.</span><button type="button" class="btn sm" id="profReset" hidden>Reset zoom</button></div><div id="briefProfSvg"></div><div class="prof-pop" id="profPop" hidden></div></div>
    <p class="note">Map and profile share their colours: climbs by difficulty, dashed red for descents to brake on, a yellow glow on the key zones (the details are in Your plan). Triangles are aid stations, numbers are km. Hover the profile to see where you are on the map.</p>
    <div class="sub-h" id="b-list">Climbs and descents</div>
    ${segListHtml(brief, P, state.btab, state.settings.splitClimbM)}`;
  wireSegTabs(box, (t) => { state.btab = t; trackEvent("briefing-tab", t === "c" ? "climbs" : "descents"); });

  // The map: the route coloured like the profile.
  briefMap = courseMap($("#briefMap"), { route: state.race.route, totalKm: brief.totalKm, ...mapStyle(brief, aid, zones, true) });
  // The profile, drawn for the whole course or for the zoom window.
  const drawProf = () => {
    const view = profileView(P, brief, null, zones, { win: state.bwin, inner: false, labels: true });
    const host = $("#briefProfSvg");
    host.innerHTML = view.html;
    $("#profReset").hidden = !state.bwin;
    const svg = host.querySelector("svg");
    const cur = svg.querySelector(".pcur");
    // kmAt(ev): the km under the pointer. getBoundingClientRect gives the SVG's size on screen in pixels; the pointer's share of that width, times 1000 (the viewBox width), is the SVG x.
    const kmAt = (ev) => { const b = svg.getBoundingClientRect(); return view.km(((ev.clientX - b.left) / b.width) * 1000); };
    // The selection rectangle shown while dragging.
    const sel = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    sel.setAttribute("class", "psel"); sel.setAttribute("y", String(view.top)); sel.setAttribute("height", String(view.base - view.top)); sel.style.display = "none";
    svg.appendChild(sel);
    // from: the km where the drag started, or null when no drag is going on.
    let from = null;
    // show(ev): move the cursor line and dot to the pointer, move the runner dot on the map to the same km, and during a drag stretch the selection from `from` to here.
    const pop = $("#profPop");
    const wrap = $("#briefProf");
    const tipAt = (ev) => {
      const t = ev.target.closest && ev.target.closest("[data-tip]");
      if (!t) { pop.hidden = true; return; }
      const [name, km, ln, up, avg, lv] = t.dataset.tip.split("|");
      pop.innerHTML = `<b>${name}</b> ${starChip(+lv)}<span>${km}</span><span>${ln}</span><span>${up}</span><span><b>${avg}</b> avg</span>`;
      pop.hidden = false;
      const w = wrap.getBoundingClientRect();
      pop.style.left = `${Math.min(w.width - pop.offsetWidth - 4, Math.max(4, ev.clientX - w.left - pop.offsetWidth / 2))}px`;
      pop.style.top = `${Math.max(4, ev.clientY - w.top - pop.offsetHeight - 14)}px`;
    };
    svg.addEventListener("pointerleave", () => { pop.hidden = true; });
    const show = (ev) => {
      if (from === null && ev.pointerType === "mouse") tipAt(ev);
      const km = kmAt(ev);
      cur.style.display = "";
      cur.setAttribute("transform", `translate(${view.x(km).toFixed(1)},0)`);
      cur.querySelector("circle").setAttribute("cy", view.y(elevAt(P, km)).toFixed(1));
      briefMap.setRunner(km);
      if (from !== null) {
        const a = Math.min(from, km), b = Math.max(from, km);
        sel.style.display = ""; sel.setAttribute("x", view.x(a).toFixed(1)); sel.setAttribute("width", Math.max(0, view.x(b) - view.x(a)).toFixed(1));
      }
    };
    // Pointer events cover mouse, pen and touch in one API. setPointerCapture keeps sending the events to the SVG even if the finger or mouse leaves it during the drag.
    svg.addEventListener("pointermove", show);
    svg.addEventListener("pointerdown", (ev) => { from = kmAt(ev); svg.setPointerCapture(ev.pointerId); show(ev); });
    svg.addEventListener("pointercancel", () => { from = null; sel.style.display = "none"; });
    svg.addEventListener("pointerup", (ev) => {
      if (from === null) return;
      const to = kmAt(ev), a = Math.min(from, to), b = Math.max(from, to);
      from = null; sel.style.display = "none";
      // A tap on a climb (touch screens have no hover) opens its pop-up.
      if (ev.pointerType !== "mouse") tipAt(ev);
      // A real drag (not a tap): at least 2% of what is on screen, and never under 300 m.
      if (b - a >= Math.max(0.3, (view.K1 - view.K0) * 0.02)) {
        state.bwin = [a, b];
        trackEvent("briefing-zoom");
        drawProf();
        briefMap.focus(a, b);
      }
    });
  };
  // Reset zoom: back to the whole course, and the map back to the whole route.
  $("#profReset").addEventListener("click", () => { state.bwin = null; drawProf(); briefMap.focus(null); briefMap.fit(); });
  drawProf();
  if (state.bwin) briefMap.focus(state.bwin[0], state.bwin[1]);
}
