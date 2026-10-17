// refs.js (ui): the "My references" card next to the file drops of every mode, and the level
// picker of Prep my run (design review of Prep my run, item 2).
//
// The card: three optional boxes, 10K best (mm:ss), half-marathon best (h:mm:ss) and easy pace
// (m:ss per km), with a line under them saying what they mean (easy pace and its range, from
// core/refs.js). The same values show in the three modes: they are saved once, in the profile
// (ui/profile.js profileSetRefs, localStorage on this device), and a "trp-refs" event tells each
// mode to plan again.
//
// The level picker: levels 1 to 5 (Recovery, Easy, Steady, Marathon, Race), shown in Prep my run
// only once a reference is set (and no target time). A gauge fills from green to red and a round
// knob slides to the level with a little bounce (a CSS transition whose timing curve overshoots:
// cubic-bezier with a value above 1); its icon moves: a turtle bobs, a leaf sways, a heart
// beats, a bolt flashes, a flame flickers. Pure CSS animation, see style.css ".lvl"; the CSS
// variable --i (0 to 4) places the knob and the end of the fill.
//
// Main exports: refsCardHtml(mode), levelPickerHtml(level), initRefs().

import { refsRead, refsCalib, refsAny, REF_LEVELS } from "../core/refs.js";
import { mmss, hms, parseDuration } from "../core/format.js";
import { profileRefs, profileSetRefs } from "./profile.js";
import { trackEvent } from "./analytics.js";

// The boxes: key in the profile, label, placeholder, and how a value is written back.
const BOXES = [
  { k: "k10", label: "10K", ph: "45:00", show: (s) => (s < 3600 ? mmss(s) : hms(s)) },
  { k: "half", label: "half", ph: "1:40:00", show: (s) => hms(s) },
  { k: "easy", label: "easy", ph: "5:30", show: (s) => mmss(s) },
];
// The five levels (1 to 5): name, icon and what it means, for the picker.
export const RUN_LEVELS = {
  recovery: { name: "Recovery", ic: "🐢", tip: "a gentle jog, slower than easy" },
  easy: { name: "Easy", ic: "🍃", tip: "talking pace, most of your training" },
  steady: { name: "Steady", ic: "💓", tip: "between easy and marathon effort" },
  marathon: { name: "Marathon", ic: "⚡", tip: "your marathon effort" },
  race: { name: "Race", ic: "🔥", tip: "all in, your race level" },
};

/**
 * Read a box as seconds: the 10K and the easy pace as m:ss ("45:00", "5:30"), the half as h:mm or
 * h:mm:ss ("1:40", "1:40:00"); any three-part time is h:mm:ss (format.js parseDuration). An empty
 * box gives null (the reference is cleared), text that is not a time gives NaN (refused).
 */
const readBox = (k, text) => {
  const t = String(text || "").trim();
  if (!t) return null;
  const v = parseDuration(t, k !== "half");
  return v === null ? NaN : v;
};

/** What the references say, as plain words for the strip's tooltip (the strip shows no summary). */
function summaryText() {
  const x = refsRead(profileRefs().refs);
  if (!x) return "Optional, any one is enough: your best 10K, your best half marathon or your easy pace. They set the level of the times.";
  // Riegel: doubling the distance makes the pace 2^(k-1) times slower.
  const own = x.riegel ? ` Twice the distance costs you ${((2 ** (x.riegel - 1) - 1) * 100).toFixed(1)}% of pace.` : "";
  return `Easy ${mmss(x.easyPace)}/km (range ${mmss(x.easyRange[0])} to ${mmss(x.easyRange[1])}, Daniels), marathon ${mmss(x.marathonPace)}/km.${own}`;
}

/**
 * The references line, for one mode ("race", "prep" or "run"): discreet optional text under that
 * mode's file drops, no box and no border (owner's rule), with the values typed straight into the
 * sentence: "Optional 10K __ half __ easy __", in small faint type (owner: minimalist). What they mean is in the tooltip.
 * In Prep my run the target time comes first ("Target __ or ..."), and the level picker follows
 * (#prepLevel, drawn by preprun.js once a reference is set and no target is typed). The values
 * are the saved ones; data-ref names the box, so one listener (initRefs) serves the three lines.
 */
export function refsCardHtml(mode) {
  const { refs } = profileRefs();
  const prep = mode === "prep";
  return `<div class="refs-card refs-strip${refsAny(refs) ? " done" : ""}" data-refs="${mode}" title="${summaryText()}">
        ${prep ? `<label class="rf-f">Target<input type="text" id="prepTarget" inputmode="numeric" autocomplete="off" placeholder="3:30" aria-label="Target time (h:mm)"></label><span class="rf-lead">or</span>` : `<span class="rf-lead">Optional</span>`}
        ${BOXES.map((b) => `<label class="rf-f">${b.label}<input type="text" inputmode="numeric" autocomplete="off" data-ref="${b.k}" placeholder="${b.ph}" value="${refs[b.k] ? b.show(refs[b.k]) : ""}"></label>`).join("")}
        ${prep ? `<div id="prepLevel"></div>` : ""}
      </div>`;
}

/**
 * The level picker of Prep my run, levels 1 to 5, with `level` selected: a thin line whose
 * coloured fill grows from green to red, five dots to tap, a small coloured knob that slides
 * there, and the level's name (its meaning in the tooltip). Owner: light and simple, so the
 * knob is a plain dot (the icon element stays, hidden by CSS).
 */
export function levelPickerHtml(level) {
  const i = Math.max(0, REF_LEVELS.indexOf(level));
  const L = RUN_LEVELS[REF_LEVELS[i]];
  return `<div class="lvl" role="radiogroup" aria-label="How hard you run it" style="--i:${i}" data-lvl="${REF_LEVELS[i]}">
      <div class="lvl-track"><i class="lvl-fill" aria-hidden="true"></i><span class="lvl-knob" aria-hidden="true"><span class="lvl-ic">${L.ic}</span></span>
        ${REF_LEVELS.map((l, n) => `<button type="button" role="radio" aria-checked="${n === i}" data-level="${l}" title="${n + 1}. ${RUN_LEVELS[l].name}: ${RUN_LEVELS[l].tip}" aria-label="${RUN_LEVELS[l].name}"></button>`).join("")}
      </div>
      <span class="lvl-name" title="${L.tip}">${L.name}</span>
    </div>`;
}

/** The calibration for the engine at `level`, or null without references (see core/refs.js). */
export const refsCalibNow = (level) => refsCalib(profileRefs().refs, level);

/**
 * Wire the cards and the picker (once, at start-up). Typing in a box saves it when the box is
 * left or Enter is pressed ("change"); a bad value turns the box red and is not saved. A click on
 * a level saves it. Both end with profileSetRefs, whose "trp-refs" event makes each mode plan
 * again; the cards are refreshed here.
 */
export function initRefs() {
  document.addEventListener("change", (ev) => {
    const inp = ev.target.closest && ev.target.closest(".refs-card [data-ref]");
    if (!inp) return;
    const k = inp.dataset.ref;
    const v = readBox(k, inp.value);
    // Out of range or unreadable: red box, nothing saved (core/refs.js REF_LIMITS).
    const ok = v === null || refsRead({ [k]: v }) !== null;
    inp.classList.toggle("bad", !ok);
    if (!ok) return;
    trackEvent("refs-set", k);
    profileSetRefs({ refs: { [k]: v } });
  });
  document.addEventListener("click", (ev) => {
    const b = ev.target.closest && ev.target.closest(".lvl [data-level]");
    if (!b) return;
    const box = b.closest(".lvl");
    const i = REF_LEVELS.indexOf(b.dataset.level);
    // Move the knob first (CSS animates it), then plan again.
    box.style.setProperty("--i", String(i));
    box.dataset.lvl = b.dataset.level;
    const L = RUN_LEVELS[b.dataset.level];
    box.querySelector(".lvl-ic").textContent = L.ic;
    const nm = box.querySelector(".lvl-name");
    nm.textContent = L.name;
    nm.title = L.tip;
    box.querySelectorAll("[data-level]").forEach((x) => x.setAttribute("aria-checked", String(x === b)));
    trackEvent("refs-level", b.dataset.level);
    // Let the knob land before the page is drawn again.
    setTimeout(() => profileSetRefs({ level: b.dataset.level }), 380);
  });
  // Keep the three lines in step: same values, same tooltip.
  document.addEventListener("trp-refs", () => {
    const { refs } = profileRefs();
    document.querySelectorAll(".refs-card").forEach((card) => {
      card.classList.toggle("done", refsAny(refs));
      card.querySelectorAll("[data-ref]").forEach((inp) => {
        if (inp === document.activeElement || inp.classList.contains("bad")) return;
        const b = BOXES.find((x) => x.k === inp.dataset.ref);
        inp.value = refs[b.k] ? b.show(refs[b.k]) : "";
      });
      card.title = summaryText();
    });
  });
}
