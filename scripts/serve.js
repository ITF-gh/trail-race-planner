// serve.js: build, then serve dist/ on http://localhost:5173 (no dependencies: only Node's built-in modules; the build itself is scripts/build.js, which needs nothing else either).
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The project folder (one level above scripts/).
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// 1.
spawnSync("node", [join(root, "scripts/build.js")], { stdio: "inherit" });
// File extension -> the Content-Type header that tells the browser what kind of file it gets.
const types = { ".html": "text/html; charset=utf-8", ".webp": "image/webp", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml" };
// 2.
createServer((req, res) => {
  // serve files from dist/ (the page and its photos); anything unknown gets the page new URL(...) splits the requested address so we keep only its path (no ?query); the "http://x" base is a dummy...
  const path = decodeURIComponent(new URL(req.url, "http://x").pathname).replace(/\.\.+/g, "");
  const file = join(root, "dist", path === "/" ? "index.html" : path);
  const hit = existsSync(file) && statSync(file).isFile() ? file : join(root, "dist/index.html");
  // Content type from the extension (text after the last dot).
  res.setHeader("content-type", types[hit.slice(hit.lastIndexOf("."))] ?? "application/octet-stream");
  res.end(readFileSync(hit));
}).listen(5173, () => console.log("http://localhost:5173"));
