// build.js: bundle the app into ONE self-contained HTML file, with no dependencies.
//
//   npm run build        ->  dist/index.html     (a complete page, open it anywhere)
//                            dist/fragment.html  (same content without <html>/<head>,
//                                                 for hosts that wrap the page themselves)
//
// What a bundler does, in miniature:
//   1. Start at src/ui/main.js and follow its `import ... from "./x.js"` lines.
//   2. Order the files so every file comes after the files it imports.
//   3. Strip the `import` lines and the `export` keywords (inside one script they
//      are not needed: everything shares one scope).
//   4. Wrap the result in a function so nothing leaks into the page.
// This works because the project follows three rules: one import per line, no
// renaming of imports with `as`, and no two modules declare the same top-level
// name. The build checks the last two and stops with a clear message if broken. Tools like esbuild do the
// same job with far more features; reach for them when the project outgrows this.
// (The first rule is checked too, for an import list split over several lines.)
//
// Besides the page, the build also copies a few files next to it (photos, the Leaflet map
// library) and refreshes the server functions' copy of src/core/history.js.
//
// Most of the work is done with regular expressions (regexes). The `m` flag makes ^ and $
// match at the start and end of every LINE (not only of the whole text), and the `g` flag
// finds every match instead of the first one.

import { readFileSync, writeFileSync, mkdirSync, cpSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sitePages, headMeta } from "./site-pages.js";
import { SITE } from "../src/site/site.js";
import { ANALYTICS, PROVIDERS } from "../src/ui/analytics.js";

// The project folder: import.meta.url is this file's address (file:///.../scripts/build.js);
// turn it into a path, take its folder (scripts/) and go one level up.
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const entry = join(root, "src/ui/main.js");

// order: the files in the order they must appear in the bundle (dependencies first).
// seen:  files already visited, so a file imported by several others is included once
//        (and an import cycle cannot loop forever). A Set answers "is it in?" quickly.
const order = [];
const seen = new Set();
/**
 * Depth-first walk of the import graph from `file` (an absolute path).
 * It visits every file that `file` imports BEFORE adding `file` itself to `order`
 * (a "post-order" walk), which is exactly what puts each dependency ahead of its users.
 * Side effects: fills `order` and `seen`; throws an Error if a file breaks the import rules.
 */
function visit(file) {
  if (seen.has(file)) return;
  seen.add(file);
  const src = readFileSync(file, "utf8");
  // Rule check 1: a line starting with `import {` that has no closing `}` on the same line
  // ([^}]* = any characters except `}`, up to the end of the line) is an import split over
  // several lines, which the line-by-line removal below would break.
  if (/^import\s*\{[^}]*$/m.test(src)) throw new Error(`${file}: keep each import on one line; the bundler removes import lines one at a time.`);
  // Rule check 2: the word `as` (\b = word boundary) inside the braces of an import.
  if (/^import\s*\{[^}]*\bas\b/m.test(src)) throw new Error(`${file}: do not rename imports with "as"; the bundler removes import lines, so the new name would not exist.`);
  // Follow each import line. The regex matches a whole line `import ... from "path";` and
  // captures the path between the quotes as m[1]; resolve() turns it into an absolute path
  // relative to the importing file's folder.
  for (const m of src.matchAll(/^import\s+.*?from\s+["'](.+?)["'];?\s*$/gm)) visit(resolve(dirname(file), m[1]));
  order.push(file);
}
visit(entry);

// names: every top-level name seen so far -> the file that declared it, to catch clashes.
const names = new Map();
// Turn each file into a piece of the bundle: imports removed, `export` keywords removed,
// and a /* path */ comment on top so the bundle stays readable.
const parts = order.map((file) => {
  let src = readFileSync(file, "utf8");
  // Delete every import line (same pattern as above). In one shared scope the imported names
  // already exist, because the files that declare them come earlier in the bundle.
  src = src.replace(/^import\s+.*?from\s+["'].+?["'];?\s*$/gm, "");
  // Delete the word `export` (and its spaces) in front of a declaration. The (?=...) part is a
  // "lookahead": it requires `function`, `const`, `let`, `class` or `async function` to follow,
  // but does not remove them.
  src = src.replace(/^export\s+(?=(async\s+)?(function|const|let|class))/gm, "");
  // Rule check 3: list the names declared at the start of a line (top-level declarations,
  // since this code base does not indent them) and refuse a name declared in two files.
  // [A-Za-z_$][\w$]* is a JavaScript identifier: a letter, _ or $, then letters, digits, _ or $.
  for (const m of src.matchAll(/^(?:async\s+)?(?:function|const|let|class)\s+([A-Za-z_$][\w$]*)/gm)) {
    const name = m[1];
    if (names.has(name)) throw new Error(`Name "${name}" is declared in both ${names.get(name)} and ${file}. Rename one.`);
    names.set(name, file);
  }
  return `/* ${file.slice(root.length + 1)} */\n${src}`;
});
// Glue the pieces inside (function(){ ... })(): a function that is defined and called at once
// (an "IIFE"), so the app's top-level names stay private instead of becoming globals of the page.
// "use strict" turns on JavaScript's strict mode (as in a module), which turns some silent
// mistakes into errors. Finally, any text "</script" inside the code (in a string, for example)
// is written "<\/script": otherwise the browser would think the <script> element ends there.
const js = `(function(){\n"use strict";\n${parts.join("\n")}\n})();`.replace(/<\/script/gi, "<\\/script");

// The page's content: the stylesheet inline in <style>, the empty <div id="app"> that the
// app fills in when it starts, and the bundled code inline in <script>.
// The styles are the app's (src/ui/style.css), then the site's (footer, "?" bubbles, the static pages).
// The fonts (Barlow and Barlow Condensed) are loaded from Google Fonts.
const css = readFileSync(join(root, "src/ui/style.css"), "utf8") + "\n" + readFileSync(join(root, "src/site/site.css"), "utf8");
const fonts = `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:ital,wght@0,600;0,700;0,800;1,700;1,800&family=Barlow:wght@400;500;600&display=swap">`;
const body = `<style>\n${css}\n</style>\n<div class="wrap" id="app"></div>\n<script>\n${js}\n</script>\n`;

// Write the outputs. `recursive: true` creates dist/ (and parents) if missing, and copies
// whole folders with cpSync.
mkdirSync(join(root, "dist"), { recursive: true });
// The server functions (supabase/functions) check achievements with the very same code as the
// app: they get a copy of history.js (a test fails if the copy is out of date).
cpSync(join(root, "src/core/history.js"), join(root, "supabase/functions/_shared/history.js"));
// Photos are separate files (inlining them as base64 would make the page ~1.3x heavier and uncacheable).
cpSync(join(root, "src/ui/photos"), join(root, "dist/photos"), { recursive: true });
// Leaflet (the map library, BSD-2 licence) ships next to the page and is loaded only when a map
// is shown, so the page stays light and the map code works offline.
cpSync(join(root, "src/vendor/leaflet"), join(root, "dist/vendor/leaflet"), { recursive: true });
// The page title comes from SITE (src/site/site.js). In HTML, "&" must be written "&amp;".
const title = `${SITE.name} · ${SITE.tagline}`;
const titleHtml = title.replace(/&/g, "&amp;");
// fragment.html: the content without <html>/<head>/<body>, for a host page that adds its own.
writeFileSync(join(root, "dist/fragment.html"), `<title>${titleHtml}</title>\n${fonts}\n${body}`);
// index.html: a complete page. The viewport meta tag makes it render at phone width on phones;
// viewport-fit=cover lets it use the whole screen on phones with a notch. headMeta adds the
// description, icons and share-preview tags.
writeFileSync(
  join(root, "dist/index.html"),
  `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">\n<title>${titleHtml}</title>\n${headMeta({ title })}\n${fonts}\n</head>\n<body>\n${body}</body>\n</html>\n`
);

// The static pages (guide, about, privacy, what's new, 404) share the app's stylesheet as a file.
// They count visits the same way as the app, with a plain script tag (they run no app code).
writeFileSync(join(root, "dist/style.css"), css);
const prov = PROVIDERS[ANALYTICS.provider];
let counter = null;
if (prov && ANALYTICS.site) {
  const { src, attrs } = prov.script(ANALYTICS.site);
  const a = Object.entries(attrs).map(([k, v]) => ` ${k}='${v}'`).join("");
  counter = { name: { goatcounter: "GoatCounter", plausible: "Plausible", cloudflare: "Cloudflare Web Analytics" }[ANALYTICS.provider], tag: `<script async src="${src}"${a}></script>` };
}
const howMd = readFileSync(join(root, "docs/HOW_IT_WORKS.md"), "utf8");
for (const [file, html] of sitePages({ fonts, counter, howMd })) writeFileSync(join(root, "dist", file), html);
// Icons, the share-preview image and the guide screenshots (made once by scripts/site-images.mjs
// and scripts/guide-shots.mjs, kept in src/site).
cpSync(join(root, "src/site/icons"), join(root, "dist"), { recursive: true });
if (existsSync(join(root, "src/site/guide"))) cpSync(join(root, "src/site/guide"), join(root, "dist/guide"), { recursive: true });
// Report the number of modules and the size of code in KB (characters / 1024).
console.log(`built dist/index.html: ${order.length} modules, ${Math.round((css.length + js.length) / 1024)} KB of code`);
