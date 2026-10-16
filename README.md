# Prep my race · trail race & run planner

Give it a race course (GPX) and one of your own recorded runs (GPX). It learns how fast you move on each kind of terrain, then predicts the race and writes a plan: pace by gradient, which climbs to hike, which descents to brake on, gel stops, checkpoints, and a heart-rate guide.

Then it lets you **rehearse race day**: the course on an OpenStreetMap map, and a replay where a runner moves along the map and the profile at your predicted pace, stopping at each climb, gel and aid station with a short cue of what to do there. It also marks the **key zones**, the stretches where the race is played, ranked by the minutes at stake.

The switch at the top picks one of three modes. **Prep my race** (the default) is everything above, plus an optional **targeted duration**: the planner says whether your runs back it up (realistic, ambitious, not backed, or comfortable), against its three scenarios. **Prep my run** (`?mode=prep`) takes the GPX of a run you are about to do and gives it back with its details for your watch. **Rewind my run** (`?mode=run`): drop the GPX of a run you just did and it plays back on the map at your real pace, with your real stops and the real time of day. It finds the **key moments**, good and bad (your strongest and weakest climb and descent, stops, when the fade starts, heart-rate drift, walking where you could run) and colours every stretch by how you ran it compared with your own average on the same kind of ground. "Try a sample run" shows it on a made-up 28 km trail run.

**Recap** lists the records of the run: average and best pace (held for one minute), fastest 200 m, 1 km and 5 km, steepest 100 m up and down, highest point, then the pace of every km as bars (click one to replay it) and a full table. On the profile, a thin blue line shows your pace (smoothed over 100 m, higher = faster) behind the elevation: a bright dot follows the runner, the stretch just run glows, and what is done fades.

**Deep dive** goes further, with charts you can play with: about 20 key numbers (VAM, split ratio, grade-adjusted fade, cadence and stride, efficiency factor, aerobic decoupling, heart-rate zones and training load, energy), with your weight and heart rates as settings; best efforts for any distance on a slider; pace by gradient band; a pace histogram; an explorer to cross any two measures (with the best-fit line and correlation); and every climb and descent in a table. Click any point or row to replay that moment.

Give it the **target** you were aiming for (a finish time or an average pace) and it compares: how far you were, how much of the gap was stops (1 min per hour is allowed), the fade (your second half run at your first-half effort) and real speed still to find. It spreads one even effort over the run, so every section gets a target time in proportion to how *you* run that kind of ground, and it shows where to find the time and where you spent too much too early. It also tells you whether the target is within reach, a stretch, or far for now, and suggests a realistic one. During the replay a ghost runner on the target pace shows how far ahead or behind you are.

Your files are read on your own machine. Nothing is uploaded.

**My account** (the round icon at the top right) keeps a run log on this device: every run you open in Rewind my run, or add to Your runs in Prep my race, is summarised (about 1 KB: date, distance, climbing, best 1, 5 and 10 km, climbing speed, fade, heart drift) and stored in the browser's IndexedDB. The menu shows your last 12 months, all-time bests, last runs, achievements (icons) and the AI tokens they earn, the **edelweiss** (sparkle logo; All-time bests open in a pop-up). Sample and demo runs are not stored. While this device has no run of its own, the menu shows the demo profile **User1** with 22 made-up runs (`src/core/demorecords.js`), never stored or sent; your first saved run replaces it. Export my data downloads the log as JSON; Delete my runs empties it.

**Online account (optional).** Signing in with an email link keeps the run log and the cairns in your account (Supabase, EU). The server recomputes the achievements from your runs and pays each one once. **Ask the AI** opens a window where you choose the source data (a date range, or the runs you tick), an axis of analysis (overall, endurance, climbing, speed, heart rate, race prep, load and recovery) and, optionally, your own question ("How can I go sub-40 in 10K in a month?"); 1 edelweiss buys 1 analysis. Claude reads one line per selected run (no names, no GPS points) and returns a direct answer, new KPIs, strengths, what to work on and the next weeks. The edelweiss is refunded if the analysis fails. Internally (database, server) the token is still called a cairn. Setup: [supabase/SETUP.md](supabase/SETUP.md). Not open yet: writes are closed in the app (`CLOUD.open` in `src/ui/cloud.js`) and in the database (`writes_open()`), so nothing is sent or stored.

## Use it

**In the browser.** Open `dist/index.html` (run `npm run build` first). Press "Try the demo" to see a full plan on made-up data (a 78 km mountain ultra with 3,800 m of climbing and seven aid stations, planned from two 30 km mountain long runs), or drop in your own two files.

**From a terminal.**

```
node cli.js --race course.gpx --effort my-run.gpx --start 09:00 --max-hr 190
```

Give several runs with `--effort` more than once (recent ones count more), and aid stations with `--aid "8.5 Refuge du Lac 2"` (km, name, minutes stopped). Other options: `--terrain smooth|mixed|technical`, `--scenario best|central|cautious`, `--hike-grade 15`, `--gel-every 45`, `--descent-boost 0.03`, `--json`. Run `node cli.js --help`.

No dependencies to install. It needs Node 20 or newer.

## Inputs

| Input | What it is | Why |
|---|---|---|
| Race course GPX | The official route, with elevation | Gives every climb and descent |
| Effort reference GPX | A recorded run of 1.5 hours or more at a steady effort, with some climbs | Your pace on each gradient, fresh and tired |
| Start time | Race start | Clock times |
| Terrain | smooth, mixed or technical | Race ground is slower than a training path |
| Max heart rate (optional) | Your measured maximum | Caps the heart-rate guide |
| Gel interval | Minutes between gels | Gel schedule |
| Hiking threshold (optional) | Gradient where you hike | Default is learned from your cadence |
| Endurance exponent | How fast you fade in a longer race | Default 0.07 |
| Faster on gentle descents | 0 to 10% | Only if your quads can take it |

A good reference run is long enough to show fatigue (so the second half differs from the first), contains climbs of several steepness levels, and was run at the effort you intend to hold in the race. The more it looks like the race, the better the plan.

## Project layout

```
src/core/track.js      read GPX, resample to a 10 m grid
src/core/terrain.js    gradient, climbs and descents (zigzag filter)
src/core/effort.js     learn your pace per gradient, fresh and tired
src/core/model.js      predict the course, three scenarios
src/core/plan.js       climbs (long ones split into sections), descents, gels, checkpoints, heart-rate guide
src/core/format.js     time and pace formatting
src/core/markdown.js   plan as Markdown
src/core/keyzones.js   key zones: where the race is played, and how many minutes are at stake
src/core/script.js     the race in time: key moments with cues, and where you are at any second
src/core/review.js     Rewind my run: grade-adjusted pace, stops, sections with a verdict, key moments of a run you did
src/core/history.js    the run log: 12-month totals, bests, achievements and cairns, record checks, AI digest (shared with the server)
src/core/runrecord.js  one small summary per run
src/demo.js            made-up GPX files for the demo and the tests
src/ui/                the browser app (main.js, map.js for the map, replay.js for race day,
                       review.js for the Rewind my run mode, print.js for the Export A4 pages (print or save as PDF), account.js for the account menu and its IndexedDB store, cloud.js for the online account, analytics.js for anonymous visit and event counts)
src/vendor/leaflet/    Leaflet 1.9.4, the map library (BSD-2 licence), copied to dist/vendor/
cli.js                 the command-line tool
scripts/build.js       bundles the app into dist/index.html, no dependencies
tests/                 node:test suite on made-up data
docs/HOW_IT_WORKS.md   the ideas behind it, with the reasoning
supabase/              online accounts: tables (migrations/), server functions (functions/), SETUP.md
```

## Live version

Every push to `main` runs the tests, builds `dist/index.html` and publishes it on GitHub Pages (`.github/workflows/pages.yml`). The hosted page is only static files: GPX files you open in it are still read in your browser and never sent anywhere.

## Commands

```
npm test         run the tests
npm run build    build dist/index.html (one self-contained file)
npm run dev      build, then serve it on http://localhost:5173
```

## Privacy

GPX files show where you live and train. `.gitignore` excludes `*.gpx` so they do not end up in a repository by accident. The tests use made-up routes.

GPX files and plans never leave the browser. The run log behind the account menu stays in this browser too (IndexedDB), with no GPS points in it. The only thing the page sends out is anonymous visit and event counts (see Analytics), unless you sign in: then the run summaries go to your account (EU), and when you ask for an AI analysis, after a consent screen, one line per run plus your heart-rate settings and weight are sent to the Claude API. Delete my account removes everything on the server.

## Analytics

The live page counts visits and a fixed set of events with [GoatCounter](https://www.goatcounter.com): no cookies, no personal data, so no cookie banner. Everything is in `src/ui/analytics.js`:

- `ANALYTICS.site` is the GoatCounter site code (`trail-race-planner`, dashboard at https://trail-race-planner.goatcounter.com). Empty means analytics is off: no script is loaded and nothing is sent.
- `ANALYTICS.provider` switches to `"plausible"` (site = your domain) or `"cloudflare"` (site = beacon token; page views only, Cloudflare Web Analytics has no custom events).
- The app calls `trackEvent(name, label)` and `trackOnce(name, label)`. Names and labels come from the code only, never from file names or what the runner typed.

Events: `demo`, `plan-built/demo|own` (once per visit), `gpx-upload/race|run`, `gpx-error/race|run`, `runs-clear`, `setting/<field>`, `section-reached/s1..s4` (once per visit), `nav/s1..s4`, `nav/race-day-button`, `briefing-tab/climbs|descents`, `scenario/<id>`, `dday-tab/<id>`, `log-mode/<mode>`, `log-time-entered` (once), `export/markdown|json`, `map-layer/<layer>`, `map-recenter`, `replay-play`, `replay-pause`, `replay-step/prev|next`, `replay-seek`, `replay-speed/<x>`, `replay-pause-at/on|off`, `replay-follow/on|off`, `replay-moment/<kind>` (`key` is a key zone), `replay-section/<kind>` (a block of the section bar), `replay-profile-tap`, `replay-keyboard` (once).

GoatCounter does not count `localhost`, so local testing stays out of the numbers. To leave out your own visits on the live site, open it once with `#toggle-goatcounter` at the end of the address.

## Status and honesty

This is a first version. The model is a transparent pace table, not a physiological simulation. Treat the three scenarios as a range of plausible outcomes. Typical error for this kind of model is 5 to 10%. See "Honest limits" in `docs/HOW_IT_WORKS.md`.

## Map

The map uses [Leaflet](https://leafletjs.com) with tiles from [OpenStreetMap](https://www.openstreetmap.org/copyright) (or [OpenTopoMap](https://opentopomap.org) for contour lines), credited in the map corner. Leaflet ships with the page and loads only when a map is shown. Without a network the tiles are missing but the course, markers and runner still draw; if Leaflet itself cannot load, a plain drawing of the course shape takes its place. The demo course is drawn as a made-up loop over the Vercors: its profile does not match the real ground there.

## Photos

The hero and section banners use free photos from [Pexels](https://www.pexels.com/license/), credited on the page.
No face is recognisable in any of them: people are seen from behind, far away or as silhouettes.
"Prep my race" keeps a nature and adventure look: Artem Meletov (hero, a summit above the clouds),
Hobi Photography (01), Elina Volkova (02), Jack Davis (03) and Lorenzo Castellino (04).
"Prep my run" and "Rewind my run" switch to sport shots: Cara Denison (hero, a runner at sunset) and Alin Serban (Rewind my run).
They live in `src/ui/photos/` as WebP files, and the build copies them to `dist/photos/`. Swap a file to
change a photo. The run-mode hero is set in CSS with `html[data-mode="run"]{--photo-hero:...}`, so the
mode switch changes it with no script. On wide screens a banner photo fills the right 64% of the banner at
its own height (`--photo-y` sets which part shows), so the runner is not cut in half behind the title.
The all-sport version (v0.18) is on branch `restore/v0.19-before-mode-photos`.
