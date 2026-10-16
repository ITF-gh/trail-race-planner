// guide-shots.mjs: take the screenshots of the user guide from the built app with the demo data,
// so the guide shows the app exactly as it is. Re-run after a visible change:
//
//   npm run build && node scripts/guide-shots.mjs [path/to/playwright/index.mjs]
//
// How: a headless Chromium (Playwright) opens dist/ through a tiny local web server, loads the
// demo or the sample run, scrolls to each section and takes a screenshot. Chromium screenshots
// are PNG or JPEG only, so the page itself re-encodes each one to WebP (canvas.toDataURL), a
// format about 30% lighter at the same look. Files land in src/site/guide/<shot>.webp, the
// names used in src/site/guide.js.

import { createServer } from "node:http";
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import { dirname, join, extname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const out = join(root, "src/site/guide");
mkdirSync(out, { recursive: true });
const { chromium } = await import(process.argv[2] || "/opt/node-tools/node_modules/playwright/index.mjs");

const TYPES = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".webp": "image/webp", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg" };
const server = createServer((req, res) => {
  let f = join(dist, decodeURIComponent(req.url.split("?")[0]));
  if (existsSync(f) && statSync(f).isDirectory()) f = join(f, "index.html");
  if (!existsSync(f)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { "content-type": TYPES[extname(f)] || "application/octet-stream" });
  res.end(readFileSync(f));
}).listen(0);
const U = `http://localhost:${server.address().port}/`;

const W = 1440, H = 900; // a laptop screen; saved at 1200 px wide
const b = await chromium.launch();
async function open(url) {
  const p = await b.newPage({ viewport: { width: W, height: H } });
  await p.route(/goatcounter|gc\.zgo/, (r) => r.abort());
  await p.addInitScript(() => { try { localStorage.clear(); localStorage.setItem("trp.theme", JSON.stringify("night")); } catch (e) { /* */ } });
  await p.goto(U + url, { waitUntil: "networkidle" });
  await p.waitForTimeout(700);
  return p;
}
async function save(p, name, clip) {
  const png = await p.screenshot(clip ? { clip } : {});
  const webp = await p.evaluate(async ({ b64, w }) => {
    const img = new Image();
    img.src = "data:image/png;base64," + b64;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = w; c.height = Math.round((img.height * w) / img.width);
    c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL("image/webp", 0.8).split(",")[1];
  }, { b64: png.toString("base64"), w: 1200 });
  writeFileSync(join(out, name + ".webp"), Buffer.from(webp, "base64"));
  console.log("  " + name);
}
/** Scroll a section under the top bar and capture one screen of it. */
async function at(p, sel, name, settle = 1200) {
  await p.evaluate((s) => { const e = document.querySelector(s); window.scrollTo(0, e.getBoundingClientRect().top + scrollY - 60); }, sel);
  await p.waitForTimeout(settle);
  await save(p, name);
}

// Prep my race: header, then the demo plan section by section.
let p = await open("");
await save(p, "race-hero");
await p.click("#demo");
await p.waitForTimeout(3500);
await at(p, "#s1", "engine");
await at(p, "#s2", "course");
await at(p, "#s3", "plan");
await at(p, "#s4", "rehearsal", 2500);
await at(p, "#s-pimp", "watch");
// The top bar, over the plan, with Export A4 and Sky mode.
await p.evaluate(() => window.scrollTo(0, document.querySelector("#s3").getBoundingClientRect().top + scrollY - 60));
await p.waitForTimeout(800);
await save(p, "top-bar", { x: 0, y: 0, width: W, height: 420 });
// The account menu, open, at the top of the page.
await p.evaluate(() => window.scrollTo(0, 0));
await p.waitForTimeout(500);
if (await p.$(".acct-btn")) { await p.click(".acct-btn"); await p.waitForTimeout(900); await save(p, "account"); }
await p.close();

// Prep my run: header, then the sample run.
p = await open("?mode=prep");
await save(p, "prep-hero");
const sample = await p.$("#prepSample");
if (sample) { await sample.click(); await p.waitForTimeout(3000); await at(p, "#s-prep", "prep", 2000); }
await p.close();

// Rewind my run: header, then the sample run.
p = await open("?mode=run");
await save(p, "rewind-hero");
await p.click("[data-run-sample]");
await p.waitForTimeout(3500);
await at(p, "#s5", "recap", 2000);
await at(p, "#s6", "deep-dive");
await p.close();

await b.close();
server.close();
console.log("guide screenshots written to src/site/guide");
