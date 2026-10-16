// help.js: the "?" next to each section title. A tap opens a small bubble with what the
// section shows (the same line as the user guide, src/site/guide.js) and a link to its card in
// guide.html. One bubble at a time; it closes on a tap outside, on Escape, or on the ×.
//
// This is "progressive disclosure": the page stays clean, the help is one tap away, and the
// full explanation (screenshot, steps, tip) is one more tap away in the guide.

import { GUIDE } from "../site/guide.js";
import { trackEvent } from "./analytics.js";

const HELP_BY_SEC = {};
GUIDE.forEach((m) => m.sections.forEach((s) => { if (s.sec) HELP_BY_SEC[s.sec] = s; }));

let helpPop = null;
let helpBtn = null;

function helpClose() {
  if (!helpPop) return;
  helpPop.remove();
  helpPop = null;
  if (helpBtn) { helpBtn.setAttribute("aria-expanded", "false"); helpBtn = null; }
}

function helpOpen(btn) {
  const s = HELP_BY_SEC[btn.dataset.help];
  if (!s) return;
  helpClose();
  helpBtn = btn;
  btn.setAttribute("aria-expanded", "true");
  helpPop = document.createElement("div");
  helpPop.className = "help-pop";
  helpPop.id = "helpPop";
  helpPop.setAttribute("role", "dialog");
  helpPop.setAttribute("aria-label", `About ${s.name}`);
  helpPop.innerHTML = `<button class="help-x" type="button" aria-label="Close">×</button><h4>${s.name}</h4><p>${s.what}</p><a href="guide.html#${s.id}">Full guide: steps and tips →</a>`;
  document.body.appendChild(helpPop);
  // Under the button, kept inside the screen (page coordinates, so it scrolls with the page).
  const r = btn.getBoundingClientRect();
  const w = helpPop.offsetWidth;
  const left = Math.max(16, Math.min(r.left + r.width / 2 - w / 2, document.documentElement.clientWidth - w - 16));
  helpPop.style.left = `${left + window.scrollX}px`;
  helpPop.style.top = `${r.bottom + 10 + window.scrollY}px`;
  helpPop.querySelector(".help-x").addEventListener("click", () => { const b = helpBtn; helpClose(); if (b) b.focus(); });
  helpPop.querySelector("a").focus({ preventScroll: true });
  trackEvent("help-open", s.id);
}

/** Add a "?" to the title of every section the guide describes. */
export function initHelp() {
  Object.keys(HELP_BY_SEC).forEach((id) => {
    const h2 = document.querySelector(`#${CSS.escape(id)} > .sec-head h2`);
    if (!h2 || h2.querySelector(".help-q")) return;
    const b = document.createElement("button");
    b.type = "button";
    b.className = "help-q";
    b.dataset.help = id;
    b.setAttribute("aria-label", `What is ${HELP_BY_SEC[id].name}?`);
    b.setAttribute("aria-expanded", "false");
    b.setAttribute("aria-controls", "helpPop");
    b.textContent = "?";
    h2.appendChild(b);
  });
  document.addEventListener("click", (ev) => {
    const b = ev.target.closest && ev.target.closest(".help-q");
    if (b) { if (b === helpBtn) helpClose(); else helpOpen(b); return; }
    if (helpPop && !helpPop.contains(ev.target)) helpClose();
  });
  document.addEventListener("keydown", (ev) => { if (ev.key === "Escape" && helpPop) { const b = helpBtn; helpClose(); if (b) b.focus(); } });
  window.addEventListener("resize", helpClose);
}
