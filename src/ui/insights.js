// insights.js (ui): the "Deep dive" section of Check my run. Cards of numbers and charts you can
// play with: the headline KPIs (with your weight and heart rates as settings), best efforts for
// any distance, pace by gradient band, the pace distribution, heart-rate zones, a scatter
// explorer where you pick both axes, and the climbs and descents table. Every chart is plain SVG
// built as a string, re-drawn when its own setting changes; a click on a point or a row asks the
// replay above to jump there (onSeek), so the charts and the replay stay linked.

import { bestEffort, bestCurve, gradeBands, hrZones, runChunks, paceHistogram, fitLine, runKpis, climbTable } from "../core/insights.js";
import { mmss, hm } from "../core/format.js";
import { trackEvent } from "./analytics.js";

const inEsc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const IN_STORE = "trp.athlete";
const IN_AXES = {
  grade: { label: "Gradient", unit: "%", get: (c) => c.grade, fmt: (v) => `${v > 0 ? "+" : ""}${v.toFixed(0)}%` },
  km: { label: "Distance", unit: "km", get: (c) => c.km, fmt: (v) => `km ${v.toFixed(1)}` },
  ele: { label: "Altitude", unit: "m", get: (c) => c.ele, fmt: (v) => `${Math.round(v)} m` },
  pace: { label: "Pace", unit: "/km", get: (c) => c.pace, fmt: (v) => `${mmss(v)}/km`, invert: true },
  gap: { label: "Grade-adjusted pace", unit: "/km", get: (c) => c.gap, fmt: (v) => `${mmss(v)}/km`, invert: true },
  speed: { label: "Speed", unit: "km/h", get: (c) => c.speed, fmt: (v) => `${v.toFixed(1)} km/h` },
  hr: { label: "Heart rate", unit: "bpm", get: (c) => c.hr, fmt: (v) => `${Math.round(v)} bpm`, needs: "hasHr" },
  cad: { label: "Cadence", unit: "spm", get: (c) => c.cad, fmt: (v) => `${Math.round(v)} spm`, needs: "hasCad" },
};
const IN_ZONE_CLS = ["z1", "z2", "z3", "z4", "z5"];

// Settings survive a reload, in this browser only.
const inState = (() => {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(IN_STORE) || "{}") || {}; } catch { saved = {}; }
  return { athlete: { weight: 70, hrRest: 60, hrMax: 0, female: false, ...saved }, effortM: 0, band: 5, bin: 15, x: "grade", y: "pace" };
})();
function inSave() {
  try { localStorage.setItem(IN_STORE, JSON.stringify(inState.athlete)); } catch { /* private mode: keep for this visit */ }
}

/** A KPI value in its unit. */
function inFmt(k) {
  const v = k.value;
  switch (k.unit) {
    case "dur": return hm(v);
    case "n": return String(Math.round(v));
    case "%": return `${(v * 100).toFixed(Math.abs(v) < 0.1 ? 1 : 0)}<small>%</small>`;
    case "pace": return `${mmss(v)}<small>/km</small>`;
    case "ratio": return v.toFixed(2);
    case "m/km": return `${Math.round(v)}<small>m/km</small>`;
    case "m/h": return `${Math.round(v)}<small>m/h</small>`;
    case "spm": return `${Math.round(v)}<small>spm</small>`;
    case "m": return `${v.toFixed(2)}<small>m</small>`;
    case "kcal": return `${Math.round(v)}<small>kcal</small>`;
    case "num0": return String(Math.round(v));
    default: return v.toFixed(2);
  }
}

/** Nice round ticks between lo and hi (about `count` of them). */
function inTicks(lo, hi, count = 5) {
  const span = Math.max(1e-9, hi - lo);
  const raw = span / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= count) || 10 * mag;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(+v.toFixed(10));
  return out;
}

/** The pace ticks: whole 15 s, 30 s or minute steps, so the labels read as paces. */
function inPaceTicks(lo, hi) {
  const span = hi - lo;
  const step = span > 600 ? 120 : span > 300 ? 60 : span > 120 ? 30 : 15;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) out.push(v);
  return out;
}

/** 3000 -> "3 km", 2500 -> "2.5 km", 400 -> "400 m". */
const inDist = (m) => (m >= 1000 ? `${+(m / 1000).toFixed(1)} km` : `${m} m`);

const inCard = (id, title, sub, body, wide) => `<div class="panel in-card${wide ? " wide" : ""}" id="${id}"><div class="in-h"><b>${title}</b>${sub ? `<small>${sub}</small>` : ""}</div>${body}</div>`;

// Charts are drawn in a narrower box on a phone, so their text stays readable once scaled down.
const IN_NARROW = typeof window !== "undefined" && window.matchMedia ? window.matchMedia("(max-width: 640px)") : null;
const inW = () => (IN_NARROW && IN_NARROW.matches ? 440 : 1000);

/* ---------- the cards ---------- */

// The max heart rate to work with: the runner's own, else an estimate. The peak of one run is
// usually under the real max (few runs go all out), so the estimate is never below 185 bpm.
const IN_HRMAX_FLOOR = 185;
function inHrMax(run) {
  const a = inState.athlete;
  if (a.hrMax) return { bpm: a.hrMax, est: false };
  return { bpm: Math.max(IN_HRMAX_FLOOR, Math.round(run.hrMax || 0)), est: true };
}

function inKpis(run) {
  const a = inState.athlete;
  const list = runKpis(run, { ...a, hrMax: run.hasHr ? inHrMax(run).bpm : null });
  const groups = [...new Set(list.map((k) => k.group))];
  return groups.map((g) => `<div class="in-kgroup"><div class="in-kg">${g}</div><div class="in-kgrid">${list.filter((k) => k.group === g).map((k) => `<div class="in-k" title="${inEsc(k.hint)}"><span class="k">${k.label}</span><b>${inFmt(k)}</b><small>${inEsc(k.hint)}</small></div>`).join("")}</div></div>`).join("");
}

function inSettings(run) {
  const a = inState.athlete;
  const maxPh = inHrMax(run).est ? inHrMax(run).bpm : Math.max(IN_HRMAX_FLOOR, Math.round(run.hrMax || 0));
  return `<form class="in-set" id="inSet" onsubmit="return false">
    <label class="f">Weight<span class="in-u"><input type="number" id="inW" min="30" max="150" step="1" value="${a.weight}"> kg</span></label>
    ${run.hasHr ? `<label class="f">Max heart rate<span class="in-u"><input type="number" id="inMax" min="120" max="230" step="1" value="${a.hrMax || ""}" placeholder="${maxPh}"> bpm</span></label>
    <label class="f">Resting heart rate<span class="in-u"><input type="number" id="inRest" min="30" max="100" step="1" value="${a.hrRest}"> bpm</span></label>
    <label class="f">Training load for<select id="inSex"><option value="m" ${a.female ? "" : "selected"}>a man</option><option value="f" ${a.female ? "selected" : ""}>a woman</option></select></label>` : ""}
    <p class="note">Used for the energy, the heart-rate zones and the training load. ${run.hasHr ? `Leave the max empty to use an estimate (${maxPh} bpm: this run's peak was ${Math.round(run.hrMax || 0)}, and one run rarely reaches your real max). Your own max makes the zones right.` : ""} Saved in this browser only.</p>
  </form>`;
}

function inBest(run) {
  const curve = bestCurve(run);
  const maxM = (run.n - 1) * run.step;
  if (!inState.effortM || inState.effortM > maxM) inState.effortM = Math.min(3000, Math.round(maxM / 2 / 100) * 100);
  const cur = bestEffort(run, inState.effortM);
  const W = inW(), H = 220, l = 60, r = 16, t = 14, b = 34;
  const lx = (m) => l + ((Math.log(m) - Math.log(curve[0].m)) / Math.max(1e-6, Math.log(maxM) - Math.log(curve[0].m))) * (W - l - r);
  const ps = curve.map((c) => c.pace).concat(cur ? [cur.pace] : []);
  const pLo = Math.min(...ps) * 0.97, pHi = Math.max(...ps) * 1.03;
  const y = (p) => t + ((p - pLo) / Math.max(1e-6, pHi - pLo)) * (H - t - b); // faster = higher up
  let s = "";
  inPaceTicks(pLo, pHi).forEach((p) => { s += `<line class="in-grid" x1="${l}" x2="${W - r}" y1="${y(p).toFixed(1)}" y2="${y(p).toFixed(1)}"/><text x="${l - 6}" y="${(y(p) + 4).toFixed(1)}" text-anchor="end">${mmss(p)}</text>`; });
  let lastX = -1e9;
  // Distance labels: skip one that would sit on top of its neighbour (the whole run's always shows).
  const endC = curve[curve.length - 1], endX = lx(endC.m);
  curve.forEach((c) => { const cx = lx(c.m); if (c !== endC && (cx - lastX < 30 || endX - cx < 30)) return; lastX = cx; s += `<text x="${cx.toFixed(1)}" y="${H - 12}" text-anchor="middle">${c.m >= 1000 ? `${+(c.m / 1000).toFixed(c.m % 1000 ? 1 : 0)}k` : c.m}</text>`; });
  s += `<path class="in-line" d="${curve.map((c, i) => `${i ? "L" : "M"}${lx(c.m).toFixed(1)},${y(c.pace).toFixed(1)}`).join("")}"/>`;
  curve.forEach((c) => { s += `<circle class="in-pt" data-sec="${Math.round(c.startSec)}" cx="${lx(c.m).toFixed(1)}" cy="${y(c.pace).toFixed(1)}" r="5"><title>Best ${c.m >= 1000 ? `${(c.m / 1000).toFixed(c.m % 1000 ? 1 : 0)} km` : `${c.m} m`}: ${mmss(c.sec)} (${mmss(c.pace)}/km), km ${c.km.toFixed(1)}</title></circle>`; });
  if (cur) s += `<line class="in-cur" x1="${lx(cur.m).toFixed(1)}" x2="${lx(cur.m).toFixed(1)}" y1="${t}" y2="${H - b}"/><circle class="in-pt cur" data-sec="${Math.round(cur.startSec)}" cx="${lx(cur.m).toFixed(1)}" cy="${y(cur.pace).toFixed(1)}" r="7"/>`;
  const label = inDist;
  return `${cur ? `<p class="in-res">Best <b>${label(cur.m)}</b>: <b>${mmss(cur.sec)}</b> at <b>${mmss(cur.pace)}/km</b>, from km ${cur.km.toFixed(1)} to ${cur.toKm.toFixed(1)}. <button type="button" class="btn sm" data-sec="${Math.round(cur.startSec)}">▶ Replay it</button></p>` : ""}
    <svg viewBox="0 0 ${W} ${H}" class="in-svg" role="img" aria-label="Best pace for each distance">${s}</svg>`;
}

/** The distance slider of the best-efforts card (drawn once, so a drag is never interrupted). */
function inBestCtl(run) {
  const maxM = (run.n - 1) * run.step;
  return `<div class="in-ctl"><label class="f in-range">Distance <b id="inEffLab">${inDist(inState.effortM)}</b><input type="range" id="inEff" min="100" max="${Math.floor(maxM / 100) * 100}" step="100" value="${inState.effortM}"></label></div>`;
}

function inBands(run) {
  const bands = gradeBands(run, inState.band).filter((b) => b.km >= 0.05);
  const W = inW(), H = 200, l = 40, r = 10, t = 22, b = 30;
  const bw = (W - l - r) / Math.max(1, bands.length);
  const maxS = Math.max(...bands.map((x) => x.share), 0.01);
  let s = "";
  bands.forEach((x, k) => {
    const h = (x.share / maxS) * (H - t - b);
    const xx = l + k * bw;
    const cls = x.mid >= inState.band ? "up" : x.mid <= -inState.band ? "down" : "flat";
    s += `<g class="in-band ${cls}"><rect x="${(xx + 2).toFixed(1)}" y="${(H - b - h).toFixed(1)}" width="${Math.max(1, bw - 4).toFixed(1)}" height="${h.toFixed(1)}"/><title>${x.from.toFixed(1)} to ${x.to.toFixed(1)}%: ${x.km.toFixed(1)} km, ${hm(x.sec)} (${Math.round(x.share * 100)}%), pace ${x.pace ? mmss(x.pace) : "–"}/km</title></g>`;
    if (bw > 26) s += `<text class="in-bv" x="${(xx + bw / 2).toFixed(1)}" y="${(H - b - h - 5).toFixed(1)}" text-anchor="middle">${x.pace ? mmss(x.pace) : ""}</text>`;
    if (bw >= 22 || k % 2 === 0) s += `<text x="${(xx + bw / 2).toFixed(1)}" y="${H - 12}" text-anchor="middle">${x.mid > 0 ? "+" : ""}${x.mid}</text>`;
  });
  s += `<text x="${l - 6}" y="${H - 12}" text-anchor="end">%</text>`;
  const row = (x) => `<tr><th>${x.from > 0 ? "+" : ""}${x.from.toFixed(1)} to ${x.to > 0 ? "+" : ""}${x.to.toFixed(1)}%</th><td>${x.km.toFixed(1)} km</td><td>${hm(x.sec)} <small>${Math.round(x.share * 100)}%</small></td><td>${x.pace ? mmss(x.pace) : "–"}</td><td>${x.gap ? mmss(x.gap) : "–"}</td>${run.hasHr ? `<td>${x.hr ? Math.round(x.hr) : "–"}</td>` : ""}${run.hasCad ? `<td>${x.cad ? Math.round(x.cad) : "–"}${x.hikeShare > 0.05 ? ` <small>${Math.round(x.hikeShare * 100)}% hiked</small>` : ""}</td>` : ""}<td>${x.vam ? `${Math.round(x.vam)} m/h ↑` : x.descentRate ? `${Math.round(x.descentRate)} m/h ↓` : "–"}</td></tr>`;
  return `<div class="in-ctl"><label class="f inline">Band width<select id="inBand">${[2, 3, 5, 10].map((w) => `<option value="${w}" ${w === inState.band ? "selected" : ""}>${w}%</option>`).join("")}</select></label></div>
    <svg viewBox="0 0 ${W} ${H}" class="in-svg" role="img" aria-label="Time spent on each gradient band">${s}</svg>
    <p class="note">Bar height = share of your moving time on that gradient; the number on top = your pace there.</p>
    <details class="in-more"><summary>The table: pace, grade-adjusted pace${run.hasHr ? ", heart rate" : ""}${run.hasCad ? ", cadence" : ""} and climbing speed per band</summary>
    <div class="in-tw"><table class="rp-tg in-t"><thead><tr><th>Gradient</th><th>Distance</th><th>Time</th><th>Pace</th><th>Grade-adj.</th>${run.hasHr ? "<th>HR</th>" : ""}${run.hasCad ? "<th>Cadence</th>" : ""}<th>Vertical</th></tr></thead><tbody>${bands.map(row).join("")}</tbody></table></div></details>`;
}

function inHist(run, list) {
  const h = paceHistogram(run, inState.bin, list);
  const W = inW(), H = 180, l = 40, r = 10, t = 16, b = 30;
  const bw = (W - l - r) / Math.max(1, h.bins.length);
  const maxS = Math.max(...h.bins.map((x) => x.share), 0.01);
  let s = "";
  const every = Math.max(1, Math.ceil(h.bins.length / (W < 1000 ? 6 : 12)));
  h.bins.forEach((x, k) => {
    const hh = (x.share / maxS) * (H - t - b);
    const xx = l + k * bw;
    s += `<g class="in-hist"><rect x="${(xx + 1).toFixed(1)}" y="${(H - b - hh).toFixed(1)}" width="${Math.max(1, bw - 2).toFixed(1)}" height="${hh.toFixed(1)}"/><title>${mmss(x.from)} to ${mmss(x.to)}/km: ${hm(x.sec)} (${Math.round(x.share * 100)}%)</title></g>`;
    if (k % every === 0) s += `<text x="${xx.toFixed(1)}" y="${H - 12}" text-anchor="middle">${mmss(x.from)}</text>`;
  });
  if (h.bins.length) {
    const p = run.movingPace;
    const lo = h.bins[0].from, hi = h.bins[h.bins.length - 1].to;
    const xx = l + ((p - lo) / Math.max(1, hi - lo)) * (W - l - r);
    s += `<line class="in-cur" x1="${xx.toFixed(1)}" x2="${xx.toFixed(1)}" y1="${t - 6}" y2="${H - b}"/><text class="in-bv" x="${(xx + 4).toFixed(1)}" y="${t}">average ${mmss(p)}</text>`;
  }
  // The pace you held most: the tallest bin.
  const top = h.bins.reduce((a, x) => (!a || x.sec > a.sec ? x : a), null);
  return `<div class="in-ctl"><label class="f inline">Bin<select id="inBin">${[10, 15, 30, 60].map((w) => `<option value="${w}" ${w === inState.bin ? "selected" : ""}>${w} s</option>`).join("")}</select></label>${top ? `<span class="in-res">Most held: <b>${mmss(top.from)} to ${mmss(top.to)}/km</b> (${Math.round(top.share * 100)}% of the time)</span>` : ""}</div>
    <svg viewBox="0 0 ${W} ${H}" class="in-svg" role="img" aria-label="How much time you spent at each pace">${s}</svg>
    <p class="note">Moving time per pace, from 100 m chunks. A wide spread is normal on a trail; two humps usually mean running and hiking.</p>`;
}

function inZones(run) {
  if (!run.hasHr) return `<p class="note">No heart rate in this file.</p>`;
  const a = inState.athlete;
  const { bpm: max, est } = inHrMax(run);
  const z = hrZones(run, max, a.hrRest, a.female);
  if (!z) return "";
  let x = 0;
  const bar = z.zones.map((q, k) => { const w = q.share * 100; const out = `<i class="in-z ${IN_ZONE_CLS[k]}" style="left:${x.toFixed(2)}%;width:${w.toFixed(2)}%" title="${q.name}: ${hm(q.sec)} (${Math.round(w)}%)"></i>`; x += w; return out; }).join("");
  return `<div class="in-zbar">${bar}</div>
    <table class="rp-tg in-t in-zt"><thead><tr><th>Zone</th><th>Heart rate</th><th>Time</th><th>Share</th></tr></thead><tbody>
    ${z.zones.map((q, k) => `<tr><th><i class="sw in-z ${IN_ZONE_CLS[k]}"></i>${q.name}</th><td>${q.toBpm ? `${q.fromBpm}–${q.toBpm}` : `${q.fromBpm}+`} bpm</td><td>${hm(q.sec)}</td><td>${Math.round(q.share * 100)}%</td></tr>`).join("")}
    </tbody></table>
    <p class="in-res">Training load (TRIMP): <b>${Math.round(z.trimp)}</b> <small>· zones as % of a max of ${max} bpm${est ? " (estimated: set your own in Key numbers)" : ""}</small></p>`;
}

function inScatter(run, list) {
  const ax = IN_AXES[inState.x], ay = IN_AXES[inState.y];
  const pts = list.filter((c) => {
    const vx = ax.get(c), vy = ay.get(c);
    return vx !== null && vy !== null && Number.isFinite(vx) && Number.isFinite(vy) && !((ax.invert && vx > 1200) || (ay.invert && vy > 1200));
  });
  const opt = (sel) => Object.entries(IN_AXES).filter(([, a]) => !a.needs || run[a.needs]).map(([k, a]) => `<option value="${k}" ${k === sel ? "selected" : ""}>${a.label}</option>`).join("");
  const ctl = `<div class="in-ctl"><label class="f inline">Across<select id="inX">${opt(inState.x)}</select></label><label class="f inline">Up<select id="inY">${opt(inState.y)}</select></label></div>`;
  if (pts.length < 3) return `${ctl}<p class="note">Not enough data for these two.</p>`;
  const xs = pts.map(ax.get), ys = pts.map(ay.get);
  const q = (arr, f) => { const s = [...arr].sort((a, b) => a - b); return s[Math.max(0, Math.min(s.length - 1, Math.floor(f * (s.length - 1))))]; };
  // Axis ranges from the 1st to 99th percentile, so one GPS glitch does not squash the cloud.
  let x0 = q(xs, 0.01), x1 = q(xs, 0.99), y0 = q(ys, 0.01), y1 = q(ys, 0.99);
  const px = (x1 - x0) * 0.05 || 1, py = (y1 - y0) * 0.05 || 1;
  x0 -= px; x1 += px; y0 -= py; y1 += py;
  const W = inW(), H = 320, l = 66, r = 16, t = 14, b = 36;
  const X = (v) => l + ((Math.max(x0, Math.min(x1, v)) - x0) / (x1 - x0)) * (W - l - r);
  // Paces: faster (smaller) goes up on the vertical axis.
  const Y = (v) => { const f = (Math.max(y0, Math.min(y1, v)) - y0) / (y1 - y0); return ay.invert ? t + f * (H - t - b) : H - b - f * (H - t - b); };
  let s = "";
  const yt = ay.invert ? inPaceTicks(y0, y1) : inTicks(y0, y1, 5);
  const xt = ax.invert ? inPaceTicks(x0, x1) : inTicks(x0, x1, 8);
  yt.forEach((v) => { s += `<line class="in-grid" x1="${l}" x2="${W - r}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}"/><text x="${l - 6}" y="${(Y(v) + 4).toFixed(1)}" text-anchor="end">${ay.invert ? mmss(v) : +v.toFixed(1)}</text>`; });
  xt.forEach((v) => { s += `<line class="in-grid" x1="${X(v).toFixed(1)}" x2="${X(v).toFixed(1)}" y1="${t}" y2="${H - b}"/><text x="${X(v).toFixed(1)}" y="${H - 18}" text-anchor="middle">${ax.invert ? mmss(v) : +v.toFixed(1)}</text>`; });
  s += `<text x="${W - r}" y="${H - 4}" text-anchor="end" class="in-axl">${ax.label} (${ax.unit})</text><text x="${l}" y="${t - 2}" class="in-axl">${ay.label} (${ay.unit})</text>`;
  pts.forEach((c) => {
    const k = Math.min(4, Math.floor(c.frac * 5));
    s += `<circle class="in-dot q${k + 1}" data-sec="${Math.round(c.startSec)}" cx="${X(ax.get(c)).toFixed(1)}" cy="${Y(ay.get(c)).toFixed(1)}" r="3.4"><title>km ${c.km.toFixed(1)}: ${ax.fmt(ax.get(c))} · ${ay.fmt(ay.get(c))}</title></circle>`;
  });
  const fit = fitLine(xs, ys);
  let txt = "";
  if (fit) {
    const a = x0, bb = x1;
    s += `<line class="in-fit" x1="${X(a).toFixed(1)}" y1="${Y(fit.intercept + fit.slope * a).toFixed(1)}" x2="${X(bb).toFixed(1)}" y2="${Y(fit.intercept + fit.slope * bb).toFixed(1)}"/>`;
    const r2 = Math.abs(fit.r);
    const strength = r2 >= 0.7 ? "strong" : r2 >= 0.4 ? "moderate" : r2 >= 0.2 ? "weak" : "no real";
    txt = `<span class="in-res">Correlation <b>r = ${fit.r.toFixed(2)}</b>: ${strength} link${r2 >= 0.2 ? `, ${(fit.slope > 0) === !ay.invert ? "both rise together" : "one rises as the other falls"}` : ""}.</span>`;
  }
  return `${ctl}${txt}<svg viewBox="0 0 ${W} ${H}" class="in-svg in-scatter" role="img" aria-label="Scatter of ${ay.label} against ${ax.label}">${s}</svg>
    <div class="in-legend"><span><i class="in-dot-l q1"></i>start</span><span><i class="in-dot-l q2"></i></span><span><i class="in-dot-l q3"></i>middle</span><span><i class="in-dot-l q4"></i></span><span><i class="in-dot-l q5"></i>end</span><span class="note">One dot per 100 m, coloured by when · the line is the best fit · click a dot to replay there</span></div>`;
}

function inClimbs(run) {
  const list = climbTable(run);
  if (!list.length) return `<p class="note">No climb or descent in this run.</p>`;
  return `<div class="in-tw"><table class="rp-tg in-t in-ct"><thead><tr><th>Section</th><th>Km</th><th>Vertical</th><th>Gradient</th><th>Time</th><th>Speed</th>${run.hasHr ? "<th>HR</th>" : ""}${run.hasCad ? "<th>Hiked</th>" : ""}<th>Verdict</th></tr></thead><tbody>
    ${list.map((c) => `<tr class="in-row" data-sec="${Math.round(c.startSec)}" tabindex="0"><th>${c.kind === "climb" ? "▲" : "▼"} ${c.i}. ${inEsc(c.title)} <small>${inEsc(c.label || "")}</small></th><td>${c.startKm.toFixed(1)} → ${c.endKm.toFixed(1)}</td><td>${c.kind === "climb" ? `+${Math.round(c.up)}` : `−${Math.round(c.down)}`} m</td><td>${c.avg > 0 ? "+" : ""}${c.avg.toFixed(1)}%</td><td>${hm(c.movSec)}</td><td>${c.vam ? `${Math.round(c.vam)} m/h` : c.rate ? `${Math.round(c.rate)} m/h · ${c.pace ? mmss(c.pace) : "–"}/km` : "–"}</td>${run.hasHr ? `<td>${c.hr ? Math.round(c.hr) : "–"}</td>` : ""}${run.hasCad ? `<td>${c.hikeShare !== null ? `${Math.round(c.hikeShare * 100)}%` : "–"}</td>` : ""}<td><span class="chip rv-${c.tone}">${c.verdict}${c.vsPct ? ` ${c.vsPct > 0 ? "+" : ""}${c.vsPct}%` : ""}</span></td></tr>`).join("")}
    </tbody></table></div><p class="note">Climbing speed in vertical metres per hour (VAM); on descents, vertical metres per hour down and the pace. Click a row to replay it.</p>`;
}

/**
 * Mount the deep dive for `run` in `box`. `onSeek(sec)` moves the replay above to that second.
 */
export function mountInsights(box, run, { onSeek } = {}) {
  if (!box) return;
  const list = runChunks(run);
  box.innerHTML = `<div class="in-wrap">
    ${inCard("inKpi", "Key numbers", "tap or hover a number for what it means", `<div id="inKpiBody">${inKpis(run)}</div><details class="in-more"><summary>Your settings: weight${run.hasHr ? ", max and resting heart rate" : ""}</summary>${inSettings(run)}</details>`, true)}
    ${inCard("inBest", "Best efforts", "your fastest stretch for any distance", `${(() => { const b = inBest(run); return `${inBestCtl(run)}<div id="inBestBody">${b}</div>`; })()}<p class="note">Each point is your fastest stretch of that length on the clock (a stop inside it counts). Faster is higher. The curve always falls: the longer the effort, the slower the best pace.</p>`)}
    ${inCard("inZone", "Heart-rate zones", run.hasHr ? "time in each zone, from your max heart rate" : "", `<div id="inZoneBody">${inZones(run)}</div>`)}
    ${inCard("inBandC", "Pace by gradient", "where your time went, and how fast you were there", `<div id="inBandBody">${inBands(run)}</div>`)}
    ${inCard("inHistC", "Pace distribution", "how much time at each pace", `<div id="inHistBody">${inHist(run, list)}</div>`)}
    ${inCard("inScat", "Explorer", "pick any two measures and see how they move together", `<div id="inScatBody">${inScatter(run, list)}</div>`, true)}
    ${inCard("inClimb", "Climbs and descents", "every one, with its numbers", inClimbs(run), true)}
  </div>`;
  const $i = (s) => box.querySelector(s);
  const seekable = (root) => root.querySelectorAll("[data-sec]").forEach((el) => {
    const go = () => { if (onSeek) { trackEvent("insight-seek", root.id || "card"); onSeek(Number(el.dataset.sec)); } };
    el.addEventListener("click", go);
    if (el.tagName === "TR") el.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
  });
  const redraw = (id, html) => { const el = $i(id); el.innerHTML = html; seekable(el); return el; };
  seekable(box);
  // Best effort: the slider re-draws the chart under it as you drag.
  const eff = $i("#inEff");
  if (eff) {
    eff.addEventListener("input", () => { inState.effortM = Number(eff.value); $i("#inEffLab").textContent = inDist(inState.effortM); redraw("#inBestBody", inBest(run)); });
    eff.addEventListener("change", () => trackEvent("insight-effort", String(inState.effortM)));
  }
  const wireSel = (sel, key, id, fn) => {
    const el = $i(sel);
    if (!el || el.dataset.wired) return; // a select that was not re-drawn keeps its listener
    el.dataset.wired = "1";
    el.addEventListener("change", () => { inState[key] = key === "x" || key === "y" ? el.value : Number(el.value); trackEvent("insight-set", key); redraw(id, fn()); wireAll(); });
  };
  const wireAll = () => {
    wireSel("#inBand", "band", "#inBandBody", () => inBands(run));
    wireSel("#inBin", "bin", "#inHistBody", () => inHist(run, list));
    wireSel("#inX", "x", "#inScatBody", () => inScatter(run, list));
    wireSel("#inY", "y", "#inScatBody", () => inScatter(run, list));
  };
  wireAll();
  // Turning a phone or resizing across the phone width re-draws the charts at the right size.
  const mountId = (box.dataset.inMount = String(Number(box.dataset.inMount || 0) + 1));
  if (IN_NARROW) IN_NARROW.addEventListener("change", () => {
    if (box.dataset.inMount !== mountId || !$i("#inBestBody")) return; // a newer run took this box
    redraw("#inBestBody", inBest(run)); redraw("#inBandBody", inBands(run)); redraw("#inHistBody", inHist(run, list)); redraw("#inScatBody", inScatter(run, list));
    wireAll();
  });
  // On a phone the explanations are hidden: a tap on a number shows its own.
  $i("#inKpiBody").addEventListener("click", (e) => { const k = e.target.closest(".in-k"); if (k) k.classList.toggle("open"); });
  // Athlete settings: re-draw the numbers and the zones on each change.
  const set = $i("#inSet");
  if (set) set.addEventListener("input", () => {
    const num = (id) => { const el = $i(id); return el && el.value !== "" ? Number(el.value) : 0; };
    const a = inState.athlete;
    a.weight = num("#inW") || 70;
    if ($i("#inMax")) { a.hrMax = num("#inMax"); a.hrRest = num("#inRest") || 60; a.female = $i("#inSex").value === "f"; }
    inSave();
    $i("#inKpiBody").innerHTML = inKpis(run);
    redraw("#inZoneBody", inZones(run));
  });
}

/** What the section shows before a run is loaded. */
export function emptyInsights(box) {
  if (!box) return;
  box.dataset.inMount = String(Number(box.dataset.inMount || 0) + 1);
  box.innerHTML = `<div class="empty"><b>Load a run above</b> (or press Try a sample run) to open its deep dive: key numbers, best efforts, heart-rate zones, pace by gradient and an explorer to cross any two measures.</div>`;
}
