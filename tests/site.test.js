import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { SITE, siteFooter, extLink } from "../src/site/site.js";
import { GUIDE, FAQ } from "../src/site/guide.js";
import { CHANGELOG } from "../src/site/changelog.js";
import { sitePages, markdown } from "../scripts/site-pages.js";

const main = readFileSync(new URL("../src/ui/main.js", import.meta.url), "utf8");

test("site: version comes from the newest changelog entry, versions are unique", () => {
  assert.equal(SITE.version, CHANGELOG[0].v);
  assert.equal(new Set(CHANGELOG.map((c) => c.v)).size, CHANGELOG.length);
});

test("site: external links stay inert while linksLive is false", () => {
  assert.equal(SITE.linksLive, false);
  const foot = siteFooter({ analytics: "GoatCounter" });
  assert.ok(!/mailto:|href="https?:/.test(foot), "no live external link in the footer");
  assert.match(foot, /contact@prepmyrace\.com/);
  assert.match(foot, new RegExp(`v${SITE.version.replace(".", "\\.")}`));
  assert.match(extLink("https://example.com", "x"), /^<span class="ext-off"/);
  const pages = sitePages({ fonts: "", counter: null, howMd: "# T\n\nHello" });
  for (const [file, html] of pages) {
    const body = html.slice(html.indexOf("<body"));
    assert.ok(!/<a [^>]*href="(https?:|mailto:)/.test(body), `${file}: no live external link`);
  }
});

test("site: every guide section points at a real section of the app and a screenshot", () => {
  for (const m of GUIDE) {
    for (const s of m.sections) {
      if (s.sec) assert.ok(main.includes(`id="${s.sec}"`), `${s.id}: #${s.sec} exists in the app`);
      if (s.shot) assert.ok(existsSync(new URL(`../src/site/guide/${s.shot}.webp`, import.meta.url)), `${s.shot}.webp exists`);
      assert.ok(s.what && s.how.length && s.tip, `${s.id}: text complete`);
    }
    if (m.shot) assert.ok(existsSync(new URL(`../src/site/guide/${m.shot}.webp`, import.meta.url)), `${m.shot}.webp exists`);
  }
  assert.ok(FAQ.length >= 8);
});

test("site: pages share the head (share preview, icons) and the 404 resolves from the site root", () => {
  const pages = Object.fromEntries(sitePages({ fonts: "", counter: { name: "GoatCounter", tag: "<script></script>" }, howMd: "# T\n\nHello" }));
  assert.deepEqual(Object.keys(pages).sort(), ["404.html", "about.html", "changelog.html", "guide.html", "privacy.html"]);
  for (const html of Object.values(pages)) {
    assert.match(html, /property="og:image" content="https:\/\/[^"]+og\.jpg"/);
    assert.match(html, /rel="apple-touch-icon"/);
    assert.match(html, /id="site-foot"/);
  }
  assert.match(pages["404.html"], new RegExp(`<base href="${SITE.base}">`));
  assert.match(pages["privacy.html"], /GoatCounter/);
});

test("site: the small Markdown converter handles headings, lists, tables and inline marks", () => {
  const html = markdown("## A `b`\n\nSome **bold** and *it*.\n\n- one\n- two\n\n1. first\n\n| x | y |\n|---|---|\n| 1 | 2 |");
  assert.match(html, /<h3>A <code>b<\/code><\/h3>/);
  assert.match(html, /<b>bold<\/b> and <i>it<\/i>/);
  assert.match(html, /<ul><li>one<\/li><li>two<\/li><\/ul>/);
  assert.match(html, /<ol><li>first<\/li><\/ol>/);
  assert.match(html, /<th>x<\/th><th>y<\/th>.*<td>1<\/td><td>2<\/td>/);
});
