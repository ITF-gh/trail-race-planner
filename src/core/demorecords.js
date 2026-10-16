// demorecords.js: the made-up run log of "User1", the demo profile the account menu shows while
// this device has no run of its own. Same shape as runRecord() summaries, so the menu, the stats
// and the achievements work on it unchanged. Nothing of it is ever stored or sent anywhere.

export const DEMO_USER = "User1";

// [days ago, name, km, D+ m, moving pace s/km, avg HR, fade %, heart drift %, climbing speed m/h]
const DEMO_RUNS = [
  [2, "Ridge loop", 14.2, 720, 412, 148, 3.1, 4.2, 980],
  [5, "Easy river run", 9.8, 110, 338, 136, 1.2, 2.1, null],
  [9, "Long run, the three summits", 31.5, 1840, 468, 145, 6.8, 7.5, 910],
  [13, "Hill repeats", 11.4, 650, 395, 156, 2.4, 3.3, 1120],
  [17, "Forest tempo", 12.1, 240, 318, 158, 1.9, 3.8, null],
  [24, "Trail marathon (race)", 43.4, 2210, 455, 152, 9.4, 8.9, 940],
  [33, "Recovery jog", 7.2, 90, 352, 131, -1.5, 1.5, null],
  [38, "Ridge loop", 14.2, 720, 421, 150, 3.6, 4.8, 950],
  [45, "Long run, lakes", 26.3, 1150, 441, 143, 5.2, 6.1, 890],
  [52, "Vertical K practice", 6.4, 980, 640, 162, 4.1, 5.0, 1240],
  [60, "Easy river run", 10.3, 120, 345, 137, 1.4, 2.4, null],
  [71, "Night trail", 15.8, 610, 430, 146, 3.9, 4.4, 900],
  [84, "Mountain day", 24.7, 1960, 520, 141, 7.7, 6.9, 870],
  [98, "Forest tempo", 12.0, 230, 325, 157, 2.2, 4.0, null],
  [115, "Ultra 55K (race)", 55.2, 3120, 512, 147, 12.6, 10.8, 860],
  [131, "Long run, the three summits", 31.4, 1830, 482, 146, 7.4, 8.1, 880],
  [150, "Hill repeats", 11.2, 640, 404, 155, 2.7, 3.6, 1080],
  [176, "Spring half (race)", 21.3, 480, 301, 164, 4.6, 5.9, 920],
  [205, "Ridge loop", 14.3, 725, 436, 151, 4.2, 5.2, 910],
  [240, "Snow run", 9.1, 310, 402, 142, 2.9, 3.1, 820],
  [282, "Easy river run", 10.1, 115, 351, 139, 1.6, 2.8, null],
  [318, "Winter long run", 22.6, 940, 452, 144, 5.9, 6.6, 840],
];

/** The demo log, dated back from `now` (newest first). */
export function demoRecords(now = Date.now()) {
  return DEMO_RUNS.map(([ago, name, km, gain, pace, hr, fade, drift, vam]) => {
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
      hrAvg: hr,
      fadePct: fade,
      decouplingPct: drift,
      vam,
      best1k: Math.max(205, Math.round(pace * 0.68)),
      best5k: km >= 5 ? Math.max(1120, Math.round(pace * 0.8 * 5)) : null,
      best10k: km >= 10 ? Math.max(2380, Math.round(pace * 0.86 * 10)) : null,
    };
  });
}
