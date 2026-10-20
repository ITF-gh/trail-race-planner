// site.js: what every page of the site shares (the app and the static pages next to it):
// the name, the version, the contact, and the footer.
//
// The app (dist/index.html) imports this file through the bundler; scripts/build.js imports it
// too, to write the static pages (guide.html, about.html, ...). One source, so the footer and
// the version can never differ from one page to another.
//
// External links are OFF for now (SITE.linksLive = false): they are written as plain text that
// looks like a link but goes nowhere, so nothing points at an address that is not ready yet
// (the prepmyrace.com mailbox, the bug tracker). Set it to true and rebuild to switch them all on.

import { CHANGELOG } from "./changelog.js";

export const SITE = {
  name: "Prep my race",
  tagline: "Trail race & run planner",
  description: "Plan your trail race from your own runs: pace on every gradient, hikes, gels, checkpoint times, a race-day rehearsal and watch messages. Free, and your GPX files never leave your browser.",
  url: "https://itf-gh.github.io/trail-race-planner/", // absolute address, for share previews
  base: "/trail-race-planner/", // path of the site on its host, for the 404 page (any depth)
  version: CHANGELOG[0].v,
  email: "contact@prepmyrace.com",
  issues: "https://github.com/ITF-gh/trail-race-planner/issues/new",
  linksLive: false,
};

const siteEsc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/** A link to another site, or (while SITE.linksLive is false) the same text, inert. */
export function extLink(href, text, cls = "") {
  if (SITE.linksLive) return `<a${cls ? ` class="${cls}"` : ""} href="${siteEsc(href)}" target="_blank" rel="noopener">${text}</a>`;
  return `<span class="ext-off${cls ? " " + cls : ""}" title="Link coming soon">${text}</span>`;
}

/** The contact address, as a mail link once links are live. */
export const mailLink = (cls = "") => (SITE.linksLive ? `<a${cls ? ` class="${cls}"` : ""} href="mailto:${SITE.email}">${SITE.email}</a>` : `<span class="ext-off${cls ? " " + cls : ""}" title="Address coming soon">${SITE.email}</span>`);

// The photographers, credited on every page. Pexels licence: free use, credit appreciated.
export const SITE_PHOTOGRAPHERS = [
  ["Artem Meletov", "https://www.pexels.com/photo/person-standing-on-mountain-peak-above-clouds-8910505/"],
  ["Cara Denison", "https://www.pexels.com/photo/silhouette-of-jogger-at-sunset-in-park-34730429/"],
  ["Boys in Bristol Photography", "https://www.pexels.com/photo/silhouette-of-a-man-running-in-a-meadow-against-the-sky-20498424/"],
  ["Hobi Photography", "https://www.pexels.com/photo/hiker-with-flashlight-looking-at-starry-night-sky-27790902/"],
  ["Elina Volkova", "https://www.pexels.com/photo/misty-forest-path-in-dense-woodland-29579873/"],
  ["Jack Davis", "https://www.pexels.com/photo/back-view-of-a-woman-running-up-the-mountain-trail-8949023/"],
  ["Lorenzo Castellino", "https://www.pexels.com/photo/man-walking-at-a-river-in-mountains-14989443/"],
  ["Alin Serban", "https://www.pexels.com/photo/trail-runner-in-green-mountain-landscape-30932860/"],
  ["Kelly", "https://www.pexels.com/photo/black-digital-smartwatch-3999644/"],
];

export const SITE_PEAK = `<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M2 27 12 9l5 8 4-5 9 15z" fill="currentColor"/><path d="m12 9 2.6 4.6L12 12l-2 2.2z" fill="#fff" opacity=".85"/></svg>`;

/**
 * The footer of every page. `pre` is the path back to the site root ("" on pages next to
 * index.html). `analytics` names the visit counter when it is on, for the privacy line.
 */
export function siteFooter({ pre = "", analytics = "" } = {}) {
  const p = (f) => pre + f;
  return `<footer class="site-foot" id="site-foot">
  <div class="sf-in">
    <div class="sf-brand">
      <a class="sf-logo" href="${p("./")}">${SITE_PEAK}<b>${SITE.name}</b></a>
      <p>${SITE.tagline}. Free, no account needed, your GPX files never leave your browser.</p>
      <p class="sf-safe"><b>Safety first.</b> Times and paces are estimates, usually within 5 to 10%. Weather, terrain, race rules and how you feel on the day come first. Not medical advice.</p>
    </div>
    <nav class="sf-col" aria-label="Help">
      <h4>Help</h4>
      <a href="${p("guide.html")}">User guide</a>
      <a href="${p("guide.html#faq")}">FAQ</a>
      <a href="${p("changelog.html")}">What's new</a>
    </nav>
    <nav class="sf-col" aria-label="About">
      <h4>About</h4>
      <a href="${p("about.html")}">About ${SITE.name}</a>
      <a href="${p("about.html#how")}">How it works</a>
      <a href="${p("privacy.html")}">Privacy</a>
    </nav>
    <div class="sf-col">
      <h4>Contact</h4>
      ${mailLink()}
      ${extLink(SITE.issues, "Report a bug or an idea")}
    </div>
  </div>
  <div class="sf-bottom">
    <span>v${SITE.version} · <a href="${p("changelog.html")}">What's new</a></span>
    <span>${analytics ? `Visits counted anonymously with ${siteEsc(analytics)}, no cookies.` : "No visit tracking."}</span>
    <span>Photos: ${SITE_PHOTOGRAPHERS.map(([n, u]) => extLink(u, n)).join(", ")} / Pexels. Maps © OpenStreetMap contributors.</span>
  </div>
</footer>`;
}
