# Trail Race Planner

Give it a race course (GPX) and one of your own recorded runs (GPX). It learns how fast you move on each kind of terrain, then predicts the race and writes a plan: pace by gradient, which climbs to hike, which descents to brake on, gel stops, checkpoints, and a heart-rate guide.

Then it lets you **rehearse race day**: the course on an OpenStreetMap map, and a replay where a runner moves along the map and the profile at your predicted pace, stopping at each climb, gel and aid station with a short cue of what to do there. It also marks the **key zones**, the stretches where the race is played, ranked by the minutes at stake.

Your files are read on your own machine. Nothing is uploaded.

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
src/demo.js            made-up GPX files for the demo and the tests
src/ui/                the browser app (main.js, map.js for the map, replay.js for race day,
                       analytics.js for anonymous visit and event counts)
src/vendor/leaflet/    Leaflet 1.9.4, the map library (BSD-2 licence), copied to dist/vendor/
cli.js                 the command-line tool
scripts/build.js       bundles the app into dist/index.html, no dependencies
tests/                 node:test suite on made-up data
docs/HOW_IT_WORKS.md   the ideas behind it, with the reasoning
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

GPX files and plans never leave the browser. The only thing the page sends out is anonymous visit and event counts (see Analytics).

## Analytics

The live page counts visits and a fixed set of events with [GoatCounter](https://www.goatcounter.com): no cookies, no personal data, so no cookie banner. Everything is in `src/ui/analytics.js`:

- `ANALYTICS.site` is the GoatCounter site code (`trail-race-planner`, dashboard at https://trail-race-planner.goatcounter.com). Empty means analytics is off: no script is loaded and nothing is sent.
- `ANALYTICS.provider` switches to `"plausible"` (site = your domain) or `"cloudflare"` (site = beacon token; page views only, Cloudflare Web Analytics has no custom events).
- The app calls `trackEvent(name, label)` and `trackOnce(name, label)`. Names and labels come from the code only, never from file names or what the runner typed.

Events: `demo`, `plan-built/demo|own` (once per visit), `gpx-upload/race|run`, `gpx-error/race|run`, `runs-clear`, `setting/<field>`, `section-reached/s1..s4` (once per visit), `nav/s1..s4`, `nav/race-day-button`, `briefing-tab/climbs|descents`, `scenario/<id>`, `dday-tab/<id>`, `log-mode/<mode>`, `log-time-entered` (once), `export/markdown|json`, `map-layer/<layer>`, `map-recenter`, `replay-play`, `replay-pause`, `replay-step/prev|next`, `replay-seek`, `replay-speed/<x>`, `replay-pause-at/on|off`, `replay-follow/on|off`, `replay-moment/<kind>` (`key` is a key zone), `replay-profile-tap`, `replay-keyboard` (once).

GoatCounter does not count `localhost`, so local testing stays out of the numbers. To leave out your own visits on the live site, open it once with `#toggle-goatcounter` at the end of the address.

## Status and honesty

This is a first version. The model is a transparent pace table, not a physiological simulation. Treat the three scenarios as a range of plausible outcomes. Typical error for this kind of model is 5 to 10%. See "Honest limits" in `docs/HOW_IT_WORKS.md`.

## Map

The map uses [Leaflet](https://leafletjs.com) with tiles from [OpenStreetMap](https://www.openstreetmap.org/copyright) (or [OpenTopoMap](https://opentopomap.org) for contour lines), credited in the map corner. Leaflet ships with the page and loads only when a map is shown. Without a network the tiles are missing but the course, markers and runner still draw; if Leaflet itself cannot load, a plain drawing of the course shape takes its place. The demo course is drawn as a made-up loop over the Vercors: its profile does not match the real ground there.

## Photos

The hero and section banners use free photos from [Pexels](https://www.pexels.com/license/), credited on the page:
Artem Meletov (hero), Hobi Photography (01, mirrored), Elina Volkova (02), Jack Davis (03).
They live in `src/ui/photos/` as WebP files cropped to the slot shape (1920×1080 hero, 900×1200 phone hero,
1600×600 banners), and the build copies them to `dist/photos/`. Swap a file to change a photo.
