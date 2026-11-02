// The comment stripper of the live build (scripts/strip.js): comments go, code never changes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Script } from "node:vm";
import { stripJs, stripCss } from "../scripts/strip.js";

test("comments go, strings, templates and regexes stay", () => {
  const src = [
    "// a line comment",
    "/** a block",
    " * comment */",
    'const url = "http://x.org/*not*/"; // after code',
    "const re = /\\/\\*[^/]*\\//g;",
    "const t = `a // ${b /* c */ + `x ${1}`} /* d */",
    "",
    "e`;",
    "const q = a / b / c;",
  ].join("\n");
  assert.equal(stripJs(src), [
    'const url = "http://x.org/*not*/";',
    "const re = /\\/\\*[^/]*\\//g;",
    "const t = `a // ${b   + `x ${1}`} /* d */",
    "",
    "e`;",
    "const q = a / b / c;",
  ].join("\n"));
});

test("CSS comments go, strings stay", () => {
  assert.equal(stripCss('/* x */\na { content: "/* y */"; } /* z */\n\nb {}'), 'a { content: "/* y */"; }\nb {}');
});

test("the built page's code still compiles", () => {
  let html;
  try { html = readFileSync("dist/index.html", "utf8"); } catch { return; } // not built yet
  const js = html.match(/<script>\n([\s\S]*?)\n<\/script>/)[1].replace(/<\\\/script/g, "</script");
  assert.doesNotThrow(() => new Script(js));
});
