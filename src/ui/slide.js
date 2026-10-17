// slide.js: make a bar of the cockpit slidable with a finger, a mouse or a pen (design review of
// Prep my run, item 4). Used by the race-day replay (replay.js) and Rewind my run (review.js) on
// the section bar, the progress bar under the clock and the profile.
//
// How it works:
//   - Pointer events (pointerdown / pointermove / pointerup) are the browser's one family of events
//     for mouse, touch and pen, so the same code serves a laptop and a phone.
//   - A press only becomes a slide once the pointer has moved a few pixels sideways: below that it
//     stays a tap, and the bar's own click (jump to a section, open its pop-up) still works.
//   - Once sliding, setPointerCapture keeps sending the moves to the bar even when the finger
//     leaves it, so a quick slide does not stop at the bar's edge.
//   - Moves are grouped with requestAnimationFrame: at most one redraw per screen frame, however
//     many moves the finger sends.
//   - The click the browser fires after a slide is dropped, so a slide is never also a tap.
// The CSS class "slidable" sets touch-action (see style.css), which tells the phone which finger
// moves are ours and which ones still scroll the page.

/**
 * Make `el` slidable. While sliding, onSlide(f) gets the pointer's position along the element,
 * f from 0 (left edge) to 1 (right edge). onStart() runs when a slide begins, onEnd() when it
 * ends. Returns nothing. Side effects: listeners on `el`, the classes "slidable" and "sliding".
 */
export function slidable(el, { onSlide, onStart = () => {}, onEnd = () => {} }) {
  // x where the pointer went down (null when no press), whether it is a slide yet, the last x seen,
  // the frame already asked for, and until when a click is a slide's own (performance.now() ms).
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
