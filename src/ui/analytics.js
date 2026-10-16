// analytics.js: anonymous visit and event counts, through one switchable provider.
//
// The planner is a static page: GitHub Pages only hands out files and cannot record anything.
// To count visits, the page loads a small script from an analytics service, and that script
// sends one HTTPS request per page view (and per event) to the service, which keeps the counts.
// All three providers below are cookieless and keep no personal data, so no cookie banner.
//
// The rest of the app only ever calls trackEvent("name", "label"). Which service receives it is
// decided here, in ANALYTICS, so switching provider is a one-line change.
//
// Rules for events, so the counts stay useful and private:
//   - names and labels come from a fixed set in the code, never from what the runner typed or
//     loaded (no file names, race names or times);
//   - kebab-case, short: "replay-play", "scenario" + "fast".
// With no site code (or on localhost, which every provider ignores) nothing is loaded or sent.
//
// Design: createAnalytics() is a "factory": it builds a tracker object from a config and an
// environment (the browser's window and document). The app makes one tracker for the real page
// at the bottom of this file; the tests make their own with a fake window, so they can check
// what would be sent without a browser or a network. Events fired before the provider's script
// has loaded wait in a small queue and are sent when it arrives.
//
// Exports: ANALYTICS (the config), PROVIDERS, createAnalytics (the factory), and for the app:
// analyticsOn, analyticsName, startAnalytics(), trackEvent(name, label), trackOnce(name, label).

export const ANALYTICS = {
  provider: "goatcounter", // "goatcounter", "plausible", "cloudflare", or "" to switch off
  site: "trail-race-planner", // goatcounter: the site code (the "xxx" of xxx.goatcounter.com); plausible: the
  // domain registered there; cloudflare: the beacon token
};

// What each provider needs: the script tag to add, and how to send one custom event.
// send() returns false while the provider's script is not loaded yet, so the event waits.
// Each provider is an object with two functions:
//   script(site)            -> { src: script URL, attrs: { attribute: value } } for the <script> tag
//   send(window, name, label) -> true when sent (or deliberately dropped), false to retry later
// The provider's script, once loaded, puts its own function on `window` (window.goatcounter,
// window.plausible); send() checks that function exists before calling it.
export const PROVIDERS = {
  goatcounter: {
    script: (site) => ({ src: "https://gc.zgo.at/count.js", attrs: { "data-goatcounter": `https://${site}.goatcounter.com/count` } }),
    // GoatCounter has no event properties: the label becomes part of the event path.
    send: (w, name, label) => {
      if (!w.goatcounter || typeof w.goatcounter.count !== "function") return false;
      const path = label ? `${name}/${label}` : name;
      w.goatcounter.count({ path, title: path, event: true });
      return true;
    },
  },
  plausible: {
    script: (site) => ({ src: "https://plausible.io/js/script.js", attrs: { "data-domain": site } }),
    send: (w, name, label) => {
      if (typeof w.plausible !== "function") return false;
      w.plausible(name, label ? { props: { label } } : undefined);
      return true;
    },
  },
  cloudflare: {
    // Cloudflare Web Analytics counts page views only: custom events are dropped.
    script: (site) => ({ src: "https://static.cloudflareinsights.com/beacon.min.js", attrs: { "data-cf-beacon": JSON.stringify({ token: site }) } }),
    send: () => true,
  },
};

// Make a name or label safe and tidy: lower case; every run of characters other than a-z and
// 0-9 becomes one "-" (regex [^a-z0-9]+); no "-" at either end (regex ^-|-$); at most 40
// characters. "Replay Play!" -> "replay-play". `s || ""` turns undefined or null into "".
const slug = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);

/**
 * Build a tracker. `env` is the browser (window and document); tests pass a fake one.
 * Returns { start(), event(name, label), once(name, label) }.
 * Also on the returned object: `enabled` (false when switched off: no provider, no site code or
 * no browser) and, after start(), `started`.
 * Nothing is sent before start() has added the provider's script; events wait in the queue.
 */
export function createAnalytics(config, env) {
  const p = PROVIDERS[config.provider];
  const on = Boolean(p && config.site && env && env.document);
  const queue = []; // events fired before the provider's script finished loading
  const seen = new Set(); // for once()
  let last = ""; // the same event twice within a second (a double click) counts once
  let lastAt = 0;
  // Send the waiting events in order, oldest first, and stop at the first one the provider
  // cannot take yet (its script not loaded): that one and the rest stay queued.
  // ...queue[0] spreads the [name, label] pair into two separate arguments.
  const flush = () => {
    while (queue.length && p.send(env.window, ...queue[0])) queue.shift();
  };
  const api = {
    enabled: on,
    /** Add the provider's <script> tag to the page head, once. When it loads, send the queue. */
    start() {
      if (!on || api.started) return;
      api.started = true;
      // Destructuring: take the src and attrs fields of the returned object as two variables.
      const { src, attrs } = p.script(config.site);
      const s = env.document.createElement("script");
      s.async = true;
      s.src = src;
      Object.entries(attrs).forEach(([k, v]) => s.setAttribute(k, v));
      s.onload = flush;
      env.document.head.appendChild(s);
    },
    /** Count one event: tidy its name and label, skip an instant repeat, queue it and try to send. */
    event(name, label) {
      if (!on) return;
      const ev = [slug(name), slug(label)];
      if (!ev[0]) return;
      const key = ev.join("/");
      // Date.now(): milliseconds since 1 January 1970, used here to measure the 1 s gap.
      const now = Date.now();
      if (key === last && now - lastAt < 1000) return;
      last = key;
      lastAt = now;
      // Blocked by an ad blocker the script never loads: keep a short queue, then drop.
      if (queue.length < 50) queue.push(ev);
      flush();
    },
    /** Count an event only the first time it happens during this visit (a Set remembers it). */
    once(name, label) {
      const key = `${name}/${label || ""}`;
      if (seen.has(key)) return;
      seen.add(key);
      api.event(name, label);
    },
  };
  return api;
}

// The page's one tracker. Outside a browser (Node running the tests or the build) `window` does
// not exist, so env is null and the tracker stays off.
const tracker = createAnalytics(ANALYTICS, typeof window === "undefined" ? null : { window, document });
// For the page's footer or privacy note: whether counting is on, and the service's display name.
export const analyticsOn = tracker.enabled;
export const analyticsName = { goatcounter: "GoatCounter", plausible: "Plausible", cloudflare: "Cloudflare Web Analytics" }[ANALYTICS.provider] || "";
// The three functions the rest of the app calls.
export function startAnalytics() { tracker.start(); }
export function trackEvent(name, label) { tracker.event(name, label); }
export function trackOnce(name, label) { tracker.once(name, label); }
