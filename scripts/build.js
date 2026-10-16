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

import { readFileSync, writeFileSync, mkdirSync, cpSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const entry = join(root, "src/ui/main.js");

const order = [];
const seen = new Set();
function visit(file) {
  if (seen.has(file)) return;
  seen.add(file);
  const src = readFileSync(file, "utf8");
  if (/^import\s*\{[^}]*$/m.test(src)) throw new Error(`${file}: keep each import on one line; the bundler removes import lines one at a time.`);
  if (/^import\s*\{[^}]*\bas\b/m.test(src)) throw new Error(`${file}: do not rename imports with "as"; the bundler removes import lines, so the new name would not exist.`);
  for (const m of src.matchAll(/^import\s+.*?from\s+["'](.+?)["'];?\s*$/gm)) visit(resolve(dirname(file), m[1]));
  order.push(file);
}
visit(entry);

const names = new Map();
const parts = order.map((file) => {
  let src = readFileSync(file, "utf8");
  src = src.replace(/^import\s+.*?from\s+["'].+?["'];?\s*$/gm, "");
  src = src.replace(/^export\s+(?=(async\s+)?(function|const|let|class))/gm, "");
  for (const m of src.matchAll(/^(?:async\s+)?(?:function|const|let|class)\s+([A-Za-z_$][\w$]*)/gm)) {
    const name = m[1];
    if (names.has(name)) throw new Error(`Name "${name}" is declared in both ${names.get(name)} and ${file}. Rename one.`);
    names.set(name, file);
  }
  return `/* ${file.slice(root.length + 1)} */\n${src}`;
});
const js = `(function(){\n"use strict";\n${parts.join("\n")}\n})();`.replace(/<\/script/gi, "<\\/script");

const css = readFileSync(join(root, "src/ui/style.css"), "utf8");
const fonts = `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:ital,wght@0,600;0,700;0,800;1,700;1,800&family=Barlow:wght@400;500;600&display=swap">`;
const body = `<style>\n${css}\n</style>\n<div class="wrap" id="app"></div>\n<script>\n${js}\n</script>\n`;

mkdirSync(join(root, "dist"), { recursive: true });
// The server functions (supabase/functions) check achievements with the very same code as the
// app: they get a copy of history.js (a test fails if the copy is out of date).
cpSync(join(root, "src/core/history.js"), join(root, "supabase/functions/_shared/history.js"));
// Photos are separate files (inlining them as base64 would make the page ~1.3x heavier and uncacheable).
cpSync(join(root, "src/ui/photos"), join(root, "dist/photos"), { recursive: true });
// Leaflet (the map library, BSD-2 licence) ships next to the page and is loaded only when a map
// is shown, so the page stays light and the map code works offline.
cpSync(join(root, "src/vendor/leaflet"), join(root, "dist/vendor/leaflet"), { recursive: true });
writeFileSync(join(root, "dist/fragment.html"), `<title>Prep my race · Trail race &amp; run planner</title>\n${fonts}\n${body}`);
writeFileSync(
  join(root, "dist/index.html"),
  `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">\n<title>Prep my race · Trail race &amp; run planner</title>\n${fonts}\n</head>\n<body>\n${body}</body>\n</html>\n`
);
console.log(`built dist/index.html: ${order.length} modules, ${Math.round((css.length + js.length) / 1024)} KB of code`);
