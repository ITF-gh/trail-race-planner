// refs.js (ui): the "My references" card next to the file drops of every mode, and the level
// picker of Prep my run (design review of Prep my run, item 2).
//
// The card: three optional boxes, 10K best (mm:ss), half-marathon best (h:mm:ss) and easy pace
// (m:ss per km), with a line under them saying what they mean (easy pace and its range, from
// core/refs.js). The same values show in the three modes: they are saved once, in the profile
// (ui/profile.js profileSetRefs, localStorage on this device), and a "trp-refs" event tells each
// mode to plan again.
//
// The level picker: Easy / Steady / Race, shown in Prep my run only once a reference is set (and
// no target time). A coloured thumb slides along a track with a little bounce (a CSS transition
// whose timing curve overshoots: cubic-bezier with a value above 1), and its icon moves: a leaf
// sways for Easy, a heart beats for Steady, a flame flickers for Race. Pure CSS animation, see
// style.css ".lvl"; the CSS variable --i (0, 1, 2) places the thumb.
//
// Main exports: refsCardHtml(mode), levelPickerHtml(level), initRefs().

import { refsRead, refsCalib, refsAny, REF_LEVELS } from "../core/refs.js";
import { mmss, hms, parseDuration } from "../core/format.js";
import { profileRefs, profileSetRefs } from "./profile.js";
import { trackEvent } from "./analytics.js";

// The boxes: key in the profile, label, placeholder, and how a value is written back.
const BOXES = [
  { k: "k10", label: "10K", ph: "45:00", show: (s) => (s < 3600 ? mmss(s) : hms(s)) },
  { k: "half", label: "Half marathon", ph: "1:40:00", show: (s) => hms(s) },
  { k: "easy", label: "Easy pace /km", ph: "5:30", show: (s) => mmss(s) },
];
// The levels: name, icon and what it means, for the picker.
export const RUN_LEVELS = {
  easy: { name: "Easy", ic: "🍃", tip: "Talking pace: the pace of most of your training" },
  steady: { name: "Steady", ic: "💓", tip: "Between easy and marathon effort" },
  race: { name: "Race", ic: "🔥", tip: "All in: your race level, carried over the distance" },
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

/** The line under the boxes: what the references say, or how to use them. */
function summaryHtml() {
  const { refs } = profileRefs();
  const x = refsRead(refs);
  if (!x) return `<span class="muted">Any one is enough. They set your level in the plan.</span>`;
  const easy = refs.easy ? `Easy pace <b>${mmss(x.easyPace)}</b>/km` : `Easy pace <b>${mmss(x.easyPace)}</b>/km <span class="muted">(${mmss(x.easyRange[0])} to ${mmss(x.easyRange[1])})</span>`;
  // Riegel: doubling the distance makes the pace 2^(k-1) times slower.
  const own = x.riegel ? ` · twice the distance costs you ${((2 ** (x.riegel - 1) - 1) * 100).toFixed(1)}% of pace` : "";
  return `${easy} · marathon ${mmss(x.marathonPace)}/km${own}`;
}

/**
 * The card, for one mode ("race", "prep" or "run"), placed in that mode's drops. The values are
 * the saved ones; data-ref names the box, so one listener (initRefs) serves the three cards.
 */
export function refsCardHtml(mode) {
  const { refs } = profileRefs();
  const note = mode === "run" ? "your run is compared with them." : "they set the level of your plan.";
  return `<div class="drop refs-card${refsAny(refs) ? " done" : ""}" data-refs="${mode}">
        <h3><span class="tag">★</span>My references</h3>
        <p>Optional. Your best 10K and half marathon, your easy pace: ${note}</p>
        <div class="refs-boxes">${BOXES.map((b) => `<label class="f">${b.label}<input type="text" inputmode="numeric" autocomplete="off" data-ref="${b.k}" placeholder="${b.ph}" value="${refs[b.k] ? b.show(refs[b.k]) : ""}"></label>`).join("")}</div>
        <div class="status refs-sum" aria-live="polite">${summaryHtml()}</div>
      </div>`;
}

/** The level picker of Prep my run (Easy / Steady / Race), with `level` selected. */
export function levelPickerHtml(level) {
  const i = Math.max(0, REF_LEVELS.indexOf(level));
  return `<div class="lvl" role="radiogroup" aria-label="How hard you run it" style="--i:${i}" data-lvl="${REF_LEVELS[i]}">
      <span class="lvl-k">How hard?</span>
      <div class="lvl-track"><span class="lvl-knob" aria-hidden="true"><span class="lvl-ic">${RUN_LEVELS[REF_LEVELS[i]].ic}</span><span class="lvl-n">${RUN_LEVELS[REF_LEVELS[i]].name}</span></span>
        ${REF_LEVELS.map((l, n) => `<button type="button" role="radio" aria-checked="${n === i}" data-level="${l}" title="${RUN_LEVELS[l].tip}">${RUN_LEVELS[l].name}</button>`).join("")}
      </div>
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
    box.querySelector(".lvl-ic").textContent = RUN_LEVELS[b.dataset.level].ic;
    box.querySelector(".lvl-n").textContent = RUN_LEVELS[b.dataset.level].name;
    box.querySelectorAll("[data-level]").forEach((x) => x.setAttribute("aria-checked", String(x === b)));
    trackEvent("refs-level", b.dataset.level);
    // Let the knob land before the page is drawn again.
    setTimeout(() => profileSetRefs({ level: b.dataset.level }), 380);
  });
  // Keep the three cards in step: same values, same summary line.
  document.addEventListener("trp-refs", () => {
    const { refs } = profileRefs();
    document.querySelectorAll(".refs-card").forEach((card) => {
      card.classList.toggle("done", refsAny(refs));
      card.querySelectorAll("[data-ref]").forEach((inp) => {
        if (inp === document.activeElement || inp.classList.contains("bad")) return;
        const b = BOXES.find((x) => x.k === inp.dataset.ref);
        inp.value = refs[b.k] ? b.show(refs[b.k]) : "";
      });
      card.querySelector(".refs-sum").innerHTML = summaryHtml();
    });
  });
}
