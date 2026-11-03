// build.js: bundle the app into ONE self-contained HTML file, with no dependencies. npm run build -> dist/index.html (a complete page, open it anywhere) dist/fragment.html (same content without <html>/<head>...

import { readFileSync, writeFileSync, mkdirSync, cpSync, existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sitePages, headMeta } from "./site-pages.js";
import { SITE } from "../src/site/site.js";
import { ANALYTICS, PROVIDERS } from "../src/ui/analytics.js";
import { CLOUD } from "../src/ui/cloud.js";
import { createHash } from "node:crypto";
import { stripJs, stripCss } from "./strip.js";

// The project folder: import.meta.url is this file's address (file:///.../scripts/build.js); turn it into a path, take its folder (scripts/) and go one level up.
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const entry = join(root, "src/ui/main.js");

// order: the files in the order they must appear in the bundle (dependencies first). seen: files already visited, so a file imported by several others is included once (and an import cycle cannot loop forever).
const order = [];
const seen = new Set();
/** Depth-first walk of the import graph from `file` (an absolute path). */
function visit(file) {
  if (seen.has(file)) return;
  seen.add(file);
  const src = readFileSync(file, "utf8");
  // Rule check 1: a line starting with `import {` that has no closing `}` on the same line ([^}]* = any characters except `}`, up to the end of the line) is an import split over several lines...
  if (/^import\s*\{[^}]*$/m.test(src)) throw new Error(`${file}: keep each import on one line; the bundler removes import lines one at a time.`);
  // Rule check 2: the word `as` (\b = word boundary) inside the braces of an import.
  if (/^import\s*\{[^}]*\bas\b/m.test(src)) throw new Error(`${file}: do not rename imports with "as"; the bundler removes import lines, so the new name would not exist.`);
  // Follow each import line.
  for (const m of src.matchAll(/^import\s+.*?from\s+["'](.+?)["'];?\s*$/gm)) visit(resolve(dirname(file), m[1]));
  order.push(file);
}
visit(entry);

// names: every top-level name seen so far -> the file that declared it, to catch clashes.
const names = new Map();
// Turn each file into a piece of the bundle: imports removed, `export` keywords removed, and comments stripped (the source keeps them; the live page does not need them).
const frUrl = `i18n/fr.json?v=${createHash("sha256").update(readFileSync(join(root, "src/i18n/fr.json"))).digest("hex").slice(0, 10)}`;
const parts = order.map((file) => {
  let src = readFileSync(file, "utf8").replaceAll('"i18n/fr.json"', `"${frUrl}"`);
  // Delete every import line (same pattern as above).
  src = src.replace(/^import\s+.*?from\s+["'].+?["'];?\s*$/gm, "");
  // Delete the word `export` (and its spaces) in front of a declaration.
  src = src.replace(/^export\s+(?=(async\s+)?(function|const|let|class))/gm, "");
  // Rule check 3: list the names declared at the start of a line (top-level declarations, since this code base does not indent them) and refuse a name declared in two files. [A-Za-z_$][\w$]* is a JavaScript identifier...
  for (const m of src.matchAll(/^(?:async\s+)?(?:function|const|let|class)\s+([A-Za-z_$][\w$]*)/gm)) {
    const name = m[1];
    if (names.has(name)) throw new Error(`Name "${name}" is declared in both ${names.get(name)} and ${file}. Rename one.`);
    names.set(name, file);
  }
  return stripJs(src);
});
// Glue the pieces inside (function(){ ... })(): a function that is defined and called at once (an "IIFE"), so the app's top-level names stay private instead of becoming globals of the page.
const js = `(function(){\n"use strict";\n${parts.join("\n")}\n})();`.replace(/<\/script/gi, "<\\/script");

// The page's content: the stylesheet inline in <style>, the empty <div id="app"> that the app fills in when it starts, and the bundled code inline in <script>.
const cssDir = join(root, "src/ui/css");
const appCss = readdirSync(cssDir).filter((f) => f.endsWith(".css")).sort().map((f) => readFileSync(join(cssDir, f), "utf8")).join("");
const css = stripCss(appCss + "\n" + readFileSync(join(root, "src/site/site.css"), "utf8"));
const fonts = `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:ital,wght@0,600;0,700;0,800;1,700;1,800&family=Barlow:wght@400;500;600&display=swap">`;
const body = `<style>\n${css}\n</style>\n<div class="wrap" id="app"></div>\n<script>\n${js}\n</script>\n`;

// Write the outputs.
mkdirSync(join(root, "dist"), { recursive: true });
// The server functions (supabase/functions) check achievements with the very same code as the app, and the AI function builds its OpenAI request with the very same prompt code: they get a copy of src/core in _shared/core...
await import("./core-copy.js");
// Photos are separate files (inlining them as base64 would make the page ~1.3x heavier and uncacheable).
cpSync(join(root, "src/ui/photos"), join(root, "dist/photos"), { recursive: true });
// Leaflet (the map library, BSD-2 licence) ships next to the page and is loaded only when a map is shown, so the page stays light and the map code works offline.
cpSync(join(root, "src/vendor/leaflet"), join(root, "dist/vendor/leaflet"), { recursive: true });
// The page title comes from SITE (src/site/site.js). In HTML, "&" must be written "&amp;".
const title = `${SITE.name} · ${SITE.tagline}`;
const titleHtml = title.replace(/&/g, "&amp;");
// The Content Security Policy (CSP): a rule list in each page's <head> telling the browser which sites the page may load code, styles, images and data from.
const origin = (u) => (u ? new URL(u).origin : "");
const counterHosts = (() => {
  const p = PROVIDERS[ANALYTICS.provider];
  if (!p || !ANALYTICS.site) return [];
  const { src, attrs } = p.script(ANALYTICS.site);
  return [origin(src), ...Object.values(attrs).filter((v) => /^https:/.test(v)).map(origin)];
})();
// Turnstile bot check (account forms), only once a site key is set in CLOUD.captcha.
const botHosts = CLOUD.captcha ? ["https://challenges.cloudflare.com"] : [];
function withCsp(html) {
  const hashes = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => `'sha256-${createHash("sha256").update(m[1]).digest("base64")}'`);
  const rules = [
    "default-src 'self'",
    `script-src 'self' ${[...hashes, ...counterHosts.slice(0, 1), ...botHosts].join(" ")}`,
    `frame-src 'self' ${botHosts.join(" ")}`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    `img-src 'self' data: blob: https://*.tile.openstreetmap.org https://tile.openstreetmap.org https://*.basemaps.cartocdn.com https://*.tile.opentopomap.org ${counterHosts.join(" ")}`,
    `connect-src 'self' ${[origin(CLOUD.url), ...counterHosts, "https://api.openai.com"].filter(Boolean).join(" ")}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].map((r) => r.trim());
  return html.replace('<meta charset="utf-8">', `<meta charset="utf-8">\n<meta http-equiv="Content-Security-Policy" content="${rules.join("; ")}">`);
}

// fragment.html: the content without <html>/<head>/<body>, for a host page that adds its own.
writeFileSync(join(root, "dist/fragment.html"), `<title>${titleHtml}</title>\n${fonts}\n${body}`);
// index.html: a complete page.
writeFileSync(
  join(root, "dist/index.html"),
  withCsp(`<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">\n<title>${titleHtml}</title>\n${headMeta({ title })}\n${fonts}\n</head>\n<body>\n${body}</body>\n</html>\n`)
);

// The static pages (guide, about, privacy, what's new, 404) share the app's stylesheet as a file.
writeFileSync(join(root, "dist/style.css"), css);
const prov = PROVIDERS[ANALYTICS.provider];
let counter = null;
if (prov && ANALYTICS.site) {
  const { src, attrs } = prov.script(ANALYTICS.site);
  const a = Object.entries(attrs).map(([k, v]) => ` ${k}='${v}'`).join("");
  counter = { name: { goatcounter: "GoatCounter", plausible: "Plausible", cloudflare: "Cloudflare Web Analytics" }[ANALYTICS.provider], tag: `<script async src="${src}"${a}></script>` };
}
for (const [file, html] of sitePages({ fonts, counter })) writeFileSync(join(root, "dist", file), withCsp(html));
// The French version (src/ui/i18n.js swaps the texts): the dictionary as dist/i18n/fr.json, read only when French is picked, and the same i18n.js as a plain script for the static pages (its export keywords removed...
mkdirSync(join(root, "dist/i18n"), { recursive: true });
writeFileSync(join(root, "dist/i18n/fr.json"), JSON.stringify(JSON.parse(readFileSync(join(root, "src/i18n/fr.json"), "utf8"))));
const i18nSrc = stripJs(readFileSync(join(root, "src/ui/i18n.js"), "utf8")).replace(/^export /gm, "").replaceAll('"i18n/fr.json"', `"${frUrl}"`);
writeFileSync(join(root, "dist/i18n.js"), `(function(){\n"use strict";\n${i18nSrc}\nif (i18nLang() === "fr") document.documentElement.classList.add("i18n-wait");\ndocument.addEventListener("DOMContentLoaded", () => i18nInit(document.querySelector(".i18n-slot")));\n})();\n`);
// Icons, the share-preview image and the guide screenshots (made once by scripts/site-images.mjs and scripts/guide-shots.mjs, kept in src/site).
cpSync(join(root, "src/site/icons"), join(root, "dist"), { recursive: true });
if (existsSync(join(root, "src/site/guide"))) cpSync(join(root, "src/site/guide"), join(root, "dist/guide"), { recursive: true });
// Installable app (PWA, also the Play Store wrapper): manifest + service worker that keeps the last copy for offline use.
writeFileSync(join(root, "dist/manifest.webmanifest"), JSON.stringify({
  name: SITE.name, short_name: SITE.name, description: SITE.description, lang: "en",
  id: "./", start_url: "./", scope: "./", display: "standalone", background_color: "#0a1530", theme_color: "#0a1530",
  icons: [
    { src: "icon-192.png", sizes: "192x192", type: "image/png" },
    { src: "icon-512.png", sizes: "512x512", type: "image/png" },
    { src: "icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
  ],
  // Run files shared to the installed app (Android share menu) or opened with it (desktop): read in ui/trackfile.js.
  share_target: { action: "./?share-target", method: "POST", enctype: "multipart/form-data", params: { files: [{ name: "track", accept: [".gpx", ".fit", ".tcx", ".zip", ".gz", "application/gpx+xml", "application/vnd.ant.fit", "application/vnd.garmin.tcx+xml", "application/zip", "application/gzip", "application/octet-stream", "text/xml"] }] } },
  file_handlers: [{ action: "./", accept: { "application/gpx+xml": [".gpx"], "application/vnd.ant.fit": [".fit"], "application/vnd.garmin.tcx+xml": [".tcx"] } }],
}, null, 1));
const swVer = createHash("sha256").update(readFileSync(join(root, "dist/index.html"))).digest("hex").slice(0, 10);
writeFileSync(join(root, "dist/sw.js"), readFileSync(join(root, "scripts/sw.js"), "utf8").replace("__VER__", swVer));
// Report the number of modules and the size of code in KB (characters / 1024).
console.log(`built dist/index.html: ${order.length} modules, ${Math.round((css.length + js.length) / 1024)} KB of code`);
