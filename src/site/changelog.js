// changelog.js: the "What's new" list, newest first, in runner's words (the git log has the
// technical detail). The first entry is the current version: the footer shows it on every page.

export const CHANGELOG = [
  { v: "2.23", date: "2026-10-27", items: [
    "The online AI is switched off for now. Everything else works as before.",
  ] },
  { v: "2.22", date: "2026-10-23", items: [
    "Prep my run AI coach: pick an effort from 1 (Recovery) to 5 (Very hard). The AI prepares the whole run at that effort, a pace and an effort for every section, plus the exercises that suit it.",
    "The AI waiting runner wears trail clothes and runs up the trail toward the horizon.",
  ] },
  { v: "2.21", date: "2026-10-23", items: [
    "The AI doc lists the Best, Central and Cautious finishes of the AI plan, as Your race shows them. The app never changes the AI's numbers.",
  ] },
  { v: "2.20", date: "2026-10-23", items: [
    "The AI waiting runner is now a real trail runner (cap, vest, knees and elbows that bend) jogging slowly, Z2 easy.",
  ] },
  { v: "2.19", date: "2026-10-23", items: [
    "While the AI works, a trail runner runs along the trail and pines, a rock, edelweiss and a bird pop up on the way.",
  ] },
  { v: "2.18", date: "2026-10-23", items: [
    "The AI is switched on for signed-in testers: 1 edelweiss for one AI race plan (Prep my race) or one AI coach session (Prep my run). If the AI does not answer, the edelweiss comes back.",
  ] },
  { v: "2.17", date: "2026-10-23", items: [
    "Save A4 to my account (signed-in testers): every Export A4 box can keep that export, with the parts you ticked, in your account. Tap it in your Account window: the mode reopens and the print window opens, ready to print or save as PDF. Heart rate and weight are never saved online: the sheet is laid out again from your points.",
  ] },
  { v: "2.16", date: "2026-10-23", items: [
    "The AI is ready on the server (still off): signed-in testers will spend 1 edelweiss for one AI race plan (Prep my race) or one AI coach session (Prep my run). Every account gets 4 free edelweiss. If the AI does not answer, the edelweiss comes back.",
  ] },
  { v: "2.15", date: "2026-10-23", items: [
    "Online account: create an account (by invitation for now), Forgot password, change password, Export my data (profile, runs, files, AI answers, saves in one file) and Delete my account, in a new Sign-in and data part of the Account window.",
  ] },
  { v: "2.14", date: "2026-10-23", items: [
    "Account window: new My files list. Every GPX you give the app is kept on this device (no heart rate), tagged Run (GPS + time, pace, cadence) or Route (GPS only), and opens again in one tap in Prep my race, Prep my run or (runs only) Rewind my run.",
    "Account menu easier to read: darker background. Signed in, your name shows next to the account button.",
  ] },
  { v: "2.13", date: "2026-10-23", items: [
    "Prep my run: a Climbs and descents section, the same tables as Your route in Prep my race (stars for climbs, shoes for descents).",
    "Prep my run: the run script list is now a run timeline. Every climb, descent and runnable stretch in order, with the time since the start, the clock time, its figures and tactic; key zones in gold. Tap a step to go there in the cockpit.",
  ] },
  { v: "2.12", date: "2026-10-20", items: [
    "Privacy page brought up to date: the online account is open to invited testers (what it keeps, heart rate and weight never online), and the AI provider is OpenAI (the AI is still off).",
    "About: How it works is now six short steps; photo credits complete. Guide and FAQ say the account is open to invited testers.",
  ] },
  { v: "2.11", date: "2026-10-20", items: [
    "Rewind my run review. The key moments now pop up under the section box like text messages, the latest one with its comment, and the list below the replay is a run script of icon chips you can filter (went well, cost you, worth knowing), each opening a card with Go there.",
    "Against your target: two big cards, like each mode's front page, to plan the next one in Prep my run or Prep my race.",
    "Deep dive: a new banner photo; key numbers without boxes; best efforts with the pace written on the curve, tap a point to pick a distance, no buttons; pace by gradient as outlined bars with the pace inside, the border colour telling when in the run you were on that gradient; the heat map's middle row is called Flat; the climbs and descents table starts folded.",
    "Site pages: the footer now opens with a trail profile line.",
  ] },
  { v: "2.10", date: "2026-10-18", items: [
    "Rewind my run, Deep dive: a new pace heat map. One row per gradient, one column per 10% of the run, each box sized by the distance run there and coloured from gold (faster than your other moments on that gradient) to grey (slower). Tap a box to replay that moment.",
  ] },
  { v: "2.9", date: "2026-10-18", items: [
    "Save to my account (signed-in testers): one button per mode keeps your race plan, run session or run in your online account, only when you press it. Reopen it later from your Account window exactly as you left it, then change the target or settings and everything is computed again. Heart rate is never kept. Up to 30 saves.",
  ] },
  { v: "2.8", date: "2026-10-18", items: [
    "Online account (invited testers): sign in with email and password, or an email link. Your profile (name, flag, a few words, badges, goals and bests) is saved to your account and comes back on any device. Heart rates and weight stay in your browser.",
  ] },
  { v: "2.5", date: "2026-10-17", items: [
    "Prep my run review. The line next to the logo is back to Trail race & run planner.",
    "Optional references: type your 10K and half-marathon bests or your easy pace (as coaches define it: you can still talk in full sentences) in the small line under the file drops of every mode. They set the level of your plan, while your runs keep the shape of how you climb and descend; in Rewind my run they put your pace in context.",
    "Prep my run: the target time sits next to the GPX drop (start time removed), a level picker from 1 Recovery to 5 Race once references are set, and the finish time under the duration.",
    "Pimp my GPX is lighter: a watch face preview, slim rows with on/off switches, Garmin .fit and .gpx downloads. Every Add GPX button sits at the bottom of its box.",
    "Online account (not open yet): read-only, the app holds no write code.",
    "Every cockpit: the fourth tile shows the elevation instead of the finish time, the bars and the profile follow your finger or mouse when you slide them, and a section or a moment lights up on the map without zooming in or out.",
  ] },
  { v: "2.4", date: "2026-10-17", items: [
    "Design review, part 2. A climb now gains at least 10% of the race's D+ (any rise of 100 m or more counts): smaller rises are bumps, not counted but still in your plan, race script and watch messages. Long climbs split where the gradient clearly changes, each section at least 15% of the climb.",
    "Difficulty shows as 1 to 4 stars, green, yellow, orange and red, everywhere. Key zones say how many minutes there are to gain.",
    "Climbs and descents tables: the start km, a mini profile with the average gradient on it, length, gain, steepest 100 m, then the stars.",
    "Your route: the map and the profile fit one screen, each climb has its number with a small window of figures, and zooming the profile zooms the map and dims the rest of the route. The key zones moved to Your plan, as star chips that open their message and show the zone on the profile and the map.",
    "Smoother pace: it now blends between gradient bands instead of jumping at each band edge.",
    "Your race: the profile is on top, taller, with the section bar under it; the % of the race joins the km line; the race script is compact, and a click on a moment zooms the map on it.",
    "Export A4 moved from the top bar into each printable section, with tick boxes to leave parts out. Your engine's pace chart lines up in three columns.",
  ] },
  { v: "2.3", date: "2026-10-17", items: [
    "Design review, part 1. A shorter line next to the logo (Prep & go) and new, livelier intro texts in the three modes.",
    "Your engine: key figures about how you move (flat pace, cadence, pace on gentle and steep climbs, best climb rate); the Your runs block is gone (each run and its weight shows under the drop box); the pace chart is lower and its values easier to read.",
    "Your route: Start time replaces Crux in the key figures, jump links without boxes, and climbs and descents tables with one header row, a new column order and a small elevation line on each row (also in Climb by climb).",
    "Scenarios are now Best, Balanced and Cautious. The Ask the AI edelweiss sits next to them, and the same edelweiss button replaces the Ask the AI text links.",
    "Your race: the section box shows its % done and the % of the race on top; under the clock, D+ done comes first, then km and the time of day.",
    "Watch messages: Keep all, Keep none and a count of the messages kept.",
  ] },
  { v: "2.2", date: "2026-10-16", items: [
    "Every replay now shows the pace line on its profile, like Rewind my run: Your race (calculated or AI) and Prep my run (with or without the AI coach). Faster is higher, the section you are on is lit, and the dot gives the pace at the runner.",
  ] },
  { v: "2.1", date: "2026-10-16", items: ["Race-day settings (start time, targeted duration, terrain, gels, aid stations and Advanced) moved to Your route. Your plan now only shows what is computed: sections, clock times and pace strategy."] },
  { v: "2.0", date: "2026-10-16", items: [
    "Version 2: AI comes to Prep my race and Prep my run. A small shiny edelweiss beside Pimp my GPX opens the Ask the AI window of each mode.",
    "Prep my race: the AI tailors your race plan; Your race gets a Calculated / AI switch and an AI message box.",
    "Prep my run: an AI coach finds exercises on your route (strides on long flats, hill repeats, uphill threshold, downhill technique...), checked by the app, and plays the session with its own switch.",
    "Every AI answer is kept in AI docs (account menu). The AI opens with the online account: for now the button sends nothing.",
  ] },
  { v: "0.40", date: "2026-10-16", items: [
    "Ask the AI for Prep my race is ready to read: race, runs, goal, target, free information and a question, with checks before anything is sent. It opens with the online account; for now the button sends nothing.",
    "Your race gets a Calculated / AI switch and an AI message box, ready for the first AI plans.",
    "Account menu: an AI docs section will keep every AI answer on this device.",
  ] },
  { v: "0.38", date: "2026-10-16", items: [
    "Heart rate is no longer read from your GPX files: the only heart data used is the max and resting heart rate you type in your profile.",
    "New Account window (account icon, then Account): name, country flag, a few words and badges, your goals and bests from 5K to 100K, heart rates and weight, and lines of your own data.",
  ] },
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
