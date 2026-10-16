// site-images.mjs: make the PNG icons and the share-preview image (og.jpg) once, from the SVG logo and
// the hero photo, with a headless browser (Playwright + Chromium). The results are committed in
// src/site/icons, so the normal build (and GitHub Actions) never needs a browser.
//
//   node scripts/site-images.mjs [path/to/playwright/index.mjs]
//
// Why PNG copies of an SVG icon: most browsers take the SVG favicon, but iPhones (home-screen
// icon) and many share previews only read PNG/JPEG.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pw = process.argv[2] || "/opt/node-tools/node_modules/playwright/index.mjs";
const { chromium } = await import(pw);
const icons = join(root, "src/site/icons");
const svg = readFileSync(join(icons, "favicon.svg"), "utf8");
const hero = readFileSync(join(root, "src/ui/photos/hero.webp")).toString("base64");

const b = await chromium.launch();
for (const [size, file] of [[32, "favicon-32.png"], [180, "apple-touch-icon.png"]]) {
  const p = await b.newPage({ viewport: { width: size, height: size } });
  // The home-screen icon is square (iOS rounds the corners itself), so no transparent corners.
  await p.setContent(`<body style="margin:0;background:#0a1530">${svg.replace("<svg ", `<svg width="${size}" height="${size}" `).replace(size === 180 ? 'rx="7"' : "@@", 'rx="0"')}</body>`);
  await p.screenshot({ path: join(icons, file), omitBackground: size === 32 });
  await p.close();
}

// The card a messaging app shows when the link is shared: 1200 x 630 is the size they all read.
const p = await b.newPage({ viewport: { width: 1200, height: 630 } });
await p.setContent(`<!doctype html><html><head>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:ital,wght@1,800&family=Barlow:wght@500;600&display=block">
<style>
body{margin:0;width:1200px;height:630px;overflow:hidden;font-family:Barlow,sans-serif;color:#f5f7fc;
background:linear-gradient(90deg,rgba(6,16,31,.92) 0%,rgba(6,16,31,.7) 45%,rgba(6,16,31,.1) 80%),url(data:image/webp;base64,${hero}) center 40%/cover}
.in{position:absolute;left:72px;top:72px;right:420px}
.brand{display:flex;align-items:center;gap:16px;font:italic 800 34px "Barlow Condensed";text-transform:uppercase;letter-spacing:.04em}
.brand svg{width:64px;height:64px}
h1{font:italic 800 108px/0.9 "Barlow Condensed";text-transform:uppercase;margin:40px 0 0}
h1 em{color:#ffc928;font-style:inherit}
p{font-size:28px;font-weight:500;margin:28px 0 0;color:#dfe6f3;max-width:800px}
.bar{position:absolute;left:0;right:0;bottom:0;height:12px;background:linear-gradient(90deg,#ff3048,#ffc928)}
</style></head><body><div class="in">
<div class="brand">${svg}Prep my race</div>
<h1>Know the course.<br><em>Own the day.</em></h1>
<p>Your trail race plan, built from your own runs. Free, in your browser.</p>
</div><div class="bar"></div></body></html>`, { waitUntil: "networkidle" });
await p.evaluate(() => document.fonts.ready);
await p.screenshot({ path: join(icons, "og.jpg"), type: "jpeg", quality: 86 });
await b.close();
console.log("icons and og.jpg written to src/site/icons");
