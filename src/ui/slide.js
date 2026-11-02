// slide.js: make a bar of the cockpit slidable with a finger, a mouse or a pen (design review of Prep my run, item 4).

/** Make `el` slidable. */
export function slidable(el, { onSlide, onStart = () => {}, onEnd = () => {} }) {
  // x where the pointer went down (null when no press), whether it is a slide yet, the last x seen, the frame already asked for, and until when a click is a slide's own (performance.now() ms).
  let downX = null, sliding = false, lastX = 0, raf = 0, dropClickUntil = 0;
  const THRESHOLD = 6; // px sideways before a press is a slide
  el.classList.add("slidable");
  // The pointer's x as a share of the element's width, clamped to 0..1.
  const frac = (x) => {
    const b = el.getBoundingClientRect();
    return b.width > 0 ? Math.max(0, Math.min(1, (x - b.left) / b.width)) : 0;
  };
  el.addEventListener("pointerdown", (ev) => {
    if (ev.button > 0) return; // right or middle mouse button: not a slide
    downX = ev.clientX;
    sliding = false;
  });
  el.addEventListener("pointermove", (ev) => {
    if (downX === null) return;
    lastX = ev.clientX;
    if (!sliding) {
      if (Math.abs(lastX - downX) < THRESHOLD) return;
      sliding = true;
      el.setPointerCapture(ev.pointerId);
      el.classList.add("sliding");
      onStart();
    }
    if (!raf) raf = requestAnimationFrame(() => { raf = 0; onSlide(frac(lastX)); });
  });
  const end = () => {
    if (downX === null) return;
    downX = null;
    if (!sliding) return;
    sliding = false;
    cancelAnimationFrame(raf);
    raf = 0;
    el.classList.remove("sliding");
    onSlide(frac(lastX)); // the exact place where the finger was lifted
    onEnd();
    dropClickUntil = performance.now() + 400;
  };
  el.addEventListener("pointerup", end);
  el.addEventListener("pointercancel", end);
  // Capture phase (the `true`): this listener runs before the buttons inside the bar see the click.
  el.addEventListener("click", (ev) => {
    if (performance.now() < dropClickUntil) { ev.stopPropagation(); ev.preventDefault(); dropClickUntil = 0; }
  }, true);
}
