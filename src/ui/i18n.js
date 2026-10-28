// i18n.js: the page in English (the default) or in French, switched by two flags next to the
// account button (and in the top bar of the site pages). Boss, 2026-10-28.
//
// How it works: the app keeps writing its texts in English, exactly as before. When French is
// picked, this file reads the French dictionary (dist/i18n/fr.json, built from src/i18n/fr.json,
// loaded once, only then) and swaps every English text on the page for its French version: the
// text pieces between tags, a few attributes (placeholder, title, aria-label, alt), and some whole
// blocks whose text has bold or links inside (then the block's HTML is swapped as one).
// A MutationObserver (a browser feature that reports every change to the page) catches each new
// or changed text, so whatever the app draws later (a replay step, a window, an A4 sheet) is
// swapped too. The English original is kept on each piece, so going back to English needs no
// reload and the files already loaded stay.
//
// Texts with numbers: "78.3 km · 3,784 m D+" is looked up as "{0} km · {1} m D+", then the
// numbers go back in, written the French way (78,3 and 3 784). Texts joined with " · ", and texts
// of several sentences, are also tried part by part. A text missing from the dictionary simply
// stays in English.
//
// The dictionary is ours (a file of this site), so swapping a block's HTML with it is safe: a
// block is only swapped when its whole content is exactly a key of the dictionary.
//
// Exports: i18nLang (the language in use), i18nInit (start: flags, dictionary, observer),
// i18nFlagsHtml (the two flag buttons). The build also makes dist/i18n.js from this file for the
// static pages (guide, about...), which run no other app code.

const I18N_KEY = "trp.lang";
// The flags, drawn in SVG (flag emoji show as two letters on Windows).
const I18N_FLAGS = {
  en: `<svg viewBox="0 0 60 30" aria-hidden="true"><clipPath id="i18nUk"><path d="M0 0v30h60V0z"/></clipPath><path d="M0 0v30h60V0z" fill="#012169"/><path d="M0 0l60 30m0-30L0 30" stroke="#fff" stroke-width="6" clip-path="url(#i18nUk)"/><path d="M0 0l60 30m0-30L0 30" stroke="#C8102E" stroke-width="3" clip-path="url(#i18nUk)"/><path d="M30 0v30M0 15h60" stroke="#fff" stroke-width="10"/><path d="M30 0v30M0 15h60" stroke="#C8102E" stroke-width="6"/></svg>`,
  fr: `<svg viewBox="0 0 3 2" aria-hidden="true"><path fill="#002654" d="M0 0h1v2H0z"/><path fill="#fff" d="M1 0h1v2H1z"/><path fill="#CE1126" d="M2 0h1v2H2z"/></svg>`,
};
const I18N_NAMES = { en: "English", fr: "Français" };
const I18N_ATTRS = ["placeholder", "title", "aria-label", "alt"];
// Blocks whose whole HTML may be swapped at once (text with <b>, <a>... inside).
const I18N_BLOCKS = new Set(["P", "LI", "H1", "H2", "H3", "H4", "H5", "LABEL", "TD", "TH", "DT", "DD", "SUMMARY", "FIGCAPTION", "SMALL", "SPAN", "DIV", "BUTTON", "A", "B", "STRONG", "EM", "I"]);
// A number as the app writes it: 78.3, 3,784, 06:30, 3h45, 1:02:03.
const I18N_NUM = /\d+(?:[.,:h']\d+)*/g;

let i18nDict = null; // { t: {english text: french}, h: {english block HTML: french}, r: [[pattern, french]] }
let i18nCur = "en";
let i18nObs = null;
let i18nBusy = false; // true while this file writes, so the observer ignores its own changes
let i18nTitleEn = ""; // the page title in English, while French is shown
let i18nTitleFr = ""; // and its French, set by this file

/** The language to show: "fr" when picked before (or ?lang=fr in the address), else "en". */
export function i18nLang() {
  try {
    const q = new URLSearchParams(location.search).get("lang");
    if (q === "fr" || q === "en") localStorage.setItem(I18N_KEY, JSON.stringify(q));
    return JSON.parse(localStorage.getItem(I18N_KEY) || "null") === "fr" ? "fr" : "en";
  } catch (e) {
    return "en";
  }
}

/** The two flag buttons; the one in use is marked aria-pressed="true". */
export function i18nFlagsHtml() {
  return `<div class="i18n-flags" role="group" aria-label="Language" translate="no">${["en", "fr"].map((l) => `<button type="button" data-lang="${l}" aria-pressed="${l === i18nCur}" aria-label="${I18N_NAMES[l]}" title="${I18N_NAMES[l]}">${I18N_FLAGS[l]}</button>`).join("")}</div>`;
}

// A number written the French way: 3,784 -> 3 784 (narrow no-break space), and 78.3 -> 78,3 but
// only when a unit follows it in the French text (`unit` true): "Climb section 1.2" keeps its dot.
const i18nNum = (n, unit) => (/^\d{1,3}(,\d{3})+$/.test(n) ? n.replace(/,/g, "\u202f") : unit && /^\d+\.\d+$/.test(n) ? n.replace(".", ",") : n);
// Put the numbers back into a French template: {0}, {1}... in their order of the English text.
const i18nFill = (fr, nums) => fr.replace(/\{(\d+)\}/g, (m, i, at) => i18nNum(nums[+i] || "", /^\s?(km|m\b|%|kg|kcal|min|h\b|s\b|\/km|m\/h)/.test(fr.slice(at + m.length)) || /^ à [+-]?\{\d+\}\s?%/.test(fr.slice(at + m.length))));

/** French for one text (spaces already tidied), or null when the dictionary has none. */
function i18nText(s) {
  const T = i18nDict.t;
  if (Object.prototype.hasOwnProperty.call(T, s)) return T[s];
  const nums = [];
  const key = s.replace(I18N_NUM, (m) => `{${nums.push(m) - 1}}`);
  if (nums.length && Object.prototype.hasOwnProperty.call(T, key)) return i18nFill(T[key], nums);
  // Texts holding a list (the sections of a climb, the bests just beaten): the dictionary's "r"
  // rules, each a pattern and its French, where {t:N} is part N translated and {l:N} part N read
  // as a list (split before each "3.1 " number, else at each ", ") with each item translated.
  for (const [re, out] of i18nDict.r) {
    const m = re.exec(s);
    if (!m) continue;
    return out.replace(/\{(t|l):(\d+)\}/g, (x, kind, n) => {
      const part = m[+n] || "";
      if (kind === "t") return i18nText(part) ?? part;
      const items = /^\d+(\.\d+)? /.test(part) ? part.split(/, (?=\d+(?:\.\d+)? )/) : part.split(", ");
      return items.map((it) => { const k = /^(\d+(?:\.\d+)?) (.+)$/.exec(it); return k ? `${k[1]} ${i18nText(k[2]) ?? k[2]}` : i18nText(it) ?? it; }).join(", ");
    }).replace(/\$(\d)/g, (x, n) => m[+n] || "");
  }
  // A piece that starts with a separator (" · Climb 3" after a bold number): translate the rest.
  const lead = /^([·:,(]\s*)(.+)$/.exec(s);
  if (lead) { const fr = i18nText(lead[2]); if (fr !== null) return lead[1] + fr; }
  // Long texts built from several pieces: try piece by piece, first the " · " parts, then the
  // sentences. A piece the dictionary lacks stays in English.
  for (const [cut, glue] of [[" · ", " · "], [/(?<=[.!?])\s+(?=[A-Z0-9])/, " "]]) {
    const parts = s.split(cut);
    if (parts.length < 2) continue;
    const fr = parts.map((p) => i18nText(p));
    if (fr.some((x) => x !== null)) return parts.map((p, i) => (fr[i] === null ? p : fr[i])).join(glue);
  }
  return null;
}

/**
 * French HTML for a block, or null. Looked up as is, then with the numbers of its text (never
 * those inside tags, such as a link's address) replaced by {0}, {1}... like i18nText.
 */
function i18nHtml(html, H) {
  if (Object.prototype.hasOwnProperty.call(H, html)) return H[html];
  const nums = [];
  const key = html.replace(/(^|>)([^<]*)/g, (m, a, txt) => a + txt.replace(I18N_NUM, (n) => `{${nums.push(n) - 1}}`));
  if (!nums.length || !Object.prototype.hasOwnProperty.call(H, key)) return null;
  return i18nFill(H[key], nums);
}

// Tidy spaces the way the dictionary keys are written.
const i18nTidy = (s) => s.replace(/\s+/g, " ").trim();

/** Swap one text piece (a DOM text node), keeping its English in node.__en. */
function i18nNode(n) {
  if (n.__fr !== undefined && n.nodeValue === n.__fr) return; // already ours
  const en = n.nodeValue;
  const s = i18nTidy(en);
  if (!s || !/[A-Za-z]/.test(s)) return;
  const fr = i18nText(s);
  if (fr === null) return;
  const out = en.match(/^\s*/)[0] + fr + en.match(/\s*$/)[0];
  n.__en = en;
  n.__fr = out;
  n.nodeValue = out;
}

/** Swap the translatable attributes of one element. */
function i18nAttrs(el) {
  for (const a of I18N_ATTRS) {
    const v = el.getAttribute(a);
    if (!v || !/[A-Za-z]/.test(v)) continue;
    if (el.__frA && el.__frA[a] === v) continue;
    const fr = i18nText(i18nTidy(v));
    if (fr === null) continue;
    (el.__enA = el.__enA || {})[a] = v;
    (el.__frA = el.__frA || {})[a] = fr;
    el.setAttribute(a, fr);
  }
}

/** Swap everything under `root` (an element or a text node). */
function i18nTree(root) {
  if (!i18nDict || i18nCur !== "fr" || !root) return;
  if (root.nodeType === 3) { if (!i18nSkip(root.parentElement)) i18nNode(root); return; }
  if (root.nodeType !== 1 || i18nSkip(root)) return;
  const H = i18nDict.h;
  const walk = (el) => {
    if (el.tagName === "TEXTAREA") { i18nAttrs(el); return; } // its placeholder, never its text
    if (i18nSkip(el)) return;
    if (el.attributes.length) i18nAttrs(el);
    // A block whose whole HTML is a dictionary key: swap it as one.
    if (I18N_BLOCKS.has(el.tagName) && el.firstElementChild && el.__frH !== el.innerHTML) {
      const fr = i18nHtml(i18nTidy(el.innerHTML), H);
      if (fr !== null) {
        el.__enH = el.innerHTML;
        el.innerHTML = fr;
        el.__frH = el.innerHTML;
        for (const c of el.querySelectorAll("*")) i18nAttrs(c);
        return;
      }
    }
    for (let c = el.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === 3) i18nNode(c);
      else if (c.nodeType === 1) walk(c);
    }
  };
  walk(root);
}

// Never translate code, styles, drawings' inner text, user input or what is marked translate="no".
const i18nSkip = (el) => !el || /^(SCRIPT|STYLE|TEXTAREA|CODE|PRE)$/.test(el.tagName) || Boolean(el.closest && el.closest("[translate=no]"));

/** Put the English back everywhere (the pieces swapped keep their English). */
function i18nRestore() {
  const all = document.body.querySelectorAll("*");
  for (const el of all) {
    if (el.__enH !== undefined && el.innerHTML === el.__frH) { el.innerHTML = el.__enH; delete el.__enH; delete el.__frH; }
  }
  for (const el of document.body.querySelectorAll("*")) {
    if (el.__enA) { for (const [a, v] of Object.entries(el.__enA)) if (el.getAttribute(a) === el.__frA[a]) el.setAttribute(a, v); delete el.__enA; delete el.__frA; }
  }
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n; n = w.nextNode()) if (n.__en !== undefined) { if (n.nodeValue === n.__fr) n.nodeValue = n.__en; delete n.__en; delete n.__fr; }
}

/** Load the French dictionary once. Resolves to true when it is there. */
async function i18nLoad() {
  if (i18nDict) return true;
  try {
    const r = await fetch("i18n/fr.json", { cache: "force-cache" });
    const j = await r.json();
    i18nDict = { t: j.t || {}, h: j.h || {}, r: (j.r || []).map(([re, out]) => [new RegExp(re), out]) };
    return true;
  } catch (e) {
    return false;
  }
}

function i18nWatch() {
  if (i18nObs) return;
  i18nObs = new MutationObserver((list) => {
    if (i18nBusy || i18nCur !== "fr") return;
    i18nBusy = true;
    try {
      for (const m of list) {
        if (m.type === "childList") m.addedNodes.forEach((n) => i18nTree(n));
        else if (m.type === "characterData") { if (!i18nSkip(m.target.parentElement)) i18nNode(m.target); }
        else if (m.type === "attributes") i18nAttrs(m.target);
      }
    } finally {
      i18nObs.takeRecords(); // our own changes: nothing to do
      i18nBusy = false;
    }
  });
  i18nObs.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: I18N_ATTRS });
  // The page title changes too (the A4 export names the PDF with it).
  const title = document.querySelector("title");
  if (title) new MutationObserver(() => {
    if (i18nCur !== "fr" || document.title === i18nTitleFr) return;
    const tt = i18nText(i18nTidy(document.title));
    if (tt !== null) { i18nTitleEn = document.title; i18nTitleFr = tt; document.title = tt; }
  }).observe(title, { childList: true, characterData: true, subtree: true });
}

/** Switch the page to `lang` ("en" or "fr"), keep the choice, mark the flags. */
async function i18nSet(lang) {
  i18nCur = lang === "fr" ? "fr" : "en";
  try { localStorage.setItem(I18N_KEY, JSON.stringify(i18nCur)); } catch (e) { /* private mode */ }
  document.documentElement.lang = i18nCur;
  document.querySelectorAll(".i18n-flags button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.lang === i18nCur)));
  if (i18nCur === "fr" && (await i18nLoad())) {
    i18nBusy = true;
    try { i18nTree(document.body); if (i18nObs) i18nObs.takeRecords(); } finally { i18nBusy = false; }
    const tt = i18nText(i18nTidy(document.title));
    if (tt !== null) { i18nTitleEn = document.title; i18nTitleFr = tt; document.title = tt; }
    i18nWatch();
  } else if (i18nCur === "en") {
    i18nBusy = true;
    try { i18nRestore(); if (i18nObs) i18nObs.takeRecords(); } finally { i18nBusy = false; }
    if (i18nTitleEn) { document.title = i18nTitleEn; i18nTitleEn = ""; }
  }
  document.documentElement.classList.remove("i18n-wait");
}

/**
 * Start: put the flags in `where` (an element; they go first inside it), listen to their
 * clicks, and show French when it was picked before. Messages of window.confirm / alert are
 * swapped too. Safe to call once per page.
 */
export function i18nInit(where) {
  const lang = i18nLang();
  if (where && !where.querySelector(".i18n-flags")) where.insertAdjacentHTML("afterbegin", i18nFlagsHtml());
  document.addEventListener("click", (e) => {
    const b = e.target.closest && e.target.closest(".i18n-flags [data-lang]");
    if (b) i18nSet(b.dataset.lang);
  });
  for (const fn of ["confirm", "alert"]) {
    const orig = window[fn];
    if (typeof orig === "function") window[fn] = (msg) => orig.call(window, i18nCur === "fr" && i18nDict && typeof msg === "string" ? i18nText(i18nTidy(msg)) || msg : msg);
  }
  if (lang === "fr") {
    document.documentElement.classList.add("i18n-wait");
    setTimeout(() => document.documentElement.classList.remove("i18n-wait"), 2000);
  }
  i18nCur = lang;
  return i18nSet(lang);
}
