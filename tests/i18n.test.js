import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CHANGELOG } from "../src/site/changelog.js";

const fr = JSON.parse(readFileSync(new URL("../src/i18n/fr.json", import.meta.url), "utf8"));
const holes = (s) => (s.match(/\{\d+\}/g) || []).sort().join();

test("i18n: every French text keeps the number slots of its English key", () => {
  for (const d of [fr.t, fr.h]) for (const [en, f] of Object.entries(d)) {
    assert.ok(f.trim(), `empty French for "${en}"`);
    assert.equal(holes(f), holes(en), `slots differ for "${en}"`);
  }
  for (const [re] of fr.r) assert.doesNotThrow(() => new RegExp(re));
});

test("i18n: the newest What's new entries are translated", () => {
  // The page looks a text up as it is, then with its numbers as {0}, {1}... (src/ui/i18n.js).
  let n;
  const slots = (s) => { n = 0; return s.replace(/\d+(?:[.,:h']\d+)*/g, () => `{${n++}}`); };
  for (const it of CHANGELOG[0].items) assert.ok(fr.t[it] || fr.h[it] || fr.t[slots(it)], `no French for "${it}"`);
});
