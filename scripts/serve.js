// serve.js: build, then serve dist/ on http://localhost:5173 (no dependencies besides esbuild).
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
spawnSync("node", [join(root, "scripts/build.js")], { stdio: "inherit" });
createServer((req, res) => {
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end(readFileSync(join(root, "dist/index.html")));
}).listen(5173, () => console.log("http://localhost:5173"));
