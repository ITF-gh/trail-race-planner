// watch.js: the "Watch messages" panel and the course download, shared by two modes: Plan a race (the race-day plan) and Prep my run (any run to come).

import { editedPoints, courseFit, courseGpx, POINT_NAME_MAX, CP } from "../core/garmin.js";
import { secAtKm } from "../core/script.js";
import { clock } from "../core/format.js";
import { trackEvent } from "./analytics.js";

// Escape text for HTML: each of & < > " (the regex's character set) becomes its entity.
const wmEsc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
// Read the edits stored under key k: parse the JSON, or {} when there is nothing (`|| "null"` then `|| {}`), when it is not valid JSON, or when the browser blocks storage (the catch).
const wmGet = (k) => { try { return JSON.parse(localStorage.getItem(k) || "null") || {}; } catch (e) { return {}; } };
// Save the edits under key k, as JSON text. A blocked storage simply keeps nothing.
const wmSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage can be blocked */ } };
// The word under the arrival time, from the FIT course point type of each message. [CP.generic] in square brackets uses the VALUE of CP.generic (a number) as the key.
const WM_KIND = { [CP.generic]: "Run", [CP.summit]: "Climb", [CP.valley]: "Descent", [CP.danger]: "Brake" };

/** The messages that go to the watch: the planner's, with the runner's edits saved under `key`. */
export function watchPoints(plan, sid, key) {
  return editedPoints(plan, sid, wmGet(key));
}

/** The "Pimp my GPX" sticker (street-art look, src/ui/css .pimp-link) that sits next to the plan's key figures and jumps to the watch messages and the course download at `href`. */
export function pimpBadge(href, sub = "Put this plan on your watch →") {
  return `<a class="pimp-link side" href="${href}"><span class="pl-tag">Bonus</span><b>Pimp my GPX</b><span class="pl-sub">${sub}</span></a>`;
}

/** The panel's HTML (design review of Prep my run: lighter and cooler). */
export function watchPanelHtml(plan, dl = "") {
  return `<div class="panel wm">
    <div class="wm-hero">
      <div class="wm-watch" aria-hidden="true"><div class="wm-face"><small class="wm-fkm"></small><b class="wm-ftext"></b><small class="wm-ft"></small></div></div>
      <div class="wm-side">
        <p class="wm-lead"><span class="wm-count" aria-live="polite"></span> One message each time the strategy changes, one at every key zone ("!"). Tap one to see it on the watch, rewrite it (${POINT_NAME_MAX} characters), move its km, switch it off.</p>
        <div class="wm-dl">${dl}</div>
        <div class="wm-tools"><button class="wm-link" type="button" data-keep-all="1">Keep all</button><button class="wm-link" type="button" data-keep-all="0">Keep none</button><button class="wm-link wm-reset" type="button">Back to the planner's</button><button class="wm-link wm-open" type="button">+ Add yours</button></div>
      </div>
    </div>
    <div class="wm-add" hidden>
      <label class="f">At km<input type="number" class="wm-addkm" step="0.1" min="0" max="${plan.course.totalKm.toFixed(1)}" placeholder="12.5"></label>
      <label class="f">Your message<input type="text" class="wm-addname" maxlength="${POINT_NAME_MAX}" placeholder="CALL HOME"></label>
      <button class="btn ghost sm wm-addbtn" type="button">Add</button>
    </div>
    <div class="wm-rows"></div>
  </div>`;
}

/** Wire the panel inside `root` (made from watchPanelHtml). say(text) reports a problem. */
export function mountWatch(root, { plan, sid, key, say = () => {} }) {
  const q = (s) => root.querySelector(s);
  // The watch face: the message of `row` in the watch's letters, its km and arrival time.
  let shown = "";
  const face = q(".wm-face");
  const preview = (row, buzz = true) => {
    if (!row) { face.hidden = true; return; }
    face.hidden = false;
    const changed = shown !== row.dataset.id;
    shown = row.dataset.id;
    q(".wm-ftext").textContent = row.querySelector(".wm-msg input").value || "…";
    q(".wm-fkm").textContent = `KM ${row.querySelector(".wm-km input").value}`;
    q(".wm-ft").textContent = row.dataset.t;
    face.classList.toggle("off", row.classList.contains("off"));
    box().querySelectorAll(".wm-row.pick").forEach((r) => r.classList.remove("pick"));
    row.classList.add("pick");
    // Reading offsetWidth makes the browser apply the removed class first, so the shake restarts.
    if (buzz && changed) { face.classList.remove("buzz"); void face.offsetWidth; face.classList.add("buzz"); }
  };
  const box = () => q(".wm-rows");
  // "+ Add yours" unfolds the add row and puts the cursor in its km box.
  q(".wm-open").addEventListener("click", () => { const a = q(".wm-add"); a.hidden = !a.hidden; if (!a.hidden) q(".wm-addkm").focus(); });
  /** Rebuild the list of messages from the plan and the stored edits, and wire each row. */
  const draw = () => {
    const ed = wmGet(key);
    // Two lists: `all` ignores the "off" edits (so an unticked message stays visible, greyed, and can be ticked again), `on` is the set of ids actually sent to the watch.
    const all = editedPoints(plan, sid, { names: ed.names, kms: ed.kms, extra: ed.extra }); // unticked ones stay listed
    const on = new Set(editedPoints(plan, sid, ed).map((p) => p.id));
    const box = q(".wm-rows");
    // One row per message: km, arrival clock time (with the kind: "Yours", "Key zone" for ids like "k1" (regex ^k\d: a "k" then a digit at the start), or the word from WM_KIND), the editable text with a character counter...
    box.innerHTML = all.map((p) => `<div class="wm-row${on.has(p.id) ? "" : " off"}${p.name.startsWith("!") ? " key" : ""}" data-id="${wmEsc(p.id)}" data-t="${clock(plan.startSec, secAtKm(plan, sid, p.km))}">
      <span class="wm-keep">${p.added ? `<button class="wm-del" type="button" data-del="1" aria-label="Remove" title="Remove">✕</button>` : `<input type="checkbox" role="switch" ${on.has(p.id) ? "checked" : ""} aria-label="Send this message" title="Send this message">`}</span>
      <span class="wm-km"><input type="number" step="0.1" min="0" max="${plan.course.totalKm.toFixed(1)}" value="${p.km.toFixed(1)}" aria-label="Km of this message" title="Move this message: type the km where you want it"></span>
      <span class="wm-msg"><input type="text" maxlength="${POINT_NAME_MAX}" value="${wmEsc(p.name)}" aria-label="Message at km ${p.km.toFixed(1)}" title="${wmEsc(p.text)}"><small class="wm-n">${p.name.length}/${POINT_NAME_MAX}</small></span>
      <span class="wm-t">${clock(plan.startSec, secAtKm(plan, sid, p.km))}<small>${p.added ? "Yours" : /^k\d/.test(p.id) ? "Key zone" : WM_KIND[p.type] || ""}</small></span>
    </div>`).join("");
    // How many messages go to the watch, out of all those listed.
    q(".wm-count").innerHTML = `<b>${all.filter((p) => on.has(p.id)).length}</b> of ${all.length} messages on your watch.`;
    // The watch face shows the message picked (the last one touched), else the first one sent.
    const pick = box.querySelector(`.wm-row[data-id="${CSS.escape(shown || "")}"]`) || box.querySelector(".wm-row:not(.off)") || box.querySelector(".wm-row");
    preview(pick, false);
    // Wire each row. `id` is kept by each listener (a closure), so it knows which row it serves.
    box.querySelectorAll(".wm-row").forEach((row) => {
      const id = row.dataset.id;
      const inp = row.querySelector(".wm-msg input");
      // Km: move the message along the course.
      const kmIn = row.querySelector(".wm-km input");
      kmIn.addEventListener("change", () => {
        const v = kmIn.value.trim() === "" ? null : parseFloat(kmIn.value);
        if (v !== null && !Number.isFinite(v)) return;
        const e = wmGet(key);
        const x = (e.extra || []).find((r) => r.id === id);
        if (x) { if (v !== null) x.km = v; }
        else { e.kms = { ...(e.kms || {}) }; if (v === null) delete e.kms[id]; else e.kms[id] = v; }
        wmSet(key, e); trackEvent("watch-msg", "move"); draw();
      });
      // Touching a row shows it on the watch face; typing updates the counter and the face live.
      row.addEventListener("focusin", () => preview(row));
      row.addEventListener("pointerdown", () => preview(row));
      inp.addEventListener("input", () => { row.querySelector(".wm-n").textContent = `${inp.value.length}/${POINT_NAME_MAX}`; preview(row, false); });
      // When the text box is left ("change" event): save.
      inp.addEventListener("change", () => {
        const e = wmGet(key);
        const x = (e.extra || []).find((r) => r.id === id);
        if (x) x.name = inp.value.trim(); else e.names = { ...(e.names || {}), [id]: inp.value.trim() };
        wmSet(key, e); trackEvent("watch-msg", "edit"); draw();
      });
      // Keep box (planner messages only): an unticked box records off[id] = true.
      const cb = row.querySelector('input[type="checkbox"]');
      if (cb) cb.addEventListener("change", () => {
        const e = wmGet(key);
        e.off = { ...(e.off || {}), [id]: !cb.checked };
        wmSet(key, e); trackEvent("watch-msg", cb.checked ? "on" : "off"); draw();
      });
      // Remove button (your own messages only): drop it from `extra`.
      const del = row.querySelector("[data-del]");
      if (del) del.addEventListener("click", () => {
        const e = wmGet(key);
        e.extra = (e.extra || []).filter((r) => r.id !== id);
        wmSet(key, e); draw();
      });
    });
  };
  // Add a message of your own.
  q(".wm-addbtn").addEventListener("click", () => {
    const km = parseFloat(q(".wm-addkm").value), name = q(".wm-addname").value.trim();
    if (!Number.isFinite(km) || !name) { say("Give a km and a message to add."); return; }
    const e = wmGet(key);
    e.extra = [...(e.extra || []), { id: `x${Date.now().toString(36)}`, km, name }];
    wmSet(key, e); trackEvent("watch-msg", "add");
    q(".wm-addkm").value = ""; q(".wm-addname").value = "";
    draw();
  });
  // Keep all / Keep none: tick or untick every planner message at once (your own messages are always kept; remove them with their ✕).
  root.querySelectorAll("[data-keep-all]").forEach((b) => b.addEventListener("click", () => {
    const keep = b.dataset.keepAll === "1";
    const e = wmGet(key);
    const ids = editedPoints(plan, sid, { names: e.names, kms: e.kms }).map((p) => p.id);
    e.off = keep ? {} : Object.fromEntries(ids.map((id) => [id, true]));
    wmSet(key, e); trackEvent("watch-msg", keep ? "keep-all" : "keep-none"); draw();
  }));
  // Reset: store an empty edit set, so the planner's messages come back as they were.
  q(".wm-reset").addEventListener("click", () => { wmSet(key, {}); trackEvent("watch-msg", "reset"); draw(); });
  draw();
}

/** Download the course with its messages: "fit" (Garmin) or "gpx" (any brand). track = the GPX points ({lat, lon, ele}). */
export function downloadCourse(kind, { plan, sid, track, name, points, suffix = sid }) {
  // FIT is a binary format (bytes); GPX is XML text.
  const data = kind === "fit" ? courseFit(plan, sid, track, { name, points }) : courseGpx(plan, sid, track, name, points);
  const blob = new Blob([data], { type: kind === "fit" ? "application/octet-stream" : "application/gpx+xml" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  // A safe file name from the course name, step by step: normalize("NFD") splits accented letters into letter + accent mark ("é" -> "e" + "´"), the next regex removes those accent marks...
  a.download = `${name.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^\w]+/g, "-").replace(/^-|-$/g, "").toLowerCase() || "course"}${suffix ? `-${suffix}` : ""}.${kind}`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  trackEvent("export", kind);
  return a.download;
}
