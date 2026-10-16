// format.js: small helpers to print times and paces consistently.
//
// Used by the UI, the CLI and markdown.js. All times inside the app are plain
// numbers of seconds; these functions turn them into text ("3:27", "3h27",
// "1:07:42", "9:45") and read text typed by a person back into seconds.

// Two-digit padding: 7 -> "07". padStart adds "0"s on the left up to length 2.
const pad = (n) => String(n).padStart(2, "0");

/** 3:27 style pace or split from seconds (m:ss). */
export function mmss(sec) {
  const s = Math.round(sec);
  return `${Math.floor(s / 60)}:${pad(s % 60)}`;
}

/**
 * 3h27 style duration.
 * Rounded to the nearest minute first, so 3h26m50s prints as 3h27.
 */
export function hm(sec) {
  const s = Math.round(sec / 60) * 60;
  return `${Math.floor(s / 3600)}h${pad(Math.floor((s % 3600) / 60))}`;
}

/** Elapsed time as a stopwatch: 1:07:42 (h:mm:ss). Negative input prints 0:00:00. */
export function hms(sec) {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 3600)}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

/**
 * Clock time of day from a start time in seconds-since-midnight plus an offset.
 * Example: clock(9 * 3600, 5400) is "10:30". `% 24` wraps past midnight, so a
 * race that runs through the night prints "1:15", not "25:15".
 */
export function clock(startSec, offsetSec) {
  const t = Math.round(startSec + offsetSec);
  const h = Math.floor(t / 3600) % 24;
  return `${h}:${pad(Math.floor((t % 3600) / 60))}`;
}

/**
 * "09:00" to seconds since midnight.
 * The regex accepts one or two digits, a colon, then exactly two digits
 * (^ and $ anchor it to the whole text). Anything else falls back to 9:00.
 */
export function parseClock(str) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(str || "").trim());
  if (!m) return 9 * 3600;
  return parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60;
}

/**
 * Parse a time typed by a person. "56:30" means minutes and seconds when
 * `shortAsMinutes` is true, otherwise hours and minutes ("1:55").
 * "1:55:00" (three parts) is always h:mm:ss. Returns seconds, or null when
 * the text is empty or not a time.
 */
export function parseDuration(str, shortAsMinutes = false) {
  if (!str) return null;
  // Split "1:55" into ["1", "55"] and convert each part to a number.
  const p = String(str).trim().split(":").map(Number);
  if (p.some((n) => !Number.isFinite(n))) return null;
  if (p.length === 3) return p[0] * 3600 + p[1] * 60 + p[2];
  if (p.length === 2) return shortAsMinutes ? p[0] * 60 + p[1] : p[0] * 3600 + p[1] * 60;
  return null;
}
