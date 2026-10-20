// site-pages.js: the static pages written next to the app by build.js.
//
//   guide.html      the user guide (one chapter per mode, a card per section) and the FAQ
//   about.html      what the planner is, contact, and a short "How it works" (the full notes stay in docs/HOW_IT_WORKS.md)
//   privacy.html    what stays on your device, what is counted, what the online account keeps
//   changelog.html  "What's new", from src/site/changelog.js
//   404.html        GitHub Pages serves it for any address that does not exist
//
// A static page is just a file the host hands out: no server code runs. Each page here gets the
// same <head> (share preview, icon), the same top bar and footer, and links the stylesheet of the
// app (style.css, written by build.js) so it looks like the app, in Night or Sky.

import { SITE, SITE_PHOTOGRAPHERS, siteFooter, extLink, mailLink, SITE_PEAK } from "../src/site/site.js";
import { GUIDE, FAQ } from "../src/site/guide.js";
import { CHANGELOG } from "../src/site/changelog.js";

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/**
 * The <head> lines every page shares: description for search engines, Open Graph tags (the
 * card WhatsApp, Slack, Facebook... draw when the link is shared; they need absolute URLs),
 * and the icons for the browser tab and the phone home screen.
 */
export function headMeta({ title, description = SITE.description, path = "" }) {
  return [
    `<meta name="description" content="${esc(description)}">`,
    `<meta name="theme-color" content="#0a1530">`,
    `<link rel="icon" href="${path}favicon.svg" type="image/svg+xml">`,
    `<link rel="icon" href="${path}favicon-32.png" sizes="32x32" type="image/png">`,
    `<link rel="apple-touch-icon" href="${path}apple-touch-icon.png">`,
    `<meta property="og:type" content="website">`,
    `<meta property="og:site_name" content="${esc(SITE.name)}">`,
    `<meta property="og:title" content="${esc(title)}">`,
    `<meta property="og:description" content="${esc(description)}">`,
    `<meta property="og:url" content="${SITE.url}">`,
    `<meta property="og:image" content="${SITE.url}og.jpg">`,
    `<meta property="og:image:width" content="1200">`,
    `<meta property="og:image:height" content="630">`,
    `<meta name="twitter:card" content="summary_large_image">`,
  ].join("\n");
}

// The look is kept in localStorage as JSON (the app's store), so "sky" is stored as "\"sky\"".
const THEME_JS = `<script>(function(){var k="trp.theme",t;try{t=JSON.parse(localStorage.getItem(k)||"null")}catch(e){}
var h=document.documentElement;function set(v){h.dataset.theme=v;var b=document.getElementById("themeBtn");if(b){b.textContent=v==="sky"?"☾ Night":"☀ Sky mode";b.setAttribute("aria-pressed",String(v==="sky"))}}
set(t==="sky"?"sky":"night");document.addEventListener("DOMContentLoaded",function(){set(h.dataset.theme);document.getElementById("themeBtn").onclick=function(){var v=h.dataset.theme==="sky"?"night":"sky";set(v);try{localStorage.setItem(k,JSON.stringify(v))}catch(e){}}})})();</script>`;

function shell({ title, description, active = "", body, fonts, counter, base = "", path = "" }) {
  const nav = [["guide.html", "Guide", "guide"], ["guide.html#faq", "FAQ", "faq"], ["about.html", "About", "about"], ["changelog.html", "What's new", "changelog"]];
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
${base ? `<base href="${base}">\n` : ""}<title>${esc(title)}</title>
${headMeta({ title, description, path })}
${fonts}
<link rel="stylesheet" href="style.css">
${THEME_JS}
</head>
<body class="site-page">
<nav class="topnav site-top" aria-label="Site">
  <div class="topnav-in">
    <a class="tn-brand st-brand" href="./" aria-label="${esc(SITE.name)}, open the planner">${SITE_PEAK}<b>${esc(SITE.name)}</b></a>
    <div class="tn-links">${nav.map(([h, t, k]) => `<a href="${h}"${k === active ? ' aria-current="page"' : ""}>${t}</a>`).join("")}</div>
    <a class="btn primary sm st-open" href="./">Open the planner</a>
    <button class="btn ghost sm tn-theme" type="button" id="themeBtn" aria-pressed="false"></button>
  </div>
</nav>
<main class="sp-main" id="top">
${body}
</main>
${siteFooter({ analytics: counter ? counter.name : "" })}
${counter ? counter.tag : ""}
</body>
</html>
`;
}

const pageHead = (kicker, title, lead) => `<header class="sp-head"><div class="sec-kicker">${kicker}</div><h1>${title}</h1>${lead ? `<p class="lead">${lead}</p>` : ""}</header>`;

/* ---------- guide ---------- */
function guideBody() {
  const toc = GUIDE.map((m) => `<li><a href="guide.html#${m.id}">${esc(m.name)}</a><span>${m.sections.map((s) => `<a href="guide.html#${s.id}">${esc(s.name)}</a>`).join("")}</span></li>`).join("") + `<li><a href="guide.html#faq">FAQ</a></li>`;
  const card = (m, s) => `<article class="g-card" id="${s.id}">
  ${s.shot ? `<a class="g-shot" href="${m.url}${s.sec ? "#" + s.sec : ""}" aria-label="Open ${esc(s.name)} in the planner"><img src="guide/${s.shot}.webp" alt="Screenshot: ${esc(s.name)}, with the demo data" loading="lazy" width="1200" height="750"></a>` : ""}
  <div class="g-txt">
    <div class="g-num">${s.num}</div>
    <h3>${esc(s.name)}</h3>
    <p class="g-what">${s.what}</p>
    <ol class="g-how">${s.how.map((h) => `<li>${h}</li>`).join("")}</ol>
    <p class="g-tip"><b>Tip</b> ${s.tip}</p>
    ${m.url && s.sec ? `<a class="g-try" href="${m.url}#${s.sec}">Open ${esc(s.name)} →</a>` : ""}
  </div>
</article>`;
  const chapter = (m) => `<section class="g-mode" id="${m.id}">
  <div class="g-mode-head">
    <div>
      <div class="sec-kicker">${m.id === "everywhere" ? "Everywhere" : "Mode"}</div>
      <h2>${esc(m.name)}</h2>
      <p>${m.lead}</p>
      ${m.start.length ? `<ol class="g-start">${m.start.map((x) => `<li>${x}</li>`).join("")}</ol>` : ""}
      ${m.id !== "everywhere" ? `<a class="btn primary sm" href="${m.url}">Open ${esc(m.name)}</a>` : ""}
    </div>
    ${m.shot ? `<img class="g-mode-shot" src="guide/${m.shot}.webp" alt="Screenshot: the ${esc(m.name)} header" loading="lazy" width="1200" height="750">` : ""}
  </div>
  ${m.sections.map((s) => card(m, s)).join("\n")}
</section>`;
  return `${pageHead("User guide", "How to use " + esc(SITE.name), "Three modes, one page. Each card below shows a section with the demo data: what it tells you, what to do, and a tip. Click a screenshot to open that section in the planner.")}
<nav class="g-toc" aria-label="Guide contents"><ol>${toc}</ol></nav>
${GUIDE.map(chapter).join("\n")}
<section class="g-mode" id="faq">
  <div class="sec-kicker">Questions</div>
  <h2>FAQ</h2>
  <div class="faq">${FAQ.map(([q, a]) => `<details><summary>${esc(q)}</summary><p>${a}</p></details>`).join("")}</div>
</section>`;
}

/* ---------- about ---------- */
/** A small Markdown to HTML converter, for docs/HOW_IT_WORKS.md: headings, paragraphs, lists, tables, bold, italic, code. */
export function markdown(md) {
  const inline = (s) => esc(s).replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>").replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<i>$2</i>");
  const out = [];
  let para = [], list = null, table = null;
  const flush = () => {
    if (para.length) out.push(`<p>${inline(para.join(" "))}</p>`);
    if (list) out.push(`<${list.tag}>${list.items.map((i) => `<li>${inline(i)}</li>`).join("")}</${list.tag}>`);
    if (table) out.push(`<div class="md-table"><table><thead><tr>${table[0].map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>${table.slice(1).map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`);
    para = []; list = null; table = null;
  };
  for (const line of md.split("\n")) {
    const h = line.match(/^(#{1,4})\s+(.*)/);
    const li = line.match(/^\s*(?:([-*])|(\d+)\.)\s+(.*)/);
    if (h) { flush(); const n = Math.min(4, h[1].length + 1); out.push(`<h${n}>${inline(h[2])}</h${n}>`); }
    else if (/^\|/.test(line)) {
      if (!table) { flush(); table = []; }
      const cells = line.replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      if (!cells.every((c) => /^:?-+:?$/.test(c))) table.push(cells);
    } else if (li) {
      const tag = li[1] ? "ul" : "ol";
      if (!list || list.tag !== tag) { flush(); list = { tag, items: [] }; }
      list.items.push(li[3]);
    } else if (!line.trim()) flush();
    else if (list && /^\s+/.test(line)) list.items[list.items.length - 1] += " " + line.trim();
    else { if (list || table) flush(); para.push(line.trim()); }
  }
  flush();
  return out.join("\n");
}

function aboutBody() {
  return `${pageHead("About", "About " + esc(SITE.name), `${esc(SITE.tagline)}: turn the race GPX and a few of your own runs into a plan you can trust, rehearse it, put it on your watch, then look back at how it went.`)}
<div class="sp-cols">
  <section class="sp-block">
    <h2>Why it exists</h2>
    <p>Race estimates are made for an average runner. On a mountain course, what matters is how <i>you</i> climb, hike and descend, and how you fade after hours on your feet. Your watch already knows that: ${esc(SITE.name)} reads it from your own runs, then applies it to every 10 metres of the race.</p>
    <p>It is a personal project by an independent engineer and trail runner who works with data. It is free, needs no account, and runs entirely in your browser: your GPX files are never uploaded.</p>
  </section>
  <section class="sp-block">
    <h2>What it is not</h2>
    <p>Not a coach and not a medical tool. Times and paces are estimates from a model, usually within 5 to 10%. Weather, terrain, race rules, mandatory gear and how you feel on the day always come first. If in doubt, slow down, and follow the race organisers and mountain rescue.</p>
  </section>
  <section class="sp-block" id="contact">
    <h2>Contact</h2>
    <p>A question, a bug, an idea, a GPX that gives a strange plan? Write to ${mailLink()}. Please add the version shown at the bottom of the page (v${SITE.version}) and, if you can, the GPX file.</p>
    <p>Bugs and ideas can also go on the public tracker: ${extLink(SITE.issues, "report a bug or an idea")}.</p>
  </section>
  <section class="sp-block">
    <h2>Credits</h2>
    <p>Photos from Pexels (free licence), with no recognisable face: ${SITE_PHOTOGRAPHERS.map(([n]) => n).join(", ")}. Maps: ${extLink("https://www.openstreetmap.org/copyright", "© OpenStreetMap contributors")}, tiles by OpenStreetMap, ${extLink("https://carto.com/attributions", "CARTO")} and ${extLink("https://opentopomap.org", "OpenTopoMap")} (CC-BY-SA), drawn with ${extLink("https://leafletjs.com", "Leaflet")} (BSD-2). Fonts: Barlow and Barlow Condensed (Open Font License). The uphill cost of running comes from Minetti et al. (2002), walking times from Tobler's hiking function.</p>
  </section>
</div>
<section class="sp-block" id="how">
  <h2>How it works</h2>
  <ol class="sp-steps">
    <li><b>Clean the tracks.</b> Your runs and the race GPX are resampled every 10 m and the GPS elevation is smoothed, so noise does not invent fake climbs.</li>
    <li><b>Learn how you move.</b> From your own runs the app measures your pace on every gradient, fresh and tired, and the gradient where you start to hike. Recent runs count more.</li>
    <li><b>Predict the race.</b> Every 10 m of the course gets the pace of its gradient, sliding from fresh to tired, adjusted for terrain and race length. Adding them up gives your finish time and a clock time everywhere, with a best and a cautious case.</li>
    <li><b>Build the plan.</b> Climbs and descents are found, rated and given a tactic (run, hike, brake), long climbs are cut into sections, and gels and aid stations are placed on the clock.</li>
    <li><b>Rehearse and take it with you.</b> Replay the race at your predicted pace, then send the key messages to your watch.</li>
    <li><b>Look back.</b> Rewind my run replays a run you did and shows where you gained or lost time, without comparing it to a plan.</li>
  </ol>
  <p class="note">Estimates, usually within 5 to 10%. The model cannot see mud, heat or a bad day. The full technical notes are in the source code (docs/HOW_IT_WORKS.md).</p>
</section>`;
}

/* ---------- privacy ---------- */
function privacyBody(counter) {
  return `${pageHead("Privacy", "Your data stays with you", "Short version: the planner runs in your browser, your GPX files are never uploaded as files, there is no cookie, and no account is needed.")}
<div class="sp-cols">
  <section class="sp-block">
    <h2>On your device only</h2>
    <ul>
      <li><b>GPX files</b> you drop are read by the page, in your browser. They are never sent anywhere.</li>
      <li><b>Settings and profile</b> (start time, aid stations, theme, targets, your name, flag, goals, max and resting heart rate, weight) are kept in your browser's local storage so they are there next time.</li>
      <li><b>Heart rate from your files is never read.</b> A GPX file may record your heart rate; the app ignores it. The only heart data it uses is the max and resting heart rate you type in your profile.</li>
      <li><b>Run log</b> (account menu): a short summary of each of your own runs (date, distance, climb, time, bests, about 1 KB each) is kept in your browser's database (IndexedDB). You can export it or delete it from the menu.</li>
    </ul>
    <p>To erase everything, use Delete in the account menu, or clear this site's data in your browser settings.</p>
  </section>
  <section class="sp-block">
    <h2>Visit counts</h2>
    ${counter ? `<p>Visits and a few button clicks (for example "replay played", never what you typed or loaded) are counted with ${extLink("https://www.goatcounter.com", "GoatCounter")}. It sets no cookie, does not store your IP address and keeps no personal data, so no consent banner is needed. The counts tell which parts of the planner are used.</p>` : `<p>No visit tracking is on.</p>`}
  </section>
  <section class="sp-block">
    <h2>Other services the page loads</h2>
    <ul>
      <li><b>Map tiles</b> from OpenStreetMap, CARTO or OpenTopoMap, when a map is shown. Like any image on the web, your browser asks their servers for them, which shows them your IP address. No course or GPS data is sent: only which map squares are needed.</li>
      <li><b>Fonts</b> from Google Fonts, with the same IP-address request when the page opens.</li>
      <li><b>Hosting</b> by GitHub Pages (GitHub Inc.), which keeps standard server logs.</li>
    </ul>
  </section>
  <section class="sp-block">
    <h2>Online account (invited testers only)</h2>
    <p>An optional online account is open to a few invited testers; sign-ups are closed. Without an account nothing is sent. With one:</p>
    <ul>
      <li>data is stored in the EU (Supabase, Frankfurt): your email address for signing in, your profile (name, flag, a few words, badges, goals and bests), and the plans, sessions or runs you choose to save with the Save button (track points, settings and target, up to 30 saves);</li>
      <li>heart rate is never kept online, and neither are the max and resting heart rate or the weight of your profile: they stay in your browser;</li>
      <li>the AI is not switched on yet. When it is, an AI answer you ask for will send that plan or run's summary to the AI provider (OpenAI) to write it, and this page will say so first;</li>
      <li>you can ask for your data or the deletion of your account at any time by email.</li>
    </ul>
  </section>
  <section class="sp-block">
    <h2>Your rights and contact</h2>
    <p>Under the GDPR you can ask what is kept about you, have it corrected or erased, and object to its use. Without an online account there is nothing about you on our side, as everything stays in your browser. For any question: ${mailLink()}.</p>
    <p class="note">Last updated ${CHANGELOG[0].date}.</p>
  </section>
</div>`;
}

/* ---------- changelog ---------- */
const changelogBody = () => `${pageHead("What's new", "What's new", `Every version of ${esc(SITE.name)}, newest first. The version you are using is shown at the bottom of each page.`)}
<ol class="cl">${CHANGELOG.map((c, i) => `<li class="cl-row${i === 0 ? " now" : ""}"><div class="cl-v"><b>v${c.v}</b><time datetime="${c.date}">${c.date}</time>${i === 0 ? `<span class="cl-now">current</span>` : ""}</div><ul>${c.items.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></li>`).join("")}</ol>`;

/* ---------- 404 ---------- */
const notFoundBody = () => `<div class="nf">${SITE_PEAK}<div class="sec-kicker">Error 404</div><h1>Off course.</h1><p class="lead">This page does not exist, or has moved. No panic: the trail is right here.</p><p><a class="btn primary" href="./">Back to the planner</a> <a class="btn ghost" href="guide.html">Read the guide</a></p></div>`;

/** Every page as [file name, html]. `counter` = {name, tag} when visits are counted. */
export function sitePages({ fonts, counter }) {
  const p = (file, o) => [file, shell({ fonts, counter, ...o })];
  return [
    p("guide.html", { title: `User guide · ${SITE.name}`, description: `How to use ${SITE.name}: the three modes and every section, with screenshots, tips and an FAQ.`, active: "guide", body: guideBody() }),
    p("about.html", { title: `About · ${SITE.name}`, active: "about", body: aboutBody() }),
    p("privacy.html", { title: `Privacy · ${SITE.name}`, description: `What ${SITE.name} keeps, where, and why: your GPX files never leave your browser.`, body: privacyBody(counter) }),
    p("changelog.html", { title: `What's new · ${SITE.name}`, active: "changelog", body: changelogBody() }),
    // The 404 page can be served at any depth (/trail-race-planner/a/b/c): <base> makes its
    // relative links and its stylesheet resolve from the site root anyway.
    p("404.html", { title: `Page not found · ${SITE.name}`, base: SITE.base, body: notFoundBody() }),
  ];
}
