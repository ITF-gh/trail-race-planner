// changelog.js: the "What's new" list, newest first, in runner's words (the git log has the
// technical detail). The first entry is the current version: the footer shows it on every page.

export const CHANGELOG = [
  { v: "0.36", date: "2026-10-16", items: [
    "User guide with a screenshot and tips for every mode and section, and an FAQ.",
    "A \"?\" next to each section title: what it shows, in three lines, with a link to the guide.",
    "About, Privacy and What's new pages, a site footer with contact, credits and the version.",
    "Tab icon and a preview card when the link is shared; a proper page for broken links.",
  ] },
  { v: "0.35", date: "2026-10-16", items: ["New name: Prep my race. Modes Prep my race, Prep my run and Rewind my run; one-word sections Engine, Course, Plan, Rehearsal, Watch, Recap, Deep dive.", "Account menu shows a demo profile until your own runs are logged."] },
  { v: "0.34", date: "2026-10-16", items: ["Export A4: print each mode as clean A4 pages, or save them as a PDF."] },
  { v: "0.33", date: "2026-10-15", items: ["Online account prepared (sign-in by email link, cairns checked on the server, one AI analysis per cairn). Not open yet: nothing is sent."] },
  { v: "0.32", date: "2026-10-15", items: ["Account menu: a log of your runs on this device, with stats, bests, achievements and cairns. Export or delete it any time."] },
  { v: "0.31", date: "2026-10-15", items: ["Deep dive: about twenty key figures and interactive charts of your run (best efforts, gradient bands, heart-rate zones, climbs). Click a point and the replay jumps there."] },
  { v: "0.28", date: "2026-10-15", items: ["Your numbers: fastest 200 m, 1 km and 5 km, steepest 100 m, splits, and a pace line on the profile."] },
  { v: "0.27", date: "2026-10-15", items: ["Sky mode: a bright theme with painted skies and light map tiles. Night stays the default."] },
  { v: "0.26", date: "2026-10-15", items: ["Lighter look everywhere: less air, smaller banners, foldable titles. Watch messages behind a street-art sticker next to the key figures."] },
  { v: "0.24", date: "2026-10-15", items: ["Watch: the race GPX given back with your plan on it, messages editable before download.", "Course profile: drag to zoom on a stretch."] },
  { v: "0.23", date: "2026-10-15", items: ["Prep my run shows the run like race day: section bar, map, profile and play button."] },
  { v: "0.20", date: "2026-10-15", items: ["Three modes: Prep my race, Prep my run and Rewind my run.", "Targeted finish time: the planner says if your runs back it up.", "Rewind my run: compare the run with the time or pace you aimed for, with a ghost runner."] },
  { v: "0.19", date: "2026-10-15", items: ["Photos by mode, never a recognisable face. Rehearsal panel always fits the screen; the map falls back to other tiles if one server fails."] },
  { v: "0.16", date: "2026-10-15", items: ["Review a run you just did: its key moments, good and bad, replayed on the map.", "Download the plan as a Garmin course (FIT) or a GPX with messages along the course."] },
  { v: "0.13", date: "2026-10-15", items: ["Rehearsal fits one screen, on desktop and phone: targets, section bar, profile, map, and a Target / Now panel."] },
  { v: "0.11", date: "2026-10-15", items: ["Race cut into numbered sections, each lit up on the bar, the map and the profile as the replay plays.", "Anonymous visit counts, without cookies."] },
  { v: "0.8", date: "2026-10-14", items: ["The course on an OpenStreetMap map, a race-day replay, and key zones: the short stretches where the race is played."] },
  { v: "0.6", date: "2026-10-13", items: ["Demo: a 78 km mountain ultra with seven aid stations, planned from two 30 km long runs."] },
  { v: "0.5", date: "2026-10-13", items: ["Real trail photos in the header and the section banners."] },
  { v: "0.3", date: "2026-10-13", items: ["Hiking threshold learned from your cadence, several runs combined (recent ones count more), aid stations."] },
  { v: "0.2", date: "2026-10-13", items: ["New design, and long climbs split into sections of their own."] },
  { v: "0.1", date: "2026-10-13", items: ["First version: a race plan built from one of your runs and the race GPX."] },
];
