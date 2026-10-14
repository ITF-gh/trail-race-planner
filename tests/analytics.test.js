import { test } from "node:test";
import assert from "node:assert/strict";
import { createAnalytics, PROVIDERS } from "../src/ui/analytics.js";

// A fake browser: records the script tags added and the events GoatCounter would receive.
function fakeEnv() {
  const added = [];
  const sent = [];
  const document = {
    head: { appendChild: (el) => added.push(el) },
    createElement: () => ({ attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } }),
  };
  return { env: { window: {}, document }, added, sent };
}

test("analytics: no site code means nothing is loaded or sent", () => {
  const { env, added } = fakeEnv();
  const a = createAnalytics({ provider: "goatcounter", site: "" }, env);
  a.start();
  a.event("demo");
  assert.equal(a.enabled, false);
  assert.equal(added.length, 0);
});

test("analytics: GoatCounter script tag, queued events flushed on load, labels cleaned", () => {
  const { env, added, sent } = fakeEnv();
  const a = createAnalytics({ provider: "goatcounter", site: "trp" }, env);
  a.start();
  assert.equal(added.length, 1);
  assert.equal(added[0].src, "https://gc.zgo.at/count.js");
  assert.equal(added[0].attrs["data-goatcounter"], "https://trp.goatcounter.com/count");
  a.event("gpx-upload", "race");
  a.event("map layer", "Topo Map!");
  assert.equal(sent.length, 0); // script not loaded yet: events wait
  env.window.goatcounter = { count: (o) => sent.push(o) };
  added[0].onload();
  assert.deepEqual(sent.map((o) => o.path), ["gpx-upload/race", "map-layer/topo-map"]);
  assert.ok(sent.every((o) => o.event === true));
  a.event("demo");
  a.event("demo"); // double click within a second counts once
  a.once("section-reached", "s2");
  a.once("section-reached", "s2");
  assert.deepEqual(sent.slice(2).map((o) => o.path), ["demo", "section-reached/s2"]);
});

test("analytics: Plausible sends the label as a property; Cloudflare drops events", () => {
  const { env, added } = fakeEnv();
  const calls = [];
  env.window.plausible = (...args) => calls.push(args);
  const a = createAnalytics({ provider: "plausible", site: "itf-gh.github.io" }, env);
  a.start();
  assert.equal(added[0].attrs["data-domain"], "itf-gh.github.io");
  a.event("scenario", "fast");
  assert.deepEqual(calls, [["scenario", { props: { label: "fast" } }]]);
  assert.equal(PROVIDERS.cloudflare.send({}, "x"), true);
});
