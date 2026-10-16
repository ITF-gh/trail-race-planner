// aichecks.js: the checks made by code when the runner clicks "Spend 1 edelweiss" in the Ask the
// AI window of Prep my race, BEFORE any call to the AI (they are free and instant).
//
// Each check gives back a short object { code, level, text, field }:
//   code   a fixed name, e.g. "empty_dataset" (the server will run the same checks again and
//          store the codes the runner chose to force)
//   level  "stop": the call cannot happen (no account, no edelweiss): Fix or Cancel only
//          "warn": the call can happen but may be wasted: Fix, Send anyway or Cancel
//   text   the message shown to the runner
//   field  which part of the window to fix ("race", "runs", "target", "notes", "question"), or
//          "" when there is nothing to fix in the window
// The window keeps everything typed, whatever button is pressed.
//
// Plain functions with no page access, so the tests run them in Node.

/** The runner's goal for the race (the chips of step 3). */
export const AI_GOALS = [
  { code: "finish", label: "Finish safely" },
  { code: "target", label: "Target time" },
  { code: "best", label: "Best possible" },
];
/** How much risk the plan may take (the chips of step 3). */
export const AI_RISKS = [
  { code: "prudent", label: "Prudent" },
  { code: "balanced", label: "Balanced" },
  { code: "bold", label: "Bold" },
];
/** Longest free information text, in characters. */
export const AI_NOTES_MAX = 500;

// Words that ask for something other than an analysis of the race and runs: a web address,
// code, or the usual ways of trying to change an AI's job. `i` = ignore upper / lower case.
const AIC_OFF_TOPIC = /(https?:\/\/|www\.|<\/?[a-z]+>|```|ignore (all |your |the |previous )|system prompt|you are now|pretend|write (me )?(a|an) (poem|story|song|email|letter|post)|translate )/i;

/**
 * The checks for one Prep my race request. `x` describes what the window would send:
 *   race        { km, gain, legs } of the loaded race GPX, or null when none is loaded
 *   gpxRuns     how many GPX files are loaded in "Your runs"
 *   storedRuns  how many stored runs the window selects
 *   targetText  the target time as typed ("7:30"), "" when none
 *   targetSec   that time in seconds, null when it cannot be read
 *   centralSec  the calculated central finish time, null without a plan
 *   notes, question   the runner's texts
 *   cloud       { open, signedIn, balance, demo }: the online account
 * Returns the list of checks that failed, hard stops first; [] means all clear.
 */
export function aiRaceChecks(x) {
  const out = [];
  const add = (code, level, text, field = "") => out.push({ code, level, text, field });
  const c = x.cloud || {};
  // Hard stops: without these the call cannot be made at all, so nothing is spent.
  if (!c.open) add("no_account", "stop", c.demo ? "Demo profile: the AI opens with the online account." : "The AI opens with the online account, soon.");
  else if (!c.signedIn) add("no_signin", "stop", "Sign in first (in the menu).");
  else if (!(c.balance >= 1)) add("no_edelweiss", "stop", "No edelweiss left: earn one with an achievement or an event.");
  // Warnings: the call can be made, but the answer may be empty or weaker.
  if (!x.race || !(x.race.km > 0)) add("empty_dataset", "warn", "No race GPX loaded: there is nothing to analyse. The AI will return nothing and the edelweiss will be spent.", "race");
  else if (x.race.km < 1 || !(x.race.gain > 0)) add("flat_course", "warn", "The race GPX is under 1 km or has no climbing: the plan will be thin.", "race");
  if (!x.gpxRuns && !x.storedRuns) add("no_runs", "warn", "No old run, in Your runs or in your account: the AI will only use the standard rules.", "runs");
  if (x.targetText && x.targetSec === null) add("target_unread", "warn", `"${x.targetText}" is not a time (use h:mm, e.g. 7:30): it will be ignored.`, "target");
  else if (x.targetSec && x.centralSec && (x.targetSec < 0.5 * x.centralSec || x.targetSec > 3 * x.centralSec)) add("target_odd", "warn", "This target is far from your calculated time (under half or over three times): check it.", "target");
  if (AIC_OFF_TOPIC.test(x.notes || "")) add("notes_off_topic", "warn", "Your free information looks like a request, not facts about you or the race. The AI only analyses your data and may return nothing.", "notes");
  if (AIC_OFF_TOPIC.test(x.question || "")) add("question_off_topic", "warn", "The AI only analyses your race and runs. This question will probably return nothing.", "question");
  return out;
}
