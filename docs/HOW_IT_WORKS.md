# How it works

This note explains the ideas behind the planner, in the order the data flows through the code. Each section names the file to open.

## 1. From GPX to evenly spaced samples (`src/core/track.js`)

A GPX file is a list of GPS points: latitude, longitude, elevation, and for a recorded run a timestamp, heart rate and cadence. A watch records them roughly once per second, so the points are close together when you run slowly and far apart when you run fast. Almost every calculation here is simpler on a regular grid, so the first step is **resampling**: walk along the track and produce one sample every 10 metres, interpolating each channel between the two surrounding GPS points.

Distance between two points uses the **haversine formula**, which gives great-circle distance on a sphere. It is accurate to well under 1% for our distances.

## 2. Gradient, and why smoothing matters (`src/core/terrain.js`)

Gradient in percent is rise divided by run, times 100. A 10% gradient climbs 10 m over 100 m of ground.

GPS elevation is noisy: a flat road can wobble by a few metres. Computed raw, that noise becomes thousands of fake 20% climbs. Two filters tame it:

- a **moving average** on elevation (plus or minus 30 m), and
- a gradient window (plus or minus 40 m) so the gradient does not flip sign at every bump.

More smoothing means fewer invented climbs and also flatter real ones. There is no perfect setting, only a consistent one (see section 4).

### Finding climbs and descents

A **zigzag filter** walks the smoothed elevation and records a turning point only when the track reverses by more than 8 m from its last extreme. A small dip in the middle of a long climb therefore does not split the climb in two. Each stretch between turning points is a climb or a descent. For each we keep the length, gain or loss, average gradient, and the **steepest 100 m**. The steepest-100 m figure matters because an average hides the wall inside a climb: a 5% climb with a 20% pitch is hiked in the middle, a 5% climb that is even all the way is run.

## 3. Learning how you move (`src/core/effort.js`)

The model needs to know your pace on each gradient. Rather than use a formula for an average runner, the app measures it from a run of yours.

1. Slide a window along the reference run and measure speed (distance over time) and gradient.
2. Drop windows where you were almost stopped (below 0.6 m/s).
3. Sort the remaining slices into **gradient bands**: flat, +2 to +6%, +6 to +10%, and so on, plus the descent bands.
4. In each band, compute your pace, heart rate and cadence. Do it separately for the first half of the run ("fresh") and the second half ("tired").

The gap between fresh and tired is your personal **fatigue curve**. A runner who loses 25% of their climbing speed but only 5% on the flat gets a different plan from one who fades evenly.

Bands with under a minute of data fall back to typical ratios to your flat pace and are marked "estimated" in the app, so you know what is measured and what is a guess.

### Extras read from the same file

- **Cadence per foot.** Many devices record 85 instead of 170. If the median cadence while running is under 120, the app doubles it.
- **Heart-rate drift.** Compare speed per heartbeat on the flat in the first and second half. A drop above about 5% (called cardiac decoupling) means your aerobic durability or fuelling limits you.
- **Hiking threshold.** When running turns into hiking, cadence collapses below about 145 steps per minute. Every uphill slice of your run is labelled run or hike by its cadence, and the app looks for the one gradient that best separates the two with the rule "hike when it is this steep or steeper": the gradient that misclassifies the fewest seconds. This is a **decision stump**, the simplest classifier in machine learning. An earlier version averaged cadence per gradient band, which failed on a band you half run and half hike (170 and 124 average to 147, which is neither).

### Several reference runs

You can give several runs. Each one counts with a weight that halves every 28 days of age, measured from the most recent run (an **exponential decay**, written w = 0.5^(age / half-life)). A run from 8 weeks before your latest counts a quarter. Every slice of every run goes into the same gradient bands with its weight, so the paces are weighted averages, and bands that one run barely touched get more data from the others.

## 4. The golden rule: measure on both sides the same way (`GRADE_HALF_WINDOW`)

On the first real test, the central prediction moved from 3h27 to 3h41 just by changing how gradient was measured on the effort file. The cause: if you measure steepness over 20 m on your run, short steep pitches look steep and slow. If you then measure the race over 80 m, the same pitches are averaged away and land in gentler bands, which your table says are fast. The prediction comes out too optimistic.

The fix is one shared constant, `GRADE_HALF_WINDOW`, used for the race and for the effort file. It is a general lesson for any model that learns from one dataset and applies to another: **calibrate and apply at the same resolution.**

## 5. Predicting the race (`src/core/model.js`)

For every 10 m of the course, take the pace of its gradient band and slide it from fresh to tired along the race. Add up the seconds. That gives a finish time and a clock time at every point.

Three adjustments stand in for what one reference run cannot tell us:

| Adjustment | What it represents | Default |
|---|---|---|
| Terrain | Roots, mud, leaves, crowds are slower than your training path | smooth 1.03, mixed 1.06, technical 1.09 |
| Duration | A longer race cannot be held at the reference effort | pace × (race time / reference time)^0.07 |
| Scenario | A plausible spread around the central guess | best −3.5%, central, cautious +3.5% |

The duration rule is a cousin of the **Riegel formula** (time2 = time1 × (distance2 / distance1)^1.06), which says endurance fades by a power law. The exponent 0.07 is a typical value for a trained amateur; raise it if you fade fast.

### Honest limits

- The model slides fresh to tired by **position along the course**, not by elapsed time.
- It assumes the reference run reflects your current fitness. An old or easy run gives an old or easy plan.
- It cannot see mud, heat, a missed gel or a bad day. The three scenarios are a range, not a promise. Expect errors of 5 to 10%.

## 6. From numbers to a plan (`src/core/plan.js`)

- **Difficulty score** of a climb: gain × steepness factor (average gradient ÷ 8%, capped between 0.5 and 2) × fatigue factor (1.00 early, 1.15 mid-race, 1.35 late). The fatigue factor is there because your data shows climbs cost more late in a run. The score is a guide for deciding where to save energy, not a physical quantity.
- **Tactics** come from simple rules: hike if the average gradient is within 2 points of your hiking threshold, hike the steep part if any 100 m stretch reaches the threshold (even inside a gentle climb), run gentle climbs, steady in between.
- **Long climbs are split into sections.** A climb of 3 km or more that gains at least 100 m (`splitClimbMinGain`) is too long to manage as one effort, so it is cut into sections of at least 1.5 km (`splitClimbM`, `sectionMinM`); a long but nearly flat "climb" stays whole. The number of sections is as many as fit; where to cut is chosen by **dynamic programming**: among all allowed cut positions, pick the one where each section's 10 m gradients scatter least around that section's own average (lowest sum of squared deviations, computed in constant time per section from **prefix sums**). Cuts therefore land where the slope changes character, such as a runnable ramp turning into a wall. Each section gets its own tactic, pace and clock time.
- **Descents** are tagged Brake (steepest 100 m of 20% or more, or average 12% or more), Control, or Let it run.
- **Gels** go every N minutes, counted from the previous gel actually taken. A gel due within 10 minutes of an aid station is taken there; otherwise it moves to the top of a climb when it would land mid-climb (eating while climbing hard is harder than on easy ground), or to the bottom of a technical descent. If that top or bottom is more than 20 minutes away (a long alpine climb), the gel is taken at the end of the current climb section, or on the way up; before a long descent, it is taken just before dropping in. No gel in the last 15 minutes.
- **Aid stations** are typed as "km name minutes". Each stop is added to every clock time after the station, so checkpoints and the finish include them. The race-length fade is computed on moving time only.
- **Heart-rate guide** is anchored on the average heart rate of your reference run: lower early, around the reference in the middle, a few beats higher late if the legs allow. If you give a max heart rate, the guide is capped at 92% of it.

## 7. Two front ends, one core (`cli.js`, `src/ui/`)

Every file in `src/core/` is a **pure function**: text and numbers in, numbers out, no reading of files, no drawing. That is why the command line and the browser app share the calculation, and why the tests run in plain Node without a browser. The thin layers around the core only read input and show output. When you extend the project, put new maths in `src/core/` with a test, and keep the UI thin.

## 8. Seeing it: map and race-day replay (`src/ui/map.js`, `src/core/script.js`, `src/ui/replay.js`)

**Map.** Every GPX point has a latitude and longitude. The resampling step interpolates them like elevation, and the plan keeps one point every 100 m (`course.route`). A web map is a mosaic of 256 px images ("tiles") cut for each zoom level; Leaflet downloads the tiles in view and draws the course on top as SVG lines, using the same projection as the tiles (Web Mercator). Each climb is painted in its difficulty colour, so the map and the profile read the same way.

**Timeline.** The model already knows the clock time at every 10 m. The plan keeps it every 100 m per scenario (`timeline`), aid-station stops included. Going from a clock time to a position is then a *binary search* in that sorted list (halve the range until one 100 m step is left) and a linear interpolation inside the step.

**Script.** `raceScript` turns the plan into moments in time order (start, each climb and its top, braking descents, gels, aid stations, halfway, the key zones, the finish), each with a short cue. `raceStateAt` answers "where am I at second t": km, altitude, gradient, pace, the climb or section you are on, the next gel and aid station.

**Replay.** `requestAnimationFrame` runs a function before each screen refresh. Each frame advances race time by the real time elapsed times the speed (one race hour in 10 s by default), and redraws only what changed. With "Stop at each moment" on, the replay pauses when it crosses a moment, so you can read the cue and picture the place. Rehearsing like this is a form of *mental imagery*, which athletes use to make race day feel familiar.

**Sections.** `raceLegs` (in `script.js`) cuts the course into numbered sections with no gap and no overlap: every climb (a long climb section by section) and every descent of the briefing, and a "runnable" section wherever the gap between them is 300 m or more (a shorter gap joins the section before). Each section carries its own targets, read off the scenario's timeline: in and out clock, time on it, moving pace (aid-station stops left out), metres up and down, the gels and aid stations on it and the heart-rate band of that phase. The replay finds the section you are on by km, and only when that number changes does it light it up in three places: the bar of sections above the map (each block as wide as its share of the course, coloured like the profile), the map and the profile (a soft glow drawn under the coloured line, so the section keeps its difficulty colour and only shines, plus a faint band on the profile). Tap a block on the bar to jump there; the map zooms onto that section and the next. Tapping or clicking the profile jumps the runner there and opens a pop-up for that section (it closes on the next tap elsewhere): its length and its real metres up (D+) and down (D−). If the OpenStreetMap tiles fail to load (four errors before any tile arrives), the map switches once to the Light map (CARTO), so it never stays a blank grey box. Under the section title, one line shows the section strategy with its pictogram (▲ climb, ▼ descent, ➜ runnable) and the next section; the moment cue below the card keeps only its title (full text in its tooltip). The Target/Now table has fixed column widths and never wraps. The panel never scrolls: rows of the "coming next" list that do not fit are left out (`fitPanel`). The panel next to the map compares Target and Now for the section, in the order a runner checks them: pace, gradient, elevation done (`gainLoss` from the section start to the runner), share of the section done, and time in the section.

**Race targets.** `raceTotals` gives the numbers for the whole race: finish, duration, average pace (finish time ÷ distance, stops included) and moving pace, gels, aid stops, and an average heart-rate forecast: the time-weighted mean of the value expected in each phase of the heart-rate guide (the middle of each band). With no heart rate in your run, it says so instead of guessing.

## 9. Key zones: where the race is played (`src/core/keyzones.js`)

A key zone is a **short stretch** where how you run changes your race. It is not only about gaining time but about managing effort, so each zone has a mode:

- **Attack**: push, time is won here. A climb *section* (a whole climb only when all its sections are key and merge), a long runnable stretch late in the race, the steep part of a late descent.
- **Prepare**: set up what comes next. The 0.8 to 2.5 km of easy ground before a big climb: eat, drink, let your heart rate drop, arrive at the foot fresh.
- **Manage**: protect your effort for later. The start (going out too fast is paid back at the end), a wall (the steepest 400 m of a climb at 18% or more, where over-pushing costs the rest of the climb), the restart after a long descent (heavy legs want to walk), the steep part of an early descent (save the quads).

Each candidate gets **minutes in play**: the typical gap, on that stretch and what follows, between runners of your level who run it well and those who do not.

    in play = time on the stretch × spread(when) × weight(kind)

- **Time on the stretch** comes from your prediction. Before both files are loaded it comes from **Tobler's hiking function** (speed = 6·e^(−3.5·|slope + 0.05|) km/h), scaled for a runner.
- **Spread** is how much runners differ at that point: 3% at the start, growing with the square of the distance covered to 18% at the finish (*fatigue divergence*: fresh legs all look alike, tired legs do not).
- **Weight**: climb sections 1.0 (×1.3 on the last big climb), runnable stretches and restarts 2.0 (running versus walking is a bigger gap than the usual spread), descents 0.5 early to 0.9 late. A Prepare zone or a wall is worth 40% of what its climb puts in play (what you protect), the start 0.6% of the finish time.

The best are kept without overlapping (a *greedy selection*), one per 13 km of race (1 to 7). So length sets how many zones, the profile sets where, and your timing sets how much each is worth.

Not modelled yet, but they would move zones: night and dawn (start time and date), heat and altitude, technical ground (OpenStreetMap trail tags), narrow single track where overtaking is hard, and cut-off times.

## 10. Looking back: the My run mode (`src/core/review.js`, `src/ui/review.js`)

The rest of the app looks forward. My run looks back at one recorded run and asks: where was I strong, where did it cost me?

**Grade-adjusted pace (GAP).** 7:00/km on a 15% climb is a harder effort than 5:00/km on the flat, so raw pace cannot compare them. Minetti and colleagues (2002) measured the energy cost of running on slopes from -45% to +45%: a polynomial C(i), in joules per kg per metre, with C(0) = 3.6. One metre at +10% costs C(0.10) / C(0) = 1.66 flat metres. Every 10 m of the run is converted into flat-equivalent metres that way, and GAP = moving time / flat-equivalent distance: the flat pace that would have cost the same energy. Downhill the lab curve promises savings of up to 50%, but on a trail you brake (rocks, roots, quads), so only half of the saving is kept.

**Stops.** On the 10 m grid a stop is a sample that took far too long. Any sample slower than 0.3 m/s (a slow hike is about 0.5) holds a stop: the time above what those 10 m take at your usual (median) speed. Stops count in the clock, not in the paces.

**A fair yardstick.** A climb is compared with your other climbs that day, a descent with your descents, a runnable stretch with your runnable stretches, all in GAP. +8% means 8% better than your own average on that kind of ground. That is the colour of the section bar, the map and the profile (green better, red worse), and it puts every metre on one scale, so a fade is a real fade and not just the start of a long descent.

**Running totals.** Moving time, flat-equivalent metres, heartbeats and hiking time are stored as cumulative sums (prefix sums), so the average over any stretch is one subtraction: (S[b] − S[a]) / (M[b] − M[a]). Sections, per-km splits, the ±300 m colouring and the live "Now" column of the replay all use it.

**Key moments.** The strongest and weakest climb, descent and runnable stretch (only when the gap to your average is 6% or more), stops of a minute or more, where the fade starts (the first point after a quarter of the run from which you stay under 95% of your day's average), a strong or tough finish (last 10%), heart-rate drift (speed per heartbeat, first half against second half: over 5% is the classic decoupling threshold), your hardest minute of heart rate, and stretches of 300 m or more walked on ground under 5% (cadence under 145 steps per minute). Each one says what happened with numbers, and most add a tip for next time.

**Honest limits.** GAP ignores terrain (mud, rocks, snow), wind and heat. A stop where your watch auto-paused leaves no points, which looks the same as a stop. "Strong" and "weak" are relative to your own day: an evenly run day has few moments, which is a good sign.

## 11. The plan on your watch (`src/core/garmin.js`)

A GPS watch follows a *course*: the route plus *course points*, named spots that raise an alert as you approach them. Fewer alerts are read better, so the planner groups neighbouring sections that share a strategy (`strategyBlocks`: three HIKE sections in a row are one block, gentle sections under 60 m up or down are just RUN) and writes one alert per block, `HIKE 5.5k +726` (strategy, length, D+ or D-), plus one per key zone marked `!`, `!POWER HIKE 2.3k`, which replaces a block alert at the same spot. Watches show 15 characters of a name (a 30-character test name gave an error), so names are cut to that and each one is tried from airy to packed until it fits; the long sentence goes in the point's note. Each point comes at least 200 m and 1 minute (at plan pace) after the one before, so alerts never stack. The 78K demo gets 30 alerts for 41 sections.

In Prep my race, the **Watch messages** list shows these alerts before export: the runner can rewrite any (15 characters), untick some, or add their own at a km (`editedPoints` applies the edits, saved in the browser, then spaces everything out again). The files carry that version.

The **Prep my run** mode (`src/core/preprun.js`, `src/ui/preprun.js`) does the same for any run to come, from its GPX alone: the same course reading (climbs, sections, descents, key zones) and tactics (hiking from 15% by default), with times from Tobler's hiking function stretched to your target time when you give one, or from your reference runs when Plan a race has some loaded. The panel and the download are shared (`src/ui/watch.js`).

The Garmin file is **FIT** (Flexible and Interoperable Data Transfer), a binary format: a 14-byte header, then messages, then a CRC-16 checksum. Each message type is first *defined* (which fields, how many bytes, which base type) and then *written* as raw values in that layout, so the file describes itself and stays compact (the 78K demo is 78 KB as FIT, 290 KB as GPX). A course is `file_id` (type course), `course` (name, sport), `lap` (totals), a timer start `event`, the `record`s (position in semicircles, altitude, distance, time) with the `course_point`s between them in distance order, and a timer stop `event`. The record times come from your plan, so the watch's Virtual Partner runs at your planned pace. Course point icons are an enum of the FIT SDK; only the classic ones (generic, summit, valley, danger) are used, because Garmin Connect stalled on a point with a newer type. The GPX follows Garmin Connect's own export: each waypoint has a `<name>`, a `<cmt>` (the point's note, here the full sentence) and a `<type>` with the icon name in capitals (`GENERIC`, `SUMMIT`...). Both exports are checked in `tests/garmin.test.js` (the FIT CRC of a valid file comes out to 0).

## Ideas for what to build next

- Save an analysed effort profile so you do not re-upload the file.
- Fit the fatigue curve on elapsed time, not on position.
- Add weather and temperature to the pace factor.
- Read FIT files directly (the binary format Garmin watches record).

## Modes and the targeted duration

Three modes share one page: Prep my race (no `mode` in the address), Prep my run (`?mode=prep`, section `s-prep`, ui/preprun.js) and See my run (`?mode=run`, ui/review.js). `setMode` in main.js sets `data-mode` on `<html>` (CSS hides `.plan-only`, `.prep-only`, `.review-only` outside their mode), stops whatever replay is not on screen, keeps the address in step and sends a `trp-mode` event other modules can follow.

**Targeted duration.** In D-day, an optional h:mm goal is checked by `judgeTarget` (plan.js) against the three scenarios, which span best (−3.5%) to cautious (+3.5%) around the central prediction. Inside that range it is *realistic*; up to 5% faster than the best case it is *ambitious* (the model itself is usually within 5 to 10%, so a great day can get there); more than 5% faster than the best case it is *not backed by your runs*; slower than the cautious case it is *comfortable*. The card also gives the average pace the goal needs, stops included, next to the central one.
