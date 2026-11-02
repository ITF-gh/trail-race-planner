// strip.js: remove comments and blank lines from JavaScript and CSS for the live site.

const REGEX_AFTER = new Set(["return", "typeof", "case", "do", "else", "in", "of", "new", "delete", "void", "throw", "instanceof", "yield", "await"]);

/** JavaScript source -> the same code without comments and without empty lines. */
export function stripJs(src) {
  let out = "";
  let i = 0;
  let prev = ""; // last significant token (character or word), to tell a regex from a division
  const braces = []; // inside a template literal's ${...}: the brace depth where it closes
  let depth = 0;
  const n = src.length;
  const word = /[A-Za-z0-9_$]/;
  const template = () => {
    // at the character after a backtick (or after the } closing a ${...}); copy up to the end or the next ${
    while (i < n) {
      const c = src[i];
      if (c === "\\") { out += c + (src[i + 1] === "\n" ? "\u0001" : src[i + 1]); i += 2; continue; }
      if (c === "`") { out += c; i++; prev = "`"; return; }
      if (c === "$" && src[i + 1] === "{") { out += "${"; i += 2; braces.push(depth); depth++; prev = "{"; return; }
      out += c === "\n" ? "\u0001" : c; i++;
    }
  };
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === "/" && d === "/") { while (i < n && src[i] !== "\n") i++; continue; }
    if (c === "/" && d === "*") {
      const end = src.indexOf("*/", i + 2);
      const body = src.slice(i, end + 2);
      i = end + 2;
      out += body.includes("\n") ? "\n" : " ";
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && src[j] !== c) j += src[j] === "\\" ? 2 : 1;
      out += src.slice(i, j + 1); i = j + 1; prev = c; continue;
    }
    if (c === "`") { out += c; i++; template(); continue; }
    if (c === "/") {
      const isRegex = prev === "" || (!word.test(prev[0]) && !")]".includes(prev) && prev !== "`" && prev !== '"' && prev !== "'") || REGEX_AFTER.has(prev);
      if (isRegex) {
        let j = i + 1, cls = false;
        while (j < n) {
          const ch = src[j];
          if (ch === "\\") { j += 2; continue; }
          if (ch === "[") cls = true; else if (ch === "]") cls = false; else if (ch === "/" && !cls) break;
          j++;
        }
        j++;
        while (j < n && word.test(src[j])) j++;
        out += src.slice(i, j); i = j; prev = "/re/"; continue;
      }
    }
    if (c === "{") depth++;
    if (c === "}") {
      depth--;
      if (braces.length && braces[braces.length - 1] === depth) { braces.pop(); out += c; i++; template(); continue; }
    }
    if (word.test(c)) {
      let j = i;
      while (j < n && word.test(src[j])) j++;
      prev = src.slice(i, j); out += prev; i = j; continue;
    }
    if (!/\s/.test(c)) prev = c;
    out += c; i++;
  }
  return dropBlankLines(out);
}

/** CSS -> the same rules without comments and without empty lines. */
export function stripCss(src) {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "*") { i = src.indexOf("*/", i + 2) + 2; continue; }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== c) j += src[j] === "\\" ? 2 : 1;
      out += src.slice(i, j + 1); i = j + 1; continue;
    }
    out += c; i++;
  }
  return dropBlankLines(out);
}

// Trailing spaces off every line, then lines left empty removed. Newlines inside template literals were
// written as \u0001 by stripJs, so the lines of a template are never touched; they are put back here.
function dropBlankLines(text) {
  return text.split("\n").filter((line) => line.trim() !== "").map((line) => line.replace(/[ \t]+$/, "")).join("\n").replaceAll("\u0001", "\n");
}
