// ai-serve.js: the app in your browser, with the Prep my race AI call working locally.
//
//   npm run ai-browser      then open http://localhost:5174
//
// The same as `npm run dev` (build, then serve dist/), plus three addresses only this server has:
//   GET  /local-ai        "a local test server is here", and whether a key was found
//   POST /local-ai        { request, input, fake }: saves them and, unless fake, sends the request
//                         to OpenAI with the key, then answers { stamp, response }
//   POST /local-ai/save   { stamp, output, result }: what the page's referee made of the answer
// Every test lands in ai-runs/<date-time>-browser/ (input.json, prompt.txt, request.json,
// response.json, output.json, result.json), like `npm run ai-local`.
//
// The key: OPENAI_API_KEY from the environment, else from the file .env.local at the repo root
// (ignored by git). It stays in this server: the page never sees it, and it is never written to
// the ai-runs files. Optional OPENAI_MODEL in the same places picks the model.
//
// Safety: the server listens on 127.0.0.1 only (this computer, not your network), and the
// /local-ai addresses refuse any request whose Origin header is not this page. Without that check,
// any website open in your browser could send requests to localhost and spend your key.

import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 5174;
spawnSync("node", [join(root, "scripts/build.js")], { stdio: "inherit" });

// The key and the model: the environment first, else a line NAME=value of .env.local.
const envFile = join(root, ".env.local");
const envText = existsSync(envFile) ? readFileSync(envFile, "utf8") : "";
const fromEnv = (name) => process.env[name] || ((envText.match(new RegExp(`^\\s*${name}\\s*=\\s*"?([^"\\s]+)"?`, "m")) || [])[1]) || "";
const KEY = fromEnv("OPENAI_API_KEY");
const MODEL = fromEnv("OPENAI_MODEL");

const types = { ".html": "text/html; charset=utf-8", ".webp": "image/webp", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml" };
const send = (res, code, obj) => { res.statusCode = code; res.setHeader("content-type", "application/json"); res.end(JSON.stringify(obj)); };
// Read a request body as JSON, at most 5 MB (a real prompt is well under 1 MB).
const body = (req) => new Promise((ok, ko) => {
  let n = 0;
  const parts = [];
  req.on("data", (c) => { n += c.length; if (n > 5e6) { ko(new Error("Too big")); req.destroy(); } else parts.push(c); });
  req.on("end", () => { try { ok(JSON.parse(Buffer.concat(parts).toString("utf8"))); } catch (e) { ko(e); } });
  req.on("error", ko);
});
// A test's folder; the stamp comes back from the page on /save, so it is checked strictly.
const dirOf = (stamp) => join(root, "ai-runs", stamp);
const save = (stamp, name, data) => writeFileSync(join(dirOf(stamp), name), typeof data === "string" ? data : JSON.stringify(data, null, 2));

async function localAi(req, res, path) {
  // Same page only: a browser always sends Origin on a POST, and it names the site that sent it.
  const origin = req.headers.origin;
  if (req.method === "POST" && origin !== `http://localhost:${PORT}` && origin !== `http://127.0.0.1:${PORT}`) return send(res, 403, { error: { message: "Not from this page." } });
  if (req.method === "GET" && path === "/local-ai") return send(res, 200, { local: true, key: Boolean(KEY), model: MODEL || "gpt-5.4-mini" });
  if (req.method !== "POST") return send(res, 405, { error: { message: "POST only." } });
  let b;
  try { b = await body(req); } catch (e) { return send(res, 400, { error: { message: "Bad request body." } }); }
  if (path === "/local-ai/save") {
    if (!/^[\d-]+-browser$/.test(b.stamp || "") || !existsSync(dirOf(b.stamp))) return send(res, 400, { error: { message: "Unknown test." } });
    save(b.stamp, "output.json", b.output ?? null);
    save(b.stamp, "result.json", b.result ?? null);
    console.log(`  ${b.stamp}: ${b.result && b.result.status}${b.result && b.result.reason ? ` (${b.result.reason})` : ""}`);
    return send(res, 200, { ok: true });
  }
  if (path !== "/local-ai") return send(res, 404, { error: { message: "Unknown address." } });
  const request = b.request;
  if (!request || typeof request.input !== "string" || typeof request.instructions !== "string") return send(res, 400, { error: { message: "No request." } });
  if (MODEL) request.model = MODEL;
  const stamp = `${new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19)}-browser`;
  mkdirSync(dirOf(stamp), { recursive: true });
  save(stamp, "input.json", b.input ?? null);
  save(stamp, "prompt.txt", `=== INSTRUCTIONS (fixed) ===\n${request.instructions}\n\n=== INPUT (data) ===\n${request.input}\n`);
  save(stamp, "request.json", request);
  if (b.fake) { console.log(`  ${stamp}: fake answer`); return send(res, 200, { stamp, response: null }); }
  if (!KEY) return send(res, 200, { stamp, response: { error: { message: "No key: put OPENAI_API_KEY=sk-... in .env.local and restart npm run ai-browser." } } });
  console.log(`  ${stamp}: calling ${request.model} (reasoning ${request.reasoning && request.reasoning.effort})…`);
  const t0 = Date.now();
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(10 * 60 * 1000),
  }).then((r) => r.json()).catch((e) => ({ error: { message: e.message } }));
  save(stamp, "response.json", response);
  console.log(`  ${stamp}: answer in ${Math.round((Date.now() - t0) / 1000)} s, ${(response.usage && response.usage.total_tokens) || 0} tokens${response.error ? `, error: ${response.error.message}` : ""}`);
  return send(res, 200, { stamp, response });
}

createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url, "http://x").pathname).replace(/\.\.+/g, "");
  if (path === "/local-ai" || path === "/local-ai/save") return void localAi(req, res, path).catch((e) => send(res, 500, { error: { message: e.message } }));
  // Everything else: a file of dist/, or the app page (as in scripts/serve.js).
  const file = join(root, "dist", path === "/" ? "index.html" : path);
  const hit = existsSync(file) && statSync(file).isFile() ? file : join(root, "dist/index.html");
  res.setHeader("content-type", types[hit.slice(hit.lastIndexOf("."))] ?? "application/octet-stream");
  res.end(readFileSync(hit));
}).listen(PORT, "127.0.0.1", () => {
  console.log(`http://localhost:${PORT}  (local AI test: ${KEY ? `key found, model ${MODEL || "gpt-5.4-mini"}` : "no key in .env.local, only the fake answer works"})`);
  console.log("Open the account icon (top right) > Ask the AI. Stop with Ctrl+C.");
});
