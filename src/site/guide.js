// guide.js: the user guide, as data. One chapter per mode, one card per section.
//
// Two places read it:
//   - scripts/build.js writes guide.html from it (screenshots, steps, tips, FAQ);
//   - the app's "?" bubbles (src/ui/help.js) show a section's `what` line and link to its card.
// So the help in the app and the guide can never say two different things.
//
// `sec` is the id of the section in the app (index.html#s1), `shot` the screenshot file in
// src/site/guide/ (taken by scripts/guide-shots.mjs from the demo data).

export const GUIDE = [
  {
    id: "race", name: "Prep my race", url: "./", shot: "race-hero",
    lead: "The main mode. Drop one or more of your own runs and the race GPX: the planner learns how you move on every gradient, reads the course, and builds your race-day plan.",
    start: ["Press <b>Try the demo</b> to see a full plan on a 78 km mountain ultra, or", "drop one or more of <b>your runs</b> (1.5 h or more, steady effort, some climbs) in box 01, and", "drop the <b>race GPX</b> (the official course, with elevation) in box 02."],
    sections: [
      { id: "engine", sec: "s1", num: "01", name: "Engine", shot: "engine",
        what: "What your own runs say about you: your pace on each gradient band, fresh and tired, when you start hiking, and how fast you fade.",
        how: ["Read the pace bands: the planner uses them for every 10 m of the race.", "Check the hiking threshold: the gradient where your cadence says you switch to walking.", "Add several runs: recent ones count more (half-life in the Plan settings)."],
        tip: "Use runs on hilly ground at a steady, honest effort. A flat race-pace 10K says little about a 3,000 m ultra." },
      { id: "course", sec: "s2", num: "02", name: "Course", shot: "course",
        what: "The race on its own, before knowing who runs it: every climb and descent, how hard each one is, and where long climbs change character.",
        how: ["Drag across the profile to zoom on a stretch.", "Switch between the Climbs and Descents lists: each is scored and coloured from easy to hard.", "Long climbs are cut into sections when their gradient changes, so you see the steep walls inside."],
        tip: "Learn the order of the three hardest climbs. That is the race you will run in your head." },
      { id: "plan", sec: "s3", num: "03", name: "Plan", shot: "plan",
        what: "Your engine on this course, with your settings: finish time, clock time at every checkpoint, how to run each climb and descent, when to eat.",
        how: ["Set the start time, the terrain on the day and your aid stations (km, name, minutes stopped).", "Type a targeted finish time: the planner says if your runs back it up.", "Pick a scenario (best, average, cautious) and read the checkpoint table, the gels and the heart-rate guide."],
        tip: "Plan on the average scenario, keep the best one for a great day. The model is usually within 5 to 10%." },
      { id: "rehearsal", sec: "s4", num: "04", name: "Rehearsal", shot: "rehearsal",
        what: "Live the race before you run it: press play and follow yourself along the course at your predicted pace, with what to do on every section.",
        how: ["Press play; change the speed, or tap the section bar to jump to a section.", "Tap the profile for a section's length and climb; the map follows the runner.", "Watch the panel: target pace, gradient and time for the section you are in."],
        tip: "Replay the key zones (gold on the bar) until you know them. Race day should feel familiar." },
      { id: "watch", sec: "s-pimp", num: "05", name: "Watch", shot: "watch",
        what: "The race GPX given back with your plan on it: short messages your watch shows along the course (hike here, brake there, key zones).",
        how: ["Read and edit the messages: one per change of strategy, at least 200 m and 1 minute apart.", "Download the .fit course (Garmin) or the .gpx with the messages.", "Copy it to your watch (Garmin Connect: Courses, import) and start it as a course on race day."],
        tip: "Names are 15 characters at most: that is all a Garmin shows. Test the course on a short run first." },
    ],
  },
  {
    id: "prep", name: "Prep my run", url: "./?mode=prep", shot: "prep-hero",
    lead: "For a training run or a race you only have the GPX of. No reference run needed: drop the course, set a target, and get it read like a race course, with the GPX given back for your watch.",
    start: ["Switch to <b>Prep my run</b> at the top of the page, then", "drop the GPX of the run to come, or press <b>Try the sample run</b>."],
    sections: [
      { id: "prep-run", sec: "s-prep", num: "◆", name: "Prep my run", shot: "prep",
        what: "The run to come, read like a race course: every climb and descent, a section bar, the map, the profile and a play button.",
        how: ["Set the time you aim for: section times are stretched to it.", "Read the key figures, then play the run like a rehearsal.", "Use the watch sticker to download the course with its messages."],
        tip: "Great for a recce: you know where to hike and where to push before you leave the car." },
    ],
  },
  {
    id: "rewind", name: "Rewind my run", url: "./?mode=run", shot: "rewind-hero",
    lead: "For a run you just did. It plays back on the map at your real pace, and the planner finds the key moments: where you were strong, where it cost you, where you stopped, when you faded.",
    start: ["Switch to <b>Rewind my run</b> at the top of the page, then", "drop the GPX your watch recorded, or press <b>Try a sample run</b>."],
    sections: [
      { id: "recap", sec: "s5", num: "▶", name: "Recap", shot: "recap",
        what: "Your run played back at its real pace, each stretch coloured by how you ran it compared with your own average on the same kind of ground. Each key moment stops the replay and says what it means.",
        how: ["Press play: the replay stops at each key moment (green good, red bad).", "Add the time or pace you aimed for: a ghost runner shows the gap, split into stops, fade and speed.", "Scroll to Your numbers: fastest 200 m, 1 km and 5 km, steepest 100 m, km splits."],
        tip: "Compare like with like: the colours already account for the gradient, so a slow climb can still be green." },
      { id: "deep-dive", sec: "s6", num: "▶▶", name: "Deep dive", shot: "deep-dive",
        what: "Everything your watch recorded, turned into numbers and charts you can play with. Click a point or a row and the replay above jumps there.",
        how: ["Read the key figures at the top (about twenty of them).", "Change a distance or a band width: the charts redraw.", "Set your weight once: it is kept in this browser. Heart rate from the file is not used."],
        tip: "The best-effort curve shows your strongest pace for every duration: watch it rise over a season." },
    ],
  },
  {
    id: "everywhere", name: "On every page", url: "./", shot: "",
    lead: "The top bar and the buttons that work in every mode.",
    start: [],
    sections: [
      { id: "top-bar", sec: "", num: "≡", name: "Top bar", shot: "top-bar",
        what: "The bar that stays on top while you scroll: jump to a section, see where you are, export, switch the look.",
        how: ["Click a section name to jump there; the red line shows how far down you are.", "<b>Export A4</b> prints the current mode as clean A4 pages, or saves them as a PDF.", "<b>Sky mode</b> switches to a bright theme, handy outdoors; <b>Night</b> brings the dark one back."],
        tip: "Print the race card and keep it in your pack: checkpoint times, with blank boxes to write your real times." },
      { id: "account", sec: "", num: "◎", name: "Account menu", shot: "account",
        what: "The round icon at the top right of the header: a log of the runs you loaded on this device, with stats, bests, achievements and cairns.",
        how: ["Your own runs are added automatically (never the demo or sample). Until the first one, it shows a demo profile with made-up runs.", "Export the log as a file, or delete it, from the same menu.", "The online account is not open yet: everything stays in this browser."],
        tip: "Cairns are earned with achievements and records. Later, one cairn will buy one AI analysis of a run." },
    ],
  },
];

// Short questions, short answers. Shown at the end of the guide (guide.html#faq).
export const FAQ = [
  ["Which GPX files work?", "Any GPX with a track: from Garmin Connect, Strava, Suunto, Coros, Polar, a race website. For your own runs, time stamps are needed; cadence is a bonus. Heart rate in the file is ignored. The race GPX needs elevation."],
  ["Where do I export a GPX of my run?", "Garmin Connect: open the activity, gear icon, Export to GPX. Strava: open the activity, the ... menu, Export GPX. Suunto and Coros: open the activity in the app or website, then Export or Share as GPX."],
  ["Are my files uploaded somewhere?", "No. The planner runs in your browser: files are read on your device and never sent. Settings and the run log stay in this browser. See the <a href=\"privacy.html\">privacy page</a>."],
  ["Why is my finish time different from the race's estimate?", "Race estimates are for an average runner. This plan is built from your own pace on each gradient, so it fits you better, if the runs you gave are recent and honest. Expect 5 to 10% either way."],
  ["Which run should I give for the Engine?", "A recent run of 1.5 h or more, at a steady effort, with some climbs and descents. Several runs are better: recent ones count more."],
  ["Why is my heart rate not shown?", "On purpose: heart rate is health data, so the app never reads it from your files. Type your max and resting heart rate in your profile (account icon, then Account): they give the plan its heart-rate guide."],
  ["How do I get the watch messages on my Garmin?", "In Watch (Prep my race) or with the sticker in Prep my run, download the .fit course. In Garmin Connect, open Training, Courses, Import, then send it to your watch. Start it as a course on race day."],
  ["Can I use it offline?", "Once the page is open, it works without network, except the map tiles and the photos. An installable offline version is planned."],
  ["Is it free?", "Yes, with no account needed. An optional online account is being prepared, with AI analyses paid in cairns earned by running, not with money."],
  ["Something looks wrong. What do I do?", "Write to us (address at the bottom of every page) with the GPX if you can, and the version number shown in the footer."],
];
