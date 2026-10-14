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

## Ideas for what to build next

- Save an analysed effort profile so you do not re-upload the file.
- Fit the fatigue curve on elapsed time, not on position.
- Add weather and temperature to the pace factor.
- Read FIT files directly (the binary format Garmin watches record).
