// chips.js: the difficulty chips shared by Prep my race (Your route, Your plan) and Prep my run
// (climbs and descents, run timeline): stars for a climb, running shoes for a descent. Each returns HTML text.
import { LEVELS, STARS, DESCENT_LABELS } from "../core/plan.js";

// descChip(level): a descent's risk as running shoes (Boss, design review 2): 3 shoes Let it run,
// 2 Control, 1 Brake (fewer shoes = less running), coloured green, orange, red; the word in the tooltip.
export const SHOE_SVG = `<svg viewBox="0 0 32 14" aria-hidden="true"><path d="M2.7 9.2C2.3 6.8 2.8 4 4 1.9c.2-.4.7-.5 1-.2l1.1 1.1c1.6 1.6 4 2.1 6 1.1l4.3-2.6c.6-.4 1.4-.3 1.8.3l1 1.5c2.3 2.8 6 4 9.6 4.8 1.6.4 2.6 1.5 2.4 2.5L4.2 10.2c-.8 0-1.4-.4-1.5-1z"/><path d="M2.8 10.9l28.4-1.4c.2 1.2-.6 2.3-2 2.5l-24.1 1.2c-1.2.1-2.2-.9-2.3-2.3z" fill-opacity=".55"/><path d="M5.6 13.6l.6-.8.6.8.6-.8.6.8.6-.8.6.8.6-.8.6.8.6-.8.6.8.6-.9.6.9.6-.9.6.9.6-.9.6.9.6-.9.6.9.6-.9.6.9.6-.9.6.9.6-.9.6.9.6-.9.6.9.6-1 .6.9" stroke="currentColor" stroke-width=".7" fill="none" stroke-linejoin="round"/><path d="M6.4 8.6c4.8-.3 9.4-1.7 13.6-3.9l.9.7C16.6 7.7 11.6 9.4 6.6 9.6z" fill="#fff" fill-opacity=".6"/><path d="M9.6 7.2c3-.3 5.9-1.2 8.5-2.5l.7.5c-2.8 1.5-6 2.5-9.1 2.7z" fill="#fff" fill-opacity=".35"/><path d="M4.2 2.2l1.6 1.6" stroke="#fff" stroke-opacity=".5" stroke-width=".8" stroke-linecap="round"/><path d="M12.8 4.1l1.3 1M14.6 3l1.3 1M16.4 2.1l1.2 1" stroke="#fff" stroke-opacity=".7" stroke-width=".8" stroke-linecap="round"/></svg>`;
export const descChip = (l) => { const k = l >= 4 ? 1 : l >= 2 ? 2 : 3; return `<span class="chip st dsc d${k}" title="${DESCENT_LABELS[l]}" aria-label="${DESCENT_LABELS[l]}">${SHOE_SVG.repeat(k)}</span>`; };
// starChip(l): a climb's difficulty as 1 to 4 stars in its level colour (the unlit ones dimmed),
// with the word (Easy...Crux) kept for screen readers and the hover tooltip.
export const starChip = (l) => `<span class="chip st l${l}" title="${LEVELS[l]}" aria-label="${l} of 4 stars, ${LEVELS[l]}">${STARS[l]}<i>${"★".repeat(4 - l)}</i></span>`;
