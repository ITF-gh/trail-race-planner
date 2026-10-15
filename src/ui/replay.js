// replay.js: section 04, the race-day replay. Plays the plan back in time: a runner moves
// along the map and the elevation profile, the clock runs at the predicted pace, and every
// key moment (climbs, gels, aid stations, key zones) shows a short cue to rehearse.
//
// Animation: requestAnimationFrame calls `frame` before each screen refresh (about 60 times
// a second). Each frame moves race time forward by (real seconds since the last frame x
// speed), then redraws only what changed: a few text fields, the runner on the map and the
// cursor on the profile. Nothing is re-rendered from scratch while it plays.
//
// Sections: the course is cut into numbered sections (raceLegs: each climb or climb section,
// each descent, the runnable stretches between). The section you are on is lit up in three
// places at once (the bar of sections above the map, the map, the profile) and its targets fill
// the panel next to the map. Those only change when you enter a new section, so draw() compares
// the section number with the last one and touches the DOM only then.

import { raceScript, raceStateAt, secAtKm, raceLegs, raceTotals, legAtKm, gainLoss } from "../core/script.js";
import { courseMap } from "./map.js";
import { mmss, hm, clock } from "../core/format.js";
import { trackEvent, trackOnce } from "./analytics.js";

/**
 * The panel never scrolls: the "coming next" list keeps only the rows that fit in it.
 * Rows are shown again first, so a taller window gets them back.
 */
export function fitPanel(list) {
  const hud = list && list.closest(".rp-hud");
  if (!hud) return;
  const rows = [...list.children];
  rows.forEach((li) => { li.hidden = false; });
  const bottom = hud.getBoundingClientRect().bottom - parseFloat(getComputedStyle(hud).paddingBottom || 0);
  rows.forEach((li) => { if (li.getBoundingClientRect().bottom > bottom + 1) li.hidden = true; });
}

const escR = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const SPEEDS = [
  { v: 120, label: "1 h in 30 s" },
  { v: 360, label: "1 h in 10 s" },
  { v: 900, label: "1 h in 4 s" },
];
/** Altitude at `km` on the profile, linear between points. */
function eleOn(P, km) {
  let i = 1;
  while (i < P.length - 1 && P[i][0] < km) i++;
  const a = P[i - 1], b = P[i];
  return a[1] + Math.max(0, Math.min(1, (km - a[0]) / (b[0] - a[0] || 1))) * (b[1] - a[1]);
}
// Length and climb of a section, written out under its title.
const legData = (l) => `${(l.endKm - l.startKm).toFixed(1)} km · +${Math.round(l.up)} / −${Math.round(l.down)} m`;
const ICON = { start: "▶", climb: "▲", top: "⛰", descent: "▼", gel: "G", aid: "⛺", phase: "◐", key: "★", finish: "🏁" };

// Survives re-renders (a scenario switch, a settings change), so the replay keeps its place.
const rp = { key: "", sec: 0, playing: false, speed: 360, pauseAt: true, follow: true, raf: 0, map: null };

/**
 * Mount the replay in `box`. `prof` draws the profile: {html, x(km), y(ele)} in SVG units of a
 * viewBox 1000 wide, with a `.pcur` group to move. `mapPaint` / `mapMarks` style the route.
 */
export function mountReplay(box, { plan, sid, prof, mapPaint, mapMarks, key }) {
  stopReplay();
  if (rp.key !== key) { rp.key = key; rp.sec = 0; }
  const st = plan.startSec;
  const sc = plan.scenarios[sid];
  const script = raceScript(plan, sid);
  rp.sec = Math.min(rp.sec, sc.finishSec);
  const hasMap = Boolean(plan.course.route);
  const legs = raceLegs(plan, sid);
  const tot = raceTotals(plan, sid);
  const TOT_KM = plan.course.totalKm;
  const pct = (km) => `${((km / TOT_KM) * 100).toFixed(3)}%`;
  const legCls = (l) => `k-${l.kind}${l.kind === "flat" ? "" : ` l${l.level}`}`;
  const totTile = (k, v, sub, cls = "") => `<div class="rp-tot ${cls}"><span class="k">${k}</span><b>${v}</b>${sub ? `<small>${sub}</small>` : ""}</div>`;

  // Everything you need while it plays sits in one screen-high "cockpit": race targets, the
  // section bar, the map, the panel (clock, target vs now, cue), the profile and the controls.
  // CSS grid places them; the map takes whatever height is left, so it shrinks on small screens.
  box.innerHTML = `
  <div class="rp-cockpit${hasMap ? "" : " nomap"}" id="rpCockpit">
  <div class="rp-totals" aria-label="Race targets">
    ${totTile("Duration", hm(tot.durationSec), `${Math.round(tot.stopSec / 60)} min of stops`)}
    ${totTile("Distance", `${TOT_KM.toFixed(1)}<small>km</small>`, `${Math.round(tot.gain)} m D+ · ${legs.length} sections`)}
    ${totTile("Average pace", `${mmss(tot.paceSec)}<small>/km</small>`, `moving ${mmss(tot.movingPaceSec)}/km`)}
    ${totTile(`Finish · ${escR(sc.label.toLowerCase())}`, clock(st, tot.finishSec), `start ${clock(st, 0)}`)}
  </div>
  <div class="rp-legbar">
    <div class="rp-legs" id="rpLegs" role="group" aria-label="Race sections">${legs.map((l) => `<button type="button" class="lg ${legCls(l)}${l.keyZone ? " kz" : ""}" data-i="${l.i - 1}" style="left:${pct(l.startKm)};width:${pct(l.endKm - l.startKm)}" title="${l.i}. ${escR(l.title)} · ${escR(l.label)} · km ${l.startKm.toFixed(1)} → ${l.endKm.toFixed(1)}" aria-label="Section ${l.i}: ${escR(l.title)}"></button>`).join("")}
      ${plan.aidStations.map((a) => `<i class="lg-aid" style="left:${pct(a.km)}" title="${escR(a.name)}"></i>`).join("")}
      <i class="lg-pos" id="rpLegPos"></i>
    </div>
    <div class="rp-legfoot">
      <div class="rp-legnow" id="rpLegNow" aria-live="polite"></div>
      <div class="rp-legend" aria-label="Legend"><span><i class="sw l1"></i>Easy</span><span><i class="sw l2"></i>Moderate</span><span><i class="sw l3"></i>Hard</span><span><i class="sw l4"></i>Crux</span><span><i class="sw fl"></i>Runnable</span><span><i class="sw ds"></i>Descent</span><span><i class="sw ds4"></i>Brake</span><span><i class="sw kz"></i>Key zone</span><span><i class="sw ad"></i>Aid</span></div>
    </div>
  </div>
    ${hasMap ? `<div class="rp-map" id="rpMap"></div>` : ""}
    <div class="panel rp-hud">
      <div class="rp-top">
        <div class="rp-clock"><span class="k">Clock</span><b id="rpClock"></b></div>
        <div class="rp-run"><span id="rpElapsed"></span><span id="rpKm"></span></div>
      </div>
      <div class="rp-prog" aria-hidden="true"><i id="rpBar"></i></div>
      <div class="rp-leg" id="rpLeg"></div>
      <div class="rp-now" id="rpNow" hidden></div>
      <div class="rp-cue" id="rpCue" aria-live="polite"></div>
      <ul class="kv rp-next" id="rpNext"></ul>
    </div>
  <div class="prof-wrap rp-prof" id="rpProf">${prof.html}</div>
  <div class="rp-controls">
    <button class="btn icon" type="button" id="rpPrev" aria-label="Previous moment" title="Previous moment (←)">⏮</button>
    <button class="btn primary rp-play" type="button" id="rpPlay"></button>
    <button class="btn icon" type="button" id="rpNextBtn" aria-label="Next moment" title="Next moment (→)">⏭</button>
    <input type="range" id="rpSeek" min="0" max="${Math.round(sc.finishSec)}" step="10" aria-label="Race time">
    <label class="f inline">Speed<select id="rpSpeed" aria-label="Replay speed">${SPEEDS.map((s) => `<option value="${s.v}" ${s.v === rp.speed ? "selected" : ""}>${s.label}</option>`).join("")}</select></label>
    <label class="chk"><input type="checkbox" id="rpPause" ${rp.pauseAt ? "checked" : ""}> Stop at each moment</label>
    ${hasMap ? `<label class="chk"><input type="checkbox" id="rpFollow" ${rp.follow ? "checked" : ""}> Follow the runner</label>` : ""}
  </div>
  </div>
  <div class="sub-h" id="rp-script">Race script · ${script.length} moments</div>
  <ol class="rp-script" id="rpScript">${script.map((e, i) => `<li data-i="${i}" class="k-${e.kind} lv${e.level}"><button type="button"><span class="ic">${ICON[e.kind] || "•"}</span><span class="t"><b>${escR(e.title)}</b><small>km ${e.km.toFixed(1)} · ${clock(st, e.sec)}</small></span><span class="cue">${escR(e.cue)}</span></button></li>`).join("")}</ol>`;

  const $r = (s) => box.querySelector(s);
  const els = { leg: $r("#rpLeg"), legNow: $r("#rpLegNow"), legPos: $r("#rpLegPos"), legBtns: [...box.querySelectorAll("#rpLegs .lg")], clock: $r("#rpClock"), el: $r("#rpElapsed"), bar: $r("#rpBar"), km: $r("#rpKm"), now: $r("#rpNow"), next: $r("#rpNext"), cue: $r("#rpCue"), play: $r("#rpPlay"), seek: $r("#rpSeek"), cur: $r("#rpProf .pcur"), list: $r("#rpScript") };
  // A window resize changes the room in the panel: fit the "coming next" list again.
  if (typeof ResizeObserver === "function") new ResizeObserver(() => fitPanel(els.next)).observe($r(".rp-hud"));
  if (hasMap) {
    rp.map = courseMap($r("#rpMap"), { route: plan.course.route, totalKm: plan.course.totalKm, paint: mapPaint, marks: mapMarks });
    rp.map.follow(rp.follow && rp.sec > 0);
  }

  // Profile: a soft band over the section you are on, and a glow drawn UNDER the coloured line
  // (inserted right after the area fill), so the section keeps its own colours and only shines.
  const svgEl = $r("#rpProf svg");
  const P = plan.course.profile;
  const linePts = (a, b) => {
    const pts = [[a, eleOn(P, a)], ...P.filter((p) => p[0] > a && p[0] < b), [b, eleOn(P, b)]];
    return pts.map((p, i) => `${i ? "L" : "M"}${prof.x(p[0]).toFixed(1)},${prof.y(p[1]).toFixed(1)}`).join("");
  };
  let legG = null;
  let glowG = null;
  if (svgEl && els.cur) {
    const NS = "http://www.w3.org/2000/svg";
    legG = document.createElementNS(NS, "g");
    legG.setAttribute("class", "pleg");
    svgEl.insertBefore(legG, els.cur);
    glowG = document.createElementNS(NS, "g");
    glowG.setAttribute("class", "pglow");
    const area = svgEl.querySelector(".area");
    svgEl.insertBefore(glowG, area ? area.nextSibling : svgEl.firstChild);
    // The hover pop-up says it all: no native tooltips on top of it.
    svgEl.querySelectorAll("title").forEach((t) => t.remove());
  }
  const drawLeg = (li) => {
    const l = legs[li];
    const n = legs[li + 1] || null;
    const band = (x, cls) => `<rect class="${cls}" x="${prof.x(x.startKm).toFixed(1)}" y="${prof.top - 4}" width="${Math.max(2, prof.x(x.endKm) - prof.x(x.startKm)).toFixed(1)}" height="${prof.base - prof.top + 4}"/>`;
    if (legG) {
      const lx = (prof.x(l.startKm) + prof.x(l.endKm)) / 2;
      legG.innerHTML = band(l, "pl-cur") + `<text class="pl-t" x="${lx.toFixed(1)}" y="${prof.base - 6}" text-anchor="middle">${l.i}</text>`;
      glowG.innerHTML = `<path class="pl-glow" d="${linePts(l.startKm, l.endKm)}"/>`;
    }
    // On a phone the profile is wider than the screen: bring the section into view.
    if (profScroll && profScroll.scrollWidth > profScroll.clientWidth + 4) {
      const k = profScroll.scrollWidth / 1000;
      const mid = ((prof.x(l.startKm) + prof.x((n || l).endKm)) / 2) * k;
      profScroll.scrollLeft = Math.max(0, mid - profScroll.clientWidth / 2);
    }
    if (rp.map) rp.map.highlight({ fromKm: l.startKm, toKm: l.endKm });
    els.legBtns.forEach((b, k) => { b.classList.toggle("on", k === li); b.classList.toggle("past", k < li); b.classList.toggle("nx", k === li + 1); });
  };
  const gradeTxt = (l) => `${l.avg > 0 ? "+" : ""}${l.avg.toFixed(1)}%`;
  // A runnable stretch says so in its title already: no chip repeating it.
  const legChip = (l) => (l.kind === "flat" ? "" : `<span class="chip l${l.level}">${escR(l.label)}</span>`);
  const profScroll = $r("#rpProf .prof-scroll");

  let lastLeg = -1;
  let lastCue = -1;
  let lastNowHtml = "";
  let lastNextHtml = "";
  const draw = () => {
    const s = raceStateAt(plan, sid, rp.sec);
    els.clock.textContent = clock(st, s.sec);
    els.el.textContent = `${hm(s.sec)} on course · ${Math.round(s.frac * 100)}%`;
    els.bar.style.width = `${(s.frac * 100).toFixed(2)}%`;
    els.km.textContent = `km ${s.km.toFixed(1)} / ${plan.course.totalKm.toFixed(1)}`;
    els.seek.value = Math.round(s.sec);
    // The section you are on: lit up everywhere when it changes, its countdown on every frame.
    const li = legAtKm(legs, s.km);
    const l = legs[li];
    if (li !== lastLeg) {
      lastLeg = li;
      drawLeg(li);
      const n = legs[li + 1];
      els.leg.className = `rp-leg k-${l.kind} lv${l.level}`;
      // Target (the plan for this section) next to Now (where the replay is): the Now column is
      // filled on every frame, the rest only when the section changes.
      const row = (k, target, id) => `<tr><th>${k}</th><td>${target}</td><td class="now" ${id ? `id="${id}"` : ""}>${id ? "" : "–"}</td></tr>`;
      els.leg.innerHTML = `
        <div class="rp-leg-h"><span class="rp-leg-n"><small>Section</small><b>${l.i}</b><small>/ ${legs.length}</small></span>
          <span class="rp-leg-t"><b>${escR(l.title)}</b>${legChip(l)}${l.keyZone ? ` <span class="chip keyc">★ Key zone ${l.keyZone.n}</span>` : ""}
          </span></div>
        <div class="rp-leg-info">
          <p class="k-${l.kind}"><span class="ic">${ICON[l.kind] || "➜"}</span><b title="${escR(l.tactic)}">${escR(l.tactic)}</b><span class="d">${legData(l)}</span></p>
          <p class="nx ${n ? `k-${n.kind}` : ""}"><span class="lab">Next</span>${n ? `<span class="ic">${ICON[n.kind] || "➜"}</span><b>${n.i}. ${escR(n.title)}</b><span class="d">${legData(n)}</span>` : `<span class="ic">${ICON.finish}</span><b>Finish</b>`}</p>
        </div>
        <table class="rp-tg">
          <thead><tr><th></th><th>Target</th><th class="now">Now</th></tr></thead>
          <tbody>
            ${row("Pace", l.pace ? `${mmss(l.pace)}/km` : "–", "tnPace")}
            ${row("Gradient", `${gradeTxt(l)} <small>avg</small>`, "tnGrade")}
            ${row("Elevation done", `+${Math.round(l.up)} / −${Math.round(l.down)} m`, "tnEle")}
            ${row("Section done", `${l.km.toFixed(2)} km`, "tnPct")}
            ${row("Section time", hm(l.durSec), "tnTime")}
          </tbody>
        </table>`;
      els.tn = Object.fromEntries(["Pace", "Grade", "Ele", "Pct", "Time"].map((k) => [k, els.leg.querySelector(`#tn${k}`)]));
      lastNextHtml = ""; // the card changed height: fit the list below it again
    }
    const leftKm = Math.max(0, l.endKm - s.km);
    const leftSec = Math.max(0, l.endSec - s.sec);
    els.legNow.innerHTML = `<b>Section ${l.i}/${legs.length}</b> · ${escR(l.title)} ${legChip(l)} <span class="left">${leftKm.toFixed(1)} km · ${leftSec >= 3600 ? hm(leftSec) : `${Math.round(leftSec / 60)} min`} to go in it</span>`;
    els.legPos.style.left = `${(s.frac * 100).toFixed(2)}%`;
    const inMin = Math.max(0, Math.round((s.sec - l.startSec) / 60));
    els.tn.Pace.textContent = s.pace ? `${mmss(s.pace)}/km` : "stopped";
    els.tn.Grade.textContent = s.aid ? "–" : `${s.grade > 0 ? "+" : ""}${s.grade.toFixed(0)}%`;
    // Climbed and dropped since the section started, against what the whole section holds.
    const done = gainLoss(P, l.startKm, Math.max(l.startKm, Math.min(l.endKm, s.km)));
    els.tn.Ele.textContent = `+${Math.round(done.up)} / −${Math.round(done.down)} m`;
    const pct = l.km > 0 ? Math.round((Math.min(l.km, Math.max(0, s.km - l.startKm)) / l.km) * 100) : 100;
    els.tn.Pct.innerHTML = `${pct}% <small>${leftKm.toFixed(1)} km left</small>`;
    els.tn.Time.innerHTML = `${inMin} min <small>${leftSec >= 3600 ? hm(leftSec) : `${Math.round(leftSec / 60)} min`} left</small>`;
    els.play.innerHTML = rp.playing ? "❚❚ Pause" : rp.sec >= sc.finishSec ? "↺ Replay" : rp.sec > 0 ? "▶ Resume" : "▶ Play race day";

    // The section card says what you are on; this line only flags a stop or the finish.
    let now = "";
    if (s.aid) now = `<span class="chip aidc">Aid station</span> <b>${escR(s.aid.name)}</b> · out at ${clock(st, s.aid.arrive[sid] + s.aid.stopMin * 60)}`;
    else if (s.sec >= sc.finishSec) now = `<span class="chip l1">Done</span> <b>Finished</b> · ${hm(sc.finishSec)}`;
    if (now !== lastNowHtml) { els.now.innerHTML = now; els.now.hidden = !now; lastNowHtml = now; }

    const until = (sec) => { const m = Math.max(0, Math.round((sec - s.sec) / 60)); return m >= 60 ? hm(m * 60) : `${m} min`; };
    const next = [
      s.keyZone ? `<li class="key"><span>★ Key zone ${s.keyZone.n}</span><b>until km ${s.keyZone.toKm.toFixed(1)}</b></li>` : s.nextKey ? `<li><span>Next key zone · ${s.nextKey.n}</span><b>km ${s.nextKey.fromKm.toFixed(1)} · ${clock(st, secAtKm(plan, sid, s.nextKey.fromKm))}</b></li>` : "",
      s.nextGel ? `<li><span>Next gel</span><b>in ${until(s.nextGel.sec)} · km ${s.nextGel.km.toFixed(1)}</b></li>` : "",
      s.nextAid ? `<li><span>Next aid · ${escR(s.nextAid.name)}</span><b>${(s.nextAid.km - s.km).toFixed(1)} km · ${clock(st, s.nextAid.arrive[sid])}</b></li>` : "",
      s.nextClimb ? `<li><span>Next climb · #${s.nextClimb.n}</span><b>${Math.round(s.nextClimb.gain)} m · in ${until(s.nextClimb.start[sid])}</b></li>` : "",
    ].join("") || `<li><span>Nothing left but the finish</span><b></b></li>`;
    if (next !== lastNextHtml) { els.next.innerHTML = next; lastNextHtml = next; fitPanel(els.next); }

    // The cue on screen is the latest moment reached.
    let ci = -1;
    for (let i = 0; i < script.length && script[i].sec <= s.sec + 0.5; i++) ci = i;
    if (ci !== lastCue) {
      lastCue = ci;
      const e = script[Math.max(0, ci)];
      els.cue.className = `rp-cue k-${e.kind} lv${e.level}`;
      els.cue.title = e.cue;
      els.cue.innerHTML = `<span class="ic">${ICON[e.kind] || "•"}</span><div><div class="rp-cue-h"><b>${escR(e.title)}</b><small>km ${e.km.toFixed(1)} · ${clock(st, e.sec)}</small></div><p>${escR(e.cue)}</p></div>`;
      els.list.querySelectorAll("li").forEach((li) => { li.classList.toggle("on", Number(li.dataset.i) === ci); li.classList.toggle("past", Number(li.dataset.i) < ci); });
    }
    if (els.cur) {
      els.cur.style.display = "";
      els.cur.setAttribute("transform", `translate(${prof.x(s.km).toFixed(1)},0)`);
      els.cur.querySelector("circle").setAttribute("cy", prof.y(s.ele).toFixed(1));
    }
    if (rp.map) rp.map.setRunner(s.km);
  };

  const frame = (now) => {
    if (!rp.playing) return;
    const dt = Math.min(0.25, (now - (rp.last || now)) / 1000);
    rp.last = now;
    const prev = rp.sec;
    let next = Math.min(sc.finishSec, prev + dt * rp.speed);
    if (rp.pauseAt) {
      const hit = script.find((e) => e.sec > prev + 0.5 && e.sec <= next);
      if (hit) { next = hit.sec + 1; rp.playing = false; els.cue.classList.add("pulse"); }
    }
    rp.sec = next;
    if (rp.sec >= sc.finishSec) rp.playing = false;
    draw();
    if (rp.playing) rp.raf = requestAnimationFrame(frame);
  };
  const play = () => {
    if (rp.sec >= sc.finishSec) rp.sec = 0;
    rp.playing = true;
    rp.last = 0;
    els.cue.classList.remove("pulse");
    if (rp.map && rp.follow) rp.map.follow(true);
    rp.raf = requestAnimationFrame(frame);
    draw();
  };
  const pause = () => { rp.playing = false; cancelAnimationFrame(rp.raf); draw(); };
  const seek = (sec) => { rp.sec = Math.max(0, Math.min(sc.finishSec, sec)); els.cue.classList.remove("pulse"); draw(); };
  const jump = (dir) => {
    const list = dir > 0 ? script.filter((e) => e.sec > rp.sec + 0.5) : script.filter((e) => e.sec < rp.sec - 1.5).reverse();
    if (list[0]) { pause(); seek(list[0].sec + 1); }
  };

  els.play.addEventListener("click", () => { trackEvent(rp.playing ? "replay-pause" : "replay-play"); rp.playing ? pause() : play(); });
  $r("#rpPrev").addEventListener("click", () => { trackEvent("replay-step", "prev"); jump(-1); });
  $r("#rpNextBtn").addEventListener("click", () => { trackEvent("replay-step", "next"); jump(1); });
  els.seek.addEventListener("input", () => seek(Number(els.seek.value)));
  els.seek.addEventListener("change", () => trackEvent("replay-seek"));
  $r("#rpSpeed").addEventListener("change", (e) => { rp.speed = Number(e.target.value); trackEvent("replay-speed", e.target.value); });
  $r("#rpPause").addEventListener("change", (e) => { rp.pauseAt = e.target.checked; trackEvent("replay-pause-at", e.target.checked ? "on" : "off"); });
  const fol = $r("#rpFollow");
  if (fol) fol.addEventListener("change", (e) => { rp.follow = e.target.checked; trackEvent("replay-follow", rp.follow ? "on" : "off"); if (rp.map) rp.map.follow(rp.follow); });
  // A click on a section of the bar jumps there and opens a pop-up with its length and real
  // metres up and down; a second click on the same section (or a click elsewhere) closes it.
  const legsBox = $r("#rpLegs");
  const tip = document.createElement("div");
  tip.className = "rp-ptip";
  tip.hidden = true;
  legsBox.appendChild(tip);
  let tipLeg = -1;
  const closeTip = () => { tip.hidden = true; tipLeg = -1; };
  document.addEventListener("pointerdown", (ev) => { if (!tip.hidden && !legsBox.contains(ev.target)) closeTip(); });
  els.legBtns.forEach((b) => b.addEventListener("click", () => {
    const i = Number(b.dataset.i);
    if (i === tipLeg) { closeTip(); return; }
    trackEvent("replay-section", legs[i].kind);
    const l = legs[i];
    tipLeg = i;
    tip.innerHTML = `<b>${l.i}. ${escR(l.title)}</b><span><i>Length</i>${l.km.toFixed(2)} km</span><span><i>D+</i>${Math.round(l.up)} m</span><span><i>D−</i>${Math.round(l.down)} m</span>`;
    tip.hidden = false;
    const lb = legsBox.getBoundingClientRect(), bb = b.getBoundingClientRect();
    tip.style.left = `${Math.max(0, Math.min(lb.width - tip.offsetWidth, bb.left - lb.left + bb.width / 2 - tip.offsetWidth / 2))}px`;
    tip.style.top = `${lb.height + 8}px`;
    pause();
    seek(l.startSec + 1);
    // Show that section and the next one on the map; following stops until Play or Recenter.
    if (rp.map) { const n = legs[l.i] || l; rp.map.show(l.startKm, n.endKm); }
  }));
  els.list.querySelectorAll("li button").forEach((b) => b.addEventListener("click", () => {
    // Which kind of moment was opened: a key zone, a climb, an aid station, a gel...
    trackEvent("replay-moment", script[Number(b.parentElement.dataset.i)].kind);
    pause();
    seek(script[Number(b.parentElement.dataset.i)].sec + 1);
    $r(".rp-cockpit").scrollIntoView({ behavior: "smooth", block: "start" });
  }));
  // Click or drag on the profile to move the runner there.
  const svg = $r("#rpProf svg");
  if (svg) {
    const toKm = (ev) => {
      const b = svg.getBoundingClientRect();
      const vx = ((ev.clientX - b.left) / b.width) * 1000;
      return prof.km(vx);
    };
    // A drag is left to the browser, so the profile scrolls freely.
    let down = null;
    svg.addEventListener("pointerdown", (ev) => { down = { x: ev.clientX, y: ev.clientY }; });
    svg.addEventListener("pointercancel", () => { down = null; });
    svg.addEventListener("pointerup", (ev) => {
      if (down && Math.hypot(ev.clientX - down.x, ev.clientY - down.y) < 8) { trackEvent("replay-profile-tap"); pause(); seek(secAtKm(plan, sid, toKm(ev))); }
      down = null;
    });
  }
  // Keyboard: space plays or pauses, arrows step between moments (only while the replay is on screen).
  rp.onKey = (ev) => {
    if (!box.isConnected) return;
    const tag = (ev.target.tagName || "").toLowerCase();
    if (["input", "select", "textarea"].includes(tag) && ev.target.type !== "range" && ev.target.type !== "checkbox") return;
    const r = box.getBoundingClientRect();
    if (r.bottom < 0 || r.top > window.innerHeight) return;
    if ([" ", "ArrowLeft", "ArrowRight"].includes(ev.key)) trackOnce("replay-keyboard");
    if (ev.key === " " && tag !== "button") { ev.preventDefault(); rp.playing ? pause() : play(); }
    else if (ev.key === "ArrowRight" && tag !== "input") { ev.preventDefault(); jump(1); }
    else if (ev.key === "ArrowLeft" && tag !== "input") { ev.preventDefault(); jump(-1); }
  };
  document.addEventListener("keydown", rp.onKey);
  draw();
}

/** Stop the animation and free the map (before a re-render, or when the plan goes away). */
export function stopReplay() {
  rp.playing = false;
  cancelAnimationFrame(rp.raf);
  if (rp.onKey) document.removeEventListener("keydown", rp.onKey);
  rp.onKey = null;
  if (rp.map) rp.map.destroy();
  rp.map = null;
}
