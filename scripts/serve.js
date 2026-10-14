// serve.js: build, then serve dist/ on http://localhost:5173 (no dependencies besides esbuild).
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
spawnSync("node", [join(root, "scripts/build.js")], { stdio: "inherit" });
const types = { ".html": "text/html; charset=utf-8", ".webp": "image/webp", ".js": "text/javascript", ".css": "text/css", ".png": "image/png" };
createServer((req, res) => {
  // serve files from dist/ (the page and its photos); anything unknown gets the page
  const path = decodeURIComponent(new URL(req.url, "http://x").pathname).replace(/\.\.+/g, "");
  const file = join(root, "dist", path === "/" ? "index.html" : path);
  const hit = existsSync(file) && statSync(file).isFile() ? file : join(root, "dist/index.html");
  res.setHeader("content-type", types[hit.slice(hit.lastIndexOf("."))] ?? "application/octet-stream");
  res.end(readFileSync(hit));
}).listen(5173, () => console.log("http://localhost:5173"));
