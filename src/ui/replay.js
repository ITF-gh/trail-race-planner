// replay.js: section 04, the race-day replay. Plays the plan back in time: a runner moves
// along the map and the elevation profile, the clock runs at the predicted pace, and every
// key moment (climbs, gels, aid stations, decision point) shows a short cue to rehearse.
//
// Animation: requestAnimationFrame calls `frame` before each screen refresh (about 60 times
// a second). Each frame moves race time forward by (real seconds since the last frame x
// speed), then redraws only what changed: a few text fields, the runner on the map and the
// cursor on the profile. Nothing is re-rendered from scratch while it plays.

import { raceScript, raceStateAt, secAtKm } from "../core/script.js";
import { LEVELS, DESCENT_LABELS } from "../core/plan.js";
import { courseMap } from "./map.js";
import { mmss, hm, clock } from "../core/format.js";

const escR = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const SPEEDS = [
  { v: 120, label: "1 h in 30 s" },
  { v: 360, label: "1 h in 10 s" },
  { v: 900, label: "1 h in 4 s" },
];
const ICON = { start: "▶", climb: "▲", top: "⛰", descent: "▼", gel: "G", aid: "⛺", phase: "◐", decision: "!", finish: "🏁" };

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

  box.innerHTML = `
  <div class="rp-stage">
    ${hasMap ? `<div class="rp-map" id="rpMap"></div>` : ""}
    <div class="panel rp-hud">
      <div class="rp-clock"><span class="k">Clock</span><b id="rpClock"></b><span id="rpElapsed"></span></div>
      <div class="rp-prog" aria-hidden="true"><i id="rpBar"></i></div>
      <div class="rp-stats">
        <div><span class="k">Km</span><b id="rpKm"></b></div>
        <div><span class="k">Altitude</span><b id="rpEle"></b></div>
        <div><span class="k">Gradient</span><b id="rpGrade"></b></div>
        <div><span class="k">Pace</span><b id="rpPace"></b></div>
      </div>
      <div class="rp-now" id="rpNow"></div>
      <ul class="kv rp-next" id="rpNext"></ul>
    </div>
  </div>
  <div class="rp-cue" id="rpCue" aria-live="polite"></div>
  <div class="rp-controls">
    <button class="btn icon" type="button" id="rpPrev" aria-label="Previous moment" title="Previous moment (←)">⏮</button>
    <button class="btn primary rp-play" type="button" id="rpPlay"></button>
    <button class="btn icon" type="button" id="rpNextBtn" aria-label="Next moment" title="Next moment (→)">⏭</button>
    <input type="range" id="rpSeek" min="0" max="${Math.round(sc.finishSec)}" step="10" aria-label="Race time">
    <label class="f inline">Speed<select id="rpSpeed" aria-label="Replay speed">${SPEEDS.map((s) => `<option value="${s.v}" ${s.v === rp.speed ? "selected" : ""}>${s.label}</option>`).join("")}</select></label>
    <label class="chk"><input type="checkbox" id="rpPause" ${rp.pauseAt ? "checked" : ""}> Stop at each moment</label>
    ${hasMap ? `<label class="chk"><input type="checkbox" id="rpFollow" ${rp.follow ? "checked" : ""}> Follow the runner</label>` : ""}
  </div>
  <div class="prof-wrap rp-prof" id="rpProf">${prof.html}</div>
  <div class="sub-h" id="rp-script">Race script · ${script.length} moments</div>
  <ol class="rp-script" id="rpScript">${script.map((e, i) => `<li data-i="${i}" class="k-${e.kind} lv${e.level}"><button type="button"><span class="ic">${ICON[e.kind] || "•"}</span><span class="t"><b>${escR(e.title)}</b><small>km ${e.km.toFixed(1)} · ${clock(st, e.sec)}</small></span><span class="cue">${escR(e.cue)}</span></button></li>`).join("")}</ol>`;

  const $r = (s) => box.querySelector(s);
  const els = { clock: $r("#rpClock"), el: $r("#rpElapsed"), bar: $r("#rpBar"), km: $r("#rpKm"), ele: $r("#rpEle"), grade: $r("#rpGrade"), pace: $r("#rpPace"), now: $r("#rpNow"), next: $r("#rpNext"), cue: $r("#rpCue"), play: $r("#rpPlay"), seek: $r("#rpSeek"), cur: $r("#rpProf .pcur"), list: $r("#rpScript") };
  if (hasMap) {
    rp.map = courseMap($r("#rpMap"), { route: plan.course.route, totalKm: plan.course.totalKm, paint: mapPaint, marks: mapMarks });
    rp.map.follow(rp.follow && rp.sec > 0);
  }

  let lastCue = -1;
  let lastNowHtml = "";
  let lastNextHtml = "";
  const draw = () => {
    const s = raceStateAt(plan, sid, rp.sec);
    els.clock.textContent = clock(st, s.sec);
    els.el.textContent = `${hm(s.sec)} on course · ${Math.round(s.frac * 100)}%`;
    els.bar.style.width = `${(s.frac * 100).toFixed(2)}%`;
    els.km.textContent = `${s.km.toFixed(1)} / ${plan.course.totalKm.toFixed(1)}`;
    els.ele.textContent = `${Math.round(s.ele)} m`;
    els.grade.textContent = s.aid ? "–" : `${s.grade > 0 ? "+" : ""}${s.grade.toFixed(0)}%`;
    els.pace.textContent = s.pace ? `${mmss(s.pace)}/km` : "stopped";
    els.seek.value = Math.round(s.sec);
    els.play.innerHTML = rp.playing ? "❚❚ Pause" : rp.sec >= sc.finishSec ? "↺ Replay" : rp.sec > 0 ? "▶ Resume" : "▶ Play race day";

    let now;
    if (s.aid) now = `<span class="chip aidc">Aid station</span> <b>${escR(s.aid.name)}</b> · out at ${clock(st, s.aid.arrive[sid] + s.aid.stopMin * 60)}`;
    else if (s.climb) {
      const x = s.section || s.climb;
      now = `<span class="chip l${x.level}">${LEVELS[x.level]}</span> <b>${s.section ? "Section" : "Climb"} ${x.n}</b> · ${escR(x.tactic)} · top at ${clock(st, s.climb.start[sid] + s.climb.dur[sid])}`;
    } else if (s.descent) now = `<span class="chip l${s.descent.level}">${DESCENT_LABELS[s.descent.level]}</span> <b>Descent ${s.descent.n}</b> · ${escR(s.descent.tactic)}`;
    else if (s.sec >= sc.finishSec) now = `<span class="chip l1">Done</span> <b>Finished</b> · ${hm(sc.finishSec)}`;
    else now = `<span class="chip flat">Runnable</span> <b>Between climbs</b> · relax, drink, run tall`;
    if (now !== lastNowHtml) { els.now.innerHTML = now; lastNowHtml = now; }

    const until = (sec) => { const m = Math.max(0, Math.round((sec - s.sec) / 60)); return m >= 60 ? hm(m * 60) : `${m} min`; };
    const next = [
      s.nextGel ? `<li><span>Next gel</span><b>in ${until(s.nextGel.sec)} · km ${s.nextGel.km.toFixed(1)}</b></li>` : "",
      s.nextAid ? `<li><span>Next aid · ${escR(s.nextAid.name)}</span><b>${(s.nextAid.km - s.km).toFixed(1)} km · ${clock(st, s.nextAid.arrive[sid])}</b></li>` : "",
      s.nextClimb ? `<li><span>Next climb · #${s.nextClimb.n}</span><b>${Math.round(s.nextClimb.gain)} m · in ${until(s.nextClimb.start[sid])}</b></li>` : "",
      s.phase ? `<li><span>Heart rate</span><b>${escR(s.phase.text)}</b></li>` : "",
    ].join("") || `<li><span>Nothing left but the finish</span><b></b></li>`;
    if (next !== lastNextHtml) { els.next.innerHTML = next; lastNextHtml = next; }

    // The cue on screen is the latest moment reached.
    let ci = -1;
    for (let i = 0; i < script.length && script[i].sec <= s.sec + 0.5; i++) ci = i;
    if (ci !== lastCue) {
      lastCue = ci;
      const e = script[Math.max(0, ci)];
      els.cue.className = `rp-cue k-${e.kind} lv${e.level}`;
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

  els.play.addEventListener("click", () => (rp.playing ? pause() : play()));
  $r("#rpPrev").addEventListener("click", () => jump(-1));
  $r("#rpNextBtn").addEventListener("click", () => jump(1));
  els.seek.addEventListener("input", () => seek(Number(els.seek.value)));
  $r("#rpSpeed").addEventListener("change", (e) => { rp.speed = Number(e.target.value); });
  $r("#rpPause").addEventListener("change", (e) => { rp.pauseAt = e.target.checked; });
  const fol = $r("#rpFollow");
  if (fol) fol.addEventListener("change", (e) => { rp.follow = e.target.checked; if (rp.map) rp.map.follow(rp.follow); });
  els.list.querySelectorAll("li button").forEach((b) => b.addEventListener("click", () => {
    pause();
    seek(script[Number(b.parentElement.dataset.i)].sec + 1);
    $r(".rp-stage").scrollIntoView({ behavior: "smooth", block: "nearest" });
  }));
  // Click or drag on the profile to move the runner there.
  const svg = $r("#rpProf svg");
  if (svg) {
    const toKm = (ev) => {
      const b = svg.getBoundingClientRect();
      const vx = ((ev.clientX - b.left) / b.width) * 1000;
      return prof.km(vx);
    };
    let dragging = false;
    svg.addEventListener("pointerdown", (ev) => { dragging = true; pause(); seek(secAtKm(plan, sid, toKm(ev))); });
    svg.addEventListener("pointermove", (ev) => { if (dragging) seek(secAtKm(plan, sid, toKm(ev))); });
    ["pointerup", "pointercancel", "pointerleave"].forEach((t) => svg.addEventListener(t, () => { dragging = false; }));
  }
  // Keyboard: space plays or pauses, arrows step between moments (only while the replay is on screen).
  rp.onKey = (ev) => {
    if (!box.isConnected) return;
    const tag = (ev.target.tagName || "").toLowerCase();
    if (["input", "select", "textarea"].includes(tag) && ev.target.type !== "range" && ev.target.type !== "checkbox") return;
    const r = box.getBoundingClientRect();
    if (r.bottom < 0 || r.top > window.innerHeight) return;
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
