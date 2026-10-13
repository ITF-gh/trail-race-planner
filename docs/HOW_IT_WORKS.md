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
- **Hiking threshold.** The first uphill band where your cadence falls below 145 steps per minute. When running turns into hiking, cadence collapses; that is where your own data says hiking starts.

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
- **Tactics** come from simple rules: hike if the average gradient is within 2 points of your hiking threshold, hike the steep part if a 100 m pitch is well above it, run gentle climbs, steady in between.
- **Long climbs are split into sections.** A climb of 3 km or more is too long to manage as one effort, so it is cut into sections of at least 1.5 km (`splitClimbM`, `sectionMinM`). The number of sections is as many as fit; where to cut is chosen by **dynamic programming**: among all allowed cut positions, pick the one where each section's 10 m gradients scatter least around that section's own average (lowest sum of squared deviations, computed in constant time per section from **prefix sums**). Cuts therefore land where the slope changes character, such as a runnable ramp turning into a wall. Each section gets its own tactic, pace and clock time.
- **Descents** are tagged Brake (steepest 100 m of 20% or more, or average 12% or more), Control, or Let it run.
- **Gels** go every N minutes of race time, moved to the top of a climb when one would land mid-climb. Eating while climbing hard is harder than eating on easy ground.
- **Heart-rate guide** is anchored on the average heart rate of your reference run: lower early, around the reference in the middle, a few beats higher late if the legs allow. If you give a max heart rate, the guide is capped at 92% of it.

## 7. Two front ends, one core (`cli.js`, `src/ui/`)

Every file in `src/core/` is a **pure function**: text and numbers in, numbers out, no reading of files, no drawing. That is why the command line and the browser app share the calculation, and why the tests run in plain Node without a browser. The thin layers around the core only read input and show output. When you extend the project, put new maths in `src/core/` with a test, and keep the UI thin.

## Ideas for what to build next

- Save an analysed effort profile so you do not re-upload the file.
- Use several reference runs and weight the recent ones.
- Fit the fatigue curve on elapsed time, not on position.
- Add weather and temperature to the pace factor.
- Read FIT files directly (the binary format Garmin watches record).
- Add an aid-station list with planned stop times.
