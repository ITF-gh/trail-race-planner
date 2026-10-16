// demorecords.js: the made-up run log of "User1", the demo profile the account menu shows while
// this device has no run of its own. Same shape as runRecord() summaries, so the menu, the stats
// and the achievements work on it unchanged. Nothing of it is ever stored or sent anywhere.
//
// Called by src/ui/account.js when this device has no saved run and nobody is signed in:
// historySummary (history.js) then runs on these records like on real ones. Each record is
// marked demo: true.

export const DEMO_USER = "User1";

// The demo runs, one array per run (compact, easy to edit), oldest last:
// [days ago, name, km, D+ m, moving pace s/km, fade %, climbing speed m/h]
// No heart rate: the app never keeps heart data from runs.
// null = no value (a flat run has no climbing speed).
const DEMO_RUNS = [
  [2, "Ridge loop", 14.2, 720, 412, 3.1, 980],
  [5, "Easy river run", 9.8, 110, 338, 1.2, null],
  [9, "Long run, the three summits", 31.5, 1840, 468, 6.8, 910],
  [13, "Hill repeats", 11.4, 650, 395, 2.4, 1120],
  [17, "Forest tempo", 12.1, 240, 318, 1.9, null],
  [24, "Trail marathon (race)", 43.4, 2210, 455, 9.4, 940],
  [33, "Recovery jog", 7.2, 90, 352, -1.5, null],
  [38, "Ridge loop", 14.2, 720, 421, 3.6, 950],
  [45, "Long run, lakes", 26.3, 1150, 441, 5.2, 890],
  [52, "Vertical K practice", 6.4, 980, 640, 4.1, 1240],
  [60, "Easy river run", 10.3, 120, 345, 1.4, null],
  [71, "Night trail", 15.8, 610, 430, 3.9, 900],
  [84, "Mountain day", 24.7, 1960, 520, 7.7, 870],
  [98, "Forest tempo", 12.0, 230, 325, 2.2, null],
  [115, "Ultra 55K (race)", 55.2, 3120, 512, 12.6, 860],
  [131, "Long run, the three summits", 31.4, 1830, 482, 7.4, 880],
  [150, "Hill repeats", 11.2, 640, 404, 2.7, 1080],
  [176, "Spring half (race)", 21.3, 480, 301, 4.6, 920],
  [205, "Ridge loop", 14.3, 725, 436, 4.2, 910],
  [240, "Snow run", 9.1, 310, 402, 2.9, 820],
  [282, "Easy river run", 10.1, 115, 351, 1.6, null],
  [318, "Winter long run", 22.6, 940, 452, 5.9, 840],
];

/**
 * The demo log, dated back from `now` (newest first).
 * Each array is destructured into named variables and turned into a record of the same shape as
 * runRecord's. The values not in the table are derived with simple rules of thumb (they only
 * need to look plausible): the date is rounded to the hour, minus 2 h; elapsed time is moving
 * time + 3% (+8% over 30 km, for stops); best efforts are fractions of the average pace, never
 * faster than a floor (3:25/km for 1 km, 3:44/km over 5 km, 3:58/km over 10 km).
 */
export function demoRecords(now = Date.now()) {
  return DEMO_RUNS.map(([ago, name, km, gain, pace, fade, vam]) => {
    const date = Math.round((now - ago * 86400000) / 3600000) * 3600000 - 2 * 3600000;
    const movingSec = Math.round(km * pace);
    const flat = pace - Math.round((gain / km) * 0.9); // grade-adjusted pace: climbing time taken out
    return {
      id: `${Math.round(date / 1000)}-${Math.round(km * 100)}`,
      v: 1,
      demo: true,
      date,
      name,
      km,
      gain,
      movingSec,
      elapsedSec: Math.round(movingSec * (km > 30 ? 1.08 : 1.03)),
      gapPace: Math.max(260, flat),
      fadePct: fade,
      vam,
      best1k: Math.max(205, Math.round(pace * 0.68)),
      best5k: km >= 5 ? Math.max(1120, Math.round(pace * 0.8 * 5)) : null,
      best10k: km >= 10 ? Math.max(2380, Math.round(pace * 0.86 * 10)) : null,
    };
  });
}
