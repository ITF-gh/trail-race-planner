# Trail Race Planner

Give it a race course (GPX) and one of your own recorded runs (GPX). It learns how fast you move on each kind of terrain, then predicts the race and writes a plan: pace by gradient, which climbs to hike, which descents to brake on, gel stops, checkpoints, and a heart-rate guide.

Your files are read on your own machine. Nothing is uploaded.

## Use it

**In the browser.** Open `dist/index.html` (run `npm run build` first). Press "Try the demo" to see a full plan on made-up data, or drop in your own two files.

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
src/demo.js            made-up GPX files for the demo and the tests
src/ui/                the browser app
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

## Status and honesty

This is a first version. The model is a transparent pace table, not a physiological simulation. Treat the three scenarios as a range of plausible outcomes. Typical error for this kind of model is 5 to 10%. See "Honest limits" in `docs/HOW_IT_WORKS.md`.

## Photos

The hero and section banners use free photos from [Pexels](https://www.pexels.com/license/), credited on the page:
Artem Meletov (hero), Hobi Photography (01, mirrored), Elina Volkova (02), Jack Davis (03).
They live in `src/ui/photos/` as WebP files cropped to the slot shape (1920×1080 hero, 900×1200 phone hero,
1600×600 banners), and the build copies them to `dist/photos/`. Swap a file to change a photo.
