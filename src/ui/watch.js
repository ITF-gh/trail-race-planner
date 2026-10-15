// watch.js: the "Watch messages" panel and the course download, shared by two modes:
// Plan a race (the race-day plan) and Prep my run (any run to come).
//
// The planner proposes the messages (core/garmin.js coursePoints); the runner checks them, rewrites
// any, unticks the unwanted ones and adds their own. Edits are kept in localStorage under a key
// per course and scenario, so they survive a reload, and the downloads carry that version.

import { editedPoints, courseFit, courseGpx, POINT_NAME_MAX, CP } from "../core/garmin.js";
import { secAtKm } from "../core/script.js";
import { clock } from "../core/format.js";
import { trackEvent } from "./analytics.js";

const wmEsc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const wmGet = (k) => { try { return JSON.parse(localStorage.getItem(k) || "null") || {}; } catch (e) { return {}; } };
const wmSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage can be blocked */ } };
const WM_KIND = { [CP.generic]: "Run", [CP.summit]: "Climb", [CP.valley]: "Descent", [CP.danger]: "Brake" };

/** The messages that go to the watch: the planner's, with the runner's edits saved under `key`. */
export function watchPoints(plan, sid, key) {
  return editedPoints(plan, sid, wmGet(key));
}

/**
 * The "Pimp my GPX" sticker (street-art look, style.css .pimp-link) that sits next to the plan's
 * key figures and jumps to the watch messages and the course download at `href`.
 */
export function pimpBadge(href, sub = "Put this plan on your watch →") {
  return `<a class="pimp-link side" href="${href}"><span class="pl-tag">Bonus</span><b>Pimp my GPX</b><span class="pl-sub">${sub}</span></a>`;
}

/** The panel's HTML: an explanation, the list (filled by mountWatch) and the add row. */
export function watchPanelHtml(plan) {
  return `<div class="panel wm">
    <p class="note" style="margin-top:0">What your watch will show along the course: one message each time the strategy changes, one at every key zone (marked "!"). Check them, rewrite any (${POINT_NAME_MAX} characters, the watch cuts the rest), untick the ones you do not want, add your own. Your version goes into the course files and is saved in this browser.</p>
    <div class="wm-row wm-head"><span>Km</span><span>Arrive</span><span>Message on the watch</span><span>Keep</span></div>
    <div class="wm-rows"></div>
    <div class="wm-add">
      <label class="f">At km<input type="number" class="wm-addkm" step="0.1" min="0" max="${plan.course.totalKm.toFixed(1)}" placeholder="12.5"></label>
      <label class="f">Your message<input type="text" class="wm-addname" maxlength="${POINT_NAME_MAX}" placeholder="CALL HOME"></label>
      <button class="btn ghost wm-addbtn" type="button">Add</button>
      <button class="btn ghost wm-reset" type="button">Back to the planner's messages</button>
    </div>
  </div>`;
}

/** Wire the panel inside `root` (made from watchPanelHtml). say(text) reports a problem. */
export function mountWatch(root, { plan, sid, key, say = () => {} }) {
  const q = (s) => root.querySelector(s);
  const draw = () => {
    const ed = wmGet(key);
    const all = editedPoints(plan, sid, { names: ed.names, extra: ed.extra }); // unticked ones stay listed
    const on = new Set(editedPoints(plan, sid, ed).map((p) => p.id));
    const box = q(".wm-rows");
    box.innerHTML = all.map((p) => `<div class="wm-row${on.has(p.id) ? "" : " off"}${p.name.startsWith("!") ? " key" : ""}" data-id="${wmEsc(p.id)}">
      <span class="wm-km">${p.km.toFixed(1)}</span>
      <span class="wm-t">${clock(plan.startSec, secAtKm(plan, sid, p.km))}<small>${p.added ? "Yours" : /^k\d/.test(p.id) ? "Key zone" : WM_KIND[p.type] || ""}</small></span>
      <span class="wm-msg"><input type="text" maxlength="${POINT_NAME_MAX}" value="${wmEsc(p.name)}" aria-label="Message at km ${p.km.toFixed(1)}" title="${wmEsc(p.text)}"><small class="wm-n">${p.name.length}/${POINT_NAME_MAX}</small></span>
      <span class="wm-keep">${p.added ? `<button class="btn ghost sm" type="button" data-del="1" aria-label="Remove">✕</button>` : `<input type="checkbox" ${on.has(p.id) ? "checked" : ""} aria-label="Keep this message">`}</span>
    </div>`).join("");
    box.querySelectorAll(".wm-row").forEach((row) => {
      const id = row.dataset.id;
      const inp = row.querySelector(".wm-msg input");
      inp.addEventListener("input", () => { row.querySelector(".wm-n").textContent = `${inp.value.length}/${POINT_NAME_MAX}`; });
      inp.addEventListener("change", () => {
        const e = wmGet(key);
        const x = (e.extra || []).find((r) => r.id === id);
        if (x) x.name = inp.value.trim(); else e.names = { ...(e.names || {}), [id]: inp.value.trim() };
        wmSet(key, e); trackEvent("watch-msg", "edit"); draw();
      });
      const cb = row.querySelector('input[type="checkbox"]');
      if (cb) cb.addEventListener("change", () => {
        const e = wmGet(key);
        e.off = { ...(e.off || {}), [id]: !cb.checked };
        wmSet(key, e); trackEvent("watch-msg", cb.checked ? "on" : "off"); draw();
      });
      const del = row.querySelector("[data-del]");
      if (del) del.addEventListener("click", () => {
        const e = wmGet(key);
        e.extra = (e.extra || []).filter((r) => r.id !== id);
        wmSet(key, e); draw();
      });
    });
  };
  q(".wm-addbtn").addEventListener("click", () => {
    const km = parseFloat(q(".wm-addkm").value), name = q(".wm-addname").value.trim();
    if (!Number.isFinite(km) || !name) { say("Give a km and a message to add."); return; }
    const e = wmGet(key);
    e.extra = [...(e.extra || []), { id: `x${Date.now().toString(36)}`, km, name }];
    wmSet(key, e); trackEvent("watch-msg", "add");
    q(".wm-addkm").value = ""; q(".wm-addname").value = "";
    draw();
  });
  q(".wm-reset").addEventListener("click", () => { wmSet(key, {}); trackEvent("watch-msg", "reset"); draw(); });
  draw();
}

/**
 * Download the course with its messages: "fit" (Garmin) or "gpx" (any brand).
 * track = the GPX points ({lat, lon, ele}). Returns the file name.
 */
export function downloadCourse(kind, { plan, sid, track, name, points, suffix = sid }) {
  const data = kind === "fit" ? courseFit(plan, sid, track, { name, points }) : courseGpx(plan, sid, track, name, points);
  const blob = new Blob([data], { type: kind === "fit" ? "application/octet-stream" : "application/gpx+xml" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${name.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^\w]+/g, "-").replace(/^-|-$/g, "").toLowerCase() || "course"}${suffix ? `-${suffix}` : ""}.${kind}`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  trackEvent("export", kind);
  return a.download;
}
